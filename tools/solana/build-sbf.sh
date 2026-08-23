#!/usr/bin/env bash
#
# Build a Solana program with the pinned platform-tools line, and bootstrap
# that toolchain on a machine that has never built one.
#
# Everything that builds packages/solana-program pinned goes through here:
# `make solana-build` (and therefore `make local-up` / `make local-verify` and
# the local-topologies workflow), `tools/solana/deploy.sh`, CI's
# reproducibility gate, and connector-settlement-solana's test harness. Run it
# from the directory you want built -- it does not cd, so the caller keeps
# that choice.
#
# WHY THIS EXISTS -- the cold-cache panic
#
# `cargo build-sbf --tools-version vX` from Agave's 2.1 line panics in under a
# second, before it ever reaches the network, when $HOME/.cache/solana does
# not exist:
#
#   thread 'main' panicked at sdk/cargo-build-sbf/src/main.rs:146:10:
#   called `Result::unwrap()` on an `Err` value:
#   Os { code: 2, kind: NotFound, message: "No such file or directory" }
#
# That line is `std::fs::read_dir(solana).unwrap()` in
# `find_installed_platform_tools()`. It is reached from
# `validate_platform_tools_version()`, which early-returns *only* when the
# requested version equals the CLI's built-in one -- v2.1.21's built-in is
# v1.43 and we ask for v1.52, so we always take the read_dir path. Nothing
# creates the directory before reading it: cargo-build-sbf creates
# $HOME/.cache/solana/<version>/ on the way to installing a toolchain, but
# never the parent.
#
# WHICH CLI YOU HAVE DECIDES WHETHER YOU EVER REACH IT
#
# That early return is why this repository's jobs split cleanly in half on a
# cold cache, and it is worth knowing before diagnosing anything here. This
# repository installs two Solana CLI versions deliberately -- v2.1.21 where the
# program is run, v3.1.12 where the deployed artifact is built (the reason for
# each is recorded once, in
# crates/connector-settlement-solana/tests/solana_cli_pins.rs). v3.1.12's
# built-in platform-tools line is v1.52, the very line pinned below, so those
# jobs take the early return and never touch the failing read_dir. v2.1.21's is
# v1.43, so those jobs always do. Every green v3 job on a cold cache was
# evidence about that early return, not about that job's retry loop -- reading
# it the other way is most of what made this expensive to find.
#
# So the failure is deterministic, not flaky, and no retry can fix it. It is
# also why every green local-topologies run stood on a cache nothing
# guaranteed: `actions/cache` created that directory as a side effect of
# restoring it. Cache entries are branch-scoped and a failed job saves none,
# so when main's entry was evicted all three topologies went red on every open
# PR at once -- including docs-only ones -- and main could not heal itself.
#
# THREE THINGS, EACH LOAD-BEARING
#
# 1. Create $HOME/.cache/solana. Fixes the panic above. After this the build
#    works from genuinely cold, so the CI cache is a speed-up rather than a
#    correctness dependency -- which is the point.
#
# 2. Retry. With the directory present but empty, the version check falls
#    through to `get_latest_platform_tools_version()`, an HTTP GET of
#    github.com/anza-xyz/platform-tools/releases/latest. That call is issue
#    #105's flake: when GitHub answers without redirecting, the literal string
#    "latest" reaches semver and panics with "unexpected character 'l' while
#    parsing major version number". Unlike (1) that one is a real transient,
#    so a bounded retry is the right shape for it. Once a toolchain at or
#    above the pin is on disk the check short-circuits offline and the call
#    stops happening at all.
#
# 3. Assert the pinned toolchain is on disk afterwards. If that same GET
#    *errors* rather than misparsing, cargo-build-sbf does not fail -- it
#    warns and silently falls back to its built-in v1.43, exiting 0 with a
#    differently sized .so -- ~112.7KB against v1.52's ~109.4KB, the same
#    split packages/solana-program/deployments/devnet-public.md records. A
#    silent downgrade would therefore break the reproducibility gate, that
#    provenance record and the deploy runbook while still looking green.
#    Each line installs under
#    $HOME/.cache/solana/<version>/platform-tools, so a fall back leaves the
#    pinned directory absent and this turns it into a refusal rather than a
#    wrong artifact. A check, never a skip (ADR 0007).
#
#    It is precisely a bootstrap check, and that is enough: once the pinned
#    toolchain is on disk, `find_installed_platform_tools()` short-circuits
#    the whole resolution offline and the pin is honoured deterministically.
#    Resolution can only go wrong on the run that has to fetch it.
#
# 4. Build in a cargo target directory of this toolchain line's OWN, and name
#    the output directory explicitly. This is the difference between "the pin
#    was requested" and "the pin is what came out", and without it the two
#    come apart silently and permanently.
#
#    Every `--tools-version` shares one cargo target directory
#    (`target/sbf-solana-solana` under a 2.1.x CLI), and inside it the leaf
#    cdylib is written to `release/deps/payment_channel.so` with NO
#    per-toolchain suffix -- unlike every dependency, which cargo names
#    `solana_program-<hash>.so` and keeps one copy per line. So two lines
#    overwrite each other's only copy of the program, while each keeps its own
#    `.fingerprint` entry saying it is up to date. Whichever line built last
#    owns the file; every later build of the other line is "Fresh", never
#    re-links, and cargo-build-sbf strips-and-copies the WRONG line's bytes
#    into target/deploy. Measured on this source, 2026-08-23, one machine:
#
#      pinned v1.52 from clean      RECOMPILED  target/deploy = 109,416 bytes
#      bare `cargo build-sbf`       RECOMPILED  target/deploy = 112,680 bytes
#      pinned v1.52 again           Fresh       target/deploy = 112,680 bytes  <-- exit 0
#      pinned v1.52 a third time    Fresh       target/deploy = 112,680 bytes
#
#    It never recovers: only editing the program's source forces the leaf to
#    re-link, and until someone does, `make solana-build`, `tools/solana/
#    deploy.sh` and connector-settlement-solana's validator harness all take a
#    v1.43 binary that no provenance record, size figure or reproducibility
#    gate here describes. Check (3) cannot see it, because the pinned
#    toolchain IS installed -- it simply was not the one that produced these
#    bytes.
#
#    Splitting the target directory per line removes the shared file, so the
#    outcome is correct by construction rather than checked afterwards, which
#    also means it holds for a line this repository has not thought of. The
#    price is one dependency build per line; there is normally one line.
#    `--sbf-out-dir` is then passed explicitly, because cargo-build-sbf
#    defaults it to <target-dir>/deploy and everything downstream --
#    deploy.sh, the harness, infra/solana/entrypoint.sh -- reads the
#    workspace's `target/deploy`.
#
set -euo pipefail

# The one platform-tools line every artifact statement in this repo is made
# about; overridable only so tools/solana/deploy.sh can pass its own copy of
# the same constant and the two can never drift.
PLATFORM_TOOLS_VERSION="${PLATFORM_TOOLS_VERSION:-v1.52}"
ATTEMPTS="${SBF_BUILD_ATTEMPTS:-3}"

# Answers "which platform-tools line does this repository build with" from the
# script that applies it, so a caller needing the literal -- the Makefile's
# solana-test target -- does not keep a second copy of it. Before anything
# else: it must not build, install or create directories.
if [[ "${1:-}" == "--print-tools-version" ]]; then
    echo "$PLATFORM_TOOLS_VERSION"
    exit 0
fi

# cargo-build-sbf reads $HOME directly rather than XDG_CACHE_HOME, so this is
# the path it will use, on Linux and macOS alike.
cache_dir="$HOME/.cache/solana"
pinned_toolchain="$cache_dir/$PLATFORM_TOOLS_VERSION/platform-tools"

mkdir -p "$cache_dir"

# Where cargo would put things, resolved the way cargo resolves it, because
# both paths below have to agree with what the rest of the repository reads.
# `locate-project --workspace` rather than a path relative to this script:
# the caller chose the directory (see the header), and a member crate's build
# output lands in the WORKSPACE root's target/, not its own.
target_root="${CARGO_TARGET_DIR:-$(dirname "$(cargo locate-project --workspace --message-format plain)")/target}"
# One cargo target directory per platform-tools line -- reason (4) above.
line_target_dir="$target_root/sbf-tools-$PLATFORM_TOOLS_VERSION"
# ...but one output directory for all of them, the one everything downstream
# reads.
sbf_out_dir="$target_root/deploy"

# The other half of (4). Splitting the target directory stops this line from
# INHERITING another's bytes, but not from failing to overwrite them:
# cargo-build-sbf's strip-and-copy into --sbf-out-dir is skipped when the
# destination is newer than the artifact it would copy (`file_older_or_missing`
# in Agave's cargo-build-sbf), and a cargo run that relinks nothing leaves this
# line's artifact at whatever mtime it last had. So a bare `cargo build-sbf`
# that wrote target/deploy a second ago still wins, and the pinned build exits
# 0 having copied nothing:
#
#   target/sbf-tools-v1.52/.../release/payment_channel.so  17:58:58  (this line)
#   target/deploy/payment_channel.so                       17:59:12  (v1.43's)
#
# Dating the destination back is enough, and it is the cheap side of the
# comparison to move: touching this line's own artifact instead makes cargo
# relink the cdylib on every run (9.4s against 1.7s here), because that file
# is hard-linked into `deps/` and is cargo's own build output. The destination
# is not cargo's. Only the timestamp changes -- no file is removed and no byte
# is rewritten, which matters because several tests reach this script
# concurrently (connector-settlement-solana's harness calls it per test) and
# one of them may be loading that .so into a validator right now.
if compgen -G "$sbf_out_dir/*.so" > /dev/null; then
    touch -t 200001010000 "$sbf_out_dir"/*.so
fi

attempt=0
while true; do
    attempt=$((attempt + 1))

    # ${1+"$@"} rather than "$@": under `set -u`, bash 3.2 -- which is still
    # what /bin/bash is on macOS -- treats an empty "$@" as an unbound variable.
    # `-- --target-dir` last: everything after `--` is handed to `cargo build`.
    if cargo build-sbf --tools-version "$PLATFORM_TOOLS_VERSION" \
        --sbf-out-dir "$sbf_out_dir" ${1+"$@"} -- --target-dir "$line_target_dir"; then
        if [[ -d "$pinned_toolchain" ]]; then
            exit 0
        fi
        echo "cargo build-sbf reported success, but platform-tools $PLATFORM_TOOLS_VERSION is" >&2
        echo "not installed at $pinned_toolchain -- it fell back to its built-in" >&2
        echo "toolchain line, which produces a different binary." >&2
    fi

    if [[ "$attempt" -ge "$ATTEMPTS" ]]; then
        echo "" >&2
        echo "ERROR: could not build with platform-tools $PLATFORM_TOOLS_VERSION after" >&2
        echo "       $attempt attempt(s)." >&2
        echo "" >&2
        echo "       The toolchain is fetched from github.com/anza-xyz/platform-tools" >&2
        echo "       into $cache_dir on first use. Check that host is" >&2
        echo "       reachable, then re-run. Do NOT drop --tools-version to work around" >&2
        echo "       this: the reproducibility gate, the devnet provenance record and the" >&2
        echo "       deploy runbook all describe the $PLATFORM_TOOLS_VERSION artifact." >&2
        exit 1
    fi

    echo "cargo build-sbf attempt $attempt failed -- retrying in 5s..." >&2
    sleep 5
done

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
set -euo pipefail

# The one platform-tools line every artifact statement in this repo is made
# about; overridable only so tools/solana/deploy.sh can pass its own copy of
# the same constant and the two can never drift.
PLATFORM_TOOLS_VERSION="${PLATFORM_TOOLS_VERSION:-v1.52}"
ATTEMPTS="${SBF_BUILD_ATTEMPTS:-3}"

# cargo-build-sbf reads $HOME directly rather than XDG_CACHE_HOME, so this is
# the path it will use, on Linux and macOS alike.
cache_dir="$HOME/.cache/solana"
pinned_toolchain="$cache_dir/$PLATFORM_TOOLS_VERSION/platform-tools"

mkdir -p "$cache_dir"

attempt=0
while true; do
    attempt=$((attempt + 1))

    # ${1+"$@"} rather than "$@": under `set -u`, bash 3.2 -- which is still
    # what /bin/bash is on macOS -- treats an empty "$@" as an unbound variable.
    if cargo build-sbf --tools-version "$PLATFORM_TOOLS_VERSION" ${1+"$@"}; then
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

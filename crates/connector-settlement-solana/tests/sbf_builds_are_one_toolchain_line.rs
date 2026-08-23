//! Two platform-tools lines must never share one cargo target directory, and
//! this repository must only ask for one.
//!
//! # What goes wrong
//!
//! `cargo build-sbf` writes the leaf cdylib it compiles to
//! `<target-dir>/<triple>/release/deps/payment_channel.so` with **no**
//! per-toolchain suffix -- unlike every dependency, which cargo names
//! `solana_program-<hash>.so` and keeps one copy per line. So two
//! `--tools-version` values pointed at one target directory overwrite each
//! other's only copy of the program, while each keeps its own `.fingerprint`
//! entry saying it is up to date. Whichever built last owns the file; every
//! later build of the other line is "Fresh", never re-links, and
//! cargo-build-sbf strips-and-copies the *wrong* line's bytes into
//! `target/deploy`. Measured on this source, 2026-08-23, Solana CLI 2.1.0:
//!
//! | step                                       | cargo      | `target/deploy/payment_channel.so` |
//! | ------------------------------------------ | ---------- | ---------------------------------- |
//! | `tools/solana/build-sbf.sh` from clean      | RECOMPILED | 109,416 bytes (v1.52, the pin)     |
//! | bare `cargo build-sbf`                      | RECOMPILED | 112,680 bytes (v1.43, the default) |
//! | `tools/solana/build-sbf.sh` again           | Fresh      | 112,680 bytes -- **exit 0**        |
//! | `tools/solana/build-sbf.sh` a third time    | Fresh      | 112,680 bytes                      |
//!
//! It does not recover. Only an edit to `packages/solana-program` forces the
//! leaf to re-link, and until someone makes one, `make solana-build`,
//! `tools/solana/deploy.sh` and this crate's validator harness all take a
//! v1.43 binary that no provenance record, size figure or reproducibility
//! gate here describes. `build-sbf.sh`'s existing "is the pinned toolchain
//! installed" check cannot see it: the pinned toolchain *is* installed, it
//! simply did not produce those bytes.
//!
//! # The two halves this file holds
//!
//! **The pinned build cannot inherit another line's bytes.** `build-sbf.sh`
//! builds in a cargo target directory keyed by the line it pins, so the
//! shared file does not exist -- correct by construction, and true for a
//! line nobody here has thought of yet. Its header's reason (4) is the long
//! version.
//!
//! **This repository asks for one line.** `make solana-test` used to run a
//! bare `cargo test-sbf`, which is not just a test runner: solana-program's
//! tests call `ProgramTest::new`, which loads `target/deploy/payment_channel.so`
//! when one is there rather than running the processor natively, so that
//! target *builds* -- with whatever line the installed CLI defaults to
//! (v1.43 on the 2.1 line this repository installs to run the program). That
//! made it both the on-chain program's gate running against a binary CI never
//! tests -- `ci.yml`'s `solana-program` job passes `--tools-version v1.52` --
//! and this repository's one reachable way to get a second line into a shared
//! target directory.
//!
//! The literal lives in `build-sbf.sh` and nowhere else; everything that needs
//! it asks, via `--print-tools-version`. A second copy is what these cases
//! exist to keep out.

const BUILD_SBF: &str = include_str!("../../../tools/solana/build-sbf.sh");
const MAKEFILE: &str = include_str!("../../../Makefile");
const CI_WORKFLOW: &str = include_str!("../../../.github/workflows/ci.yml");

/// The recipe lines of one make target -- the tab-indented lines following
/// `<name>:`, so a case can assert what that target *runs* rather than what
/// the Makefile mentions somewhere.
fn make_recipe(name: &str) -> String {
    let header = format!("\n{name}:");
    let after = MAKEFILE
        .split_once(&header)
        .unwrap_or_else(|| panic!("the Makefile has no target named `{name}`"))
        .1;
    after
        .lines()
        .skip(1)
        .take_while(|line| line.starts_with('\t'))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn the_pinned_build_gets_a_cargo_target_directory_of_its_own() {
    assert!(
        BUILD_SBF.contains(r#"line_target_dir="$target_root/sbf-tools-$PLATFORM_TOOLS_VERSION""#),
        "tools/solana/build-sbf.sh no longer derives a per-platform-tools-line cargo target \
         directory. Sharing one with another line does not fail -- it silently emits the other \
         line's binary from then on, and never recovers. See this file's header for the \
         measurement."
    );
    assert!(
        BUILD_SBF.contains(r#"-- --target-dir "$line_target_dir""#),
        "tools/solana/build-sbf.sh no longer hands cargo its own --target-dir, so the pinned \
         build is back in the directory every other --tools-version writes to."
    );
}

#[test]
fn the_pinned_build_still_writes_where_everything_downstream_reads() {
    assert!(
        BUILD_SBF.contains(r#"sbf_out_dir="$target_root/deploy""#)
            && BUILD_SBF.contains(r#"--sbf-out-dir "$sbf_out_dir""#),
        "tools/solana/build-sbf.sh must pass --sbf-out-dir explicitly. cargo-build-sbf defaults \
         it to <target-dir>/deploy, and giving the build its own target directory would \
         otherwise move the artifact out from under tools/solana/deploy.sh, this crate's \
         harness and infra/solana/entrypoint.sh, all of which read the workspace's \
         target/deploy."
    );
}

#[test]
fn the_pinned_build_makes_its_own_artifact_win_the_copy() {
    assert!(
        BUILD_SBF.contains(r#"touch -t 200001010000 "$sbf_out_dir"/*.so"#),
        "tools/solana/build-sbf.sh no longer dates back what is already in the output \
         directory. Splitting the target directory stops this line inheriting another's bytes \
         but not failing to overwrite them: cargo-build-sbf skips its strip-and-copy when the \
         destination is newer than the artifact it would copy (`file_older_or_missing`), so a \
         bare `cargo build-sbf` a second earlier still wins and the pinned build exits 0 having \
         copied nothing."
    );
}

#[test]
fn build_sbf_answers_which_line_it_pins() {
    assert!(
        BUILD_SBF.contains("--print-tools-version"),
        "tools/solana/build-sbf.sh no longer answers --print-tools-version. It is the single \
         source of the platform-tools line; the Makefile and ci.yml's reproducibility gate ask \
         it rather than keeping copies, and a copy is how two lines get into this repository in \
         the first place."
    );
}

#[test]
fn the_program_gate_builds_with_the_line_this_repository_pins() {
    let recipe = make_recipe("solana-test");
    assert!(
        recipe.contains("cargo test-sbf --tools-version $(PLATFORM_TOOLS_VERSION)"),
        "`make solana-test` no longer pins the platform-tools line. `cargo test-sbf` builds \
         target/deploy/payment_channel.so -- solana-program's tests load it through \
         ProgramTest::new -- so bare it runs the on-chain program's gate against a binary CI \
         never tests, and leaves a second toolchain line's artifact where this crate's harness \
         and the containers pick it up. Recipe was:\n{recipe}"
    );
    assert!(
        MAKEFILE.contains(
            "PLATFORM_TOOLS_VERSION = $(shell $(CURDIR)/tools/solana/build-sbf.sh \
             --print-tools-version)"
        ),
        "the Makefile no longer asks tools/solana/build-sbf.sh which line it pins."
    );
    assert!(
        !recipe.contains("v1."),
        "`make solana-test` names a platform-tools version literal. There is one copy of it, in \
         tools/solana/build-sbf.sh; ask for it with --print-tools-version instead, so this \
         target and that script cannot come to pin different lines. Recipe was:\n{recipe}"
    );
}

#[test]
fn the_program_gate_bootstraps_the_toolchain_before_it_needs_it() {
    assert!(
        MAKEFILE.contains("solana-test: solana-build"),
        "`make solana-test` must run after `make solana-build`. A pinned `cargo test-sbf` on a \
         machine whose $HOME/.cache/solana does not exist yet hits exactly the panic \
         tools/solana/build-sbf.sh exists to prevent (connector#1110); running that script \
         first creates the directory and installs the pinned line, after which \
         cargo-build-sbf's version check short-circuits offline."
    );
}

#[test]
fn the_reproducibility_gate_resets_the_directory_the_pinned_build_builds_in() {
    assert!(
        CI_WORKFLOW.contains(
            r#"line_dir="target/sbf-tools-$(tools/solana/build-sbf.sh --print-tools-version)""#
        ),
        "ci.yml's solana-program-reproducibility job no longer resets the directory \
         tools/solana/build-sbf.sh actually builds in. That job proves build #2 recompiles \
         rather than re-copying build #1's artifact; resetting a directory the build does not \
         use makes it assert reproducibility by construction, which is the tautology its own \
         `exit 1` guard was added to prevent."
    );
}

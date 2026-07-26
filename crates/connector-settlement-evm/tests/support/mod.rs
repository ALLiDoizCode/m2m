//! Shared support for connector-settlement-evm's integration tests: whether `anvil` is on
//! `PATH`, and the CI-vs-local policy for what to do when it is not (issue #471).

use std::process::Command;

/// True if `anvil --version` runs successfully.
pub fn anvil_available() -> bool {
    Command::new("anvil")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The one place every anvil-gated test asks "do I have a chain to talk to, and if not, is
/// that acceptable right now". A real chain is genuinely under test here (ADR 0007), so a CI
/// run that lacks `anvil` must fail loudly rather than silently skip and report `passed` --
/// that combination is worse than the test not existing, because it reports success. `CI` is
/// set by GitHub Actions (and effectively every other CI system) for every job, so gating on
/// it -- rather than a bespoke `REQUIRE_ANVIL` variable nobody remembers to set -- means a
/// fresh CI job fails by default. A local run without Foundry installed still skips, since
/// requiring every contributor to install Foundry just to run `cargo test` is a real cost this
/// crate doesn't need to impose.
///
/// Returns `true` when the caller should proceed with its real assertions, `false` when the
/// caller should return early (having already skipped gracefully via a printed message).
pub fn require_anvil() -> bool {
    if anvil_available() {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "anvil is not on PATH, but CI is set -- the Rust Workspace Gate must install \
             Foundry (foundry-rs/foundry-toolchain) before this crate's tests run. Refusing to \
             silently skip and report success here; see issue #471."
        );
    }

    eprintln!(
        "skipping: anvil is not on PATH (install Foundry: https://getfoundry.sh) -- this test \
         needs a real chain and only skips because this is not a CI run"
    );
    false
}

//! THE record of which Solana CLI this repository installs where, and why
//! there are two of them.
//!
//! Every `release.anza.xyz/<version>/install` in this repository resolves to
//! one of the two constants below, and the cases in this file are what makes
//! that true. GitHub Actions cannot share an `env:` across workflow files and
//! `.sandcastle/Dockerfile` and `devbox.json` cannot read one at all, so the
//! literal is necessarily repeated at each install site. The single source is
//! therefore this file plus the guard: the pins live here with their reasons,
//! the consumers carry a one-line pointer back, and
//! [`every_installed_solana_cli_is_one_of_the_two_recorded_pins`] fails the
//! build the moment a workflow, the image or the docs name a version this file
//! does not.
//!
//! # Why two
//!
//! Because the two versions are load-bearing in opposite directions and no
//! single version satisfies both.
//!
//! ## [`RUST_GATE_CLI`] -- the CLI that runs the program
//!
//! Installed by `ci.yml`'s `rust-gate`, `local-topologies.yml` and
//! `.sandcastle/Dockerfile`. All three want the same thing: a
//! `solana-test-validator` this crate's integration tier can spawn (ADR 0007 --
//! the tier spawns its own disposable chain, so the binary has to be present),
//! driving a program built against the release line the workspace compiles
//! against.
//!
//! Two independent reasons, either one sufficient:
//!
//! 1. **v3's `solana-test-validator` hard-requires io_uring.** Verified against
//!    the binaries: `strings` on v3.1.12's `solana-test-validator` contains
//!    `assertion failed: io_uring_supported()` (agave `fs/src/dirs.rs`), while
//!    the 2.1 line's contains no io_uring reference at all. The agent
//!    container's seccomp profile does not permit it, so a v3 validator panics
//!    there even though the host kernel supports io_uring.
//! 2. **The workspace pins the Solana crates to `=2.1.0`** -- `solana-sdk` and
//!    `solana-rpc-client` in `crates/connector-settlement-solana/Cargo.toml`,
//!    `solana-program`, `solana-program-test` and `solana-sdk` in
//!    `packages/solana-program/Cargo.toml`. The CLI that deploys and drives the
//!    program is then the same release line the program is built against.
//!    [`the_workspace_pins_the_solana_crates_to_the_rust_gate_line`] holds the
//!    pin and the crates together, so bumping one surfaces the other.
//!
//! To change it: those crate pins would have to move off the 2.1 line **and**
//! v3's validator would have to stop requiring io_uring (or the sandbox start
//! permitting it). One without the other is not enough.
//!
//! ## [`DEPLOY_PATH_CLI`] -- the CLI that builds what gets deployed
//!
//! Installed by `ci.yml`'s `solana-program` and `solana-program-reproducibility`
//! jobs, and by `devbox.json`'s `init_hook`. This is the CLI the deploy path
//! mandates: `docs/solana-deployment.md`'s prerequisites and
//! `tools/solana/deploy.sh`'s header both require Solana CLI >= 3.1.12, and
//! `solana-program-reproducibility` exists to gate that path -- so it has to
//! build with the CLI a human following the runbook will build with.
//!
//! That is not cosmetic. With `--tools-version v1.52` fixed on both sides, the
//! CLI driving the build still changes the artifact. Measured on this source on
//! 2026-08-22, same platform-tools line, same lockfile, same machine:
//!
//! | CLI     | `payment_channel.so` | sha256      |
//! | ------- | -------------------- | ----------- |
//! | 2.1.0   | 109,400 bytes        | `ae2e9148…` |
//! | 3.1.12  | 109,400 bytes        | `5e34f188…` |
//!
//! Each is reproducible under its own CLI -- rebuilding under 2.1.0 returned
//! `ae2e9148…` again -- so `solana-program-reproducibility` is not measuring
//! noise; it is blessing the bytes of whichever CLI it installs. Installing the
//! other one would make it bless bytes nobody deploys.
//!
//! To change it: the runbook's floor would have to move, and whoever moves it
//! has to re-establish provenance against the live devnet program. Note what
//! that record does and does not say.
//! `packages/solana-program/deployments/devnet-public.md`'s reproducible-build
//! table reports a v1.52 build matching the live bytes exactly in size and
//! 99.66% byte-identically -- and its third row is labelled "v2.1.0 CLI default
//! tools", so that whole comparison was made with a **2.1.x** CLI, not with
//! this pin. It is evidence about the platform-tools v1.52 line, not about
//! [`DEPLOY_PATH_CLI`]. Nothing in CI compares a build against those recorded
//! bytes: `solana-program-reproducibility` compares two clean builds to each
//! other. Do not read it as a provenance check against devnet.
//!
//! # The asymmetry that cost a day
//!
//! Which of the two a job installs also decides whether it can bootstrap the
//! SBF toolchain from cold at all, because `cargo build-sbf`'s version check
//! early-returns when the requested platform-tools version equals the CLI's
//! built-in one. [`RUST_GATE_CLI`]'s built-in is v1.43 and
//! [`DEPLOY_PATH_CLI`]'s is v1.52, which is the line this repository pins -- so
//! the v3 jobs take the early return and the v2 jobs take the path that panics
//! on a missing `$HOME/.cache/solana`. `tools/solana/build-sbf.sh`'s header has
//! the full analysis; connector#1110 fixed the panic itself. It is recorded
//! here only because "which CLI does this job have" is the question that
//! explains why half the jobs survived a cold cache and half did not.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// The CLI every job that *runs* the program installs. See the module header
/// before changing it.
const RUST_GATE_CLI: &str = "v2.1.21";

/// The CLI every job that *builds what gets deployed* installs. See the module
/// header before changing it.
const DEPLOY_PATH_CLI: &str = "v3.1.12";

const CI_WORKFLOW: &str = include_str!("../../../.github/workflows/ci.yml");
const LOCAL_TOPOLOGIES_WORKFLOW: &str =
    include_str!("../../../.github/workflows/local-topologies.yml");
const SANDCASTLE_DOCKERFILE: &str = include_str!("../../../.sandcastle/Dockerfile");
const DEVBOX_JSON: &str = include_str!("../../../devbox.json");
const DEPLOY_SCRIPT: &str = include_str!("../../../tools/solana/deploy.sh");
const DEPLOY_RUNBOOK: &str = include_str!("../../../docs/solana-deployment.md");
const BUILD_SBF: &str = include_str!("../../../tools/solana/build-sbf.sh");
const SETTLEMENT_MANIFEST: &str = include_str!("../Cargo.toml");
const PROGRAM_MANIFEST: &str = include_str!("../../../packages/solana-program/Cargo.toml");

/// Installs this guard deliberately does not hold to a pin, each with the
/// reason -- the same shape as `tools/ci/check-tracked-secrets.sh`'s
/// allowlist, and for the same reason: a blanket rule with no escape hatch
/// gets deleted rather than amended.
///
/// `infra/linode/bootstrap.sh` tracks `release.anza.xyz/stable`. It provisions
/// the **self-hosted chain box** -- anvil, `solana-test-validator`, faucet,
/// nginx -- not a connector box: `infra/linode-relay/bootstrap.sh` and
/// `infra/linode-store/bootstrap.sh`, which do provision the boxes serving
/// devnet, install no Solana CLI at all. That chain box was deleted in the
/// public-chain cutover (`44b15bdc`, 2026-07-19, toon-meta#374); its own
/// README and `endpoints.json` are banner-marked historical, and its sole
/// caller -- `.github/workflows/devnet-deploy.yml`, `workflow_dispatch` only
/// and behind the reviewer-gated `devnet` environment -- has not run since
/// 2026-06-23, four weeks before the cutover.
///
/// It does **build**: line 67 runs `make solana-build`, and
/// `docker-compose.yml` bind-mounts the resulting `payment_channel.so` into
/// that box's validator at genesis, so the host CLI decides the program bytes
/// that box runs. What it does not do is gate or ship anything -- no artifact
/// this repository releases passes through it. Pinning it is therefore a
/// separate decision from this one, and a smaller one than deleting the box's
/// provisioning outright. Were it pinned, [`DEPLOY_PATH_CLI`] is what this
/// file's own taxonomy demands: it is the CLI that builds a deployed program.
/// Note also that the install sits behind `if ! command -v solana`, so a pin
/// here only ever binds a blank disk -- it can never change the CLI on a box
/// that already has one.
const UNPINNED_BY_DESIGN: &[&str] = &["infra/linode/bootstrap.sh"];

/// This file's own path, repo-relative. The walk below skips it: the prose
/// above quotes the install URL in order to explain it, which would otherwise
/// make the record look like a consumer of itself.
const SELF: &str = "crates/connector-settlement-solana/tests/solana_cli_pins.rs";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root is two levels above this crate")
}

/// Every `release.anza.xyz/<version>/install` in `raw`, as the `<version>`
/// segment exactly as written. A plain string scan rather than a YAML or JSON
/// parse: the four consumers are two workflows, a Dockerfile and a JSON file,
/// and what matters is the literal each of them hands to `sh`.
fn installed_versions(raw: &str) -> BTreeSet<String> {
    let mut found = BTreeSet::new();
    for tail in raw.split("release.anza.xyz/").skip(1) {
        if let Some(version) = tail.split("/install").next() {
            found.insert(version.to_string());
        }
    }
    found
}

/// Every file under the repository root that installs a Solana CLI, mapped to
/// the versions it installs. Repo-relative paths, heavy directories skipped.
///
/// A walk rather than a fixed list of `include_str!`s, because the failure this
/// guards against includes *a new consumer* -- a workflow or an image added
/// later that quietly picks a third version. A guard keyed only on the files
/// that exist today would pass while the repository disagreed with itself.
fn solana_cli_installs() -> BTreeMap<String, BTreeSet<String>> {
    let root = repo_root();
    let mut installs = BTreeMap::new();
    let mut queue = vec![root.clone()];

    while let Some(dir) = queue.pop() {
        let entries = std::fs::read_dir(&dir).unwrap_or_else(|error| {
            panic!("cannot read {dir:?} while scanning for Solana CLI installs: {error}")
        });
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if !matches!(
                    name.as_str(),
                    "target" | "node_modules" | ".git" | ".devbox" | ".claude"
                ) {
                    queue.push(path);
                }
                continue;
            }
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            if bytes.len() > 512 * 1024 {
                continue;
            }
            let relative = path
                .strip_prefix(&root)
                .expect("walked paths are under the root")
                .to_string_lossy()
                .to_string();
            // This file quotes the install URL while explaining it. It is the
            // record, not a consumer of it.
            if relative == SELF {
                continue;
            }
            let versions = installed_versions(&String::from_utf8_lossy(&bytes));
            if versions.is_empty() {
                continue;
            }
            installs.insert(relative, versions);
        }
    }

    installs
}

/// The lines of `ci.yml` belonging to one top-level job, so a case can assert
/// what *that* job installs rather than what the file mentions somewhere. Jobs
/// are the only two-space-indented keys in this workflow.
fn ci_job(name: &str) -> String {
    let header = format!("\n  {name}:\n");
    let after = CI_WORKFLOW
        .split_once(&header)
        .unwrap_or_else(|| panic!("ci.yml has no job named `{name}`"))
        .1;
    let mut block = String::new();
    for line in after.lines() {
        let is_next_job = line.starts_with("  ")
            && !line.starts_with("   ")
            && !line.trim_start().starts_with('#')
            && line.trim_end().ends_with(':');
        if is_next_job {
            break;
        }
        block.push_str(line);
        block.push('\n');
    }
    block
}

#[test]
fn every_installed_solana_cli_is_one_of_the_two_recorded_pins() {
    let recorded = BTreeSet::from([RUST_GATE_CLI.to_string(), DEPLOY_PATH_CLI.to_string()]);
    let mut drifted = Vec::new();

    for (file, versions) in solana_cli_installs() {
        if UNPINNED_BY_DESIGN.contains(&file.as_str()) {
            continue;
        }
        for version in versions {
            if !recorded.contains(&version) {
                drifted.push(format!("{file} installs {version}"));
            }
        }
    }

    assert!(
        drifted.is_empty(),
        "a Solana CLI version in this repository is not one this file records:\n  {}\n\nThis \
         repository installs exactly two, deliberately: {RUST_GATE_CLI} where the program is RUN \
         and {DEPLOY_PATH_CLI} where the deployed artifact is BUILT. Neither is interchangeable \
         with the other -- read this file's header, and if the new version really is right, \
         change the constant here and say why, so the next reader is not left guessing again.",
        drifted.join("\n  ")
    );
}

#[test]
fn the_repository_installs_the_solana_cli_from_exactly_the_known_places() {
    let expected: BTreeSet<&str> = BTreeSet::from([
        ".github/workflows/ci.yml",
        ".github/workflows/local-topologies.yml",
        ".sandcastle/Dockerfile",
        "devbox.json",
        "infra/linode/bootstrap.sh",
    ]);
    let actual: BTreeSet<String> = solana_cli_installs().into_keys().collect();
    let actual: BTreeSet<&str> = actual.iter().map(String::as_str).collect();

    assert_eq!(
        actual, expected,
        "the set of files installing a Solana CLI changed. A new one is not forbidden -- it just \
         has to be a deliberate choice between the two pins this file records, and named here so \
         the next drift is still visible. A removed one means a consumer this file claims to \
         cover no longer exists."
    );
}

#[test]
fn the_rust_workspace_gate_installs_the_cli_that_runs_the_program() {
    assert_eq!(
        installed_versions(&ci_job("rust-gate")),
        BTreeSet::from([RUST_GATE_CLI.to_string()]),
        "ci.yml's rust-gate job must install {RUST_GATE_CLI}. It spawns \
         solana-test-validator for connector-settlement-solana's integration tier, and the v3 \
         line's validator asserts io_uring support the sandbox does not grant."
    );
}

#[test]
fn the_container_topologies_and_the_agent_image_install_the_cli_that_runs_the_program() {
    assert_eq!(
        installed_versions(LOCAL_TOPOLOGIES_WORKFLOW),
        BTreeSet::from([RUST_GATE_CLI.to_string()]),
        "local-topologies.yml must install {RUST_GATE_CLI}, the same CLI ci.yml's rust-gate \
         installs -- it runs the shipped image against a real validator."
    );
    assert_eq!(
        installed_versions(SANDCASTLE_DOCKERFILE),
        BTreeSet::from([RUST_GATE_CLI.to_string()]),
        ".sandcastle/Dockerfile must install {RUST_GATE_CLI}, the same CLI the gate installs. An \
         agent that passes locally on a different toolchain than the gate has learned nothing."
    );
}

#[test]
fn the_program_jobs_install_the_cli_the_deploy_path_mandates() {
    for job in ["solana-program", "solana-program-reproducibility"] {
        assert_eq!(
            installed_versions(&ci_job(job)),
            BTreeSet::from([DEPLOY_PATH_CLI.to_string()]),
            "ci.yml's {job} job must install {DEPLOY_PATH_CLI}. It builds the artifact the \
             deploy runbook describes, and the CLI changes those bytes even with platform-tools \
             pinned -- see this file's header."
        );
    }
}

#[test]
fn the_deploy_runbook_and_the_deploy_script_name_the_deploy_path_cli() {
    let bare = DEPLOY_PATH_CLI.trim_start_matches('v');
    for (name, raw) in [
        ("docs/solana-deployment.md", DEPLOY_RUNBOOK),
        ("tools/solana/deploy.sh", DEPLOY_SCRIPT),
    ] {
        assert!(
            raw.contains(&format!("Solana CLI >= {bare}")),
            "{name} no longer states `Solana CLI >= {bare}`. That floor is the whole reason \
             ci.yml's program jobs install {DEPLOY_PATH_CLI} rather than {RUST_GATE_CLI}; if the \
             runbook moves, the gate builds bytes nobody deploys."
        );
    }
}

#[test]
fn devbox_installs_and_asserts_the_deploy_path_cli() {
    let bare = DEPLOY_PATH_CLI.trim_start_matches('v');
    assert_eq!(
        installed_versions(DEVBOX_JSON),
        BTreeSet::from([DEPLOY_PATH_CLI.to_string()]),
        "devbox.json's init_hook must install {DEPLOY_PATH_CLI} -- a devbox shell is where the \
         deploy runbook's commands get run by hand."
    );
    let devbox_job = ci_job("devbox-validate");
    assert!(
        devbox_job.contains(&format!("solana-cli {}", bare.replace('.', "\\."))),
        "ci.yml's devbox-validate job no longer asserts `solana-cli {bare}`, so devbox.json could \
         drift from {DEPLOY_PATH_CLI} without failing anything."
    );
    assert!(
        devbox_job.contains(&format!(
            "solana-cli-${{{{ runner.os }}}}-{DEPLOY_PATH_CLI}"
        )),
        "ci.yml's devbox-validate cache key no longer names {DEPLOY_PATH_CLI}, so a version bump \
         would silently restore the previous CLI from cache."
    );
}

#[test]
fn the_workspace_pins_the_solana_crates_to_the_rust_gate_line() {
    let line = RUST_GATE_CLI
        .trim_start_matches('v')
        .rsplit_once('.')
        .expect("the pin is v<major>.<minor>.<patch>")
        .0;
    let pin = format!("\"={line}.0\"");

    for (name, manifest, crates) in [
        (
            "crates/connector-settlement-solana/Cargo.toml",
            SETTLEMENT_MANIFEST,
            &["solana-rpc-client", "solana-sdk"][..],
        ),
        (
            "packages/solana-program/Cargo.toml",
            PROGRAM_MANIFEST,
            &["solana-program", "solana-program-test", "solana-sdk"][..],
        ),
    ] {
        for krate in crates {
            assert!(
                manifest.contains(&format!("{krate} = {pin}")),
                "{name} no longer pins {krate} to {pin}. Half the reason ci.yml, \
                 local-topologies.yml and .sandcastle/Dockerfile install Solana CLI \
                 {RUST_GATE_CLI} is that the CLI driving the program matches the release line the \
                 program is compiled against. Moving the crates off the {line} line means \
                 revisiting that pin -- see this file's header for the other half (io_uring)."
            );
        }
    }
}

#[test]
fn build_sbf_records_which_cli_reaches_the_cold_bootstrap_path() {
    assert!(
        BUILD_SBF.contains(RUST_GATE_CLI) && BUILD_SBF.contains(DEPLOY_PATH_CLI),
        "tools/solana/build-sbf.sh's header no longer names both {RUST_GATE_CLI} and \
         {DEPLOY_PATH_CLI}. Its cold-cache analysis only makes sense against a specific CLI's \
         built-in platform-tools version, and the fact that one of this repository's two CLIs \
         reaches the failing path and the other does not is the single most confusing thing about \
         having two -- connector#1110 took a day partly because nothing said it."
    );
}

//! Issue #572 (narrowed by #719): `contracts/TokenNetwork.json` and
//! `contracts/TokenNetworkRegistry.json` must have a reproducible origin -- a real `forge build`
//! of `packages/contracts` -- and regenerating them against an unchanged `packages/contracts/src`
//! must leave the ABI unchanged. This is the gate that keeps the committed ABI from drifting away
//! from the Solidity it claims to describe: if someone hand-edits the ABI, or if
//! `packages/contracts/src` changes without `contracts/regenerate-token-network-abi.sh` being
//! rerun, this test fails.
//!
//! Only `abi` is compared against a fresh build. `bytecode`/`deployedBytecode` are deliberately
//! excluded from the comparison: solc appends a trailing CBOR-encoded IPFS metadata hash to both
//! (issue #719's reproduction: the two artifacts differ only 99.5% through, immediately after the
//! CBOR marker `a2646970667358221220`), and that hash is derived from source file paths and the
//! exact compiler settings, so it varies by build environment. `ci.yml` installs
//! `foundry-rs/foundry-toolchain@v1` with no version pin and `contracts.yml` uses `nightly`, so a
//! fresh local build's bytecode can differ from CI's even when the Solidity is unchanged --
//! comparing it here would make the test unfixable by a contributor for any real Solidity change
//! (see the superseded #707). Do not add the bytecode comparison back. The committed JSON still
//! carries `bytecode`/`deployedBytecode`, since the crate reads them at runtime; they are simply
//! no longer asserted against a fresh build.
//!
//! Builds real Solidity with a real `forge` (gated by `support::require_forge`, mirroring
//! `support::require_anvil`'s CI-vs-local policy) -- no mocked compiler output.

mod support;

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn contracts_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts")
}

fn bindings_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("contracts")
}

fn assert_abi_matches_committed(contract_name: &str) {
    let forge_output = contracts_dir()
        .join("out")
        .join(format!("{contract_name}.sol"))
        .join(format!("{contract_name}.json"));
    let full: Value = serde_json::from_str(
        &std::fs::read_to_string(&forge_output)
            .unwrap_or_else(|e| panic!("read {}: {e}", forge_output.display())),
    )
    .unwrap_or_else(|e| panic!("parse {}: {e}", forge_output.display()));

    let committed_path = bindings_dir().join(format!("{contract_name}.json"));
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(&committed_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", committed_path.display())),
    )
    .unwrap_or_else(|e| panic!("parse {}: {e}", committed_path.display()));

    assert_eq!(
        full["abi"], committed["abi"],
        "contracts/{contract_name}.json's ABI does not match a fresh `forge build` of \
         packages/contracts/src/{contract_name}.sol -- regenerate it with \
         contracts/regenerate-token-network-abi.sh and commit the result"
    );
}

#[test]
fn token_network_and_registry_abis_match_a_fresh_forge_build() {
    if !support::require_forge() {
        return;
    }

    let status = Command::new("forge")
        .arg("build")
        .current_dir(contracts_dir())
        .status()
        .expect("run forge build");
    assert!(
        status.success(),
        "forge build failed in {:?}",
        contracts_dir()
    );

    assert_abi_matches_committed("TokenNetwork");
    assert_abi_matches_committed("TokenNetworkRegistry");
}

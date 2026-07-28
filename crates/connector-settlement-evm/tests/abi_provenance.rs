//! Issue #572: `contracts/TokenNetwork.json` and `contracts/TokenNetworkRegistry.json` must have
//! a reproducible origin -- a real `forge build` of `packages/contracts` -- and regenerating
//! them against an unchanged `packages/contracts/src` must be a no-op. This is the gate that
//! keeps the committed ABI from drifting away from the Solidity it claims to describe: if
//! someone hand-edits either JSON file, or if `packages/contracts/src` changes without
//! `contracts/regenerate-token-network-abi.sh` being rerun, this test fails.
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

/// The same trim `regenerate-token-network-abi.sh` applies: a full forge artifact carries
/// `methodIdentifiers`/`rawMetadata`/`metadata`/`id` alongside `abi`/`bytecode`/
/// `deployedBytecode`; only the latter three are the committed convention this crate already
/// uses for `MockERC20.json`.
fn trim_artifact(full: &Value) -> Value {
    serde_json::json!({
        "abi": full["abi"],
        "bytecode": {
            "object": full["bytecode"]["object"],
            "sourceMap": full["bytecode"]["sourceMap"],
            "linkReferences": full["bytecode"]["linkReferences"],
        },
        "deployedBytecode": {
            "object": full["deployedBytecode"]["object"],
            "sourceMap": full["deployedBytecode"]["sourceMap"],
            "linkReferences": full["deployedBytecode"]["linkReferences"],
            "immutableReferences": full["deployedBytecode"]["immutableReferences"],
        },
    })
}

fn assert_artifact_matches_committed(contract_name: &str) {
    let forge_output = contracts_dir()
        .join("out")
        .join(format!("{contract_name}.sol"))
        .join(format!("{contract_name}.json"));
    let full: Value = serde_json::from_str(
        &std::fs::read_to_string(&forge_output)
            .unwrap_or_else(|e| panic!("read {}: {e}", forge_output.display())),
    )
    .unwrap_or_else(|e| panic!("parse {}: {e}", forge_output.display()));
    let freshly_built = trim_artifact(&full);

    let committed_path = bindings_dir().join(format!("{contract_name}.json"));
    let committed: Value = serde_json::from_str(
        &std::fs::read_to_string(&committed_path)
            .unwrap_or_else(|e| panic!("read {}: {e}", committed_path.display())),
    )
    .unwrap_or_else(|e| panic!("parse {}: {e}", committed_path.display()));

    assert_eq!(
        freshly_built, committed,
        "contracts/{contract_name}.json does not match a fresh `forge build` of \
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

    assert_artifact_matches_committed("TokenNetwork");
    assert_artifact_matches_committed("TokenNetworkRegistry");
}

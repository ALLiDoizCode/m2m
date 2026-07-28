#!/usr/bin/env bash
# Regenerates TokenNetwork.json and TokenNetworkRegistry.json in this directory from a real
# `forge build` of packages/contracts/src -- the only origin those two artifacts are allowed to
# have (issue #572). Run this after any change to
# packages/contracts/src/{TokenNetwork,TokenNetworkRegistry}.sol and commit the result.
#
# `crates/connector-settlement-evm/tests/abi_provenance.rs` asserts this script is a no-op
# against an unchanged packages/contracts/src -- that is the "an ABI cannot drift from the
# Solidity it claims to describe" gate the issue asks for, so do not hand-edit the two JSON
# files this script writes.
#
# MockERC20.json is untouched by this script -- it comes from the standalone .sol file in this
# same directory, not from packages/contracts.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
contracts_dir="$script_dir/../../../packages/contracts"

(cd "$contracts_dir" && forge build)

extract() {
  local artifact="$1"
  local out_file="$2"
  jq '{
    abi: .abi,
    bytecode: {
      object: .bytecode.object,
      sourceMap: .bytecode.sourceMap,
      linkReferences: .bytecode.linkReferences
    },
    deployedBytecode: {
      object: .deployedBytecode.object,
      sourceMap: .deployedBytecode.sourceMap,
      linkReferences: .deployedBytecode.linkReferences,
      immutableReferences: .deployedBytecode.immutableReferences
    }
  }' "$artifact" > "$out_file"
}

extract "$contracts_dir/out/TokenNetwork.sol/TokenNetwork.json" "$script_dir/TokenNetwork.json"
extract "$contracts_dir/out/TokenNetworkRegistry.sol/TokenNetworkRegistry.json" "$script_dir/TokenNetworkRegistry.json"

echo "Regenerated TokenNetwork.json and TokenNetworkRegistry.json from $contracts_dir/src"

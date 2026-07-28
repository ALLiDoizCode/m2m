//! Solana settlement program (issue #428, ADR 0001, ADR 0002): a
//! purpose-built, native-SOL payment channel program backing
//! `connector-settlement-solana`'s `SettlementBackend`, and this port's
//! second real implementation after `connector-settlement-evm` (#459).
//!
//! Deliberately a fresh program rather than a reuse of
//! `packages/solana-program` (the legacy `payment-channel` program the
//! existing TypeScript connector's `PaymentChannelProvider` stack drives):
//! that program is SPL-token-denominated, PDA-per-participant-pair, and
//! carries claim-nonce/challenge-duration fields this port has no concept
//! of. `connector-settlement-evm` set the precedent of writing a small,
//! purpose-built on-chain artifact for this port rather than adapting the
//! legacy one, and this crate follows it.

// solana-program 2.1.0's own `entrypoint!` macro expands to `cfg`s
// (`feature = "custom-heap"`, `target_os = "solana"`) this crate never
// declares, which trips rustc's `unexpected_cfgs` lint under `-D warnings`
// regardless of what this crate's own code does -- a known upstream gap in
// `solana-program-entrypoint`, not something fixable from the call site
// beyond this allow.
#![allow(unexpected_cfgs)]

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

use solana_program::account_info::AccountInfo;
use solana_program::entrypoint::ProgramResult;
use solana_program::pubkey::Pubkey;

/// This program's fixed address on any validator it is deployed into --
/// generated once (`deploy/connector-settlement-solana-program-keypair.json`,
/// checked in like `deploy/connector_settlement_solana_program.so` itself)
/// so every test run deploys to the same address rather than a fresh random
/// one, the same role `DEPLOYER_PRIVATE_KEY` plays for the EVM harness.
pub const PROGRAM_ID: &str = "9RMCe65sCb466R4vNgdGzQXDUbaepgCigyWgjvsctN6E";

/// Absolute path to the checked-in, pre-built `.so` for this program --
/// checked in the same way `connector-settlement-evm` checks in
/// `MockERC20.json`'s compiled bytecode, so a test spawning a real
/// `solana-test-validator` does not need `cargo build-sbf` (and the Solana
/// BPF SDK it requires) on `PATH` to deploy it.
pub fn so_path() -> std::path::PathBuf {
    std::path::PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/deploy/connector_settlement_solana_program.so"
    ))
}

// `entrypoint!` pulls in `solana-program`'s BPF-only global allocator and
// panic handler -- correct for the on-chain `cdylib` `cargo build-sbf`
// produces, but unsafe to link into a normal host process. `no-entrypoint`
// is the standard Solana idiom (spl-token and friends use it the same way)
// for the case this crate is *also* pulled in as an ordinary library, which
// `connector-settlement-solana` does purely for the account layout and wire
// format in `state`/`instruction` -- it depends on this crate with
// `default-features = false, features = ["no-entrypoint"]`.
#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, instruction_data)
}

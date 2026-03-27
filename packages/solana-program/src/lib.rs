// Payment Channel Program — Solana On-Chain Program
//
// Story 33.1: Channel Lifecycle (initialize, deposit, close, settle, force_close_expired)
// Story 33.2: Claim Verification (claim_from_channel with Ed25519 precompile)
//
// Framework: Native solana-program (no Anchor) — binary size target ~30-60KB

pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    processor::process_instruction(program_id, accounts, instruction_data)
}

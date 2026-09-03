//! Client-side wire encoding for the deployed `payment-channel` program
//! (`packages/solana-program`, program id `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`
//! on `solana:devnet`), mirrored here rather than imported: that crate
//! builds for the SBF target only (`crate-type = ["cdylib", "lib"]`, no
//! client feature) and exports no client SDK. Every discriminator, PDA
//! seed, instruction layout and account layout below is copied from
//! `packages/solana-program/src/{instruction,state,processor}.rs` and must
//! be kept in lock-step with it (issue #567) -- this is the client half of
//! the same wire that crate's on-chain processor parses.

use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;

/// Instruction discriminators -- `packages/solana-program/src/instruction.rs:7-12`.
pub const INITIALIZE_CHANNEL: [u8; 8] = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const DEPOSIT: [u8; 8] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const CLOSE_CHANNEL: [u8; 8] = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const SETTLE_CHANNEL: [u8; 8] = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const CLAIM_FROM_CHANNEL: [u8; 8] = [0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

/// `packages/solana-program/src/state.rs:34` -- 8-byte discriminator + 170
/// bytes of fields and padding.
pub const ACCOUNT_SIZE: usize = 178;
/// ASCII "pchannel" -- `packages/solana-program/src/state.rs:11`.
pub const DISCRIMINATOR: [u8; 8] = *b"pchannel";

const PARTICIPANT_A_OFFSET: usize = 8;
const PARTICIPANT_B_OFFSET: usize = 40;
const TOKEN_MINT_OFFSET: usize = 72;
const DEPOSIT_A_OFFSET: usize = 104;
const DEPOSIT_B_OFFSET: usize = 112;
const TRANSFERRED_AMOUNT_A_OFFSET: usize = 120;
const TRANSFERRED_AMOUNT_B_OFFSET: usize = 128;
const NONCE_A_OFFSET: usize = 136;
const NONCE_B_OFFSET: usize = 144;
const CHALLENGE_DURATION_OFFSET: usize = 152;
const STATE_OFFSET: usize = 160;
const CLOSE_TIMESTAMP_OFFSET: usize = 161;

/// Sort two participants lexicographically -- `derive_channel_pda` seeds on
/// `(min, max)` so the same pair of parties always derives the same PDA
/// regardless of open()'s argument order (`processor.rs:52-58`).
pub fn sort_participants(a: &Pubkey, b: &Pubkey) -> (Pubkey, Pubkey) {
    if a < b {
        (*a, *b)
    } else {
        (*b, *a)
    }
}

/// `["channel", min(a,b), max(a,b), token_mint]` -- `processor.rs:61-72`.
pub fn channel_pda(
    participant_a: &Pubkey,
    participant_b: &Pubkey,
    token_mint: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let (min, max) = sort_participants(participant_a, participant_b);
    Pubkey::find_program_address(
        &[b"channel", min.as_ref(), max.as_ref(), token_mint.as_ref()],
        program_id,
    )
}

/// `["vault", channel_pda]` -- `processor.rs:75-77`.
pub fn vault_pda(channel_pda: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"vault", channel_pda.as_ref()], program_id)
}

pub fn pack_initialize_channel(challenge_duration: u64) -> Vec<u8> {
    let mut data = INITIALIZE_CHANNEL.to_vec();
    data.extend_from_slice(&challenge_duration.to_le_bytes());
    data
}

pub fn pack_deposit(amount: u64) -> Vec<u8> {
    let mut data = DEPOSIT.to_vec();
    data.extend_from_slice(&amount.to_le_bytes());
    data
}

pub fn pack_close_channel() -> Vec<u8> {
    CLOSE_CHANNEL.to_vec()
}

pub fn pack_settle_channel() -> Vec<u8> {
    SETTLE_CHANNEL.to_vec()
}

pub fn pack_claim_from_channel(nonce: u64, transferred_amount: u64) -> Vec<u8> {
    let mut data = CLAIM_FROM_CHANNEL.to_vec();
    data.extend_from_slice(&nonce.to_le_bytes());
    data.extend_from_slice(&transferred_amount.to_le_bytes());
    data
}

/// The domain tag every balance-proof message begins with (ADR 0053, issue
/// #1082). Defined here rather than imported because this crate does not
/// depend on `connector-signer`; it MUST stay byte-identical to
/// `connector_signer::SOLANA_BALANCE_PROOF_DOMAIN_TAG` and to the program's
/// own `BALANCE_PROOF_DOMAIN_TAG`. The committed
/// `peer_carriage.claim_solana` vector is what keeps all three in step.
const BALANCE_PROOF_DOMAIN_TAG: &[u8; 16] = b"TOON-BALPROOF-V2";

/// The 96-byte balance-proof message the deployed program's Ed25519
/// precompile check verifies (ADR 0053, issue #1082):
/// `domain tag || program_id || channel_pda || nonce (LE) ||
/// transferred_amount (LE)`.
///
/// **This must stay byte-identical to
/// [`connector_signer::solana_balance_proof_message`] and to the program's
/// own `expected_message`.** Three copies of one format is two too many, and
/// they are kept in step by `connector-vectors`' committed
/// `peer_carriage.claim_solana` entry, which every one of them is checked
/// against.
pub fn balance_proof_message(
    program_id: &Pubkey,
    channel_pda: &Pubkey,
    nonce: u64,
    transferred_amount: u64,
) -> [u8; 96] {
    let mut message = [0u8; 96];
    message[0..16].copy_from_slice(BALANCE_PROOF_DOMAIN_TAG);
    message[16..48].copy_from_slice(program_id.as_ref());
    message[48..80].copy_from_slice(channel_pda.as_ref());
    message[80..88].copy_from_slice(&nonce.to_le_bytes());
    message[88..96].copy_from_slice(&transferred_amount.to_le_bytes());
    message
}

/// Build the Ed25519-precompile instruction the deployed program requires
/// at index 0 of a `ClaimFromChannel` transaction
/// (`processor.rs:830-837`), from a signature this backend was already
/// handed rather than one it produces itself.
///
/// `solana_sdk::ed25519_instruction::new_ed25519_instruction` cannot be
/// used here: it takes an `ed25519_dalek::Keypair` and signs the message
/// itself, but this backend only ever receives a [`connector_settlement::Claim`]'s
/// already-produced `signature` bytes -- it never holds the counterparty's
/// signing key. This mirrors that function's own instruction-data layout
/// byte-for-byte (num_signatures=1, one padding byte, then the
/// fixed-size `Ed25519SignatureOffsets`, all three `*_instruction_index`
/// fields set to `u16::MAX` so every offset is read from this same
/// instruction), which is exactly what `verify_ed25519_precompile` parses.
pub fn ed25519_verify_instruction(
    pubkey: &Pubkey,
    signature: &[u8; 64],
    message: &[u8],
) -> Instruction {
    const PUBKEY_SERIALIZED_SIZE: usize = 32;
    const SIGNATURE_SERIALIZED_SIZE: usize = 64;
    const SIGNATURE_OFFSETS_SERIALIZED_SIZE: usize = 14;
    const SIGNATURE_OFFSETS_START: usize = 2;
    const DATA_START: usize = SIGNATURE_OFFSETS_SERIALIZED_SIZE + SIGNATURE_OFFSETS_START;

    let public_key_offset = DATA_START;
    let signature_offset = public_key_offset + PUBKEY_SERIALIZED_SIZE;
    let message_data_offset = signature_offset + SIGNATURE_SERIALIZED_SIZE;

    let mut data = Vec::with_capacity(message_data_offset + message.len());
    data.push(1u8); // num_signatures
    data.push(0u8); // padding byte, unread by the verifier

    data.extend_from_slice(&(signature_offset as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // signature_instruction_index
    data.extend_from_slice(&(public_key_offset as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // public_key_instruction_index
    data.extend_from_slice(&(message_data_offset as u16).to_le_bytes());
    data.extend_from_slice(&(message.len() as u16).to_le_bytes());
    data.extend_from_slice(&u16::MAX.to_le_bytes()); // message_instruction_index

    debug_assert_eq!(data.len(), public_key_offset);
    data.extend_from_slice(pubkey.as_ref());
    debug_assert_eq!(data.len(), signature_offset);
    data.extend_from_slice(signature);
    debug_assert_eq!(data.len(), message_data_offset);
    data.extend_from_slice(message);

    Instruction {
        program_id: solana_sdk::ed25519_program::id(),
        accounts: vec![],
        data,
    }
}

/// The lifecycle states `packages/solana-program/src/state.rs:56-60`
/// stores in its one `state` byte.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelStatus {
    Opened,
    Closed,
    Settled,
}

/// A parsed `ChannelState` account -- the client-side twin of
/// `packages/solana-program::state::ChannelState`.
#[derive(Debug, Clone)]
pub struct ChannelAccount {
    pub participant_a: Pubkey,
    pub participant_b: Pubkey,
    pub token_mint: Pubkey,
    pub deposit_a: u64,
    pub deposit_b: u64,
    pub transferred_amount_a: u64,
    pub transferred_amount_b: u64,
    pub nonce_a: u64,
    pub nonce_b: u64,
    pub challenge_duration: u64,
    pub status: ChannelStatus,
    pub close_timestamp: i64,
}

impl ChannelAccount {
    /// `None` for anything that is not a well-formed `ChannelState`
    /// account -- too short, wrong discriminator, or an unrecognized
    /// status byte. A settled channel's account is closed by the program
    /// itself (`processor.rs:635-647`: lamports zeroed, data zeroed), so a
    /// settled channel this parser is asked to read is indistinguishable
    /// from an account that never existed -- callers that need to tell
    /// those apart keep their own record of channels they themselves
    /// settled (see [`crate::SolanaSettlementBackend`]).
    pub fn parse(data: &[u8]) -> Option<Self> {
        if data.len() < ACCOUNT_SIZE {
            return None;
        }
        if data[0..8] != DISCRIMINATOR {
            return None;
        }
        let status = match data[STATE_OFFSET] {
            0 => ChannelStatus::Opened,
            1 => ChannelStatus::Closed,
            2 => ChannelStatus::Settled,
            _ => return None,
        };
        Some(Self {
            participant_a: read_pubkey(data, PARTICIPANT_A_OFFSET),
            participant_b: read_pubkey(data, PARTICIPANT_B_OFFSET),
            token_mint: read_pubkey(data, TOKEN_MINT_OFFSET),
            deposit_a: read_u64(data, DEPOSIT_A_OFFSET),
            deposit_b: read_u64(data, DEPOSIT_B_OFFSET),
            transferred_amount_a: read_u64(data, TRANSFERRED_AMOUNT_A_OFFSET),
            transferred_amount_b: read_u64(data, TRANSFERRED_AMOUNT_B_OFFSET),
            nonce_a: read_u64(data, NONCE_A_OFFSET),
            nonce_b: read_u64(data, NONCE_B_OFFSET),
            challenge_duration: read_u64(data, CHALLENGE_DURATION_OFFSET),
            status,
            close_timestamp: read_i64(data, CLOSE_TIMESTAMP_OFFSET),
        })
    }
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

fn read_i64(data: &[u8], offset: usize) -> i64 {
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&data[offset..offset + 8]);
    i64::from_le_bytes(bytes)
}

fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&data[offset..offset + 32]);
    Pubkey::new_from_array(bytes)
}

/// The channel-lifecycle instructions this crate builds, plus the accounts
/// each one takes -- `AccountMeta` order matches
/// `packages/solana-program/src/processor.rs`'s own per-instruction doc
/// comments exactly, since the on-chain program reads accounts
/// positionally.
pub struct Accounts;

impl Accounts {
    pub fn initialize_channel(
        payer: &Pubkey,
        participant_a: &Pubkey,
        participant_b: &Pubkey,
        token_mint: &Pubkey,
        channel_pda: &Pubkey,
        vault_pda: &Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*participant_a, false),
            AccountMeta::new_readonly(*participant_b, false),
            AccountMeta::new_readonly(*token_mint, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new(*vault_pda, false),
            AccountMeta::new_readonly(solana_sdk::system_program::id(), false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::rent::id(), false),
        ]
    }

    pub fn deposit(
        depositor: &Pubkey,
        depositor_token_account: &Pubkey,
        vault_token_account: &Pubkey,
        channel_pda: &Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(*depositor, true),
            AccountMeta::new(*depositor_token_account, false),
            AccountMeta::new(*vault_token_account, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(spl_token::id(), false),
        ]
    }

    pub fn close_channel(closer: &Pubkey, channel_pda: &Pubkey) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(*closer, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ]
    }

    pub fn settle_channel(
        caller: &Pubkey,
        channel_pda: &Pubkey,
        vault_token_account: &Pubkey,
        participant_a_token: &Pubkey,
        participant_b_token: &Pubkey,
        rent_recipient: &Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new_readonly(*caller, true),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new(*vault_token_account, false),
            AccountMeta::new(*participant_a_token, false),
            AccountMeta::new(*participant_b_token, false),
            AccountMeta::new(*rent_recipient, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(solana_sdk::sysvar::clock::id(), false),
        ]
    }

    pub fn claim_from_channel(
        fee_payer: &Pubkey,
        claimer: &Pubkey,
        channel_pda: &Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            // `fee_payer` is always this backend's own transaction fee
            // payer (`SolanaSettlementBackend::submit`'s `Some(&self.payer
            // .pubkey())`), which the message compiler forces to be a
            // writable signer regardless of this flag -- `new_readonly`
            // here just matches `processor.rs`'s own account-list comment
            // (`[signer]`, no `writable` tag) rather than claiming a
            // privilege this instruction doesn't itself need.
            AccountMeta::new_readonly(*fee_payer, true),
            AccountMeta::new_readonly(*claimer, false),
            AccountMeta::new(*channel_pda, false),
            AccountMeta::new_readonly(solana_sdk::sysvar::instructions::id(), false),
        ]
    }
}

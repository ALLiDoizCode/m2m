// Payment Channel Program — Channel State Account Layout
//
// Fixed-size account: 8-byte discriminator + 170 bytes data = 178 bytes total.
//
// Field ordering groups all same-sized fields together for alignment and
// to match the test file's expected offsets.

use solana_program::pubkey::Pubkey;

/// 8-byte discriminator for the ChannelState account: ASCII "pchannel".
pub const DISCRIMINATOR: [u8; 8] = [0x70, 0x63, 0x68, 0x61, 0x6E, 0x6E, 0x65, 0x6C];

/// Total size of the ChannelState account data (including discriminator).
///
/// Layout (178 bytes total):
///   [0..8]     discriminator (8 bytes)
///   [8..40]    participant_a Pubkey (32 bytes)
///   [40..72]   participant_b Pubkey (32 bytes)
///   [72..104]  token_mint Pubkey (32 bytes)
///   [104..112] deposit_a u64 (8 bytes)
///   [112..120] deposit_b u64 (8 bytes)
///   [120..128] transferred_amount_a u64 (8 bytes)
///   [128..136] transferred_amount_b u64 (8 bytes)
///   [136..144] nonce_a u64 (8 bytes)
///   [144..152] nonce_b u64 (8 bytes)
///   [152..160] challenge_duration u64 (8 bytes)
///   [160]      state u8 (1 byte)
///   [161..169] close_timestamp i64 (8 bytes)
///   [169]      bump u8 (1 byte)
///   Fields: 3*32 + 7*8 + 1 + 8 + 1 = 96 + 56 + 10 = 162 bytes
///   With 8-byte discriminator: 8 + 162 = 170 bytes used
///   Padding: 8 bytes reserved [170..178] for future use
///   Account size: 178 bytes
pub const ACCOUNT_SIZE: usize = 178;

// Offsets from the start of account data (including 8-byte discriminator prefix).
pub const PARTICIPANT_A_OFFSET: usize = 8;
pub const PARTICIPANT_B_OFFSET: usize = 40;
pub const TOKEN_MINT_OFFSET: usize = 72;
pub const DEPOSIT_A_OFFSET: usize = 104;
pub const DEPOSIT_B_OFFSET: usize = 112;
pub const TRANSFERRED_AMOUNT_A_OFFSET: usize = 120;
pub const TRANSFERRED_AMOUNT_B_OFFSET: usize = 128;
pub const NONCE_A_OFFSET: usize = 136;
pub const NONCE_B_OFFSET: usize = 144;
pub const CHALLENGE_DURATION_OFFSET: usize = 152;
pub const STATE_OFFSET: usize = 160;
pub const CLOSE_TIMESTAMP_OFFSET: usize = 161;
pub const BUMP_OFFSET: usize = 169;
// Padding: [170..178] = 8 bytes reserved for Story 33.2 extensions (e.g., vault_bump)
// Total account size: 178 bytes (170 used + 8 reserved)

/// Channel lifecycle states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ChannelStatus {
    Opened = 0,
    Closed = 1,
    Settled = 2,
}

impl ChannelStatus {
    pub fn from_u8(val: u8) -> Option<Self> {
        match val {
            0 => Some(Self::Opened),
            1 => Some(Self::Closed),
            2 => Some(Self::Settled),
            _ => None,
        }
    }
}

/// On-chain channel state stored in a PDA account.
#[derive(Debug, Clone)]
pub struct ChannelState {
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
    pub state: u8,
    pub close_timestamp: i64,
    pub bump: u8,
}

impl ChannelState {
    /// Deserialize from raw account data bytes.
    pub fn deserialize(data: &[u8]) -> Result<Self, solana_program::program_error::ProgramError> {
        if data.len() < ACCOUNT_SIZE {
            return Err(solana_program::program_error::ProgramError::InvalidAccountData);
        }
        if data[0..8] != DISCRIMINATOR {
            return Err(solana_program::program_error::ProgramError::InvalidAccountData);
        }

        fn read_u64(data: &[u8], offset: usize) -> Result<u64, solana_program::program_error::ProgramError> {
            let bytes: [u8; 8] = data[offset..offset + 8]
                .try_into()
                .map_err(|_| solana_program::program_error::ProgramError::InvalidAccountData)?;
            Ok(u64::from_le_bytes(bytes))
        }
        fn read_i64(data: &[u8], offset: usize) -> Result<i64, solana_program::program_error::ProgramError> {
            let bytes: [u8; 8] = data[offset..offset + 8]
                .try_into()
                .map_err(|_| solana_program::program_error::ProgramError::InvalidAccountData)?;
            Ok(i64::from_le_bytes(bytes))
        }
        fn read_pubkey(data: &[u8], offset: usize) -> Result<Pubkey, solana_program::program_error::ProgramError> {
            Pubkey::try_from(&data[offset..offset + 32])
                .map_err(|_| solana_program::program_error::ProgramError::InvalidAccountData)
        }

        Ok(Self {
            participant_a: read_pubkey(data, PARTICIPANT_A_OFFSET)?,
            participant_b: read_pubkey(data, PARTICIPANT_B_OFFSET)?,
            token_mint: read_pubkey(data, TOKEN_MINT_OFFSET)?,
            deposit_a: read_u64(data, DEPOSIT_A_OFFSET)?,
            deposit_b: read_u64(data, DEPOSIT_B_OFFSET)?,
            transferred_amount_a: read_u64(data, TRANSFERRED_AMOUNT_A_OFFSET)?,
            transferred_amount_b: read_u64(data, TRANSFERRED_AMOUNT_B_OFFSET)?,
            nonce_a: read_u64(data, NONCE_A_OFFSET)?,
            nonce_b: read_u64(data, NONCE_B_OFFSET)?,
            challenge_duration: read_u64(data, CHALLENGE_DURATION_OFFSET)?,
            state: data[STATE_OFFSET],
            close_timestamp: read_i64(data, CLOSE_TIMESTAMP_OFFSET)?,
            bump: data[BUMP_OFFSET],
        })
    }

    /// Serialize into raw account data bytes.
    pub fn serialize(&self, data: &mut [u8]) -> Result<(), solana_program::program_error::ProgramError> {
        if data.len() < ACCOUNT_SIZE {
            return Err(solana_program::program_error::ProgramError::AccountDataTooSmall);
        }

        data[0..8].copy_from_slice(&DISCRIMINATOR);
        data[PARTICIPANT_A_OFFSET..PARTICIPANT_A_OFFSET + 32]
            .copy_from_slice(self.participant_a.as_ref());
        data[PARTICIPANT_B_OFFSET..PARTICIPANT_B_OFFSET + 32]
            .copy_from_slice(self.participant_b.as_ref());
        data[TOKEN_MINT_OFFSET..TOKEN_MINT_OFFSET + 32]
            .copy_from_slice(self.token_mint.as_ref());
        data[DEPOSIT_A_OFFSET..DEPOSIT_A_OFFSET + 8]
            .copy_from_slice(&self.deposit_a.to_le_bytes());
        data[DEPOSIT_B_OFFSET..DEPOSIT_B_OFFSET + 8]
            .copy_from_slice(&self.deposit_b.to_le_bytes());
        data[TRANSFERRED_AMOUNT_A_OFFSET..TRANSFERRED_AMOUNT_A_OFFSET + 8]
            .copy_from_slice(&self.transferred_amount_a.to_le_bytes());
        data[TRANSFERRED_AMOUNT_B_OFFSET..TRANSFERRED_AMOUNT_B_OFFSET + 8]
            .copy_from_slice(&self.transferred_amount_b.to_le_bytes());
        data[NONCE_A_OFFSET..NONCE_A_OFFSET + 8]
            .copy_from_slice(&self.nonce_a.to_le_bytes());
        data[NONCE_B_OFFSET..NONCE_B_OFFSET + 8]
            .copy_from_slice(&self.nonce_b.to_le_bytes());
        data[CHALLENGE_DURATION_OFFSET..CHALLENGE_DURATION_OFFSET + 8]
            .copy_from_slice(&self.challenge_duration.to_le_bytes());
        data[STATE_OFFSET] = self.state;
        data[CLOSE_TIMESTAMP_OFFSET..CLOSE_TIMESTAMP_OFFSET + 8]
            .copy_from_slice(&self.close_timestamp.to_le_bytes());
        data[BUMP_OFFSET] = self.bump;

        // Zero out reserved padding bytes
        for i in (BUMP_OFFSET + 1)..ACCOUNT_SIZE {
            data[i] = 0;
        }

        Ok(())
    }
}

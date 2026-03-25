// Payment Channel Program — Instruction Discriminators and Parsing
//
// Simple u8 discriminators (matching the test file's placeholder values).

/// Instruction discriminators — first 8 bytes of instruction data.
/// Using simple sequential byte patterns matching the test helpers.
pub const INITIALIZE_CHANNEL: [u8; 8] = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const DEPOSIT: [u8; 8] = [0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const CLOSE_CHANNEL: [u8; 8] = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const SETTLE_CHANNEL: [u8; 8] = [0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const FORCE_CLOSE_EXPIRED: [u8; 8] = [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
pub const CLAIM_FROM_CHANNEL: [u8; 8] = [0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

/// Parsed instruction variants.
pub enum PaymentChannelInstruction {
    /// Initialize a new payment channel.
    /// Data: challenge_duration (u64 LE, 8 bytes)
    InitializeChannel { challenge_duration: u64 },

    /// Deposit SPL tokens into the channel vault.
    /// Data: amount (u64 LE, 8 bytes)
    Deposit { amount: u64 },

    /// Close the channel (start challenge period).
    CloseChannel,

    /// Settle the channel after challenge period.
    SettleChannel,

    /// Force close an expired channel.
    ForceCloseExpired,

    /// Claim from channel with balance proof (Story 33.2 — stub).
    ClaimFromChannel,
}

impl PaymentChannelInstruction {
    /// Parse instruction data into a typed variant.
    pub fn unpack(data: &[u8]) -> Result<Self, solana_program::program_error::ProgramError> {
        if data.len() < 8 {
            return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
        }

        let (disc, rest) = data.split_at(8);
        let disc_arr: [u8; 8] = disc
            .try_into()
            .map_err(|_| solana_program::program_error::ProgramError::InvalidInstructionData)?;

        match disc_arr {
            INITIALIZE_CHANNEL => {
                if rest.len() < 8 {
                    return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
                }
                let bytes: [u8; 8] = rest[0..8]
                    .try_into()
                    .map_err(|_| solana_program::program_error::ProgramError::InvalidInstructionData)?;
                let challenge_duration = u64::from_le_bytes(bytes);
                Ok(Self::InitializeChannel { challenge_duration })
            }
            DEPOSIT => {
                if rest.len() < 8 {
                    return Err(solana_program::program_error::ProgramError::InvalidInstructionData);
                }
                let bytes: [u8; 8] = rest[0..8]
                    .try_into()
                    .map_err(|_| solana_program::program_error::ProgramError::InvalidInstructionData)?;
                let amount = u64::from_le_bytes(bytes);
                Ok(Self::Deposit { amount })
            }
            CLOSE_CHANNEL => Ok(Self::CloseChannel),
            SETTLE_CHANNEL => Ok(Self::SettleChannel),
            FORCE_CLOSE_EXPIRED => Ok(Self::ForceCloseExpired),
            CLAIM_FROM_CHANNEL => Ok(Self::ClaimFromChannel),
            _ => Err(solana_program::program_error::ProgramError::InvalidInstructionData),
        }
    }
}

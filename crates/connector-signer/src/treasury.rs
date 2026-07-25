use sha3::{Digest, Keccak256};

use crate::address::{derive_evm_address, Address};
use crate::error::TreasuryError;
use crate::signer::{Signature, Signer};

/// A funding transfer signed by the treasury's key, ready to submit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTransfer {
    pub from: Address,
    pub to: Address,
    pub amount: u128,
    pub nonce: u64,
    pub signature: Signature,
}

/// Opaque handle to a submitted transaction.
pub type TxHash = [u8; 32];

/// Confirmation that a funding transfer was submitted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FundingReceipt {
    pub tx_hash: TxHash,
    pub to: Address,
    pub amount: u128,
}

/// The port a treasury spends and reads balance through. A settlement
/// backend crate (EVM, Solana) implements this against the real chain; a
/// fake implementation upholding the same contract is what this crate's
/// own tests use, so treasury logic is tested without any chain in the
/// loop.
pub trait ChainClient: Send + Sync {
    fn balance_of(&self, address: &Address) -> Result<u128, TreasuryError>;
    fn submit_transfer(&self, transfer: SignedTransfer) -> Result<TxHash, TreasuryError>;
}

/// The account that collateralises payment channels and pays gas (ADR
/// 0012). It holds no key material of its own — every operation is signed
/// through a [`Signer`] — and it holds no policy: it reports what the
/// chain reports and submits what it is asked to submit. There is
/// deliberately no balance cache, no spending limit and no anomaly check
/// here; those are the fraud/anomaly rule engine the issue excludes.
pub struct Treasury<'s> {
    signer: &'s dyn Signer,
    chain: Box<dyn ChainClient>,
}

impl<'s> Treasury<'s> {
    pub fn new(signer: &'s dyn Signer, chain: Box<dyn ChainClient>) -> Self {
        Treasury { signer, chain }
    }

    /// The treasury's own address, derived from the signer's current
    /// public key. Changes when the signer rotates.
    pub fn address(&self) -> Result<Address, TreasuryError> {
        let public_key = self.signer.public_key()?;
        Ok(derive_evm_address(&public_key))
    }

    /// The treasury's current on-chain balance.
    pub fn balance(&self) -> Result<u128, TreasuryError> {
        let address = self.address()?;
        self.chain.balance_of(&address)
    }

    /// Sign and submit a funding transfer to `to` for `amount`, at `nonce`.
    /// The caller supplies the nonce: sequencing transactions is a chain
    /// client concern (matching the settlement backend the treasury
    /// submits through), not something this port arbitrates.
    pub fn fund(
        &self,
        to: Address,
        amount: u128,
        nonce: u64,
    ) -> Result<FundingReceipt, TreasuryError> {
        let from = self.address()?;
        let have = self.chain.balance_of(&from)?;
        if have < amount {
            return Err(TreasuryError::InsufficientBalance { have, need: amount });
        }

        let digest = transfer_digest(&from, &to, amount, nonce);
        let signature = self.signer.sign(&digest)?;
        let transfer = SignedTransfer {
            from,
            to,
            amount,
            nonce,
            signature,
        };
        let tx_hash = self.chain.submit_transfer(transfer)?;
        Ok(FundingReceipt {
            tx_hash,
            to,
            amount,
        })
    }
}

fn transfer_digest(from: &Address, to: &Address, amount: u128, nonce: u64) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    hasher.update(from);
    hasher.update(to);
    hasher.update(amount.to_be_bytes());
    hasher.update(nonce.to_be_bytes());
    let hash = hasher.finalize();
    let mut digest = [0u8; 32];
    digest.copy_from_slice(&hash);
    digest
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalSigner;
    use std::sync::Mutex;

    struct FakeChain {
        balances: Mutex<std::collections::HashMap<Address, u128>>,
        submitted: Mutex<Vec<SignedTransfer>>,
    }

    impl FakeChain {
        fn funded(address: Address, amount: u128) -> Self {
            let mut balances = std::collections::HashMap::new();
            balances.insert(address, amount);
            FakeChain {
                balances: Mutex::new(balances),
                submitted: Mutex::new(Vec::new()),
            }
        }
    }

    impl ChainClient for FakeChain {
        fn balance_of(&self, address: &Address) -> Result<u128, TreasuryError> {
            Ok(*self.balances.lock().unwrap().get(address).unwrap_or(&0))
        }

        fn submit_transfer(&self, transfer: SignedTransfer) -> Result<TxHash, TreasuryError> {
            let mut balances = self.balances.lock().unwrap();
            let from_balance = balances.entry(transfer.from).or_insert(0);
            *from_balance -= transfer.amount;
            *balances.entry(transfer.to).or_insert(0) += transfer.amount;

            let tx_hash = transfer_digest(
                &transfer.from,
                &transfer.to,
                transfer.amount,
                transfer.nonce,
            );
            self.submitted.lock().unwrap().push(transfer);
            Ok(tx_hash)
        }
    }

    #[test]
    fn reports_balance_from_the_chain_client() {
        let signer = LocalSigner::generate("treasury-key");
        let address = derive_evm_address(&signer.public_key().unwrap());
        let chain = FakeChain::funded(address, 1_000);
        let treasury = Treasury::new(&signer, Box::new(chain));

        assert_eq!(treasury.balance().unwrap(), 1_000);
    }

    #[test]
    fn funds_a_channel_by_submitting_a_signed_transfer() {
        let signer = LocalSigner::generate("treasury-key");
        let treasury_address = derive_evm_address(&signer.public_key().unwrap());
        let chain = FakeChain::funded(treasury_address, 1_000);
        let treasury = Treasury::new(&signer, Box::new(chain));

        let channel_address = [0x42u8; 20];
        let receipt = treasury.fund(channel_address, 300, 0).unwrap();

        assert_eq!(receipt.to, channel_address);
        assert_eq!(receipt.amount, 300);
        assert_eq!(treasury.balance().unwrap(), 700);
    }

    #[test]
    fn refuses_to_fund_past_its_balance() {
        let signer = LocalSigner::generate("treasury-key");
        let treasury_address = derive_evm_address(&signer.public_key().unwrap());
        let chain = FakeChain::funded(treasury_address, 100);
        let treasury = Treasury::new(&signer, Box::new(chain));

        let err = treasury.fund([0x42u8; 20], 300, 0).unwrap_err();
        assert_eq!(
            err,
            TreasuryError::InsufficientBalance {
                have: 100,
                need: 300
            }
        );
    }

    #[test]
    fn funding_address_tracks_signer_rotation() {
        let signer = LocalSigner::generate("treasury-key");
        let first_address = derive_evm_address(&signer.public_key().unwrap());
        let chain = FakeChain::funded(first_address, 1_000);
        let treasury = Treasury::new(&signer, Box::new(chain));

        signer.rotate().unwrap();
        let second_address = derive_evm_address(&signer.public_key().unwrap());

        assert_eq!(treasury.address().unwrap(), second_address);
        assert_ne!(second_address, first_address);
        // The old address's balance is unreachable through the rotated
        // treasury handle -- rotation moves which key signs, matching a
        // production KMS/local rotation exactly.
        assert_eq!(treasury.balance().unwrap(), 0);
    }
}

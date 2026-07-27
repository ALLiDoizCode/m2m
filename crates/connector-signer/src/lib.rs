//! Signing and treasury (ADR 0001, ADR 0012).
//!
//! This crate is the connector's sole owner of key handling: the [`Signer`]
//! port with its [`LocalSigner`] and [`KmsSigner`] implementations, and the
//! [`Treasury`] that spends through a `Signer`. No other crate in this
//! workspace holds key material or performs a signing operation directly —
//! anything that needs to sign a claim or a settlement transaction takes a
//! `&dyn Signer`. It is also where a claim's signature is checked, whether
//! that is this connector's own internal, chain-agnostic digest ([`verify`],
//! peer wire) or a client edge claim's chain-native wallet signature
//! ([`verify_evm_balance_proof`]/[`verify_solana_balance_proof`], issue
//! #506) -- neither needs key material of its own, only the public key or
//! address a channel's counterparty is already known by.
//!
//! Deliberately absent, per ADR 0012: mnemonic recovery, seed management,
//! human wallet authentication, a wallet database, and any fraud or
//! anomaly rule engine. Those invariants are enforced elsewhere, by
//! watermarks and signature verification on the packet plane.

mod address;
mod claim_signature;
mod crypto;
mod error;
mod kms;
mod local;
mod signer;
mod treasury;

pub use address::{derive_evm_address, to_hex, Address};
pub use claim_signature::{
    evm_balance_proof_digest, solana_balance_proof_message, verify_evm_balance_proof,
    verify_solana_balance_proof, EvmBalanceProof,
};
pub use error::{SignerError, TreasuryError};
pub use kms::{InMemoryKmsBackend, KmsBackend, KmsSigner};
pub use local::LocalSigner;
pub use signer::{verify, PublicKeyBytes, Signature, Signer};
pub use treasury::{ChainClient, FundingReceipt, SignedTransfer, Treasury, TxHash};

#[cfg(test)]
mod contract;

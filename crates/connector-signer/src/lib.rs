//! Signing and treasury (ADR 0001, ADR 0012).
//!
//! This crate is the connector's sole owner of key handling: the [`Signer`]
//! port with its [`LocalSigner`] and [`KmsSigner`] implementations, and the
//! [`Treasury`] that spends through a `Signer`. No other crate in this
//! workspace holds key material or performs a signing operation directly —
//! anything that needs to sign a claim or a settlement transaction takes a
//! `&dyn Signer`. It is also where a claim's signature is checked -- both a
//! peer-wire claim (issue #575, ADR 0024) and a client edge claim's
//! chain-native wallet signature (issue #506) go through
//! [`verify_evm_balance_proof`]/[`verify_solana_balance_proof`], neither
//! needing key material of its own, only the public key or address a
//! channel's counterparty is already known by. [`verify`] is unrelated to
//! either: it is the `Signer` contract suite's own "a signature recovers to
//! its signer's own public key" check (`src/contract.rs`).
//!
//! Deliberately absent, per ADR 0012: mnemonic recovery, seed management,
//! human wallet authentication, a wallet database, and any fraud or
//! anomaly rule engine. Those invariants are enforced elsewhere, by
//! watermarks and signature verification on the packet plane.

mod address;
mod claim_signature;
mod claim_state_challenge;
mod crypto;
mod ed25519_signer;
mod error;
pub mod giftwrap;
mod kms;
mod local;
pub mod nip59;
pub mod nostr;
mod signer;
mod treasury;

pub use address::{derive_evm_address, to_hex, Address};
pub use claim_signature::{
    evm_balance_proof_digest, solana_balance_proof_message, verify_evm_balance_proof,
    verify_solana_balance_proof, EvmBalanceProof,
};
pub use claim_state_challenge::{
    evm_claim_state_challenge_digest, solana_claim_state_challenge_message,
    verify_evm_claim_state_challenge, verify_solana_claim_state_challenge, EvmClaimStateChallenge,
};
pub use ed25519_signer::{Ed25519Signer, LocalEd25519Signer};
pub use error::{SignerError, TreasuryError};
pub use giftwrap::GiftWrapError;
pub use kms::{InMemoryKmsBackend, KmsBackend, KmsSigner};
pub use local::LocalSigner;
pub use nip59::{unwrap_claim, wrap_claim, Nip59Error, WrappedClaim};
pub use nostr::{sign_ilp_peer_info, NostrEvent, ILP_PEER_INFO_KIND};
pub use signer::{verify, PublicKeyBytes, Signature, Signer};
pub use treasury::{ChainClient, FundingReceipt, SignedTransfer, Treasury, TxHash};

#[cfg(test)]
mod contract;

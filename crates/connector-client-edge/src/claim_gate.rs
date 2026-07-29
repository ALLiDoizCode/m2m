//! Claim ingest gate for the client edge (`docs/protocol/client-edge-spec.md`
//! §1.3, issues #504, #522, #506/#544, #558): turns the
//! `ILP-Payment-Channel-Claim` (`-Wrapped`) header's already-decoded JSON
//! into a structurally valid, fresh, value-covering, cryptographically
//! verified [`ClientClaim`], or a documented refusal -- structure, then
//! freshness/watermark, then value binding against the matched route's
//! price, then (last, and only once all three have passed) the claim's
//! signature against its channel's counterparty: a replay or an
//! underpayment is refused before this ingress ever spends a signature
//! check on it.
//!
//! Reuses `connector_domain`'s pure nonce/watermark/value rules
//! ([`connector_domain::validate_claim`], [`connector_domain::validate_price`],
//! [`connector_domain::advance_watermark`]) exactly as the peer wire's own
//! `connector_runtime::ClaimBook` does for the first two -- this is a
//! second *state* around the same rules, not a second set of rules. The
//! state is deliberately separate from `ClaimBook`: a client-edge claim's
//! channel is never a peer-wire channel, and (unlike `ClaimBook::accept_inbound`)
//! a watermark advance here is gated behind a signature verification, on the
//! `ClientClaimGate`'s own claim-native scheme (EIP-712 for EVM, Ed25519 for
//! Solana -- `connector_signer::claim_signature`), not `ClaimBook`'s
//! chain-agnostic internal digest.
//!
//! **What "verified" means here** (issue #558): a claim's signature must
//! recover to the counterparty this connector has recorded for the channel
//! the claim names -- client-edge-spec.md §1.3 step 4 in full -- looked up
//! in the [`ClientChannelRegistry`] this gate is built with. A claim's own
//! `signerAddress`/`signerPublicKey` is not consulted, and neither is the
//! EIP-712 domain it declares for itself: a claim gets no say in what it is
//! checked against, or a forger would simply sign their own bytes with
//! their own key and declare themself the payer. A claim naming a channel
//! this connector has no record of is refused as
//! [`ClaimIngestRejection::UnknownChannel`], distinguishably from a bad
//! signature and from an underpayment -- there is nothing to verify it
//! against, and "unverifiable" is never "accepted". No configuration, flag
//! or build profile falls back to the claim's self-declared signer.
//!
//! **Where that record comes from** (issue #556): the registry answers
//! from what the config file declared, or -- for a channel nothing
//! declared -- from the chain, via a [`crate::ClientChannelSource`]. That
//! resolution is the one part of this gate that can do I/O, which is why
//! [`ClientClaimGate::ingest`] is `async`. A resolution that *fails* is
//! [`ClaimIngestRejection::ChannelLookupFailed`]: the claim is refused,
//! loudly and distinguishably from a channel that genuinely does not
//! exist, and under no circumstance falls back to trusting it.

use std::collections::HashMap;
use std::sync::RwLock;

use connector_domain::client_claim::{
    parse_client_claim, ClientClaim, ClientClaimError, EvmClientClaim, SolanaClientClaim,
};
use connector_domain::{advance_watermark, validate_claim, validate_price, ClaimError, Watermark};
use connector_signer::{verify_evm_balance_proof, verify_solana_balance_proof, EvmBalanceProof};

use crate::channels::{decode_base58_bytes, decode_hex_bytes, ClientChannelRegistry};

/// Why the gate refused a claim. [`ClaimIngestRejection::Mina`] and
/// [`ClaimIngestRejection::Malformed`] are kept distinct on purpose: the
/// acceptance criteria requires a Mina claim's refusal to be distinguishable
/// from a merely malformed one; [`ClaimIngestRejection::Underpayment`] is
/// kept distinct from both for the same reason (issue #522);
/// [`ClaimIngestRejection::SignatureInvalid`] is kept distinct from all of
/// them for the same reason again (issue #506/#544) -- a claim that fails
/// cryptographic verification is neither stale, malformed nor underpaying;
/// and [`ClaimIngestRejection::UnknownChannel`] is kept distinct from
/// *those* for the same reason once more (issue #558) -- a claim naming a
/// channel this connector has no record of has not failed verification, it
/// could not be verified at all, and the two must not be reported as the
/// same thing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimIngestRejection {
    Malformed(String),
    Mina,
    NonceNotAdvancing,
    AmountNotAdvancing,
    Underpayment {
        advanced: u64,
        price: u64,
    },
    /// The claim names a channel this connector has no counterparty
    /// recorded for (issue #558), so there is no key its signature could
    /// be checked against. Matches the peer wire's own
    /// `connector_runtime::ClaimRejectReason::UnknownChannel`.
    UnknownChannel,
    /// This connector could not find out who the claim's channel belongs
    /// to (issue #556) -- its [`crate::ClientChannelSource`] failed, e.g.
    /// an unreachable RPC endpoint. Distinct from
    /// [`ClaimIngestRejection::UnknownChannel`] on purpose: that one is a
    /// fact about the channel, this one is a failure of this connector's,
    /// and reporting an outage as "no such channel" would tell a
    /// legitimate payer to go away for a reason that is not true. Both
    /// refuse the claim -- an unverifiable claim is never accepted.
    ChannelLookupFailed(String),
    SignatureInvalid,
    WrapUnsupported,
    WrapFailed(String),
}

impl ClaimIngestRejection {
    /// A human-readable reason, carried in the REJECT packet's `message`
    /// (RFC-0027) so a client can tell what went wrong without access to
    /// this connector's logs.
    pub fn message(&self) -> String {
        match self {
            ClaimIngestRejection::Malformed(reason) => {
                format!("claim rejected: structurally invalid: {reason}")
            }
            ClaimIngestRejection::Mina => "claim rejected: mina claims are refused -- ADR 0002 \
                 drops Mina support from the Rust connector; stay on the TypeScript fleet for \
                 Mina channels"
                .to_string(),
            ClaimIngestRejection::NonceNotAdvancing => {
                "claim rejected: nonce does not advance this channel's watermark (replay)"
                    .to_string()
            }
            ClaimIngestRejection::AmountNotAdvancing => "claim rejected: cumulative amount goes \
                 backwards relative to this channel's watermark"
                .to_string(),
            ClaimIngestRejection::Underpayment { advanced, price } => format!(
                "claim rejected: advances value by {advanced}, less than this route's price of {price}"
            ),
            ClaimIngestRejection::UnknownChannel => "claim rejected: names a channel this \
                 connector has no record of, so there is no counterparty to verify its \
                 signature against"
                .to_string(),
            ClaimIngestRejection::ChannelLookupFailed(reason) => format!(
                "claim rejected: this connector could not look up the channel's counterparty, \
                 so the claim cannot be verified -- retry once the lookup succeeds: {reason}"
            ),
            ClaimIngestRejection::SignatureInvalid => "claim rejected: signature does not \
                 verify against this channel's recorded counterparty"
                .to_string(),
            ClaimIngestRejection::WrapUnsupported => "claim rejected: this connector is not \
                 configured to unwrap a privacy-wrapped claim"
                .to_string(),
            ClaimIngestRejection::WrapFailed(reason) => {
                format!("claim rejected: failed to unwrap claim: {reason}")
            }
        }
    }
}

/// Per-channel watermark state for claims presented at the client edge,
/// over the channels this connector has a record of.
pub struct ClientClaimGate {
    /// Whose signature this gate accepts, per channel (issue #558). Fixed
    /// at construction rather than mutable behind the lock: a channel's
    /// counterparty is configuration, not something an arriving claim may
    /// teach this connector.
    channels: ClientChannelRegistry,
    watermarks: RwLock<HashMap<String, Watermark>>,
}

impl ClientClaimGate {
    /// A gate accepting claims on `channels` and no others. An empty
    /// registry refuses every claim as
    /// [`ClaimIngestRejection::UnknownChannel`] -- see
    /// [`crate::ClientChannelRegistry`]'s own doc for why that is the
    /// intended failure mode rather than an oversight.
    pub fn new(channels: ClientChannelRegistry) -> ClientClaimGate {
        ClientClaimGate {
            channels,
            watermarks: RwLock::new(HashMap::new()),
        }
    }

    /// Parse and fully validate a plaintext claim JSON body (already
    /// base64-decoded and, if it arrived wrapped, already unwrapped by the
    /// caller): structure, then freshness/watermark, then value binding
    /// against `price` -- the matched route's price (issue #522), `0` for a
    /// route that charges nothing or that isn't priced at all -- then,
    /// last, the claim's signature against the counterparty recorded for
    /// the channel it names (issue #506/#544, #558).
    /// Advances this claim's channel watermark only when the claim is
    /// fully accepted -- a rejected claim, whether stale, underpaying or
    /// unverifiable, leaves the watermark exactly as it was, so a
    /// corrected resubmission is still judged against the same baseline.
    ///
    /// `async` because resolving a channel nothing declared is a read
    /// against a chain (issue #556). The watermark lock is deliberately
    /// **not** held across that await -- a `std::sync::RwLock` guard held
    /// across a suspension point would stall every other packet in flight
    /// -- so the freshness and value rules are evaluated twice: once up
    /// front, which is what keeps #544's ordering promise that a replay or
    /// an underpayment never pays for a signature check, and once more
    /// under the write lock immediately before the watermark advances,
    /// which is what makes two concurrent claims on one channel still
    /// serialise. The second evaluation is the authoritative one.
    pub async fn ingest(
        &self,
        claim_json: &str,
        price: u64,
    ) -> Result<ClientClaim, ClaimIngestRejection> {
        let claim = parse_client_claim(claim_json).map_err(|error| match error {
            ClientClaimError::Mina => ClaimIngestRejection::Mina,
            other => ClaimIngestRejection::Malformed(other.to_string()),
        })?;

        let key = claim.channel_key();
        {
            let watermarks = self
                .watermarks
                .read()
                .expect("client claim watermarks lock poisoned");
            check_freshness_and_value(watermarks.get(&key).copied(), &claim, price)?;
        }

        verify_claim_signature(&self.channels, &claim).await?;

        let mut watermarks = self
            .watermarks
            .write()
            .expect("client claim watermarks lock poisoned");
        // Re-read rather than reusing the value from above: a concurrent
        // claim on this same channel may have advanced the watermark while
        // the channel lookup was in flight, and accepting both would be
        // exactly the replay this gate exists to refuse.
        check_freshness_and_value(watermarks.get(&key).copied(), &claim, price)?;
        watermarks.insert(
            key,
            advance_watermark(claim.nonce(), claim.transferred_amount()),
        );
        Ok(claim)
    }
}

/// client-edge-spec.md §1.3 steps 2 and 3 against `current`: the claim's
/// nonce and cumulative amount must advance this channel's watermark, and
/// the advance must cover `price`. Pure, and cheap enough to run twice --
/// see [`ClientClaimGate::ingest`] for why it is.
fn check_freshness_and_value(
    current: Option<Watermark>,
    claim: &ClientClaim,
    price: u64,
) -> Result<(), ClaimIngestRejection> {
    if let Err(error) = validate_claim(current, claim.nonce(), claim.transferred_amount()) {
        return Err(match error {
            ClaimError::NonceNotAdvancing { .. } => ClaimIngestRejection::NonceNotAdvancing,
            ClaimError::AmountNotAdvancing { .. } => ClaimIngestRejection::AmountNotAdvancing,
            ClaimError::Underpayment { .. } => {
                unreachable!("validate_claim never returns Underpayment")
            }
        });
    }
    if let Err(error) = validate_price(current, claim.transferred_amount(), price) {
        return Err(match error {
            ClaimError::Underpayment { advanced, price } => {
                ClaimIngestRejection::Underpayment { advanced, price }
            }
            other => unreachable!("validate_price only ever returns Underpayment: {other:?}"),
        });
    }
    Ok(())
}

/// Verify a claim's signature against the counterparty `channels` records
/// for the channel it names -- the gate's last stage, run only once
/// structure, freshness and value have all passed (issue #506/#544, #558).
/// The channel lookup belongs to this stage rather than ahead of it
/// precisely because it is the *signature's* missing half: a replay or an
/// underpayment is still refused for what it is, before this connector
/// spends any cryptographic work, exactly as #544 ordered it.
async fn verify_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &ClientClaim,
) -> Result<(), ClaimIngestRejection> {
    match claim {
        ClientClaim::Evm(claim) => verify_evm_claim_signature(channels, claim).await,
        ClientClaim::Solana(claim) => verify_solana_claim_signature(channels, claim),
    }
}

async fn verify_evm_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &EvmClientClaim,
) -> Result<(), ClaimIngestRejection> {
    // An id that is not a 32-byte `channelId` cannot be a channel this
    // connector recorded, and cannot be one any chain could resolve either
    // -- so it is unknown rather than merely unverifiable, and is settled
    // here without spending a lookup on it.
    let Some(channel_id) = decode_hex_bytes::<32>(&claim.channel_id) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };
    let channel = match channels.evm(&channel_id).await {
        Ok(Some(channel)) => channel,
        Ok(None) => return Err(ClaimIngestRejection::UnknownChannel),
        // Loud, per issue #556: an operator has to be able to tell "my
        // chain endpoint is down, so no *new* channel can be recognised"
        // apart from "someone is claiming on channels that do not exist".
        // The claim is refused either way.
        Err(failure) => {
            tracing::warn!(
                channel_id = %claim.channel_id,
                error = %failure,
                "refusing a client claim: could not resolve its channel's counterparty"
            );
            return Err(ClaimIngestRejection::ChannelLookupFailed(failure.0));
        }
    };

    // `lockedAmount`/`locksRoot` are read from the claim because they are
    // material the counterparty signed over (ADR 0004 hashes both, as
    // zeros), not because the claim is trusted about them: a value the
    // signer did not sign simply produces a digest their signature does
    // not recover under. The signer and the EIP-712 domain are the two the
    // claim gets no say in, and both come from `channel` below.
    let Some(locks_root) = decode_hex_bytes::<32>(&claim.locks_root) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };
    let Ok(locked_amount) = claim.locked_amount.parse::<u128>() else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };
    let Some(signature) = decode_hex_bytes::<65>(&claim.signature) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };

    let proof = EvmBalanceProof {
        channel_id,
        nonce: claim.nonce,
        transferred_amount: u128::from(claim.transferred_amount),
        locked_amount,
        locks_root,
        chain_id: channel.chain_id,
        token_network_address: channel.token_network_address,
    };
    if verify_evm_balance_proof(&proof, &signature, &channel.counterparty) {
        Ok(())
    } else {
        Err(ClaimIngestRejection::SignatureInvalid)
    }
}

fn verify_solana_claim_signature(
    channels: &ClientChannelRegistry,
    claim: &SolanaClientClaim,
) -> Result<(), ClaimIngestRejection> {
    let Some(channel_account) = decode_base58_bytes::<32>(&claim.channel_account) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };
    // Declared records only -- see `ClientChannelRegistry::solana`: there
    // is no Solana client-edge channel source, so a Solana claim is
    // payable exactly when configuration named its channel.
    let Some(counterparty) = channels.solana(&channel_account) else {
        return Err(ClaimIngestRejection::UnknownChannel);
    };

    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    let Ok(signature) = BASE64.decode(&claim.signature) else {
        return Err(ClaimIngestRejection::SignatureInvalid);
    };

    if verify_solana_balance_proof(
        &channel_account,
        claim.nonce,
        claim.transferred_amount,
        &signature,
        &counterparty,
    ) {
        Ok(())
    } else {
        Err(ClaimIngestRejection::SignatureInvalid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::test_source::FakeChannelSource;
    use crate::channels::EvmChannel;
    use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, Address};
    use libsecp256k1::{Message, PublicKey, SecretKey};
    use std::sync::Arc;

    const EVM_CHAIN_ID: u64 = 8453;
    const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];
    const SOLANA_CHANNEL_ACCOUNT: [u8; 32] = [3u8; 32];

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The channels these tests claim against, each recorded with the
    /// fixed test keypair below as its counterparty (issue #558) -- a claim
    /// on any other channel, or signed by any other key, is refused.
    fn test_channels() -> ClientChannelRegistry {
        let (_secret, address) = evm_signer();
        let channel = EvmChannel {
            counterparty: address,
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let mut channels = ClientChannelRegistry::new();
        channels
            .record_evm(&channel_id(), channel)
            .expect("a 32-byte hex channel id");
        channels
            .record_evm(&second_channel_id(), channel)
            .expect("a 32-byte hex channel id");
        channels
            .record_solana(
                &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
                &base58_encode(&solana_signer().public.to_bytes()),
            )
            .expect("a 32-byte base58 channel account");
        channels
    }

    /// A gate with a record of [`test_channels`] and nothing else.
    fn gate() -> ClientClaimGate {
        ClientClaimGate::new(test_channels())
    }

    /// A fixed, deterministic EVM keypair -- deterministic on purpose, since
    /// these tests assert on *whether* a signature verifies, not on which
    /// specific key produced it.
    fn evm_signer() -> (SecretKey, Address) {
        let secret = SecretKey::parse(&[9u8; 32]).unwrap();
        let public = PublicKey::from_secret_key(&secret);
        (secret, derive_evm_address(&public.serialize()))
    }

    /// Sign `digest` exactly the way a real EVM wallet would (a 65-byte
    /// `r || s || v` signature, `v` in the conventional `{27, 28}` range).
    fn sign_evm(secret: &SecretKey, digest: &[u8; 32]) -> Vec<u8> {
        let message = Message::parse(digest);
        let (signature, recovery_id) = libsecp256k1::sign(&message, secret);
        let mut bytes = signature.serialize().to_vec();
        let recovery_byte: u8 = recovery_id.into();
        bytes.push(recovery_byte + 27);
        bytes
    }

    /// An EVM claim JSON carrying whatever `signature`/`signer_address` hex
    /// strings are given verbatim -- the low-level builder every EVM test
    /// helper below goes through, so a test can substitute a wrong,
    /// corrupted or absent value without hand-writing the whole claim.
    fn evm_claim_json_with(
        channel_id: &str,
        nonce: u64,
        transferred_amount: u64,
        signature_hex: &str,
        signer_address_hex: &str,
        chain_fields: &str,
    ) -> String {
        format!(
            r#"{{
                "version": "1.0",
                "blockchain": "evm",
                "messageId": "msg-{nonce}",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-bob",
                "channelId": "{channel_id}",
                "nonce": {nonce},
                "transferredAmount": "{transferred_amount}",
                "lockedAmount": "0",
                "locksRoot": "0x{zeros}",
                "signature": "{signature_hex}",
                "signerAddress": "{signer_address_hex}"
                {chain_fields}
            }}"#,
            zeros = "0".repeat(64),
        )
    }

    /// An EVM claim JSON with a genuine EIP-712 signature produced by
    /// `secret` and declaring `declared_signer` as its own `signerAddress`
    /// -- the two are separable on purpose (issue #558): a forger signs
    /// perfectly well with a key of their own and declares whatever they
    /// like, so a test needs to be able to build exactly that.
    fn evm_claim_json_signed_by(
        secret: &SecretKey,
        declared_signer: &Address,
        channel_id: &str,
        nonce: u64,
        transferred_amount: u64,
    ) -> String {
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(channel_id).expect("test channel_id is valid hex"),
            nonce,
            transferred_amount: u128::from(transferred_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(secret, &evm_balance_proof_digest(&proof));
        evm_claim_json_with(
            channel_id,
            nonce,
            transferred_amount,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(declared_signer),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        )
    }

    /// An EVM claim JSON with a genuine EIP-712 signature over its own
    /// fields, produced by [`evm_signer`] -- so every test using it exercises
    /// the real verification path (issue #506/#544), not a bypass.
    fn evm_claim_json(channel_id: &str, nonce: u64, transferred_amount: u64) -> String {
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(channel_id).expect("test channel_id is valid hex"),
            nonce,
            transferred_amount: u128::from(transferred_amount),
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));
        evm_claim_json_with(
            channel_id,
            nonce,
            transferred_amount,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        )
    }

    fn channel_id() -> String {
        format!("0x{}", "ab".repeat(32))
    }

    /// A second recorded channel, for the tests that need two.
    fn second_channel_id() -> String {
        format!("0x{}", "cd".repeat(32))
    }

    /// A channel this connector has no record of -- well-formed as an id,
    /// simply never recorded.
    fn unrecorded_channel_id() -> String {
        format!("0x{}", "ef".repeat(32))
    }

    #[tokio::test]
    async fn a_fresh_claim_is_accepted() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_replayed_nonce_is_rejected_without_touching_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .await
            .expect("first claim accepted");

        let replay = gate.ingest(&evm_claim_json(&channel, 5, 999), 0).await;
        assert_eq!(replay, Err(ClaimIngestRejection::NonceNotAdvancing));

        // The watermark still holds at nonce 5 -- a genuinely advancing
        // claim after the rejected replay is judged against it, not against
        // whatever the rejected replay tried to claim.
        let next = gate.ingest(&evm_claim_json(&channel, 6, 500), 0).await;
        assert!(next.is_ok());
    }

    #[tokio::test]
    async fn an_amount_going_backwards_is_rejected() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 500), 0)
            .await
            .expect("first claim accepted");

        let result = gate.ingest(&evm_claim_json(&channel, 2, 100), 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::AmountNotAdvancing));
    }

    #[tokio::test]
    async fn the_watermark_never_advances_on_a_rejected_claim() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .await
            .expect("first claim accepted");
        gate.ingest(&evm_claim_json(&channel, 5, 999), 0)
            .await
            .unwrap_err(); // replay, rejected
        gate.ingest(&evm_claim_json(&channel, 6, 100), 0)
            .await
            .unwrap_err(); // amount regresses vs. watermark 500

        // Watermark is still exactly (5, 500): a claim of nonce 6 / amount
        // 500 (equal, not less) still advances cleanly.
        assert!(gate
            .ingest(&evm_claim_json(&channel, 6, 500), 0)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn different_channels_have_independent_watermarks() {
        let gate = gate();
        gate.ingest(&evm_claim_json(&channel_id(), 5, 500), 0)
            .await
            .expect("first channel");

        let result = gate
            .ingest(&evm_claim_json(&second_channel_id(), 1, 10), 0)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_mina_claim_is_rejected_distinguishably_from_malformed() {
        let gate = gate();
        let json = r#"{
            "version": "1.0",
            "blockchain": "mina",
            "messageId": "claim-3",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-dave",
            "zkAppAddress": "irrelevant",
            "tokenId": "1",
            "balanceCommitment": "abc",
            "nonce": 1,
            "proof": "AAAA",
            "salt": "salt"
        }"#;

        assert_eq!(gate.ingest(json, 0).await, Err(ClaimIngestRejection::Mina));
    }

    #[tokio::test]
    async fn a_structurally_invalid_claim_is_rejected_as_malformed() {
        let gate = gate();
        let result = gate
            .ingest(r#"{"version": "1.0", "blockchain": "evm"}"#, 0)
            .await;
        assert!(matches!(result, Err(ClaimIngestRejection::Malformed(_))));
    }

    #[tokio::test]
    async fn a_first_claim_advancing_by_at_least_the_price_is_accepted() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 100)
            .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_first_claim_advancing_by_less_than_the_price_is_underpayment() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&channel_id(), 1, 99), 100)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 99,
                price: 100
            })
        );
    }

    #[tokio::test]
    async fn an_underpaying_claim_does_not_advance_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 99), 100)
            .await
            .unwrap_err();

        // A corrected resubmission is judged against the same (untouched)
        // baseline -- nonce 1 would otherwise fail as a replay if the
        // rejected claim above had advanced anything.
        let result = gate.ingest(&evm_claim_json(&channel, 1, 100), 100).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_later_claim_only_needs_to_cover_the_price_since_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 100), 100)
            .await
            .expect("first claim covers the price");

        // Advances by only 50 past the watermark of 100 -- underpayment
        // against a price of 100, even though the claim's own cumulative
        // transferredAmount (150) is larger than the price in isolation.
        let result = gate.ingest(&evm_claim_json(&channel, 2, 150), 100).await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 50,
                price: 100
            })
        );

        // Advancing by exactly the price is accepted.
        assert!(gate
            .ingest(&evm_claim_json(&channel, 2, 200), 100)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_zero_price_route_charges_nothing() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 0), 0).await;
        assert!(result.is_ok());
    }

    // -- Signature verification (issue #506/#544) --

    #[tokio::test]
    async fn a_genuine_evm_signature_is_accepted() {
        let gate = gate();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await;
        assert!(result.is_ok());
    }

    /// The forger of issue #558: a well-formed claim, genuinely signed,
    /// self-consistent -- and signed by a key that is not the channel's
    /// counterparty. Before #558 this was *accepted*, because the claim was
    /// checked against the signer it declared for itself.
    #[tokio::test]
    async fn an_evm_claim_signed_by_a_key_that_is_not_the_channels_counterparty_is_rejected() {
        let gate = gate();

        // An attacker's own freshly generated keypair, declared as this
        // claim's signer. The signature genuinely recovers to it; it is
        // simply not a party to the channel being claimed against.
        let forger_secret = SecretKey::parse(&[0x5a; 32]).unwrap();
        let forger_address =
            derive_evm_address(&PublicKey::from_secret_key(&forger_secret).serialize());
        let (_genuine_secret, counterparty) = evm_signer();
        assert_ne!(
            forger_address, counterparty,
            "the forger must not accidentally be the counterparty"
        );

        let claim =
            evm_claim_json_signed_by(&forger_secret, &forger_address, &channel_id(), 1, 100);

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A forged claim is refused *and* leaves nothing behind: the channel's
    /// real counterparty is judged against the same baseline afterwards.
    #[tokio::test]
    async fn a_forged_claim_advances_no_watermark() {
        let gate = gate();
        let forger_secret = SecretKey::parse(&[0x5a; 32]).unwrap();
        let forger_address =
            derive_evm_address(&PublicKey::from_secret_key(&forger_secret).serialize());
        gate.ingest(
            &evm_claim_json_signed_by(&forger_secret, &forger_address, &channel_id(), 9, 900),
            0,
        )
        .await
        .unwrap_err();

        // The counterparty's own first claim, at a far lower nonce and
        // amount than the forgery named, is still a fresh first claim.
        assert!(gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 0)
            .await
            .is_ok());
    }

    /// A claim's `signerAddress` is not consulted at all -- the registry
    /// decides. A claim declaring the wrong address, but genuinely signed
    /// by the channel's actual counterparty, is accepted: the field is
    /// unverified decoration, and this connector does not act on it either
    /// way.
    #[tokio::test]
    async fn an_evm_claims_declared_signer_field_carries_no_authority() {
        let gate = gate();
        let (secret, _address) = evm_signer();
        let claim = evm_claim_json_signed_by(
            &secret,
            &[0xde; 20], // a declared signer that is nobody
            &channel_id(),
            1,
            100,
        );

        assert!(gate.ingest(&claim, 0).await.is_ok());
    }

    /// A claim naming a channel this connector has no record of is refused
    /// -- distinguishably from a bad signature and from an underpayment
    /// (issue #558's AC2).
    #[tokio::test]
    async fn a_claim_on_an_unrecorded_channel_is_refused_as_unknown_channel() {
        let gate = gate();
        let claim = evm_claim_json(&unrecorded_channel_id(), 1, 100);

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::UnknownChannel));
        assert_ne!(result, Err(ClaimIngestRejection::SignatureInvalid));
        assert!(result.unwrap_err().message().contains("no record of"));
    }

    /// An empty registry is not an open door: a gate with a record of no
    /// channel at all refuses even a perfectly signed claim, rather than
    /// falling back to the claim's own declared signer (issue #558's AC8).
    #[tokio::test]
    async fn a_gate_with_no_recorded_channels_accepts_nothing() {
        let gate = ClientClaimGate::new(ClientChannelRegistry::new());
        assert_eq!(
            gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0).await,
            Err(ClaimIngestRejection::UnknownChannel)
        );
    }

    /// Issue #556/#502: a channel **nothing declared**, resolved from the
    /// chain, is accepted -- the unaffiliated buyer's path. On a tree
    /// without this change there is no source to consult and this exact
    /// claim is refused `UnknownChannel`, so an operator has to edit
    /// `[[client_channels]]` and restart before anyone new can pay.
    ///
    /// The claim is signed by [`evm_signer`] and the *source* -- standing
    /// in for `TokenNetwork.channels(id)` -- is what names that address as
    /// the channel's counterparty. Nothing here reads the claim's own
    /// `signerAddress`; the forger tests below still pass unchanged.
    #[tokio::test]
    async fn a_claim_on_a_channel_only_the_chain_knows_about_is_accepted() {
        let (_secret, address) = evm_signer();
        let channel_id = decode_hex_bytes::<32>(&unrecorded_channel_id()).unwrap();
        let gate = ClientClaimGate::new(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::knowing(vec![(
                channel_id,
                EvmChannel {
                    counterparty: address,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )]),
        )));

        let accepted = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 100), 100)
            .await
            .expect("a channel the chain knows about is payable without a config edit");
        assert_eq!(
            accepted.channel_key(),
            format!("evm:{}", unrecorded_channel_id())
        );
    }

    /// The forger rule survives the new source: a claim signed by a key
    /// that is not what the *chain* holds as the channel's counterparty is
    /// still refused, even though the channel itself resolves.
    #[tokio::test]
    async fn a_claim_signed_by_someone_other_than_the_chains_counterparty_is_still_refused() {
        let channel_id = decode_hex_bytes::<32>(&unrecorded_channel_id()).unwrap();
        let forger = SecretKey::parse(&[13u8; 32]).unwrap();
        let forger_address = derive_evm_address(&PublicKey::from_secret_key(&forger).serialize());
        let (_secret, genuine) = evm_signer();
        let gate = ClientClaimGate::new(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::knowing(vec![(
                channel_id,
                EvmChannel {
                    counterparty: genuine,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )]),
        )));

        let claim =
            evm_claim_json_signed_by(&forger, &forger_address, &unrecorded_channel_id(), 1, 100);
        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A source that cannot answer refuses the claim -- it never degrades
    /// to trusting what the claim says about itself -- and says so
    /// distinguishably from a channel that genuinely does not exist, so an
    /// operator can tell an RPC outage from a sender naming channels at
    /// random.
    #[tokio::test]
    async fn a_claim_whose_channel_lookup_fails_is_refused_distinguishably() {
        let gate = ClientClaimGate::new(ClientChannelRegistry::new().with_source(Arc::new(
            FakeChannelSource::unreachable("connection refused"),
        )));

        let result = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 100), 0)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::ChannelLookupFailed(
                "connection refused".to_string()
            ))
        );
        assert_ne!(result, Err(ClaimIngestRejection::UnknownChannel));
        let message = result.unwrap_err().message();
        assert!(message.contains("could not look up"), "{message}");
        assert!(message.contains("connection refused"), "{message}");
    }

    /// A node whose config declares its channels keeps working while its
    /// chain endpoint is down: the declared record answers, and the broken
    /// source is never consulted. This is the "still start and serve when
    /// the chain is unreachable" requirement at claim level.
    #[tokio::test]
    async fn a_declared_channel_is_still_payable_while_the_chain_is_unreachable() {
        let mut channels = ClientChannelRegistry::new();
        let (_secret, address) = evm_signer();
        channels
            .record_evm(
                &channel_id(),
                EvmChannel {
                    counterparty: address,
                    chain_id: EVM_CHAIN_ID,
                    token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
                },
            )
            .expect("a 32-byte hex channel id");
        let gate = ClientClaimGate::new(channels.with_source(Arc::new(
            FakeChannelSource::unreachable("connection refused"),
        )));

        assert!(gate
            .ingest(&evm_claim_json(&channel_id(), 1, 100), 0)
            .await
            .is_ok());
    }

    /// An unrecorded channel is refused *after* freshness and value, not
    /// before: #544's ordering is preserved, so an underpaying claim still
    /// costs this ingress no channel lookup or cryptographic work to
    /// refuse (issue #558's AC4).
    #[tokio::test]
    async fn an_underpaying_claim_on_an_unrecorded_channel_is_still_refused_as_underpayment() {
        let gate = gate();
        let result = gate
            .ingest(&evm_claim_json(&unrecorded_channel_id(), 1, 99), 100)
            .await;
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 99,
                price: 100
            })
        );
    }

    #[tokio::test]
    async fn an_evm_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let mut signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));
        signature[0] ^= 0xff;

        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[tokio::test]
    async fn an_evm_claim_with_a_truncated_signature_is_rejected_not_panicking() {
        let gate = gate();
        let (_secret, address) = evm_signer();
        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            "0xabcd",
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    /// The EIP-712 domain a claim is verified under comes from the channel's
    /// record, never from the claim (issue #558): a claim declaring no
    /// `chainId`/`tokenNetworkAddress` at all still verifies, and a claim
    /// declaring a *different* domain than the one recorded gains nothing by
    /// it -- both are judged against the recorded domain.
    #[tokio::test]
    async fn an_evm_claims_declared_eip712_domain_carries_no_authority() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: EVM_CHAIN_ID,
            token_network_address: EVM_TOKEN_NETWORK_ADDRESS,
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));

        let no_declared_domain = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            "",
        );
        assert!(gate.ingest(&no_declared_domain, 0).await.is_ok());

        // The same signature, now declaring a domain it was not produced
        // under. It is still checked against the recorded one, so it still
        // verifies -- the declared fields simply do not participate.
        let wrong_declared_domain = evm_claim_json_with(
            &channel_id(),
            2,
            200,
            &format!(
                "0x{}",
                hex_encode(&sign_evm(
                    &secret,
                    &evm_balance_proof_digest(&EvmBalanceProof {
                        nonce: 2,
                        transferred_amount: 200,
                        ..proof
                    })
                ))
            ),
            &to_hex(&address),
            r#", "chainId": 1, "tokenNetworkAddress": "0x00000000000000000000000000000000000000ff""#,
        );
        assert!(gate.ingest(&wrong_declared_domain, 0).await.is_ok());
    }

    /// A claim signed under a domain that is *not* the channel's recorded
    /// one does not verify -- the recorded domain is the only one this
    /// connector computes a digest under.
    #[tokio::test]
    async fn an_evm_claim_signed_under_another_domain_is_rejected() {
        let gate = gate();
        let (secret, address) = evm_signer();
        let proof = EvmBalanceProof {
            channel_id: decode_hex_bytes::<32>(&channel_id()).unwrap(),
            nonce: 1,
            transferred_amount: 100,
            locked_amount: 0,
            locks_root: [0u8; 32],
            chain_id: 1,
            token_network_address: [0xff; 20],
        };
        let signature = sign_evm(&secret, &evm_balance_proof_digest(&proof));

        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            r#", "chainId": 1, "tokenNetworkAddress": "0x00000000000000000000000000000000000000ff""#,
        );

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    #[tokio::test]
    async fn a_claim_failing_signature_verification_does_not_advance_the_watermark() {
        let gate = gate();
        let channel = channel_id();
        let (_secret, address) = evm_signer();
        let bad_signature_claim = evm_claim_json_with(
            &channel,
            1,
            100,
            "0xabcd",
            &to_hex(&address),
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );
        gate.ingest(&bad_signature_claim, 0).await.unwrap_err();

        // The watermark was never advanced by the rejected claim -- the
        // same nonce/amount is accepted here as a fresh first claim, not
        // refused as a replay.
        let genuine = gate.ingest(&evm_claim_json(&channel, 1, 100), 0).await;
        assert!(genuine.is_ok());
    }

    fn solana_signer() -> ed25519_dalek::Keypair {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::from_seed([13u8; 32]);
        ed25519_dalek::Keypair::generate(&mut rng)
    }

    fn base58_encode(bytes: &[u8]) -> String {
        bs58::encode(bytes).into_string()
    }

    fn solana_claim_json_with(
        channel_account: &str,
        nonce: u64,
        transferred_amount: u64,
        signature_base64: &str,
        signer_public_key: &str,
    ) -> String {
        format!(
            r#"{{
                "version": "1.0",
                "blockchain": "solana",
                "messageId": "msg-{nonce}",
                "timestamp": "2026-02-02T12:00:00.000Z",
                "senderId": "peer-carol",
                "programId": "11111111111111111111111111111111",
                "channelAccount": "{channel_account}",
                "nonce": {nonce},
                "transferredAmount": "{transferred_amount}",
                "signature": "{signature_base64}",
                "signerPublicKey": "{signer_public_key}"
            }}"#
        )
    }

    fn genuine_solana_claim_json(
        channel_account_bytes: &[u8; 32],
        nonce: u64,
        transferred_amount: u64,
    ) -> String {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let keypair = solana_signer();
        let message = connector_signer::solana_balance_proof_message(
            channel_account_bytes,
            nonce,
            transferred_amount,
        );
        let signature = keypair.sign(&message);
        solana_claim_json_with(
            &base58_encode(channel_account_bytes),
            nonce,
            transferred_amount,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&keypair.public.to_bytes()),
        )
    }

    #[tokio::test]
    async fn a_genuine_solana_signature_is_accepted() {
        let gate = gate();
        let claim = genuine_solana_claim_json(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let result = gate.ingest(&claim, 0).await;
        assert!(result.is_ok());
    }

    /// The Solana half of issue #558's forger: a genuine Ed25519 signature
    /// over the right message, produced by a key that is not the channel's
    /// recorded counterparty and declared as the claim's own signer. Both
    /// families verify against the registry, not against themselves.
    #[tokio::test]
    async fn a_solana_claim_signed_by_a_key_that_is_not_the_channels_counterparty_is_rejected() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;
        use rand::SeedableRng;

        let gate = gate();
        let forger =
            ed25519_dalek::Keypair::generate(&mut rand::rngs::StdRng::from_seed([99u8; 32]));
        assert_ne!(
            forger.public.to_bytes(),
            solana_signer().public.to_bytes(),
            "the forger must not accidentally be the counterparty"
        );
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let signature = forger.sign(&message);

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&forger.public.to_bytes()),
        );

        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::SignatureInvalid)
        );
    }

    /// A Solana claim naming a channel account this connector has no record
    /// of is refused as [`ClaimIngestRejection::UnknownChannel`], the same
    /// as its EVM counterpart.
    #[tokio::test]
    async fn a_solana_claim_on_an_unrecorded_channel_is_refused_as_unknown_channel() {
        let gate = gate();
        let claim = genuine_solana_claim_json(&[8u8; 32], 1, 100);
        assert_eq!(
            gate.ingest(&claim, 0).await,
            Err(ClaimIngestRejection::UnknownChannel)
        );
    }

    /// A Solana claim's `signerPublicKey` carries no authority either: a
    /// claim genuinely signed by the recorded counterparty is accepted
    /// however it declares itself.
    #[tokio::test]
    async fn a_solana_claims_declared_signer_field_carries_no_authority() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = gate();
        let signer = solana_signer();
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let signature = signer.sign(&message);

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&[7u8; 32]),
        );

        assert!(gate.ingest(&claim, 0).await.is_ok());
    }

    #[tokio::test]
    async fn a_solana_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = gate();
        let keypair = solana_signer();
        let message =
            connector_signer::solana_balance_proof_message(&SOLANA_CHANNEL_ACCOUNT, 1, 100);
        let mut signature_bytes = keypair.sign(&message).to_bytes();
        signature_bytes[0] ^= 0xff;

        let claim = solana_claim_json_with(
            &base58_encode(&SOLANA_CHANNEL_ACCOUNT),
            1,
            100,
            &BASE64.encode(signature_bytes),
            &base58_encode(&keypair.public.to_bytes()),
        );

        let result = gate.ingest(&claim, 0).await;
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[tokio::test]
    async fn a_mina_claim_is_never_routed_into_signature_verification() {
        // Mina is refused at structural parsing (ADR 0002), long before
        // this gate would ever reach a signature check -- there is no Mina
        // arm in `verify_claim_signature` to route into.
        let gate = gate();
        let json = r#"{
            "version": "1.0",
            "blockchain": "mina",
            "messageId": "claim-mina",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-dave",
            "zkAppAddress": "irrelevant",
            "tokenId": "1",
            "balanceCommitment": "abc",
            "nonce": 1,
            "proof": "AAAA",
            "salt": "salt"
        }"#;
        assert_eq!(gate.ingest(json, 0).await, Err(ClaimIngestRejection::Mina));
    }
}

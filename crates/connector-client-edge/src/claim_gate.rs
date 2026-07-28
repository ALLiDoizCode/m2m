//! Claim ingest gate for the client edge (`docs/protocol/client-edge-spec.md`
//! §1.3, issue #504): turns the `ILP-Payment-Channel-Claim`(`-Wrapped`)
//! header's already-decoded JSON into a structurally valid, fresh
//! [`ClientClaim`], or a documented refusal -- structure, then
//! freshness/watermark, deliberately before any cryptographic claim
//! signature verification (issue #506) or value binding against a route's
//! price (issue #507).
//!
//! Reuses `connector_domain`'s pure nonce/watermark rule
//! ([`connector_domain::validate_claim`], [`connector_domain::advance_watermark`])
//! exactly as the peer wire's own `connector_runtime::ClaimBook` does --
//! this is a second *state* around the same rule, not a second rule. The
//! state is deliberately separate from `ClaimBook`: a client-edge claim's
//! channel is never a peer-wire channel, and (unlike `ClaimBook::accept_inbound`)
//! nothing here gates a watermark advance behind a signature verification --
//! that check does not exist yet at this ingress (issue #506).

use std::collections::HashMap;
use std::sync::RwLock;

use connector_domain::client_claim::{parse_client_claim, ClientClaim, ClientClaimError};
use connector_domain::{advance_watermark, validate_claim, ClaimError, Watermark};

/// Why the gate refused a claim. [`ClaimIngestRejection::Mina`] and
/// [`ClaimIngestRejection::Malformed`] are kept distinct on purpose: the
/// acceptance criteria requires a Mina claim's refusal to be distinguishable
/// from a merely malformed one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimIngestRejection {
    Malformed(String),
    Mina,
    NonceNotAdvancing,
    AmountNotAdvancing,
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
            ClaimIngestRejection::WrapUnsupported => "claim rejected: this connector is not \
                 configured to unwrap a privacy-wrapped claim"
                .to_string(),
            ClaimIngestRejection::WrapFailed(reason) => {
                format!("claim rejected: failed to unwrap claim: {reason}")
            }
        }
    }
}

/// Per-channel watermark state for claims presented at the client edge.
#[derive(Default)]
pub struct ClientClaimGate {
    watermarks: RwLock<HashMap<String, Watermark>>,
}

impl ClientClaimGate {
    pub fn new() -> ClientClaimGate {
        ClientClaimGate::default()
    }

    /// Parse and fully validate a plaintext claim JSON body (already
    /// base64-decoded and, if it arrived wrapped, already unwrapped by the
    /// caller): structure, then freshness/watermark. Advances this claim's
    /// channel watermark only when the claim is accepted -- a rejected
    /// claim leaves the watermark exactly as it was.
    pub fn ingest(&self, claim_json: &str) -> Result<ClientClaim, ClaimIngestRejection> {
        let claim = parse_client_claim(claim_json).map_err(|error| match error {
            ClientClaimError::Mina => ClaimIngestRejection::Mina,
            other => ClaimIngestRejection::Malformed(other.to_string()),
        })?;

        let key = claim.channel_key();
        let mut watermarks = self
            .watermarks
            .write()
            .expect("client claim watermarks lock poisoned");
        let current = watermarks.get(&key).copied();
        match validate_claim(current, claim.nonce(), claim.transferred_amount()) {
            Ok(()) => {
                watermarks.insert(
                    key,
                    advance_watermark(claim.nonce(), claim.transferred_amount()),
                );
                Ok(claim)
            }
            Err(ClaimError::NonceNotAdvancing { .. }) => {
                Err(ClaimIngestRejection::NonceNotAdvancing)
            }
            Err(ClaimError::AmountNotAdvancing { .. }) => {
                Err(ClaimIngestRejection::AmountNotAdvancing)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evm_claim_json(channel_id: &str, nonce: u64, transferred_amount: u64) -> String {
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
                "signature": "0xabcdef",
                "signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1"
            }}"#,
            zeros = "0".repeat(64)
        )
    }

    fn channel_id() -> String {
        format!("0x{}", "ab".repeat(32))
    }

    #[test]
    fn a_fresh_claim_is_accepted() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100));
        assert!(result.is_ok());
    }

    #[test]
    fn a_replayed_nonce_is_rejected_without_touching_the_watermark() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500))
            .expect("first claim accepted");

        let replay = gate.ingest(&evm_claim_json(&channel, 5, 999));
        assert_eq!(replay, Err(ClaimIngestRejection::NonceNotAdvancing));

        // The watermark still holds at nonce 5 -- a genuinely advancing
        // claim after the rejected replay is judged against it, not against
        // whatever the rejected replay tried to claim.
        let next = gate.ingest(&evm_claim_json(&channel, 6, 500));
        assert!(next.is_ok());
    }

    #[test]
    fn an_amount_going_backwards_is_rejected() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 500))
            .expect("first claim accepted");

        let result = gate.ingest(&evm_claim_json(&channel, 2, 100));
        assert_eq!(result, Err(ClaimIngestRejection::AmountNotAdvancing));
    }

    #[test]
    fn the_watermark_never_advances_on_a_rejected_claim() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500))
            .expect("first claim accepted");
        gate.ingest(&evm_claim_json(&channel, 5, 999)).unwrap_err(); // replay, rejected
        gate.ingest(&evm_claim_json(&channel, 6, 100)).unwrap_err(); // amount regresses vs. watermark 500

        // Watermark is still exactly (5, 500): a claim of nonce 6 / amount
        // 500 (equal, not less) still advances cleanly.
        assert!(gate.ingest(&evm_claim_json(&channel, 6, 500)).is_ok());
    }

    #[test]
    fn different_channels_have_independent_watermarks() {
        let gate = ClientClaimGate::new();
        gate.ingest(&evm_claim_json(&channel_id(), 5, 500))
            .expect("first channel");

        let other_channel = format!("0x{}", "cd".repeat(32));
        let result = gate.ingest(&evm_claim_json(&other_channel, 1, 10));
        assert!(result.is_ok());
    }

    #[test]
    fn a_mina_claim_is_rejected_distinguishably_from_malformed() {
        let gate = ClientClaimGate::new();
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

        assert_eq!(gate.ingest(json), Err(ClaimIngestRejection::Mina));
    }

    #[test]
    fn a_structurally_invalid_claim_is_rejected_as_malformed() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(r#"{"version": "1.0", "blockchain": "evm"}"#);
        assert!(matches!(result, Err(ClaimIngestRejection::Malformed(_))));
    }
}

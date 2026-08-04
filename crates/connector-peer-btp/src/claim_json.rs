//! The claim on the wire (`peer-carriage-spec.md` §4): **the client edge's
//! claim JSON, verbatim**.
//!
//! One claim shape, one JSON encoding, two transfer encodings. A peer claim
//! is the same JSON object `client-edge-spec.md` §1.3 defines for a client
//! claim -- `version: "1.0"`, discriminated by `blockchain`, with the same
//! required and chain-specific fields -- and on BTP the
//! `payment-channel-claim` protocolData entry carries
//! `JSON.stringify(claim)` as raw UTF-8, no base64 layer (that is a header
//! artifact and nothing else).
//!
//! This is not a convenience. It is spec I4: one claim codec, one
//! structural validator, one signature verifier serve both edges, so a
//! change to the claim shape cannot land on one and not the other.
//! [`parse`] therefore calls
//! [`connector_domain::client_claim::parse_client_claim`] -- the client
//! edge's own validator -- rather than reading fields itself, and
//! [`encode`] emits exactly what that validator accepts.
//!
//! `connector_runtime::WireClaim::encode`'s length-prefixed binary form is
//! **not used on either carriage** (§3.2). It stays an in-process type
//! above the `PeerTransport` port; this module is the conversion, and
//! nothing here ever puts those bytes on a wire.

use connector_btp::{ProtocolData, CLAIM_PROTOCOL, CONTENT_TYPE_TEXT};
use connector_domain::client_claim::{parse_client_claim, ClientClaim, ClientClaimError};
use connector_runtime::WireClaim;
use connector_signer::Signature;

/// The EIP-712 domain a peering relation's channel is signed under -- the
/// `[[peer_channels]]` row's `chain_id` and `token_network`
/// (`peer-carriage-spec.md` §11). Carried onto the wire as the claim's
/// optional `chainId`/`tokenNetworkAddress`, which is what lets a
/// counterparty's `ClaimBook` check the signature against ADR 0024's
/// digest without any out-of-band agreement beyond the config both
/// operators already wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerClaimDomain {
    pub chain_id: u64,
    pub token_network: [u8; 20],
}

/// Why a `payment-channel-claim` entry could not become a [`WireClaim`].
#[derive(Debug, PartialEq, Eq)]
pub enum ClaimDecodeError {
    /// Not valid UTF-8, so not the raw-UTF-8 JSON §4 requires.
    NotUtf8,
    /// Structurally invalid per the client edge's own validator.
    Structural(String),
    /// A `solana` claim. The shape is pinned by the spec (§10.2 item 4)
    /// and deliberately marked aspirational there; `ClaimBook` verifies
    /// EIP-712 balance proofs only, so this connector cannot judge one and
    /// says so rather than silently accepting it.
    UnsupportedChain(&'static str),
    /// The `signature` field is not `0x` + 130 hex characters (§4.2's
    /// 65-byte `r ‖ s ‖ v`).
    Signature,
}

impl std::fmt::Display for ClaimDecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimDecodeError::NotUtf8 => f.write_str("claim protocolData is not valid UTF-8 JSON"),
            ClaimDecodeError::Structural(reason) => write!(f, "{reason}"),
            ClaimDecodeError::UnsupportedChain(chain) => {
                write!(
                    f,
                    "'{chain}' peer claims are not verifiable by this connector"
                )
            }
            ClaimDecodeError::Signature => {
                f.write_str("'signature' must be 0x-prefixed 130-char hex (r ‖ s ‖ v)")
            }
        }
    }
}

/// The canonical form of an EVM channel id (§4.1, `client-edge-spec.md`
/// §1.3 step 2): `0x` + 64 **lower-case** hex.
///
/// Applied before a watermark is read or written, on both the emitting and
/// the receiving side. A connector that keyed a peer watermark by literal
/// text would grant a fresh watermark per spelling, and one signed claim
/// would buy carriage once per casing it was retyped in. Anything that is
/// not that shape is returned unchanged -- it will fail structural
/// validation on its own, and quietly rewriting it here would only hide
/// where.
pub fn canonical_evm_channel_id(channel_id: &str) -> String {
    let is_bytes32_hex = channel_id.len() == 66
        && channel_id.starts_with("0x")
        && channel_id[2..].bytes().all(|b| b.is_ascii_hexdigit());
    if is_bytes32_hex {
        channel_id.to_ascii_lowercase()
    } else {
        channel_id.to_string()
    }
}

/// `0x` + 64 lower-case hex, the shape `locksRoot` takes when locks are
/// hashed as zeros -- which is always, per `peer-wire-spec.md` §3.5 and
/// ADR 0024. Neither field enters the digest as anything else, on either
/// edge.
const ZERO_BYTES32: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";

/// Render `claim` as the §4 JSON, signed by `signer_address` on `domain`.
///
/// `message_id` and `timestamp` are the caller's, deliberately: §6.3
/// requires a payer's retransmission of an unacknowledged claim to be
/// **byte-identical**, and a timestamp sampled here would make that
/// impossible. The dial side therefore caches the string it emitted for a
/// `(channel, nonce, cumulative)` triple and reuses it (see
/// [`crate::dial`]), rather than re-rendering with a fresh `now`.
pub fn encode(
    claim: &WireClaim,
    signer_address: &[u8; 20],
    domain: PeerClaimDomain,
    message_id: &str,
    timestamp: &str,
) -> String {
    let signer = format!("0x{}", hex::encode(signer_address));
    let json = serde_json::json!({
        "version": "1.0",
        "blockchain": "evm",
        "messageId": message_id,
        "timestamp": timestamp,
        "senderId": signer,
        "channelId": canonical_evm_channel_id(&claim.channel_id),
        "nonce": claim.nonce,
        "transferredAmount": claim.cumulative_amount.to_string(),
        // Hashed as zeros, always (§3.1, ADR 0024): the deployed
        // `TokenNetwork.sol` typehash requires the fields, and this
        // connector has no locks to put in them.
        "lockedAmount": "0",
        "locksRoot": ZERO_BYTES32,
        "signature": format!("0x{}", hex::encode(claim.signature.to_bytes())),
        "signerAddress": signer,
        "chainId": domain.chain_id,
        "tokenNetworkAddress": format!("0x{}", hex::encode(domain.token_network)),
    });
    serde_json::to_string(&json).expect("a json! object always serializes")
}

/// The `payment-channel-claim` protocolData entry carrying `json` as **raw
/// UTF-8** (§4) -- verbatim the client edge's existing convention
/// (`client-edge-spec.md` §1.9 step 2), with no base64 layer.
pub fn protocol_data(json: &str) -> ProtocolData {
    ProtocolData {
        name: CLAIM_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: json.as_bytes().to_vec(),
    }
}

/// The raw JSON of a frame's `payment-channel-claim` entry, if it carried
/// one. A frame with no claim is legal on both carriages (§10.2 item 6),
/// so `None` is an ordinary outcome and not a refusal.
pub fn from_protocol_data(protocol_data: &[ProtocolData]) -> Option<&[u8]> {
    protocol_data
        .iter()
        .find(|pd| pd.name == CLAIM_PROTOCOL)
        .map(|pd| pd.data.as_slice())
}

/// Parse a §4 claim into the in-process [`WireClaim`] the pipeline below
/// the port judges, through the client edge's own structural validator
/// (I4).
///
/// The channel id is canonicalised here, before the caller can reach a
/// watermark with it (§4.1).
pub fn parse(raw: &[u8]) -> Result<WireClaim, ClaimDecodeError> {
    let json = std::str::from_utf8(raw).map_err(|_| ClaimDecodeError::NotUtf8)?;
    let claim = parse_client_claim(json).map_err(|error| match error {
        ClientClaimError::Mina => ClaimDecodeError::UnsupportedChain("mina"),
        other => ClaimDecodeError::Structural(other.to_string()),
    })?;
    let claim = match claim {
        ClientClaim::Evm(claim) => claim,
        ClientClaim::Solana(_) => return Err(ClaimDecodeError::UnsupportedChain("solana")),
    };
    Ok(WireClaim {
        channel_id: canonical_evm_channel_id(&claim.channel_id),
        nonce: claim.nonce,
        cumulative_amount: claim.transferred_amount,
        signature: parse_signature(&claim.signature)?,
    })
}

/// §4.2: 65 bytes `r ‖ s ‖ v`, with `v` as libsecp256k1 emits it
/// (`{0, 1}`), never the wallet `{27, 28}` convention. The one place that
/// conversion happens is immediately before on-chain submission, and it is
/// not here.
fn parse_signature(signature: &str) -> Result<Signature, ClaimDecodeError> {
    let hex_body = signature
        .strip_prefix("0x")
        .ok_or(ClaimDecodeError::Signature)?;
    let bytes = hex::decode(hex_body).map_err(|_| ClaimDecodeError::Signature)?;
    if bytes.len() != 65 {
        return Err(ClaimDecodeError::Signature);
    }
    let mut r = [0u8; 32];
    r.copy_from_slice(&bytes[0..32]);
    let mut s = [0u8; 32];
    s.copy_from_slice(&bytes[32..64]);
    Ok(Signature {
        r,
        s,
        recovery_id: bytes[64],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wire_claim() -> WireClaim {
        WireClaim {
            channel_id: format!("0x{:064x}", 7),
            nonce: 4,
            cumulative_amount: 12_500,
            signature: Signature {
                r: [0x11; 32],
                s: [0x22; 32],
                recovery_id: 1,
            },
        }
    }

    fn domain() -> PeerClaimDomain {
        PeerClaimDomain {
            chain_id: 84_532,
            token_network: [0x33; 20],
        }
    }

    /// I4, mechanically: what the peer carriage emits is what the *client
    /// edge's* validator accepts, and the value survives the round trip.
    #[test]
    fn an_emitted_claim_parses_back_through_the_client_edges_own_validator() {
        let claim = wire_claim();
        let json = encode(
            &claim,
            &[0x44; 20],
            domain(),
            "0x…:4",
            "2030-01-01T00:00:00.000Z",
        );

        let parsed = parse(json.as_bytes()).expect("the client edge validator accepts it");

        assert_eq!(parsed, claim);
    }

    /// §4: the entry is raw UTF-8 JSON, not base64 -- base64 is an HTTP
    /// header artifact and appears nowhere on this carriage.
    #[test]
    fn the_claim_entry_carries_raw_utf8_json() {
        let json = encode(
            &wire_claim(),
            &[0x44; 20],
            domain(),
            "m",
            "2030-01-01T00:00:00Z",
        );

        let entry = protocol_data(&json);

        assert_eq!(entry.name, CLAIM_PROTOCOL);
        assert_eq!(String::from_utf8(entry.data).expect("utf-8"), json);
    }

    /// §3.1/ADR 0024: `lockedAmount`/`locksRoot` are hashed as zeros, and
    /// the domain the counterparty verifies under rides the claim.
    #[test]
    fn an_emitted_claim_pins_zero_locks_and_carries_its_eip712_domain() {
        let json = encode(
            &wire_claim(),
            &[0x44; 20],
            domain(),
            "m",
            "2030-01-01T00:00:00Z",
        );

        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["lockedAmount"], "0");
        assert_eq!(value["locksRoot"], ZERO_BYTES32);
        assert_eq!(value["chainId"], 84_532);
        assert_eq!(
            value["tokenNetworkAddress"],
            format!("0x{}", hex::encode([0x33u8; 20]))
        );
        assert_eq!(value["blockchain"], "evm");
        assert_eq!(value["version"], "1.0");
    }

    /// §4.1: the channel id is canonicalised before it can reach a
    /// watermark, so one signed claim cannot buy carriage once per casing
    /// it was retyped in.
    #[test]
    fn a_recased_channel_id_canonicalises_to_one_watermark_key() {
        let upper = format!("0x{}", "AB".repeat(32));
        let lower = format!("0x{}", "ab".repeat(32));

        assert_eq!(canonical_evm_channel_id(&upper), lower);
        assert_eq!(canonical_evm_channel_id(&lower), lower);
        // Not a bytes32 at all: left alone, to fail structural validation
        // where the reason is legible.
        assert_eq!(canonical_evm_channel_id("CHANNEL-A"), "CHANNEL-A");
    }

    /// §4.2: `v` rides as libsecp256k1 emits it, unchanged in both
    /// directions.
    #[test]
    fn the_recovery_id_rides_raw_and_is_never_shifted_to_the_wallet_convention() {
        for recovery_id in [0u8, 1] {
            let claim = WireClaim {
                signature: Signature {
                    recovery_id,
                    ..wire_claim().signature
                },
                ..wire_claim()
            };
            let json = encode(&claim, &[0x44; 20], domain(), "m", "2030-01-01T00:00:00Z");
            let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
            let signature = value["signature"].as_str().expect("a string");
            assert_eq!(
                &signature[signature.len() - 2..],
                format!("{recovery_id:02x}")
            );

            assert_eq!(parse(json.as_bytes()).expect("round trip"), claim);
        }
    }

    #[test]
    fn a_solana_claim_is_refused_by_chain_rather_than_reported_malformed() {
        let json = serde_json::json!({
            "version": "1.0",
            "blockchain": "solana",
            "messageId": "m",
            "timestamp": "2030-01-01T00:00:00Z",
            "senderId": "s",
            "programId": "11111111111111111111111111111111",
            "channelAccount": "11111111111111111111111111111112",
            "nonce": 1,
            "transferredAmount": "10",
            "signature": "0xabcd",
            "signerPublicKey": "11111111111111111111111111111113",
        })
        .to_string();

        assert_eq!(
            parse(json.as_bytes()),
            Err(ClaimDecodeError::UnsupportedChain("solana"))
        );
    }

    #[test]
    fn a_malformed_claim_is_refused_with_the_validators_own_reason() {
        assert!(matches!(
            parse(b"{\"version\":\"2.0\"}"),
            Err(ClaimDecodeError::Structural(_))
        ));
        assert_eq!(parse(&[0xff, 0xfe]), Err(ClaimDecodeError::NotUtf8));
    }

    #[test]
    fn a_short_signature_is_refused_rather_than_zero_padded() {
        let json = encode(
            &wire_claim(),
            &[0x44; 20],
            domain(),
            "m",
            "2030-01-01T00:00:00Z",
        )
        .replace(
            &format!("0x{}", hex::encode(wire_claim().signature.to_bytes())),
            "0xdeadbeef",
        );

        assert_eq!(parse(json.as_bytes()), Err(ClaimDecodeError::Signature));
    }
}

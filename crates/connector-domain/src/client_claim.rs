//! Client-edge payment claim shape (`docs/protocol/client-edge-spec.md` §1.3,
//! issue #504): the JSON claim a client presents in the
//! `ILP-Payment-Channel-Claim`(`-Wrapped`) header, and its structural
//! validation. Recovered from the deleted
//! `packages/connector/src/btp/btp-claim-types.ts` (git history at
//! `c4a4ad10^`), which is the shape's only prior definition -- field names,
//! required-ness and formats below are ported from its
//! `validateClaimMessage`/`validateEVMClaim`/`validateSolanaClaim`, not
//! guessed at.
//!
//! Distinct from [`crate::claim::Watermark`]'s peer-wire `WireClaim`: same
//! nonce/watermark rule ([`crate::validate_claim`], [`crate::advance_watermark`]),
//! a different wire shape and a different channel namespace (a client-edge
//! claim never touches a peer-wire channel).
//!
//! Mina is deliberately excluded from [`ClientClaim`] entirely. ADR 0002
//! drops Mina from the Rust connector, and this ticket's own acceptance
//! criteria requires refusing a Mina claim "with a reason naming the dropped
//! support, distinguishable from a malformed claim" -- [`parse_client_claim`]
//! checks the `blockchain` discriminator before attempting any Mina-specific
//! structural validation, so a well-formed Mina claim is refused for the
//! right reason rather than accidentally accepted or misreported as
//! malformed.
//!
//! Cryptographic verification (EIP-712 recovery, Ed25519) and value binding
//! against a route's price are deliberately not this module's concern --
//! issues #506 and #507 -- so a [`ClientClaim`] carries its signature and
//! amount fields only in the string/number shape they arrived in, validated
//! for format but never interpreted cryptographically here.

use serde_json::Value;
use thiserror::Error;

/// Fields common to every claim regardless of chain (client-edge-spec.md
/// §1.3's "required fields on every claim").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientClaimCommon {
    pub message_id: String,
    pub timestamp: String,
    pub sender_id: String,
}

/// An EVM claim (Raiden-style balance proof), per
/// `btp-claim-types.ts`'s `EVMClaimMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvmClientClaim {
    pub common: ClientClaimCommon,
    pub channel_id: String,
    pub nonce: u64,
    pub transferred_amount: u64,
    pub locked_amount: String,
    pub locks_root: String,
    pub signature: String,
    pub signer_address: String,
    pub chain_id: Option<u64>,
    pub token_network_address: Option<String>,
    pub token_address: Option<String>,
}

/// A Solana claim (Ed25519 balance proof), per
/// `btp-claim-types.ts`'s `SolanaClaimMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SolanaClientClaim {
    pub common: ClientClaimCommon,
    pub program_id: String,
    pub channel_account: String,
    pub nonce: u64,
    pub transferred_amount: u64,
    pub signature: String,
    pub signer_public_key: String,
    pub cluster: Option<String>,
}

/// A structurally valid, non-Mina client-edge claim (client-edge-spec.md
/// §1.3). Discriminated on chain the same way the wire's `blockchain` field
/// does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientClaim {
    Evm(EvmClientClaim),
    Solana(SolanaClientClaim),
}

impl ClientClaim {
    /// The channel this claim's freshness/watermark is judged against,
    /// namespaced by chain so an EVM `channelId` and a Solana
    /// `channelAccount` can never collide even in the (practically
    /// impossible, since their alphabets differ) case of equal text.
    pub fn channel_key(&self) -> String {
        match self {
            ClientClaim::Evm(claim) => format!("evm:{}", claim.channel_id),
            ClientClaim::Solana(claim) => format!("solana:{}", claim.channel_account),
        }
    }

    pub fn nonce(&self) -> u64 {
        match self {
            ClientClaim::Evm(claim) => claim.nonce,
            ClientClaim::Solana(claim) => claim.nonce,
        }
    }

    pub fn transferred_amount(&self) -> u64 {
        match self {
            ClientClaim::Evm(claim) => claim.transferred_amount,
            ClientClaim::Solana(claim) => claim.transferred_amount,
        }
    }

    pub fn common(&self) -> &ClientClaimCommon {
        match self {
            ClientClaim::Evm(claim) => &claim.common,
            ClientClaim::Solana(claim) => &claim.common,
        }
    }
}

/// Why [`parse_client_claim`] refused a claim. [`ClientClaimError::Mina`] is
/// kept separate from [`ClientClaimError::Malformed`] on purpose -- the
/// acceptance criteria requires the two to be distinguishable, since one
/// means "this connector cannot settle this chain" and the other means "this
/// request made no sense".
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ClientClaimError {
    #[error("claim header is not valid JSON: {0}")]
    InvalidJson(String),
    #[error("claim is structurally invalid: {0}")]
    Malformed(String),
    #[error(
        "mina claims are refused: ADR 0002 drops Mina support from the Rust connector -- \
         stay on the TypeScript fleet for Mina channels"
    )]
    Mina,
}

fn malformed(msg: impl Into<String>) -> ClientClaimError {
    ClientClaimError::Malformed(msg.into())
}

fn required_str<'a>(
    obj: &'a serde_json::Map<String, Value>,
    field: &str,
) -> Result<&'a str, ClientClaimError> {
    obj.get(field)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            malformed(format!(
                "missing or invalid '{field}' (expected non-empty string)"
            ))
        })
}

fn optional_str(
    obj: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<Option<String>, ClientClaimError> {
    match obj.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(malformed(format!(
            "'{field}' must be a string when present"
        ))),
    }
}

fn required_nonce(obj: &serde_json::Map<String, Value>) -> Result<u64, ClientClaimError> {
    obj.get("nonce")
        .and_then(Value::as_u64)
        .ok_or_else(|| malformed("missing or invalid 'nonce' (expected a non-negative integer)"))
}

fn required_decimal_amount(
    obj: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<u64, ClientClaimError> {
    let raw = required_str(obj, field)?;
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return Err(malformed(format!(
            "'{field}' must be a non-negative integer string"
        )));
    }
    raw.parse::<u64>()
        .map_err(|_| malformed(format!("'{field}' does not fit in a u64")))
}

fn is_hex_of_len(s: &str, hex_chars: usize) -> bool {
    s.len() == hex_chars + 2 && s.starts_with("0x") && s[2..].bytes().all(|b| b.is_ascii_hexdigit())
}

const BASE58_ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn is_base58(s: &str, min_len: usize, max_len: usize) -> bool {
    (min_len..=max_len).contains(&s.len()) && s.bytes().all(|b| BASE58_ALPHABET.contains(&b))
}

fn parse_common(
    obj: &serde_json::Map<String, Value>,
) -> Result<(&str, ClientClaimCommon), ClientClaimError> {
    let version = required_str(obj, "version")?;
    if version != "1.0" {
        return Err(malformed(format!(
            "unsupported claim version '{version}' (expected '1.0')"
        )));
    }
    let blockchain = required_str(obj, "blockchain")?;
    let message_id = required_str(obj, "messageId")?.to_string();
    let timestamp = required_str(obj, "timestamp")?;
    if !is_iso8601(timestamp) {
        return Err(malformed(format!(
            "'timestamp' must be ISO 8601 with a 'Z' timezone, got '{timestamp}'"
        )));
    }
    let timestamp = timestamp.to_string();
    let sender_id = required_str(obj, "senderId")?.to_string();
    Ok((
        blockchain,
        ClientClaimCommon {
            message_id,
            timestamp,
            sender_id,
        },
    ))
}

/// A deliberately narrow ISO-8601 check matching the deleted TS reference's
/// own regex (`YYYY-MM-DDTHH:MM:SS(.mmm)?Z`) -- this is a wire-format gate,
/// not a general-purpose date parser.
fn is_iso8601(s: &str) -> bool {
    let bytes = s.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range.clone())
            .is_some_and(|slice| slice.iter().all(u8::is_ascii_digit) && slice.len() == range.len())
    };
    if bytes.len() == 20 {
        digits(0..4)
            && bytes[4] == b'-'
            && digits(5..7)
            && bytes[7] == b'-'
            && digits(8..10)
            && bytes[10] == b'T'
            && digits(11..13)
            && bytes[13] == b':'
            && digits(14..16)
            && bytes[16] == b':'
            && digits(17..19)
            && bytes[19] == b'Z'
    } else if bytes.len() == 24 {
        digits(0..4)
            && bytes[4] == b'-'
            && digits(5..7)
            && bytes[7] == b'-'
            && digits(8..10)
            && bytes[10] == b'T'
            && digits(11..13)
            && bytes[13] == b':'
            && digits(14..16)
            && bytes[16] == b':'
            && digits(17..19)
            && bytes[19] == b'.'
            && digits(20..23)
            && bytes[23] == b'Z'
    } else {
        false
    }
}

fn parse_evm(
    obj: &serde_json::Map<String, Value>,
    common: ClientClaimCommon,
) -> Result<EvmClientClaim, ClientClaimError> {
    let channel_id = required_str(obj, "channelId")?.to_string();
    if !is_hex_of_len(&channel_id, 64) {
        return Err(malformed(
            "'channelId' must be 0x-prefixed 64-char hex (bytes32)",
        ));
    }
    let nonce = required_nonce(obj)?;
    let transferred_amount = required_decimal_amount(obj, "transferredAmount")?;
    let locked_amount = required_str(obj, "lockedAmount")?.to_string();
    if !locked_amount.bytes().all(|b| b.is_ascii_digit()) {
        return Err(malformed(
            "'lockedAmount' must be a non-negative integer string",
        ));
    }
    let locks_root = required_str(obj, "locksRoot")?.to_string();
    if !is_hex_of_len(&locks_root, 64) {
        return Err(malformed(
            "'locksRoot' must be 0x-prefixed 64-char hex (bytes32)",
        ));
    }
    let signature = required_str(obj, "signature")?.to_string();
    let signer_address = required_str(obj, "signerAddress")?.to_string();
    if !is_hex_of_len(&signer_address, 40) {
        return Err(malformed("'signerAddress' must be 0x-prefixed 40-char hex"));
    }
    let chain_id = match obj.get("chainId") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_u64()
                .filter(|id| *id > 0)
                .ok_or_else(|| malformed("'chainId' must be a positive integer when present"))?,
        ),
    };
    let token_network_address = optional_str(obj, "tokenNetworkAddress")?;
    if let Some(addr) = &token_network_address {
        if !is_hex_of_len(addr, 40) {
            return Err(malformed(
                "'tokenNetworkAddress' must be 0x-prefixed 40-char hex when present",
            ));
        }
    }
    let token_address = optional_str(obj, "tokenAddress")?;
    if let Some(addr) = &token_address {
        if !is_hex_of_len(addr, 40) {
            return Err(malformed(
                "'tokenAddress' must be 0x-prefixed 40-char hex when present",
            ));
        }
    }
    Ok(EvmClientClaim {
        common,
        channel_id,
        nonce,
        transferred_amount,
        locked_amount,
        locks_root,
        signature,
        signer_address,
        chain_id,
        token_network_address,
        token_address,
    })
}

fn parse_solana(
    obj: &serde_json::Map<String, Value>,
    common: ClientClaimCommon,
) -> Result<SolanaClientClaim, ClientClaimError> {
    let program_id = required_str(obj, "programId")?.to_string();
    if !is_base58(&program_id, 32, 44) {
        return Err(malformed(
            "'programId' must be a base58-encoded Solana address (32-44 chars)",
        ));
    }
    let channel_account = required_str(obj, "channelAccount")?.to_string();
    if !is_base58(&channel_account, 32, 44) {
        return Err(malformed(
            "'channelAccount' must be a base58-encoded Solana address (32-44 chars)",
        ));
    }
    let nonce = required_nonce(obj)?;
    let transferred_amount = required_decimal_amount(obj, "transferredAmount")?;
    let signature = required_str(obj, "signature")?.to_string();
    let signer_public_key = required_str(obj, "signerPublicKey")?.to_string();
    if !is_base58(&signer_public_key, 32, 44) {
        return Err(malformed(
            "'signerPublicKey' must be a base58-encoded Solana public key (32-44 chars)",
        ));
    }
    let cluster = optional_str(obj, "cluster")?;
    if let Some(cluster) = &cluster {
        const VALID: &[&str] = &["mainnet-beta", "devnet", "testnet", "localnet"];
        if !VALID.contains(&cluster.as_str()) {
            return Err(malformed(format!(
                "'cluster' must be one of {VALID:?} when present, got '{cluster}'"
            )));
        }
    }
    Ok(SolanaClientClaim {
        common,
        program_id,
        channel_account,
        nonce,
        transferred_amount,
        signature,
        signer_public_key,
        cluster,
    })
}

/// Parse and structurally validate a client-edge claim's JSON body
/// (client-edge-spec.md §1.3): required/optional fields per chain and their
/// formats. Does not check freshness, value or cryptography -- those are
/// [`crate::validate_claim`] (freshness/watermark, reused unchanged by the
/// caller) and issues #506/#507 respectively.
///
/// `blockchain: "mina"` is refused as [`ClientClaimError::Mina`] before any
/// Mina-specific field is even inspected -- a well-formed Mina claim is
/// refused for the deliberate reason ADR 0002 gives, never reported as
/// malformed.
pub fn parse_client_claim(json: &str) -> Result<ClientClaim, ClientClaimError> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| ClientClaimError::InvalidJson(e.to_string()))?;
    let obj = value
        .as_object()
        .ok_or_else(|| malformed("claim must be a JSON object"))?;

    let (blockchain, common) = parse_common(obj)?;
    match blockchain {
        "mina" => Err(ClientClaimError::Mina),
        "evm" => parse_evm(obj, common).map(ClientClaim::Evm),
        "solana" => parse_solana(obj, common).map(ClientClaim::Solana),
        other => Err(malformed(format!("unsupported blockchain '{other}'"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evm_claim_json() -> String {
        let channel_id = format!("0x{}", "ab".repeat(32));
        let locks_root = format!("0x{}", "0".repeat(64));
        format!(
            r#"{{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "claim-1",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-bob",
            "channelId": "{channel_id}",
            "nonce": 5,
            "transferredAmount": "1000000000000000000",
            "lockedAmount": "0",
            "locksRoot": "{locks_root}",
            "signature": "0xabcdef",
            "signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1"
        }}"#
        )
    }

    fn solana_claim_json() -> &'static str {
        r#"{
            "version": "1.0",
            "blockchain": "solana",
            "messageId": "claim-2",
            "timestamp": "2026-02-02T12:00:00Z",
            "senderId": "peer-carol",
            "programId": "11111111111111111111111111111111",
            "channelAccount": "So11111111111111111111111111111111111111112",
            "nonce": 3,
            "transferredAmount": "42",
            "signature": "deadbeef",
            "signerPublicKey": "So11111111111111111111111111111111111111112"
        }"#
    }

    #[test]
    fn a_well_formed_evm_claim_parses() {
        let claim = parse_client_claim(&evm_claim_json()).expect("parses");
        match claim {
            ClientClaim::Evm(evm) => {
                assert_eq!(evm.nonce, 5);
                assert_eq!(evm.transferred_amount, 1_000_000_000_000_000_000);
                assert_eq!(evm.common.message_id, "claim-1");
            }
            ClientClaim::Solana(_) => panic!("expected an EVM claim"),
        }
    }

    #[test]
    fn a_well_formed_solana_claim_parses() {
        let claim = parse_client_claim(solana_claim_json()).expect("parses");
        match claim {
            ClientClaim::Solana(solana) => {
                assert_eq!(solana.nonce, 3);
                assert_eq!(solana.transferred_amount, 42);
            }
            ClientClaim::Evm(_) => panic!("expected a Solana claim"),
        }
    }

    #[test]
    fn channel_key_is_namespaced_by_chain() {
        let claim = parse_client_claim(solana_claim_json()).expect("parses");
        assert!(claim.channel_key().starts_with("solana:"));
    }

    #[test]
    fn not_json_at_all_is_invalid_json_not_malformed() {
        let err = parse_client_claim("not json").unwrap_err();
        assert!(matches!(err, ClientClaimError::InvalidJson(_)));
    }

    #[test]
    fn a_claim_missing_a_required_field_is_malformed() {
        let json = r#"{
            "version": "1.0",
            "blockchain": "evm",
            "messageId": "claim-1",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-bob"
        }"#;
        let err = parse_client_claim(json).unwrap_err();
        assert!(matches!(err, ClientClaimError::Malformed(_)));
    }

    #[test]
    fn a_claim_with_a_field_in_the_wrong_format_for_its_chain_is_malformed() {
        let channel_id_field = format!(r#""channelId": "0x{}""#, "ab".repeat(32));
        let bad = evm_claim_json().replace(&channel_id_field, r#""channelId": "not-hex""#);
        let err = parse_client_claim(&bad).unwrap_err();
        assert!(matches!(err, ClientClaimError::Malformed(_)));
    }

    #[test]
    fn a_mina_claim_is_refused_distinguishably_from_malformed() {
        let json = r#"{
            "version": "1.0",
            "blockchain": "mina",
            "messageId": "claim-3",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-dave",
            "zkAppAddress": "B620000000000000000000000000000000000000000000000000",
            "tokenId": "1",
            "balanceCommitment": "abc",
            "nonce": 1,
            "proof": "AAAA",
            "salt": "salt"
        }"#;
        let err = parse_client_claim(json).unwrap_err();
        assert_eq!(err, ClientClaimError::Mina);
        assert_ne!(err, ClientClaimError::Malformed("anything".to_string()));
    }

    #[test]
    fn an_unsupported_blockchain_is_malformed_not_mina() {
        let json = r#"{
            "version": "1.0",
            "blockchain": "bitcoin",
            "messageId": "claim-4",
            "timestamp": "2026-02-02T12:00:00.000Z",
            "senderId": "peer-erin"
        }"#;
        let err = parse_client_claim(json).unwrap_err();
        assert!(matches!(err, ClientClaimError::Malformed(_)));
    }

    #[test]
    fn a_wrong_version_is_malformed() {
        let bad = evm_claim_json().replace(r#""version": "1.0""#, r#""version": "2.0""#);
        let err = parse_client_claim(&bad).unwrap_err();
        assert!(matches!(err, ClientClaimError::Malformed(_)));
    }

    #[test]
    fn optional_fields_are_accepted_when_present_and_valid() {
        let with_optional = evm_claim_json().replace(
            r#""signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1""#,
            r#""signerAddress": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1", "chainId": 8453, "tokenNetworkAddress": "0x1234567890123456789012345678901234567890""#,
        );
        let claim = parse_client_claim(&with_optional).expect("parses");
        match claim {
            ClientClaim::Evm(evm) => {
                assert_eq!(evm.chain_id, Some(8453));
                assert_eq!(
                    evm.token_network_address,
                    Some("0x1234567890123456789012345678901234567890".to_string())
                );
            }
            ClientClaim::Solana(_) => panic!("expected an EVM claim"),
        }
    }
}

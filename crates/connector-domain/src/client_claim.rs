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
//! Distinct from [`crate::claim::Watermark`]'s peer-role `WireClaim`: same
//! nonce/watermark rule ([`crate::validate_claim`], [`crate::advance_watermark`]),
//! a different wire shape and a different channel namespace (a client-edge
//! claim never touches a peer channel).
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
    /// impossible, since their alphabets differ) case of equal text, and
    /// **canonical** within that namespace (issue #643) -- see
    /// [`canonical_channel_key`] for why the second is a security property
    /// rather than tidiness.
    pub fn channel_key(&self) -> String {
        match self {
            ClientClaim::Evm(claim) => {
                format!("{EVM_NAMESPACE}:{}", canonical_evm_id(&claim.channel_id))
            }
            ClientClaim::Solana(claim) => {
                format!("{SOLANA_NAMESPACE}:{}", claim.channel_account)
            }
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

    /// The key whose signature this claim *says* it carries, namespaced by
    /// chain the same way [`ClientClaim::channel_key`] namespaces the
    /// channel: `evm:0x<40 lower-case hex>` or `solana:<base58>`.
    ///
    /// **This is a self-declared value and it is not authority for
    /// anything.** Whose signature a claim is checked against comes from
    /// the connector's own per-channel record and never from here (issue
    /// #558) -- see `connector_client_edge::ClientChannelRegistry`. It
    /// exists for one narrower purpose: to be the identity an *unresolvable*
    /// channel lookup is budgeted against (issue #613), where by definition
    /// there is no recognized channel to budget against instead, and where
    /// the alternative identities are worse. It is therefore a label for
    /// grouping and attribution, not a credential.
    ///
    /// Canonicalised for exactly the reason
    /// [`canonical_channel_key`] canonicalises an id: hex has no case, so a
    /// budget keyed by the literal text would hand one sender a fresh
    /// allowance per recasing of their own address. Solana's base58 is
    /// case-*sensitive* and a 32-byte key has one spelling, so it is left
    /// alone for the same reason the Solana channel namespace is.
    pub fn signer_key(&self) -> String {
        match self {
            ClientClaim::Evm(claim) => format!(
                "{EVM_NAMESPACE}:{}",
                claim.signer_address.to_ascii_lowercase()
            ),
            ClientClaim::Solana(claim) => {
                format!("{SOLANA_NAMESPACE}:{}", claim.signer_public_key)
            }
        }
    }

    /// The claim's self-declared signer, exactly as written -- unnamespaced
    /// and uncanonicalized, unlike [`ClientClaim::signer_key`]. Its one
    /// consumer is [`crate::identity::resolve_identity`]'s anonymous-sender
    /// ephemeral identity (client-edge-spec.md §1.2, issue #502): a label
    /// derived from whatever this claim already parsed out, not a second
    /// parse of the claim JSON. **This is a self-declared value and it is
    /// not authority for anything** -- the same caveat [`ClientClaim::signer_key`]
    /// documents applies here unchanged.
    pub fn signer(&self) -> &str {
        match self {
            ClientClaim::Evm(claim) => &claim.signer_address,
            ClientClaim::Solana(claim) => &claim.signer_public_key,
        }
    }
}

/// The chain namespace [`ClientClaim::channel_key`] prefixes an EVM
/// `channelId` with.
pub const EVM_NAMESPACE: &str = "evm";

/// The chain namespace [`ClientClaim::channel_key`] prefixes a Solana
/// `channelAccount` with.
pub const SOLANA_NAMESPACE: &str = "solana";

/// The canonical form of an already-namespaced channel key -- the key a
/// watermark is filed under, and the only form a lookup of one may be
/// made in (issue #643).
///
/// # Why this exists
///
/// A watermark keyed by the literal text a claim arrived with is not a
/// replay defence, because one channel has many literal texts. `channelId`
/// is `bytes32` hex, and hex has no case: `0xAB..` and `0xab..` name the
/// same 32 bytes, and every downstream consumer already agrees they do --
/// the client edge's `ClientChannelRegistry` resolves the counterparty by
/// the *decoded* bytes, and the EIP-712 digest a claim's signature recovers
/// under is computed over those same bytes, so a claim re-presented with
/// its `channelId` recased verifies identically. Only the watermark key
/// disagreed, which handed a client 2^64 fresh, empty watermarks per
/// channel: `validate_claim(None, ..)` accepts any nonce, so one signed
/// claim bought a write once per casing it was retyped in.
///
/// So: the key is canonicalized here, once, and both the write and the
/// read of a watermark go through it. Two claims this connector would
/// verify against the same channel record are keyed the same, by
/// construction rather than by every call site remembering to lowercase.
///
/// # What canonical means, per namespace
///
/// * `evm:` -- `0x` followed by 64 lowercase hex characters, whenever the
///   id is 64 hex characters with or without that prefix (i.e. exactly
///   the shape that decodes to a 32-byte `channelId`). Exactly one
///   spelling, and it names the same bytes as every other spelling of it,
///   without this crate taking a hex dependency and without the key
///   ceasing to be greppable in a journal line.
///
///   **The `0x` is kept, and that is a compatibility requirement rather
///   than taste.** A pre-#643 build derived this key as
///   `format!("evm:{}", claim.channel_id)`, and [`parse_evm`] only ever
///   admitted a `0x`-prefixed `channelId`, so every key already on disk
///   is `evm:0x<hex>`. For the universal case -- a client sending
///   lowercase `0x` hex -- the canonical key is therefore **byte-identical
///   to the legacy one**, which is what makes rolling a node's image back
///   to a pre-#643 build a no-op instead of a catastrophe: an older binary
///   replaying a journal this build wrote derives the same key for the
///   next claim, finds the watermark, and refuses the replay. Stripping
///   the prefix would leave that older binary computing `evm:0x<hex>`
///   against a journal folded under `evm:<hex>`, getting `None`, and
///   `validate_claim(None, ..)` re-accepting the client's entire spend
///   history. The deploy model is baked image tags on boxes where rolling
///   a tag back is routine, so that is a live path, not a hypothetical.
/// * `solana:` -- identity. Base58 of an exact 32-byte decode already has
///   exactly one spelling (a differently-spelled string decodes to a
///   different, non-32-byte value), so there is nothing to normalise and
///   normalising anyway would only risk merging two ids that are not the
///   same account.
/// * anything else -- identity, byte for byte. A key in no namespace this
///   function knows is left exactly as it was found rather than guessed
///   at: a journal's entry alphabet is shared with the peer semantics, whose
///   channel ids carry no namespace prefix at all, and quietly rewriting
///   one of those would be inventing a channel.
///
/// # Injectivity
///
/// Canonicalisation only ever *merges* spellings of one channel; it never
/// merges two channels. Within `evm:`, the canonical form is `0x` plus 64
/// lowercase hex characters -- and any string of that shape is itself
/// always canonicalised rather than falling through, so the identity
/// fallback can never emit one and collide with it. Across namespaces
/// nothing can collide: the prefix is preserved.
pub fn canonical_channel_key(key: &str) -> String {
    match key.split_once(':') {
        Some((EVM_NAMESPACE, id)) => format!("{EVM_NAMESPACE}:{}", canonical_evm_id(id)),
        _ => key.to_string(),
    }
}

/// The canonical spelling of an EVM `channelId`: see
/// [`canonical_channel_key`]'s "What canonical means" for the rule and why
/// an id that is not 64 hex characters is returned untouched rather than
/// coerced.
fn canonical_evm_id(channel_id: &str) -> String {
    let hex = channel_id.strip_prefix("0x").unwrap_or(channel_id);
    if hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        format!("0x{}", hex.to_ascii_lowercase())
    } else {
        channel_id.to_string()
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
    if !raw.bytes().all(|b| b.is_ascii_digit()) {
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

    /// Issue #613: the identity an unresolvable lookup is budgeted against
    /// is namespaced by chain for the same reason the channel key is -- an
    /// EVM address and a Solana public key are different kinds of thing,
    /// and one budget must never be spendable from the other's namespace.
    #[test]
    fn a_signer_key_is_namespaced_by_chain() {
        assert!(parse_client_claim(&evm_claim_json())
            .expect("parses")
            .signer_key()
            .starts_with("evm:"));
        assert!(parse_client_claim(solana_claim_json())
            .expect("parses")
            .signer_key()
            .starts_with("solana:"));
    }

    /// Unlike `signer_key`, `signer` carries the claim's self-declared
    /// value exactly as written -- no chain namespace, no case
    /// canonicalization -- since its one consumer (`identity::resolve_identity`)
    /// formats it into `http:<signer>` itself (client-edge-spec.md §1.2).
    #[test]
    fn signer_is_the_self_declared_value_unnamespaced_and_uncanonicalized() {
        assert_eq!(
            parse_client_claim(&evm_claim_json())
                .expect("parses")
                .signer(),
            "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1"
        );
        assert_eq!(
            parse_client_claim(solana_claim_json())
                .expect("parses")
                .signer(),
            "So11111111111111111111111111111111111111112"
        );
    }

    /// An address's casing is notation, not identity (the same rule #643
    /// established for a `channelId`). A budget keyed by the literal text
    /// would hand one sender 2^40 fresh allowances for the price of
    /// re-typing their own checksummed address, which is not a budget.
    #[test]
    fn an_evm_signer_key_is_the_same_whatever_case_its_hex_arrived_in() {
        let checksummed = parse_client_claim(&evm_claim_json())
            .expect("parses")
            .signer_key();
        let lower = parse_client_claim(&evm_claim_json().replace(
            "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb1",
            "0x742d35cc6634c0532925a3b844bc9e7595f0beb1",
        ))
        .expect("parses")
        .signer_key();

        assert_eq!(checksummed, lower);
        assert_eq!(
            checksummed,
            "evm:0x742d35cc6634c0532925a3b844bc9e7595f0beb1"
        );
    }

    // -- Canonical channel keys (issue #643) --

    /// The defect itself: hex has no case, so the same signed claim
    /// retyped in a different casing must not be a different channel. On a
    /// tree without this fix the two keys differ, each gets its own empty
    /// watermark, and `validate_claim(None, ..)` accepts the replay.
    #[test]
    fn an_evm_channel_key_is_the_same_whatever_case_its_hex_arrived_in() {
        let lower = evm_claim_json();
        let upper = lower.replace(&"ab".repeat(32), &"AB".repeat(32));
        assert_ne!(lower, upper, "the two spellings must actually differ");

        let lower_key = parse_client_claim(&lower).expect("parses").channel_key();
        let upper_key = parse_client_claim(&upper).expect("parses").channel_key();

        assert_eq!(lower_key, upper_key);
        assert_eq!(lower_key, format!("evm:0x{}", "ab".repeat(32)));
    }

    /// Mixed casing -- the shape a real attacker would reach for, since it
    /// looks least like a deliberate probe -- collapses the same way.
    #[test]
    fn an_evm_channel_key_is_the_same_for_mixed_case_hex() {
        let mixed = evm_claim_json().replace(&"ab".repeat(32), &"aB".repeat(32));
        assert_eq!(
            parse_client_claim(&mixed).expect("parses").channel_key(),
            format!("evm:0x{}", "ab".repeat(32))
        );
    }

    /// The prefix variant. Today's parser requires the `0x` prefix, so a
    /// bare-hex `channelId` never reaches a watermark at all -- but the
    /// client edge's `decode_hex_bytes` strips the prefix when it resolves
    /// the channel record, so the two *would* be one channel the moment
    /// step 1 were loosened. The key is canonical over both spellings now,
    /// so loosening the parser can never reopen this hole.
    #[test]
    fn a_bare_hex_channel_id_is_refused_today_and_canonicalises_to_the_prefixed_key_anyway() {
        let bare = evm_claim_json().replace(&format!("0x{}", "ab".repeat(32)), &"ab".repeat(32));
        assert!(
            matches!(
                parse_client_claim(&bare),
                Err(ClientClaimError::Malformed(_))
            ),
            "a bare-hex channelId is a structural failure today"
        );

        assert_eq!(
            canonical_channel_key(&format!("evm:{}", "AB".repeat(32))),
            canonical_channel_key(&format!("evm:0x{}", "ab".repeat(32)))
        );
    }

    /// **The rollback contract.** For the universal case -- a client
    /// sending the lowercase `0x` hex `parse_evm` has always required --
    /// the canonical key must be *byte-identical* to the key a pre-#643
    /// build derived, or rolling a node's image back to one of those
    /// builds orphans every watermark this build wrote and re-accepts the
    /// client's whole spend history. The legacy formula is reproduced
    /// here rather than called: it no longer exists in this tree, and
    /// this test is the contract with a binary that is not this one.
    #[test]
    fn the_canonical_key_is_byte_identical_to_the_key_a_pre_643_build_derived() {
        let claim = parse_client_claim(&evm_claim_json()).expect("parses");
        let ClientClaim::Evm(evm) = &claim else {
            panic!("expected an EVM claim");
        };

        // Exactly `ClientClaim::channel_key` as it stood before #643.
        let legacy_key = format!("evm:{}", evm.channel_id);

        assert_eq!(
            claim.channel_key(),
            legacy_key,
            "a rolled-back binary must derive the same key this build files under"
        );
        assert_eq!(claim.channel_key(), format!("evm:0x{}", "ab".repeat(32)));
    }

    /// Canonicalising a key that is already canonical changes nothing --
    /// what makes it safe to apply on both the write and the read of a
    /// watermark, and on a journal entry written by either build.
    #[test]
    fn canonicalising_a_canonical_key_is_a_no_op() {
        let key = format!("evm:0x{}", "ab".repeat(32));
        assert_eq!(canonical_channel_key(&key), key);
        assert_eq!(canonical_channel_key(&canonical_channel_key(&key)), key);
    }

    /// Solana ids are canonical as they arrive: base58 of an exact 32-byte
    /// decode has one spelling, and case is *significant* in base58 -- so
    /// this must leave them strictly alone, or it would merge two accounts
    /// that are genuinely different.
    #[test]
    fn a_solana_channel_key_is_left_exactly_as_it_arrived() {
        let account = "So11111111111111111111111111111111111111112";
        assert_eq!(
            canonical_channel_key(&format!("solana:{account}")),
            format!("solana:{account}")
        );
        assert_ne!(
            canonical_channel_key(&format!("solana:{}", account.to_lowercase())),
            format!("solana:{account}"),
            "base58 is case-sensitive: these are different accounts"
        );
    }

    /// A key in no namespace this function knows -- a peer channel id
    /// sharing the journal's entry alphabet, say -- is returned byte for
    /// byte. Rewriting one would be inventing a channel.
    #[test]
    fn a_key_in_no_known_namespace_is_returned_untouched() {
        for key in ["channel-a", "0xABCDEF", "", "mina:B62qFoo", "evm"] {
            assert_eq!(canonical_channel_key(key), key);
        }
    }

    /// Canonicalisation merges spellings of one channel, never two
    /// channels: an EVM id that is not 64 hex characters is left as it was
    /// and still cannot collide with one that was canonicalised.
    #[test]
    fn canonicalisation_never_merges_two_different_evm_channels() {
        let a = canonical_channel_key(&format!("evm:0x{}", "ab".repeat(32)));
        let b = canonical_channel_key(&format!("evm:0x{}", "cd".repeat(32)));
        let short = canonical_channel_key("evm:0xabcd");
        assert_ne!(a, b);
        assert_ne!(a, short);
        assert_eq!(short, "evm:0xabcd");
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

    /// The Solana half of the case above, on the one field issue #1127
    /// pinned. `programId` names the settlement program the
    /// `channelAccount` lives under (`client-edge-spec.md` §1.3), and it is
    /// **required**: a claim that omits it declares no program at all, which
    /// is a different and worse thing than declaring the wrong one. Only the
    /// EVM shape had a missing-field test before, so the required-ness of
    /// this field rested on `required_str`'s implementation alone.
    #[test]
    fn a_solana_claim_with_no_program_id_is_malformed() {
        let without =
            solana_claim_json().replace(r#""programId": "11111111111111111111111111111111","#, "");
        assert!(
            !without.contains("programId"),
            "the field really was removed"
        );
        let err = parse_client_claim(&without).unwrap_err();
        assert!(matches!(err, ClientClaimError::Malformed(_)), "{err:?}");
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

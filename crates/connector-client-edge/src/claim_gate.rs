//! Claim ingest gate for the client edge (`docs/protocol/client-edge-spec.md`
//! §1.3, issues #504, #522, #506/#544): turns the `ILP-Payment-Channel-Claim`
//! (`-Wrapped`) header's already-decoded JSON into a structurally valid,
//! fresh, value-covering, cryptographically verified [`ClientClaim`], or a
//! documented refusal -- structure, then freshness/watermark, then value
//! binding against the matched route's price, then (last, and only once all
//! three have passed) the claim's own signature: a replay or an
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
//! **What "verified" means here, today:** this connector has no settlement
//! configuration and no per-channel counterparty registry yet (issue #542 --
//! settlement is unconstructed), so there is nothing to compare a claim's
//! signer against except the claim's own self-declared signer field
//! (`signerAddress`/`signerPublicKey`). `verify_claim_signature` below
//! therefore checks that the signature is well-formed and recovers to *some*
//! key, and that the key is the one the claim itself declares -- narrower
//! than client-edge-spec.md §1.3 step 4's "recovers to the channel's
//! counterparty". It catches a garbage, corrupted or mismatched signature; it
//! does not catch a forger who signs correctly with their own key and simply
//! declares themself the payer. Widen this to the real counterparty once
//! #542 gives this gate a channel registry to look one up in.

use std::collections::HashMap;
use std::sync::RwLock;

use connector_domain::client_claim::{
    parse_client_claim, ClientClaim, ClientClaimError, EvmClientClaim, SolanaClientClaim,
};
use connector_domain::{advance_watermark, validate_claim, validate_price, ClaimError, Watermark};
use connector_signer::{verify_evm_balance_proof, verify_solana_balance_proof, EvmBalanceProof};

/// Why the gate refused a claim. [`ClaimIngestRejection::Mina`] and
/// [`ClaimIngestRejection::Malformed`] are kept distinct on purpose: the
/// acceptance criteria requires a Mina claim's refusal to be distinguishable
/// from a merely malformed one; [`ClaimIngestRejection::Underpayment`] is
/// kept distinct from both for the same reason (issue #522);
/// [`ClaimIngestRejection::SignatureInvalid`] is kept distinct from all of
/// them for the same reason again (issue #506/#544) -- a claim that fails
/// cryptographic verification is neither stale, malformed nor underpaying.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClaimIngestRejection {
    Malformed(String),
    Mina,
    NonceNotAdvancing,
    AmountNotAdvancing,
    Underpayment { advanced: u64, price: u64 },
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
            ClaimIngestRejection::SignatureInvalid => "claim rejected: signature does not \
                 verify against the claim's own declared signer"
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
    /// caller): structure, then freshness/watermark, then value binding
    /// against `price` -- the matched route's price (issue #522), `0` for a
    /// route that charges nothing or that isn't priced at all -- then,
    /// last, the claim's own cryptographic signature (issue #506/#544).
    /// Advances this claim's channel watermark only when the claim is
    /// fully accepted -- a rejected claim, whether stale, underpaying or
    /// unverifiable, leaves the watermark exactly as it was, so a
    /// corrected resubmission is still judged against the same baseline.
    pub fn ingest(
        &self,
        claim_json: &str,
        price: u64,
    ) -> Result<ClientClaim, ClaimIngestRejection> {
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
        verify_claim_signature(&claim)?;

        watermarks.insert(
            key,
            advance_watermark(claim.nonce(), claim.transferred_amount()),
        );
        Ok(claim)
    }
}

/// Decode a `0x`-prefixed (or bare) hex string into exactly `N` bytes, or
/// `None` for anything malformed or the wrong length -- never a panic, same
/// as every other step of this gate (issue #506's "refused as a validation
/// failure, never as a crash").
fn decode_hex_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    hex::decode(s.strip_prefix("0x").unwrap_or(s))
        .ok()?
        .try_into()
        .ok()
}

/// Decode a base58 string into exactly `N` bytes, or `None` for anything
/// malformed or the wrong length.
fn decode_base58_bytes<const N: usize>(s: &str) -> Option<[u8; N]> {
    bs58::decode(s).into_vec().ok()?.try_into().ok()
}

/// Verify a claim's own cryptographic signature -- the gate's last stage,
/// run only once structure, freshness and value have all passed (issue
/// #506/#544). See this module's own doc comment for exactly what
/// "verified" means today, absent a channel-counterparty registry (#542).
fn verify_claim_signature(claim: &ClientClaim) -> Result<(), ClaimIngestRejection> {
    let verified = match claim {
        ClientClaim::Evm(claim) => verify_evm_claim_signature(claim),
        ClientClaim::Solana(claim) => verify_solana_claim_signature(claim),
    };
    if verified {
        Ok(())
    } else {
        Err(ClaimIngestRejection::SignatureInvalid)
    }
}

fn verify_evm_claim_signature(claim: &EvmClientClaim) -> bool {
    let Some(channel_id) = decode_hex_bytes::<32>(&claim.channel_id) else {
        return false;
    };
    let Some(locks_root) = decode_hex_bytes::<32>(&claim.locks_root) else {
        return false;
    };
    let Ok(locked_amount) = claim.locked_amount.parse::<u128>() else {
        return false;
    };
    // No settlement registry yet (#542) to look a channel's domain up in --
    // a claim missing the data needed to compute its own signed digest
    // cannot be verified, and is refused rather than silently accepted.
    let Some(chain_id) = claim.chain_id else {
        return false;
    };
    let Some(token_network_address) = claim
        .token_network_address
        .as_deref()
        .and_then(decode_hex_bytes::<20>)
    else {
        return false;
    };
    let Some(expected_signer) = decode_hex_bytes::<20>(&claim.signer_address) else {
        return false;
    };
    let Some(signature) = decode_hex_bytes::<65>(&claim.signature) else {
        return false;
    };

    let proof = EvmBalanceProof {
        channel_id,
        nonce: claim.nonce,
        transferred_amount: u128::from(claim.transferred_amount),
        locked_amount,
        locks_root,
        chain_id,
        token_network_address,
    };
    verify_evm_balance_proof(&proof, &signature, &expected_signer)
}

fn verify_solana_claim_signature(claim: &SolanaClientClaim) -> bool {
    let Some(channel_account) = decode_base58_bytes::<32>(&claim.channel_account) else {
        return false;
    };
    let Some(signer_public_key) = decode_base58_bytes::<32>(&claim.signer_public_key) else {
        return false;
    };
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    let Ok(signature) = BASE64.decode(&claim.signature) else {
        return false;
    };

    verify_solana_balance_proof(
        &channel_account,
        claim.nonce,
        claim.transferred_amount,
        &signature,
        &signer_public_key,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_signer::{derive_evm_address, evm_balance_proof_digest, to_hex, Address};
    use libsecp256k1::{Message, PublicKey, SecretKey};

    const EVM_CHAIN_ID: u64 = 8453;
    const EVM_TOKEN_NETWORK_ADDRESS: [u8; 20] = [0x42; 20];

    fn hex_encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
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

    #[test]
    fn a_fresh_claim_is_accepted() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0);
        assert!(result.is_ok());
    }

    #[test]
    fn a_replayed_nonce_is_rejected_without_touching_the_watermark() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .expect("first claim accepted");

        let replay = gate.ingest(&evm_claim_json(&channel, 5, 999), 0);
        assert_eq!(replay, Err(ClaimIngestRejection::NonceNotAdvancing));

        // The watermark still holds at nonce 5 -- a genuinely advancing
        // claim after the rejected replay is judged against it, not against
        // whatever the rejected replay tried to claim.
        let next = gate.ingest(&evm_claim_json(&channel, 6, 500), 0);
        assert!(next.is_ok());
    }

    #[test]
    fn an_amount_going_backwards_is_rejected() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 500), 0)
            .expect("first claim accepted");

        let result = gate.ingest(&evm_claim_json(&channel, 2, 100), 0);
        assert_eq!(result, Err(ClaimIngestRejection::AmountNotAdvancing));
    }

    #[test]
    fn the_watermark_never_advances_on_a_rejected_claim() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 5, 500), 0)
            .expect("first claim accepted");
        gate.ingest(&evm_claim_json(&channel, 5, 999), 0)
            .unwrap_err(); // replay, rejected
        gate.ingest(&evm_claim_json(&channel, 6, 100), 0)
            .unwrap_err(); // amount regresses vs. watermark 500

        // Watermark is still exactly (5, 500): a claim of nonce 6 / amount
        // 500 (equal, not less) still advances cleanly.
        assert!(gate.ingest(&evm_claim_json(&channel, 6, 500), 0).is_ok());
    }

    #[test]
    fn different_channels_have_independent_watermarks() {
        let gate = ClientClaimGate::new();
        gate.ingest(&evm_claim_json(&channel_id(), 5, 500), 0)
            .expect("first channel");

        let other_channel = format!("0x{}", "cd".repeat(32));
        let result = gate.ingest(&evm_claim_json(&other_channel, 1, 10), 0);
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

        assert_eq!(gate.ingest(json, 0), Err(ClaimIngestRejection::Mina));
    }

    #[test]
    fn a_structurally_invalid_claim_is_rejected_as_malformed() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(r#"{"version": "1.0", "blockchain": "evm"}"#, 0);
        assert!(matches!(result, Err(ClaimIngestRejection::Malformed(_))));
    }

    #[test]
    fn a_first_claim_advancing_by_at_least_the_price_is_accepted() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 100);
        assert!(result.is_ok());
    }

    #[test]
    fn a_first_claim_advancing_by_less_than_the_price_is_underpayment() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 99), 100);
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 99,
                price: 100
            })
        );
    }

    #[test]
    fn an_underpaying_claim_does_not_advance_the_watermark() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 99), 100)
            .unwrap_err();

        // A corrected resubmission is judged against the same (untouched)
        // baseline -- nonce 1 would otherwise fail as a replay if the
        // rejected claim above had advanced anything.
        let result = gate.ingest(&evm_claim_json(&channel, 1, 100), 100);
        assert!(result.is_ok());
    }

    #[test]
    fn a_later_claim_only_needs_to_cover_the_price_since_the_watermark() {
        let gate = ClientClaimGate::new();
        let channel = channel_id();
        gate.ingest(&evm_claim_json(&channel, 1, 100), 100)
            .expect("first claim covers the price");

        // Advances by only 50 past the watermark of 100 -- underpayment
        // against a price of 100, even though the claim's own cumulative
        // transferredAmount (150) is larger than the price in isolation.
        let result = gate.ingest(&evm_claim_json(&channel, 2, 150), 100);
        assert_eq!(
            result,
            Err(ClaimIngestRejection::Underpayment {
                advanced: 50,
                price: 100
            })
        );

        // Advancing by exactly the price is accepted.
        assert!(gate.ingest(&evm_claim_json(&channel, 2, 200), 100).is_ok());
    }

    #[test]
    fn a_zero_price_route_charges_nothing() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 0), 0);
        assert!(result.is_ok());
    }

    // -- Signature verification (issue #506/#544) --

    #[test]
    fn a_genuine_evm_signature_is_accepted() {
        let gate = ClientClaimGate::new();
        let result = gate.ingest(&evm_claim_json(&channel_id(), 1, 100), 0);
        assert!(result.is_ok());
    }

    #[test]
    fn an_evm_claim_whose_signature_does_not_match_its_declared_signer_is_rejected() {
        let gate = ClientClaimGate::new();
        let (secret, _address) = evm_signer();
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

        // A genuine signature, but declared as belonging to a different
        // (also well-formed) address than the one that actually produced it.
        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            "0x000000000000000000000000000000000000dead",
            &format!(
                r#", "chainId": {EVM_CHAIN_ID}, "tokenNetworkAddress": "{}""#,
                to_hex(&EVM_TOKEN_NETWORK_ADDRESS)
            ),
        );

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn an_evm_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        let gate = ClientClaimGate::new();
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

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn an_evm_claim_with_a_truncated_signature_is_rejected_not_panicking() {
        let gate = ClientClaimGate::new();
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

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn an_evm_claim_with_no_data_to_compute_its_digest_is_rejected() {
        // No `chainId`/`tokenNetworkAddress` at all -- this connector has no
        // channel registry to fall back on (#542), so there is nothing to
        // verify a signature against.
        let gate = ClientClaimGate::new();
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

        let claim = evm_claim_json_with(
            &channel_id(),
            1,
            100,
            &format!("0x{}", hex_encode(&signature)),
            &to_hex(&address),
            "",
        );

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn a_claim_failing_signature_verification_does_not_advance_the_watermark() {
        let gate = ClientClaimGate::new();
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
        gate.ingest(&bad_signature_claim, 0).unwrap_err();

        // The watermark was never advanced by the rejected claim -- the
        // same nonce/amount is accepted here as a fresh first claim, not
        // refused as a replay.
        let genuine = gate.ingest(&evm_claim_json(&channel, 1, 100), 0);
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

    #[test]
    fn a_genuine_solana_signature_is_accepted() {
        let gate = ClientClaimGate::new();
        let channel_account = [3u8; 32];
        let claim = genuine_solana_claim_json(&channel_account, 1, 100);
        let result = gate.ingest(&claim, 0);
        assert!(result.is_ok());
    }

    #[test]
    fn a_solana_claim_whose_signature_does_not_match_its_declared_signer_is_rejected() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = ClientClaimGate::new();
        let channel_account = [3u8; 32];
        let signer = solana_signer();
        let message = connector_signer::solana_balance_proof_message(&channel_account, 1, 100);
        let signature = signer.sign(&message);

        // A genuine signature, but declared under a different public key
        // than the one that actually produced it.
        let other_public_key = [7u8; 32];
        let claim = solana_claim_json_with(
            &base58_encode(&channel_account),
            1,
            100,
            &BASE64.encode(signature.to_bytes()),
            &base58_encode(&other_public_key),
        );

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn a_solana_claim_with_a_corrupted_signature_is_rejected_not_panicking() {
        use base64::engine::general_purpose::STANDARD as BASE64;
        use base64::Engine;
        use ed25519_dalek::Signer as Ed25519Signer;

        let gate = ClientClaimGate::new();
        let channel_account = [3u8; 32];
        let keypair = solana_signer();
        let message = connector_signer::solana_balance_proof_message(&channel_account, 1, 100);
        let mut signature_bytes = keypair.sign(&message).to_bytes();
        signature_bytes[0] ^= 0xff;

        let claim = solana_claim_json_with(
            &base58_encode(&channel_account),
            1,
            100,
            &BASE64.encode(signature_bytes),
            &base58_encode(&keypair.public.to_bytes()),
        );

        let result = gate.ingest(&claim, 0);
        assert_eq!(result, Err(ClaimIngestRejection::SignatureInvalid));
    }

    #[test]
    fn a_mina_claim_is_never_routed_into_signature_verification() {
        // Mina is refused at structural parsing (ADR 0002), long before
        // this gate would ever reach a signature check -- there is no Mina
        // arm in `verify_claim_signature` to route into.
        let gate = ClientClaimGate::new();
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
        assert_eq!(gate.ingest(json, 0), Err(ClaimIngestRejection::Mina));
    }
}

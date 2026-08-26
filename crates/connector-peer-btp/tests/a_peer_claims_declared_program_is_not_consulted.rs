//! `peer-carriage-spec.md` §4.1: a Solana **peer** claim's declared
//! `programId` is validated structurally and then discarded, and a
//! disagreement with the program the channel lives under is **not**
//! reported -- the one place a peer claim is judged by a different rule
//! from the client claim it is byte-for-byte the same object as.
//!
//! `client-edge-spec.md` §1.3 step 4 requires the other answer on the other
//! edge: a connector MUST report a client claim whose `programId` is not
//! the settlement program its `channelAccount` lives under (and MUST NOT
//! refuse on it). This file is the peer edge's half of that pair, stated by
//! name so that changing the policy is a visible change to a named test
//! rather than a silent one -- the same job
//! `a_solana_claim_declaring_a_foreign_program_is_accepted_on_its_signature`
//! does in `connector-client-edge`'s claim gate.
//!
//! What the two tests below hold is the argument §4.1 makes, not just its
//! conclusion. A peer-edge report could find exactly two things, and
//! neither is actionable:
//!
//! - the peer signed under a program this node does not settle with. The
//!   signature then fails and the claim is refused outright
//!   (`a_peer_claim_signed_under_a_program_this_node_does_not_settle_with_is_refused`),
//!   so the peering moves nothing from its first packet -- a report would
//!   annotate a total failure, not surface a hidden one.
//! - the peer declared one program and signed under another
//!   (`a_peer_claim_declaring_a_foreign_program_is_accepted_on_its_signature`).
//!   That is the silent case, and the one the client edge reports; it is
//!   also the one this connector cannot produce, because a single
//!   `[settlement.solana] program_id` both renders the declared field and
//!   keys the channel the signature is checked against
//!   (`this_connectors_own_peer_claim_declares_the_program_it_is_verified_under`).
//!
//! Neither test asserts a refusal on the field, on either edge. A claim
//! that reaches the verifier with a wrong label and a right signature is
//! cryptographically correct and fully redeemable, so refusing it would
//! refuse money the node can collect (issue #1127 step 4).

use std::collections::HashMap;

use connector_peer_btp::claim_json;
use connector_runtime::{ClaimAckOutcome, ClaimBook, ClaimRejectReason, ClaimSignature, WireClaim};
use connector_signer::solana_balance_proof_message;
use ed25519_dalek::{Keypair, PublicKey, SecretKey, Signer};

/// The settlement program this node redeems under -- in production always
/// `[settlement.solana] program_id`, the only program a Solana
/// `[[peer_channels]]` row can be judged under since issue #1128. The
/// deployed SPL Token program's id, reused here only as a well-formed
/// base58 32-byte fixture, matching the const `claim_json`'s own tests use.
const PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/// A program no channel of this node's lives under. The **system program**
/// specifically, because that is the value a payer built against the wire
/// contract before PR #1133 is most likely to still be sending: it is what
/// `peer_carriage.claim_solana` declared for its whole life.
const FOREIGN_PROGRAM: &str = "11111111111111111111111111111111";

/// The Solana channel account the peering's `[[peer_channels]]` row binds.
const CHANNEL_ACCOUNT: &str = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

fn bs58_32(value: &str) -> [u8; 32] {
    let decoded = bs58::decode(value)
        .into_vec()
        .expect("a base58 32-byte fixture");
    decoded.try_into().expect("exactly 32 bytes")
}

/// The peer's own ed25519 identity, deterministic so a failure reproduces.
fn peer_keypair() -> Keypair {
    let secret = SecretKey::from_bytes(&[0x2c; 32]).expect("32 bytes is a valid seed");
    let public = PublicKey::from(&secret);
    Keypair { secret, public }
}

/// A `ClaimBook` holding this peering's one Solana channel, registered
/// under `PROGRAM` -- what `Connector::with_solana_channel` is handed at
/// boot from `[[peer_channels]]` plus `[settlement.solana]`.
fn book(peer: &Keypair) -> ClaimBook {
    let book = ClaimBook::new(None, HashMap::new(), HashMap::new());
    book.set_solana_channel(
        CHANNEL_ACCOUNT,
        &bs58::encode(peer.public.to_bytes()).into_string(),
        PROGRAM,
    )
    .expect("a 32-byte base58 account, key and program");
    book
}

/// The §4 claim JSON, declaring `declared_program` and carrying a genuine
/// ed25519 balance proof bound to `signed_program` (ADR 0053 puts the
/// program at offset 16 of that message). The two are separate parameters
/// precisely so a test can make them disagree; nothing in this connector's
/// own rendering path can.
fn peer_claim_json(peer: &Keypair, declared_program: &str, signed_program: &str) -> String {
    let message = solana_balance_proof_message(
        &bs58_32(signed_program),
        &bs58_32(CHANNEL_ACCOUNT),
        1,
        250_000,
    );
    let signature = peer.sign(&message).to_bytes();
    let public = bs58::encode(peer.public.to_bytes()).into_string();
    serde_json::json!({
        "version": "1.0",
        "blockchain": "solana",
        "messageId": "peer-claim:1",
        "timestamp": "2030-01-01T00:00:00.000Z",
        "senderId": public,
        "programId": declared_program,
        "channelAccount": CHANNEL_ACCOUNT,
        "nonce": 1,
        "transferredAmount": "250000",
        "signature": base64_encode(&signature),
        "signerPublicKey": public,
    })
    .to_string()
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.encode(bytes)
}

/// The policy, by name. A peer claim declaring a program its channel does
/// **not** live under, but signed correctly under the program this node
/// settles with, is accepted on the strength of its signature -- and
/// silently: the peer carriage reports nothing, unlike the client edge.
///
/// Inverting this test is the smallest honest statement that the policy
/// changed. Do not invert it without changing `peer-carriage-spec.md` §4.1
/// and `client-edge-spec.md` §1.3 step 4 together, and note that neither
/// edge may promote the field to a **refusal** while payers deployed
/// against the pre-#1133 contract are still sending the value this test
/// declares (issue #1127 step 4).
#[test]
fn a_peer_claim_declaring_a_foreign_program_is_accepted_on_its_signature() {
    let peer = peer_keypair();
    let json = peer_claim_json(&peer, FOREIGN_PROGRAM, PROGRAM);

    let claim = claim_json::parse(json.as_bytes()).expect("structurally valid");

    assert_eq!(
        book(&peer).accept_inbound(&claim),
        ClaimAckOutcome::Accepted,
        "the signature is checked against the channel's own program (ADR 0053), so a claim \
         mislabelling it is still fully redeemable and is not refused on the label"
    );
}

/// The parsed claim carries no program id at all, so nothing below the
/// carriage *could* compare one: two claims differing only in `programId`
/// are the same `WireClaim`. This is the structural fact §4.1 rests on, and
/// the reason a peer-edge report would cost a field on `WireClaim` -- the
/// in-process type whose whole discipline is that what a claim is checked
/// against comes from this connector's own per-channel record.
#[test]
fn two_peer_claims_differing_only_in_their_declared_program_parse_to_one_claim() {
    let peer = peer_keypair();

    let conforming =
        claim_json::parse(peer_claim_json(&peer, PROGRAM, PROGRAM).as_bytes()).expect("valid");
    let mislabelled =
        claim_json::parse(peer_claim_json(&peer, FOREIGN_PROGRAM, PROGRAM).as_bytes())
            .expect("valid");

    assert_eq!(
        conforming, mislabelled,
        "`programId` is validated structurally and then dropped, so the two are one claim"
    );
}

/// The other half of §4.1's argument: the disagreement a peer-edge report
/// *could* surface -- a peer settling under a different program -- is
/// already a hard refusal, reached by the signature rather than by the
/// label. `ClaimBook::accept_inbound` logs the rejection as
/// revenue-affecting and the verdict rides back in the claim ack, so a
/// second line naming the program would annotate a failure that is already
/// total: under §1's P3 the PREPARE this claim covered is not admitted as
/// peer traffic at all, so the peering carries nothing from its first
/// packet.
#[test]
fn a_peer_claim_signed_under_a_program_this_node_does_not_settle_with_is_refused() {
    let peer = peer_keypair();
    let json = peer_claim_json(&peer, FOREIGN_PROGRAM, FOREIGN_PROGRAM);

    let claim = claim_json::parse(json.as_bytes()).expect("structurally valid");

    assert_eq!(
        book(&peer).accept_inbound(&claim),
        ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid),
        "a claim signed under a program this node does not redeem through never verifies, \
         whatever it declares -- the misconfiguration a declared-programId check would report \
         is already refused by the bytes"
    );
}

/// Why the silent case is one this connector cannot produce. The outbound
/// half renders `programId` from the program id its `[[peer_channels]]` row
/// resolves -- `[settlement.solana] program_id`, the only value there is
/// since issue #1128 -- and the inbound half verifies against the same
/// value through `ClaimBook`. One configured value, two uses: a claim this
/// connector emits declares the program its own signature is bound to, and
/// the peer receiving it accepts it.
///
/// This is the property `peer-carriage-spec.md` §4.1 cites when it says a
/// peer-edge report would have nothing to find, so it is held here rather
/// than asserted in prose.
#[test]
fn this_connectors_own_peer_claim_declares_the_program_it_is_verified_under() {
    let peer = peer_keypair();
    let message =
        solana_balance_proof_message(&bs58_32(PROGRAM), &bs58_32(CHANNEL_ACCOUNT), 1, 250_000);
    let signed = WireClaim {
        channel_id: CHANNEL_ACCOUNT.to_string(),
        nonce: 1,
        cumulative_amount: 250_000,
        signature: ClaimSignature::Solana(peer.sign(&message).to_bytes()),
    };

    // The one program id the dial side has for this channel is the one the
    // config resolved, and it is what `encode` renders.
    let json = claim_json::encode(
        &signed,
        &[0x44; 20],
        Some(&peer.public.to_bytes()),
        Some(PROGRAM),
        None,
        "peer-claim:1",
        "2030-01-01T00:00:00.000Z",
    );

    let declared: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
    assert_eq!(declared["programId"], PROGRAM);

    let parsed = claim_json::parse(json.as_bytes()).expect("the client edge's own validator");
    assert_eq!(
        book(&peer).accept_inbound(&parsed),
        ClaimAckOutcome::Accepted,
        "the rendered label and the verified program are the same configured value"
    );
}

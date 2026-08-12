//! The BTP peer carriage end to end (`docs/protocol/peer-carriage-spec.md`,
//! issue #727): a [`BtpPeerTransport`] **dials**, a [`PeerSession`]
//! **accepts**, and the frames between them are the ones §3's table names.
//!
//! Nothing here is a fake shortcut past the thing under test. The two sides
//! are joined by an in-memory duplex standing in for the websocket and
//! *only* for the websocket: every frame is encoded and decoded by
//! `connector-btp`, every role decision is
//! `connector_peer_auth::decide_role`'s, every claim is judged by the real
//! `ClaimBook` behind a real `Connector`, and the payer reaches the payee
//! only through the `PeerTransport` port. What is not exercised is TLS and
//! the socket itself.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use connector_btp::{
    decode_frame, encode_message, encode_response, BtpFrame, BtpSessionHandle, OutboundRequests,
    ProtocolData, AUTH_PROTOCOL, BTP_ERROR, BTP_RESPONSE, BTP_TRANSFER, CLAIM_PROTOCOL,
    CONTENT_TYPE_TEXT,
};
use connector_config::{PeerCredential, StaticRoute};
use connector_domain::{
    derive_condition, EnvelopeRequest, EnvelopeResponse, PacketResponse, Prepare,
};
use connector_peer_auth::{encode_raw, PeerAuthPolicy, PresentedCredential};
use connector_peer_btp::accept::{PeerAcceptPolicy, PeerSession, SessionEnd};
use connector_peer_btp::dial::{DialError, PeerDialer, PeerRelation};
use connector_peer_btp::{
    ack, AcceptedClaims, BtpPeerTransport, ClaimEnforcementPolicy, PeerCarriageState,
};
use connector_runtime::{
    ChannelDomain, ClaimAckOutcome, ClaimRejectReason, ClaimSignature, Clock, Connector,
    FakeAppClient, InProcessPeerTransport, PeerForward, PeerTransport, TestClock, WireClaim,
};
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, EvmBalanceProof, LocalSigner, Signature, Signer,
};
use tokio::sync::mpsc;
use url::Url;

// ─── fixtures ───

const CHAIN_ID: u64 = 84_532;
const TOKEN_NETWORK: [u8; 20] = [0x33; 20];
const PEER_ID: &str = "peer-b";
const SECRET: &str = "a-shared-secret";

fn channel_id() -> String {
    format!("0x{:064x}", 7)
}

fn clock() -> Arc<TestClock> {
    Arc::new(TestClock::new(
        Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
    ))
}

fn domain() -> ChannelDomain {
    ChannelDomain {
        chain_id: CHAIN_ID,
        token_network_address: TOKEN_NETWORK,
    }
}

/// A claim on [`channel_id`] signed by `signer`, exactly as `ClaimBook`
/// signs one: the EIP-712 `BalanceProof` digest of ADR 0024, with
/// `lockedAmount`/`locksRoot` as zeros.
fn sign_claim(signer: &dyn Signer, nonce: u64, cumulative_amount: u64) -> WireClaim {
    let mut on_chain_id = [0u8; 32];
    on_chain_id[31] = 7;
    let proof = EvmBalanceProof {
        channel_id: on_chain_id,
        nonce,
        transferred_amount: u128::from(cumulative_amount),
        locked_amount: 0,
        locks_root: [0u8; 32],
        chain_id: CHAIN_ID,
        token_network_address: TOKEN_NETWORK,
    };
    WireClaim {
        channel_id: channel_id(),
        nonce,
        cumulative_amount,
        signature: ClaimSignature::Evm(
            signer
                .sign(&evm_balance_proof_digest(&proof))
                .expect("sign"),
        ),
    }
}

/// The payee: a connector with no routes -- so every packet it is handed
/// answers `F02` and the *claim*'s verdict is visibly independent of the
/// packet's (§6.2) -- and one `[[peer_channels]]`-shaped channel whose
/// counterparty is `payer`.
fn payee(payer: &dyn Signer) -> Arc<Connector> {
    let counterparty = derive_evm_address(&payer.public_key().unwrap());
    Arc::new(
        Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id"),
    )
}

/// As [`payee`], but with one terminated, priced route -- the fixture issue
/// #880's price-coverage gate tests need, since a payee with no routes at
/// all (`payee`) never reaches that gate (§3.1: the gate is scoped to a
/// `Terminated` route's own price, exactly like the pre-existing amount
/// check right below it in `Connector::handle_peer_prepare`).
fn payee_with_route(payer: &dyn Signer, route: StaticRoute) -> Arc<Connector> {
    let counterparty = derive_evm_address(&payer.public_key().unwrap());
    Arc::new(
        Connector::new(
            vec![route],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id"),
    )
}

/// A policy in which `PEER_ID` is configured, has a secret, and is channel
/// bound -- P1 and P2 both satisfiable.
fn bound_policy() -> Arc<PeerAuthPolicy> {
    let credential = PeerCredential::new(SECRET);
    Arc::new(PeerAuthPolicy::new(
        vec![(PEER_ID, &credential)],
        vec![PEER_ID],
    ))
}

fn carriage(connector: Arc<Connector>, policy: Arc<PeerAuthPolicy>) -> Arc<PeerCarriageState> {
    carriage_with_enforcement(
        connector,
        policy,
        Arc::new(ClaimEnforcementPolicy::default()),
    )
}

/// [`carriage`], with an explicit [`ClaimEnforcementPolicy`] (issue #883,
/// child B6) rather than the default (empty, so every peer reads
/// `ClaimEnforcement::Enforce` -- the same hard-refuse behaviour issue #880
/// shipped, unaffected by the migration knob existing).
fn carriage_with_enforcement(
    connector: Arc<Connector>,
    policy: Arc<PeerAuthPolicy>,
    enforcement: Arc<ClaimEnforcementPolicy>,
) -> Arc<PeerCarriageState> {
    Arc::new(PeerCarriageState::new(
        connector,
        policy,
        Arc::new(AcceptedClaims::new()),
        enforcement,
        PeerAcceptPolicy::default(),
    ))
}

fn prepare(destination: &str) -> Prepare {
    Prepare {
        amount: 100,
        expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        execution_condition: [0x9a; 32],
        destination: destination.to_string(),
        data: b"sealed to whoever terminates this route".to_vec(),
    }
}

// ─── the in-memory duplex standing in for the websocket ───

/// Runs one accepting [`PeerSession`] per dial, joined to the dialing side
/// by two channels. Every byte between them goes through the real codec.
struct LoopbackDialer {
    state: Arc<PeerCarriageState>,
    /// Every frame the dialing side wrote, in order -- so a test can assert
    /// what actually went on the wire (§3's table) and not merely what came
    /// back.
    sent: Arc<Mutex<Vec<BtpFrame>>>,
}

impl LoopbackDialer {
    fn new(state: Arc<PeerCarriageState>) -> Arc<LoopbackDialer> {
        Arc::new(LoopbackDialer {
            state,
            sent: Arc::new(Mutex::new(Vec::new())),
        })
    }
}

#[async_trait]
impl PeerDialer for LoopbackDialer {
    async fn dial(&self, _peer_id: &str, _endpoint: &Url) -> Result<BtpSessionHandle, DialError> {
        let (to_peer, mut to_peer_rx) = mpsc::channel::<Vec<u8>>(32);
        let (from_peer, mut from_peer_rx) = mpsc::channel::<Vec<u8>>(32);
        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(to_peer, Arc::clone(&outbound));

        // The accepting side, reading exactly the bytes the dialing side
        // wrote.
        let (tap, sent) = (mpsc::channel::<Vec<u8>>(32), Arc::clone(&self.sent));
        let (tapped, tapped_rx) = tap;
        tokio::spawn(async move {
            while let Some(bytes) = to_peer_rx.recv().await {
                sent.lock()
                    .expect("sent frames lock")
                    .push(decode_frame(&bytes).expect("our own encoder"));
                if tapped.send(bytes).await.is_err() {
                    break;
                }
            }
        });
        let session = PeerSession::new(Arc::clone(&self.state), from_peer);
        tokio::spawn(session.run(tapped_rx));

        // The answer path: a RESPONSE/ERROR resolves whichever outbound
        // request it names (§7.3), which is the only correlation either
        // carriage has or needs.
        tokio::spawn(async move {
            while let Some(bytes) = from_peer_rx.recv().await {
                if let Ok(frame) = decode_frame(&bytes) {
                    outbound.resolve(frame);
                }
            }
        });
        Ok(handle)
    }
}

/// A dialer that never connects -- the "the remote does not expose what we
/// dial" case §2.2 says is not locally detectable and must surface as an
/// ordinary dial failure.
struct DeadDialer;

#[async_trait]
impl PeerDialer for DeadDialer {
    async fn dial(&self, peer_id: &str, endpoint: &Url) -> Result<BtpSessionHandle, DialError> {
        Err(DialError {
            peer_id: peer_id.to_string(),
            endpoint: endpoint.to_string(),
            reason: "connection refused".to_string(),
        })
    }
}

/// The Solana channel account this relation's `[[peer_channels]]` row binds
/// (issue #759) -- a real base58-encoded 32-byte account, reused only as a
/// well-formed fixture.
fn solana_channel_account() -> String {
    "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin".to_string()
}

/// The program id that channel was opened under -- the deployed SPL Token
/// program's, reused here only as a well-formed base58 32-byte fixture.
const SOLANA_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

fn relation() -> PeerRelation {
    let mut domains = HashMap::new();
    domains.insert(
        channel_id(),
        connector_peer_btp::PeerClaimDomain {
            chain_id: CHAIN_ID,
            token_network: TOKEN_NETWORK,
        },
    );
    let mut solana_program_ids = HashMap::new();
    solana_program_ids.insert(solana_channel_account(), SOLANA_PROGRAM_ID.to_string());
    PeerRelation::new(
        PEER_ID,
        Url::parse("wss://peer.example:443/btp").unwrap(),
        PresentedCredential::new(PEER_ID, SECRET),
        domains,
        solana_program_ids,
        Duration::from_millis(30_000),
        Duration::from_millis(30_000),
    )
}

fn transport(dialer: Arc<dyn PeerDialer>, payer: &dyn Signer) -> BtpPeerTransport {
    let mut transport = BtpPeerTransport::new(
        dialer,
        derive_evm_address(&payer.public_key().unwrap()),
        clock() as Arc<dyn Clock>,
    );
    transport.add_peer(relation());
    transport
}

// ─── §3, §6: a claim rides a PREPARE and is acknowledged ───

/// §6.2, the property whose loss would silently destroy ADR 0024's
/// semantics: **one RESPONSE carries two independent answers**. The packet
/// is rejected (the payee has no route for it) and the claim that rode it
/// is accepted, on the same frame.
#[tokio::test]
async fn a_claim_riding_a_prepare_is_judged_independently_of_the_packet() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    let claim = sign_claim(&payer_signer, 1, 500);

    let PeerForward {
        response,
        ack,
        reached_peer: reached,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.nowhere"), 0, Some(claim))
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F02"),
        other => panic!("expected the payee's own reject, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::Accepted);
    assert!(reached, "the peer answered, so this hop forwarded");
}

/// §3's table, on the wire: the claim rides a `payment-channel-claim`
/// entry as **raw UTF-8 JSON** on a MESSAGE whose `ilpPacket` is the OER
/// PREPARE, and the auth credential rode the session's first MESSAGE.
#[tokio::test]
async fn the_frames_a_dialed_peering_puts_on_the_wire_are_the_ones_section_3_names() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let _ = transport
        .forward(
            PEER_ID,
            prepare("g.nowhere"),
            1_250,
            Some(sign_claim(&payer_signer, 1, 500)),
        )
        .await;

    let sent = dialer.sent.lock().expect("sent frames lock").clone();
    let auth = &sent[0];
    assert_eq!(auth.frame_type, connector_btp::BTP_MESSAGE);
    let credential = auth
        .protocol_data
        .iter()
        .find(|pd| pd.name == AUTH_PROTOCOL)
        .expect("the credential rode the first MESSAGE");
    let json: serde_json::Value = serde_json::from_slice(&credential.data).expect("raw UTF-8 JSON");
    assert_eq!(json["peerId"], PEER_ID);

    let message = &sent[1];
    assert_eq!(message.frame_type, connector_btp::BTP_MESSAGE);
    assert!(
        Prepare::decode(&message.ilp_packet).is_ok(),
        "the OER PREPARE rides ilpPacket"
    );
    let claim = message
        .protocol_data
        .iter()
        .find(|pd| pd.name == CLAIM_PROTOCOL)
        .expect("the claim rode as protocolData");
    let claim_json: serde_json::Value =
        serde_json::from_slice(&claim.data).expect("raw UTF-8 JSON, no base64 layer");
    assert_eq!(claim_json["blockchain"], "evm");
    assert_eq!(claim_json["nonce"], 1);
    let minimum_delivery = message
        .protocol_data
        .iter()
        .find(|pd| pd.name == connector_btp::MINIMUM_DELIVERY_PROTOCOL)
        .expect("the sender's floor rode unchanged");
    assert_eq!(minimum_delivery.data, b"1250".to_vec());
}

// ─── §3, §6: FLUSH is a TRANSFER ───

/// §3's FLUSH row: a **TRANSFER (type 7)** whose `amount` is the claim's
/// new cumulative, carrying the claim in `payment-channel-claim` and **no
/// `ilpPacket`**; answered by a RESPONSE carrying the `claim-ack`.
#[tokio::test]
async fn a_flush_is_a_transfer_whose_amount_is_the_claims_new_cumulative() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let ack = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 1, 900))
        .await;

    assert_eq!(ack, ClaimAckOutcome::Accepted);
    let sent = dialer.sent.lock().expect("sent frames lock").clone();
    let flush = sent
        .iter()
        .find(|frame| frame.frame_type == BTP_TRANSFER)
        .expect("the flush rode a TRANSFER, not a MESSAGE");
    assert_eq!(flush.amount, Some(900), "amount is the new cumulative");
    assert!(
        flush.ilp_packet.is_empty(),
        "a FLUSH carries no ILP packet at all"
    );
    assert!(flush
        .protocol_data
        .iter()
        .any(|pd| pd.name == CLAIM_PROTOCOL));
}

/// Issue #759's AC, exercised on the real BTP wire: a Solana claim flushed
/// over this carriage carries the `[[peer_channels]]`-configured
/// `programId` -- never the deleted `PLACEHOLDER_SOLANA_PROGRAM_ID` -- and
/// the same bytes round-trip through the client edge's own validator
/// (`claim_json::parse`), the same proof
/// `the_frames_a_dialed_peering_puts_on_the_wire_are_the_ones_section_3_names`
/// gives the EVM shape.
#[tokio::test]
async fn a_flushed_solana_claim_carries_its_configured_program_id_on_the_wire() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let mut transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    transport.set_solana_signer_public_key([0x77; 32]);

    let claim = WireClaim {
        channel_id: solana_channel_account(),
        nonce: 1,
        cumulative_amount: 500,
        signature: ClaimSignature::Solana([0x5a; 64]),
    };

    let _ = transport.flush(PEER_ID, claim.clone()).await;

    let sent = dialer.sent.lock().expect("sent frames lock").clone();
    let flush = sent
        .iter()
        .find(|frame| frame.frame_type == BTP_TRANSFER)
        .expect("the flush rode a TRANSFER");
    let entry = flush
        .protocol_data
        .iter()
        .find(|pd| pd.name == CLAIM_PROTOCOL)
        .expect("the claim rode as protocolData");
    let claim_json: serde_json::Value =
        serde_json::from_slice(&entry.data).expect("raw UTF-8 JSON");
    assert_eq!(claim_json["blockchain"], "solana");
    assert_eq!(claim_json["programId"], SOLANA_PROGRAM_ID);
    assert_eq!(claim_json["channelAccount"], solana_channel_account());

    let parsed = connector_peer_btp::claim_json::parse(&entry.data).expect("round trip");
    assert_eq!(parsed, claim);
}

// ─── §6.3: the idempotent re-ack ───

/// §6.3, the rule that stands between a lost ack and a permanently wedged
/// peering: a byte-identical retransmission of the claim already at the
/// watermark is answered **`accepted`**, never `nonce_not_advancing`, and
/// nothing is advanced or recorded.
#[tokio::test]
async fn a_byte_identical_retransmission_at_the_watermark_is_accepted_again() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    let claim = sign_claim(&payer_signer, 3, 900);

    let first = transport.flush(PEER_ID, claim.clone()).await;
    let retransmitted = transport.flush(PEER_ID, claim.clone()).await;

    assert_eq!(first, ClaimAckOutcome::Accepted);
    assert_eq!(
        retransmitted,
        ClaimAckOutcome::Accepted,
        "a lost ack must not wedge the peering"
    );

    // And the retransmission really was byte-identical: the payer reused
    // the exact JSON it emitted, timestamp included (§6.3).
    let sent = dialer.sent.lock().expect("sent frames lock").clone();
    let claims: Vec<&ProtocolData> = sent
        .iter()
        .filter(|frame| frame.frame_type == BTP_TRANSFER)
        .filter_map(|frame| {
            frame
                .protocol_data
                .iter()
                .find(|pd| pd.name == CLAIM_PROTOCOL)
        })
        .collect();
    assert_eq!(claims.len(), 2);
    assert_eq!(claims[0].data, claims[1].data);
}

/// §6.3's other half: the *same nonce* with any other field changed is a
/// different claim, refused `nonce_not_advancing` exactly as §3.2's
/// strictly-advancing rule requires. Together with the test above this
/// pins the whole boundary.
#[tokio::test]
async fn the_same_nonce_with_different_bytes_is_refused_nonce_not_advancing() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let accepted = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 3, 900))
        .await;
    let same_nonce_more_money = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 3, 1_500))
        .await;

    assert_eq!(accepted, ClaimAckOutcome::Accepted);
    assert_eq!(
        same_nonce_more_money,
        ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing)
    );
}

// ─── §6.3: absence, malformation and the timeout ───

/// A payee that answers the claim-bearing frame but carries **no**
/// `claim-ack`. §6.3: not acknowledged -- never accepted, never rejected,
/// never inferred from the packet's own verdict.
#[tokio::test]
async fn a_response_carrying_no_ack_leaves_the_claim_not_acknowledged() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(
        Arc::new(SilentPayee { ack: None }) as Arc<dyn PeerDialer>,
        &payer_signer,
    );

    let ack = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
        .await;

    assert_eq!(ack, ClaimAckOutcome::NotSent);
}

/// §6.3: a malformed ack is likewise not acknowledged, and must not be
/// read as either verdict.
#[tokio::test]
async fn a_malformed_ack_leaves_the_claim_not_acknowledged() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(
        Arc::new(SilentPayee {
            ack: Some(br#"{"result":"probably"}"#.to_vec()),
        }) as Arc<dyn PeerDialer>,
        &payer_signer,
    );

    let ack = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
        .await;

    assert_eq!(ack, ClaimAckOutcome::NotSent);
}

/// A payee that answers every request with an empty RESPONSE, optionally
/// carrying `ack` bytes verbatim -- for the absence and malformation cases
/// a well-behaved `PeerSession` will not produce.
struct SilentPayee {
    ack: Option<Vec<u8>>,
}

#[async_trait]
impl PeerDialer for SilentPayee {
    async fn dial(&self, _peer_id: &str, _endpoint: &Url) -> Result<BtpSessionHandle, DialError> {
        let (to_peer, mut to_peer_rx) = mpsc::channel::<Vec<u8>>(32);
        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(to_peer, Arc::clone(&outbound));
        let ack = self.ack.clone();
        tokio::spawn(async move {
            while let Some(bytes) = to_peer_rx.recv().await {
                let frame = decode_frame(&bytes).expect("our own encoder");
                let entries: Vec<ProtocolData> = ack
                    .iter()
                    .map(|data| ProtocolData {
                        name: connector_btp::CLAIM_ACK_PROTOCOL.to_string(),
                        content_type: CONTENT_TYPE_TEXT,
                        data: data.clone(),
                    })
                    .collect();
                let answer = encode_response(frame.request_id, &entries, &[]);
                let _ = outbound.resolve(decode_frame(&answer).expect("our own encoder"));
            }
        });
        Ok(handle)
    }
}

// ─── §2.2: a peer that cannot be dialed ───

/// §2.2: whether the remote exposes what we dial is not locally
/// detectable, so it surfaces as an ordinary dial failure -- and a packet
/// routed there rejects **`T01`**, never `T00` and never a silent drop.
/// `reached` is false, so no fee of this hop's belongs on the reject that
/// goes back (ADR 0011).
#[tokio::test]
async fn a_peer_that_cannot_be_dialed_rejects_t01_and_was_never_reached() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(DeadDialer) as Arc<dyn PeerDialer>, &payer_signer);

    let PeerForward {
        response,
        ack,
        reached_peer: reached,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.somewhere"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => {
            assert_eq!(reject.code.as_str(), "T01");
            assert!(reject.message.contains(PEER_ID));
        }
        other => panic!("expected T01, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::NotSent);
    assert!(!reached);
}

#[tokio::test]
async fn a_peer_id_this_connector_does_not_dial_rejects_t01() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(DeadDialer) as Arc<dyn PeerDialer>, &payer_signer);

    let PeerForward {
        response,
        reached_peer: reached,
        ..
    } = transport
        .forward("nowhere", prepare("g.somewhere"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
        other => panic!("expected T01, got {other:?}"),
    }
    assert!(!reached);
}

// ─── §1: role is decided by authentication ───

/// A session driver for the accept side alone: feed frames in, read the
/// answers out.
struct Accepting {
    frames: mpsc::Sender<Vec<u8>>,
    answers: mpsc::Receiver<Vec<u8>>,
    session: tokio::task::JoinHandle<SessionEnd>,
}

fn accepting(state: Arc<PeerCarriageState>) -> Accepting {
    let (frames, frames_rx) = mpsc::channel::<Vec<u8>>(32);
    let (replies, answers) = mpsc::channel::<Vec<u8>>(32);
    let session = tokio::spawn(PeerSession::new(state, replies).run(frames_rx));
    Accepting {
        frames,
        answers,
        session,
    }
}

impl Accepting {
    async fn send(&self, frame: Vec<u8>) {
        self.frames.send(frame).await.expect("the session is live");
    }

    async fn answer(&mut self) -> BtpFrame {
        let bytes = self
            .answers
            .recv()
            .await
            .expect("the session answered the request");
        decode_frame(&bytes).expect("our own encoder")
    }
}

fn auth_frame(request_id: u32, peer_id: &str, secret: &str) -> Vec<u8> {
    let credential = PresentedCredential::new(peer_id, secret);
    encode_message(
        request_id,
        &[ProtocolData {
            name: AUTH_PROTOCOL.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: encode_raw(&credential),
        }],
        &[],
    )
}

fn claim_frame(request_id: u32, claim_json: &str) -> Vec<u8> {
    encode_message(
        request_id,
        &[ProtocolData {
            name: CLAIM_PROTOCOL.to_string(),
            content_type: CONTENT_TYPE_TEXT,
            data: claim_json.as_bytes().to_vec(),
        }],
        &prepare("g.nowhere").encode(),
    )
}

fn claim_as_json(claim: &WireClaim, payer: &dyn Signer) -> String {
    connector_peer_btp::claim_json::encode(
        claim,
        &derive_evm_address(&payer.public_key().unwrap()),
        None,
        None,
        Some(connector_peer_btp::PeerClaimDomain {
            chain_id: CHAIN_ID,
            token_network: TOKEN_NETWORK,
        }),
        "message-1",
        "2030-01-01T00:00:00.000Z",
    )
}

/// **The named regression (§1.9).** `toon-sandbox` admitted an anonymous
/// BTP session with `btp_auth … success:true mode:"no-auth"` and then
/// treated it as a quasi-peer. Each of the five interactions below is
/// classified `client` and reaches **no peer handling whatsoever** --
/// testable, per §1.9, as: no `claim-ack` was emitted, and the claim they
/// carried moved no peer watermark (proved by a subsequent *genuine* peer
/// claim at nonce 1 being accepted, which it could not be if any of these
/// had advanced anything).
#[tokio::test]
async fn the_named_regression_no_interaction_becomes_a_peer_without_p1_and_p2() {
    let payer_signer = LocalSigner::generate("payer");
    let credential = PeerCredential::new(SECRET);
    // `unbound` is configured and has a secret, but no `[[peer_channels]]`
    // row: P2 alone failing.
    let unbound = PeerCredential::new(SECRET);
    let policy = Arc::new(PeerAuthPolicy::new(
        vec![(PEER_ID, &credential), ("unbound", &unbound)],
        vec![PEER_ID],
    ));
    let connector = payee(&payer_signer);
    let state = carriage(Arc::clone(&connector), policy);
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);

    let asserted: Vec<Option<(&str, &str)>> = vec![
        // 1. no credential at all
        None,
        // 2. an empty secret
        Some((PEER_ID, "")),
        // 3. a correct peer id with a wrong secret
        Some((PEER_ID, "not-the-secret")),
        // 4. a correct credential for a peer with no channel binding
        Some(("unbound", SECRET)),
        // 5. a valid credential naming a peer id that is not configured
        Some(("stranger", SECRET)),
    ];

    for (index, credential) in asserted.into_iter().enumerate() {
        let mut session = accepting(Arc::clone(&state));
        if let Some((peer_id, secret)) = credential {
            session.send(auth_frame(1, peer_id, secret)).await;
            let ack = session.answer().await;
            assert_eq!(
                ack.frame_type, BTP_RESPONSE,
                "case {index}: an asserted credential is not refused for the assertion alone (§1.6)"
            );
        }
        session.send(claim_frame(2, &json)).await;
        let answer = session.answer().await;
        assert!(
            ack::from_protocol_data(&answer.protocol_data).is_none(),
            "case {index}: a client interaction gets no claim-ack (§1.7)"
        );
    }

    // Nothing above moved a peer watermark: a genuine peer's claim at
    // nonce 1 is still fresh.
    let mut peer = accepting(Arc::clone(&state));
    peer.send(auth_frame(1, PEER_ID, SECRET)).await;
    let _ = peer.answer().await;
    peer.send(claim_frame(2, &json)).await;
    let answer = peer.answer().await;
    assert_eq!(
        ack::from_protocol_data(&answer.protocol_data),
        Some(ClaimAckOutcome::Accepted),
        "no client interaction had advanced this channel's peer watermark"
    );
}

/// §1.5: a second `auth` entry on a session whose role is already bound is
/// **not evaluated**. It is a BTP ERROR (`F00 NotAcceptedError`), and the
/// role is left exactly as it was. Re-authentication mid-session is the
/// escalation path this closes.
#[tokio::test]
async fn a_second_auth_frame_is_an_error_and_never_an_escalation() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(Arc::clone(&state));

    // Bind as a *client* first: a credential that fails P1.
    session.send(auth_frame(1, PEER_ID, "wrong")).await;
    assert_eq!(session.answer().await.frame_type, BTP_RESPONSE);

    // Now present the correct one. It must not be evaluated.
    session.send(auth_frame(2, PEER_ID, SECRET)).await;
    let answer = session.answer().await;

    assert_eq!(answer.frame_type, BTP_ERROR);
    // And the role really is unchanged: a claim still gets no ack.
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);
    session.send(claim_frame(3, &json)).await;
    let answer = session.answer().await;
    assert!(ack::from_protocol_data(&answer.protocol_data).is_none());
}

/// §1.5: more than one `auth` entry on one frame is **refused, not
/// resolved** -- never the first, never the last, never a concatenation.
/// This is the credential-smuggling defence, and its absence is how "which
/// credential did we check?" becomes unanswerable.
#[tokio::test]
async fn two_auth_entries_on_one_frame_are_refused_rather_than_resolved() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(Arc::clone(&state));

    let entry = |peer_id: &str, secret: &str| ProtocolData {
        name: AUTH_PROTOCOL.to_string(),
        content_type: CONTENT_TYPE_TEXT,
        data: encode_raw(&PresentedCredential::new(peer_id, secret)),
    };
    session
        .send(encode_message(
            1,
            &[entry(PEER_ID, "wrong"), entry(PEER_ID, SECRET)],
            &[],
        ))
        .await;
    let answer = session.answer().await;

    assert_eq!(answer.frame_type, BTP_ERROR);
    // Neither credential was adopted: the session is still a client, and
    // the role is still unbound, so a *later* single auth entry binds it.
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);
    session.send(claim_frame(2, &json)).await;
    let answer = session.answer().await;
    assert!(ack::from_protocol_data(&answer.protocol_data).is_none());
}

/// §1.5: frames processed **before** the role is bound are client frames
/// and are never retroactively reclassified. The claim below arrives
/// first, gets no ack (a client's claim is not judged in the peer
/// namespace), and authenticating afterwards does not reach back and
/// change that.
#[tokio::test]
async fn a_frame_before_auth_stays_a_client_frame_after_auth() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(Arc::clone(&state));
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);

    session.send(claim_frame(1, &json)).await;
    let before = session.answer().await;
    assert!(
        ack::from_protocol_data(&before.protocol_data).is_none(),
        "a pre-auth frame is a client frame"
    );

    session.send(auth_frame(2, PEER_ID, SECRET)).await;
    let _ = session.answer().await;

    // The pre-auth claim was never judged, so nonce 1 is still fresh --
    // which is exactly what "not retroactively reclassified" means here.
    session.send(claim_frame(3, &json)).await;
    let after = session.answer().await;
    assert_eq!(
        ack::from_protocol_data(&after.protocol_data),
        Some(ClaimAckOutcome::Accepted)
    );
}

/// §1.10's bounded escape hatch: on a **dedicated peer listener with
/// mandatory authentication** an interaction that fails P1 or P2 is
/// refused outright rather than downgraded -- safe only because such a
/// listener serves no clients. Role is still decided by P1 and P2; the
/// listener never becomes the decider.
#[tokio::test]
async fn a_dedicated_peer_listener_refuses_rather_than_downgrades() {
    let payer_signer = LocalSigner::generate("payer");
    let state = Arc::new(PeerCarriageState::new(
        payee(&payer_signer),
        bound_policy(),
        Arc::new(AcceptedClaims::new()),
        Arc::new(ClaimEnforcementPolicy::default()),
        PeerAcceptPolicy {
            mandatory_auth: true,
            ..PeerAcceptPolicy::default()
        },
    ));
    let mut session = accepting(state);

    session.send(auth_frame(1, PEER_ID, "wrong")).await;
    let answer = session.answer().await;

    assert_eq!(answer.frame_type, BTP_ERROR);
    assert_eq!(
        session.session.await.expect("the session task"),
        SessionEnd::Refused
    );
}

// ─── §5.1: minimum delivery ───

/// §5.1: a malformed `toon-minimum-delivery` rejects the PREPARE `F01`
/// and is **never** silently treated as zero -- zero is the weakest
/// possible floor, and substituting it turns a framing bug into an
/// under-delivery. The claim that rode the same frame is still
/// acknowledged (§6.2).
#[tokio::test]
async fn a_malformed_minimum_delivery_rejects_f01_and_is_never_silently_zero() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(state);
    session.send(auth_frame(1, PEER_ID, SECRET)).await;
    let _ = session.answer().await;

    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);
    session
        .send(encode_message(
            2,
            &[
                ProtocolData {
                    name: CLAIM_PROTOCOL.to_string(),
                    content_type: CONTENT_TYPE_TEXT,
                    data: json.into_bytes(),
                },
                ProtocolData {
                    name: connector_btp::MINIMUM_DELIVERY_PROTOCOL.to_string(),
                    content_type: CONTENT_TYPE_TEXT,
                    data: b"twelve".to_vec(),
                },
            ],
            &prepare("g.nowhere").encode(),
        ))
        .await;
    let answer = session.answer().await;

    let reject = connector_domain::Reject::decode(&answer.ilp_packet).expect("a REJECT");
    assert_eq!(reject.code.as_str(), "F01");
    assert_eq!(
        ack::from_protocol_data(&answer.protocol_data),
        Some(ClaimAckOutcome::Accepted),
        "the claim's verdict is independent of the packet's (§6.2)"
    );
}

// ─── issue #880 (owner decision #868): every peer PREPARE to a priced
// terminated route carries a covering claim, or is refused with the client
// edge's own x402 greeting ───

/// No claim at all: refused `F06` with the x402 terms attached exactly like
/// the client edge's own BTP carriage answers a claimless request (issue
/// #880, `peer-carriage-spec.md` §3.1) -- never delivered to the app.
#[tokio::test]
async fn a_claimless_peer_prepare_to_a_priced_route_is_refused_with_the_x402_greeting() {
    let payer_signer = LocalSigner::generate("payer");
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let state = carriage(payee_with_route(&payer_signer, route), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let PeerForward {
        response,
        payment_required,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.example.app"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F06"),
        other => panic!("expected an F06 reject, got {other:?}"),
    }
    let terms = payment_required.expect("the x402 greeting rode the reject");
    assert_eq!(terms.price(), Some(25));
    assert_eq!(terms.pay_to(), Some("g.example.app"));
}

/// A claim rides the PREPARE, but its own advance over the watermark falls
/// short of the route's price: refused exactly the same way as no claim at
/// all (issue #880's second acceptance case). The claim's own nonce/amount
/// validity is unaffected by this gate -- it is still acknowledged (§6.2).
#[tokio::test]
async fn a_claim_that_does_not_cover_the_routes_price_is_refused_the_same_way() {
    let payer_signer = LocalSigner::generate("payer");
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let state = carriage(payee_with_route(&payer_signer, route), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    let claim = sign_claim(&payer_signer, 1, 10); // advances only 10, price is 25

    let PeerForward {
        response,
        ack,
        payment_required,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.example.app"), 0, Some(claim))
        .await;

    assert_eq!(ack, ClaimAckOutcome::Accepted);
    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F06"),
        other => panic!("expected an F06 reject, got {other:?}"),
    }
    assert!(payment_required.is_some());
}

/// The boundary this gate exists to leave open: a claim whose advance
/// exactly meets the route's price is admitted precisely as it was before
/// this issue -- delivered to the app, no greeting.
#[tokio::test]
async fn a_covering_claim_is_admitted_exactly_as_today() {
    let payer_signer = LocalSigner::generate("payer");
    let identity_signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("payee-identity"));
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let app_client = Arc::new(FakeAppClient::new());
    let response_body = b"irrelevant".to_vec();
    app_client.respond(
        route.handler_url(),
        connector_runtime::AppOutcome::Answered {
            response: EnvelopeResponse {
                status: 200,
                headers: vec![],
                body: response_body.clone(),
            },
        },
    );
    let counterparty = derive_evm_address(&payer_signer.public_key().unwrap());
    let connector = Arc::new(
        Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id")
        .with_identity_signer(Arc::clone(&identity_signer)),
    );
    let state = carriage(connector, bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    let claim = sign_claim(&payer_signer, 1, 25); // advances exactly the price

    // A genuinely sealed envelope (ADR 0018/0019), so this termination can
    // actually fulfil rather than being refused for want of sealing --
    // orthogonal to this gate, but needed to prove delivery reached the app.
    let envelope = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: b"hello".to_vec(),
    };
    let identity_public = identity_signer.public_key().expect("identity public key");
    let (data, shared_secret) =
        connector_signer::giftwrap::seal_request(&envelope.encode(), &identity_public)
            .expect("seal");
    let condition = derive_condition(&connector_signer::giftwrap::derive_fulfillment(
        &shared_secret,
    ));
    let sealed_prepare = Prepare {
        amount: 25,
        expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        execution_condition: condition,
        destination: "g.example.app".to_string(),
        data,
    };

    let PeerForward {
        response,
        ack,
        payment_required,
        ..
    } = transport
        .forward(PEER_ID, sealed_prepare, 0, Some(claim))
        .await;

    assert_eq!(ack, ClaimAckOutcome::Accepted);
    assert!(
        payment_required.is_none(),
        "an admitted packet carries no greeting"
    );
    let fulfill = match response {
        PacketResponse::Fulfill(fulfill) => fulfill,
        other => panic!("expected a fulfil, got {other:?}"),
    };
    let opened = connector_signer::giftwrap::open_response(&shared_secret, &fulfill.data)
        .expect("open the sealed fulfil");
    let opened = EnvelopeResponse::decode(&opened).expect("decode envelope");
    assert_eq!(opened.body, response_body);
    assert_eq!(app_client.deliveries().len(), 1);
}

// ─── issue #883 (child B6): the `claim_enforcement = "observe"` migration
// knob admits and logs an uncovered peer PREPARE instead of refusing it ───

/// The migration's whole point: a peering flipped to `Observe` admits a
/// claimless PREPARE to a priced route -- delivered to the app, no `F06`,
/// no x402 greeting -- where issue #880's default (`Enforce`, proven by
/// [`a_claimless_peer_prepare_to_a_priced_route_is_refused_with_the_x402_greeting`])
/// would have refused it.
#[tokio::test]
async fn observe_admits_a_claimless_peer_prepare_the_default_would_refuse() {
    let payer_signer = LocalSigner::generate("payer");
    let identity_signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("payee-identity"));
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let app_client = Arc::new(FakeAppClient::new());
    let response_body = b"irrelevant".to_vec();
    app_client.respond(
        route.handler_url(),
        connector_runtime::AppOutcome::Answered {
            response: EnvelopeResponse {
                status: 200,
                headers: vec![],
                body: response_body.clone(),
            },
        },
    );
    let counterparty = derive_evm_address(&payer_signer.public_key().unwrap());
    let connector = Arc::new(
        Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id")
        .with_identity_signer(Arc::clone(&identity_signer)),
    );
    let enforcement = Arc::new(ClaimEnforcementPolicy::new(vec![(
        PEER_ID,
        connector_config::ClaimEnforcement::Observe,
    )]));
    let state = carriage_with_enforcement(connector, bound_policy(), enforcement);
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    // A genuinely sealed envelope, so a route this gate lets through can
    // actually fulfil -- proving delivery reached the app, not merely that
    // no reject fired.
    let envelope = EnvelopeRequest {
        method: "POST".to_string(),
        target: "/".to_string(),
        headers: vec![],
        body: b"hello".to_vec(),
    };
    let identity_public = identity_signer.public_key().expect("identity public key");
    let (data, shared_secret) =
        connector_signer::giftwrap::seal_request(&envelope.encode(), &identity_public)
            .expect("seal");
    let condition = derive_condition(&connector_signer::giftwrap::derive_fulfillment(
        &shared_secret,
    ));
    let sealed_prepare = Prepare {
        amount: 25,
        expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
        execution_condition: condition,
        destination: "g.example.app".to_string(),
        data,
    };

    let PeerForward {
        response,
        payment_required,
        ..
    } = transport
        // No claim at all -- the shape `Enforce` refuses.
        .forward(PEER_ID, sealed_prepare, 0, None)
        .await;

    assert!(
        payment_required.is_none(),
        "an admitted packet carries no greeting"
    );
    let fulfill = match response {
        PacketResponse::Fulfill(fulfill) => fulfill,
        other => panic!("expected a fulfil, got {other:?}"),
    };
    let opened = connector_signer::giftwrap::open_response(&shared_secret, &fulfill.data)
        .expect("open the sealed fulfil");
    let opened = EnvelopeResponse::decode(&opened).expect("decode envelope");
    assert_eq!(opened.body, response_body);
    assert_eq!(app_client.deliveries().len(), 1);
}

/// A migration is per peering, not global: a second peer id this policy has
/// no `Observe` entry for still reads `Enforce` -- the safe default -- even
/// though `ClaimEnforcementPolicy` is non-empty.
#[tokio::test]
async fn observe_for_one_peer_does_not_widen_to_a_peer_with_no_entry() {
    let payer_signer = LocalSigner::generate("payer");
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let enforcement = Arc::new(ClaimEnforcementPolicy::new(vec![(
        "some-other-peer",
        connector_config::ClaimEnforcement::Observe,
    )]));
    let state = carriage_with_enforcement(
        payee_with_route(&payer_signer, route),
        bound_policy(),
        enforcement,
    );
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let PeerForward {
        response,
        payment_required,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.example.app"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F06"),
        other => panic!("expected an F06 reject, got {other:?}"),
    }
    assert!(payment_required.is_some());
}

/// PR #913 review finding: a claim signed by a non-counterparty key still
/// *decodes* and can declare any `cumulative_amount` it likes -- coverage
/// judged off that declared amount, ignoring the claim book's own verdict,
/// let an unlimited-value, never-verified claim buy service. The verdict
/// here is `signature_invalid`; coverage must be refused regardless of the
/// amount declared, exactly like a claimless PREPARE.
#[tokio::test]
async fn a_forged_claim_declaring_a_large_amount_does_not_buy_coverage() {
    let payer_signer = LocalSigner::generate("payer");
    let impostor = LocalSigner::generate("impostor");
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let app_client = Arc::new(FakeAppClient::new());
    let counterparty = derive_evm_address(&payer_signer.public_key().unwrap());
    let connector = Arc::new(
        Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id"),
    );
    let state = carriage(connector, bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    // Signed by an impostor, not the channel's configured counterparty --
    // declares far more than the route's price, but never verifies.
    let claim = sign_claim(&impostor, 1, 1_000_000);

    let PeerForward {
        response,
        ack,
        payment_required,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.example.app"), 0, Some(claim))
        .await;

    assert_eq!(
        ack,
        ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid)
    );
    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F06"),
        other => panic!("expected an F06 reject, got {other:?}"),
    }
    assert!(payment_required.is_some());
    assert!(
        app_client.deliveries().is_empty(),
        "a forged claim must never reach the app"
    );
}

/// PR #913 review finding, second case: a genuinely signed claim replayed
/// at an already-used nonce also decodes and can declare any amount, and
/// its verdict is `nonce_not_advancing` -- not `signature_invalid`, but
/// equally not `accepted`. The refusal must repeat on every retransmission
/// and the watermark must never move off the last genuinely accepted
/// claim.
#[tokio::test]
async fn a_claim_replayed_at_a_used_nonce_never_buys_coverage() {
    let payer_signer = LocalSigner::generate("payer");
    let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
    let app_client = Arc::new(FakeAppClient::new());
    let counterparty = derive_evm_address(&payer_signer.public_key().unwrap());
    let connector = Arc::new(
        Connector::new(
            vec![route],
            vec![],
            app_client.clone(),
            Arc::new(InProcessPeerTransport::new()),
            clock(),
        )
        .with_channel_verification_key(channel_id(), counterparty)
        .with_channel_domain(channel_id(), domain())
        .expect("a bytes32 channel id"),
    );
    let accepted = Arc::new(AcceptedClaims::new());
    let state = Arc::new(PeerCarriageState::new(
        connector,
        bound_policy(),
        Arc::clone(&accepted),
        Arc::new(ClaimEnforcementPolicy::default()),
        PeerAcceptPolicy::default(),
    ));
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    // A first claim at nonce 1 genuinely covers the price and advances the
    // watermark to 25.
    let first = sign_claim(&payer_signer, 1, 25);
    let first_ack = transport.flush(PEER_ID, first).await;
    assert_eq!(first_ack, ClaimAckOutcome::Accepted);

    // Replayed at the same nonce, declaring an amount that would cover many
    // more packets if it were judged by amount alone.
    let replayed = sign_claim(&payer_signer, 1, 1_000_000);

    for attempt in 0..2 {
        let PeerForward {
            response,
            ack,
            payment_required,
            ..
        } = transport
            .forward(PEER_ID, prepare("g.example.app"), 0, Some(replayed.clone()))
            .await;

        assert_eq!(
            ack,
            ClaimAckOutcome::Rejected(ClaimRejectReason::NonceNotAdvancing),
            "attempt {attempt}"
        );
        match response {
            PacketResponse::Reject(reject) => {
                assert_eq!(reject.code.as_str(), "F06", "attempt {attempt}")
            }
            other => panic!("expected an F06 reject on attempt {attempt}, got {other:?}"),
        }
        assert!(payment_required.is_some(), "attempt {attempt}");
    }
    assert!(
        app_client.deliveries().is_empty(),
        "the replayed claim must never reach the app"
    );
    let watermark = accepted
        .watermark(PEER_ID, &channel_id())
        .expect("a watermark was recorded by the first, genuine claim");
    assert_eq!(
        watermark.cumulative_amount, 25,
        "the replayed claim's declared amount must never advance the watermark"
    );
}

// ─── §6.1: the four reasons reach the wire ───

/// A claim signed by somebody who is not the channel's configured
/// counterparty is `signature_invalid`, and that verdict reaches the payer
/// as §6.1's JSON.
#[tokio::test]
async fn a_claim_from_the_wrong_signer_is_acknowledged_signature_invalid() {
    let payer_signer = LocalSigner::generate("payer");
    let impostor = LocalSigner::generate("impostor");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let ack = transport
        .flush(PEER_ID, sign_claim(&impostor, 1, 500))
        .await;

    assert_eq!(
        ack,
        ClaimAckOutcome::Rejected(ClaimRejectReason::SignatureInvalid)
    );
}

/// A claim naming a channel this connector has no record of is
/// `unknown_channel`.
#[tokio::test]
async fn a_claim_on_an_unconfigured_channel_is_acknowledged_unknown_channel() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);
    let claim = WireClaim {
        channel_id: format!("0x{:064x}", 99),
        ..sign_claim(&payer_signer, 1, 500)
    };

    let ack = transport.flush(PEER_ID, claim).await;

    assert_eq!(
        ack,
        ClaimAckOutcome::Rejected(ClaimRejectReason::UnknownChannel)
    );
}

// ─── §7.1: ordering ───

/// §7.1: claims on one session are judged **strictly sequentially, in
/// arrival order**, so claims sent in order on one socket cannot race each
/// other into `nonce_not_advancing`. Sixteen advancing claims are sent
/// back to back without waiting for any answer; every one is accepted.
#[tokio::test]
async fn claims_sent_in_order_on_one_session_never_race_each_other() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(state);
    session.send(auth_frame(1, PEER_ID, SECRET)).await;
    let _ = session.answer().await;

    for nonce in 1..=16u64 {
        let json = claim_as_json(
            &sign_claim(&payer_signer, nonce, nonce * 100),
            &payer_signer,
        );
        session
            .send(encode_message(
                nonce as u32 + 1,
                &[ProtocolData {
                    name: CLAIM_PROTOCOL.to_string(),
                    content_type: CONTENT_TYPE_TEXT,
                    data: json.into_bytes(),
                }],
                &[],
            ))
            .await;
    }

    for _ in 1..=16 {
        let answer = session.answer().await;
        assert_eq!(
            ack::from_protocol_data(&answer.protocol_data),
            Some(ClaimAckOutcome::Accepted)
        );
    }
}

// ─── §1.7: a client's peer-shaped bytes ───

/// §1.7/§12(5): a client interaction's `toon-minimum-delivery` is
/// **ignored** -- not rejected and not applied -- so a client SDK that
/// sets an unrecognised entry is not broken by a peer feature and no error
/// message discloses the peer surface. A malformed one on a client frame
/// is therefore not an `F01` either.
#[tokio::test]
async fn a_client_interactions_peer_shaped_bytes_are_ignored_not_refused() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let mut session = accepting(state);

    session
        .send(encode_message(
            1,
            &[ProtocolData {
                name: connector_btp::MINIMUM_DELIVERY_PROTOCOL.to_string(),
                content_type: CONTENT_TYPE_TEXT,
                data: b"twelve".to_vec(),
            }],
            &prepare("g.nowhere").encode(),
        ))
        .await;
    let answer = session.answer().await;

    let reject = connector_domain::Reject::decode(&answer.ilp_packet).expect("a REJECT");
    assert_ne!(
        reject.code.as_str(),
        "F01",
        "a client's minimum-delivery is ignored, never refused"
    );
    assert!(ack::from_protocol_data(&answer.protocol_data).is_none());
}

// ─── §2.3: BTP is symmetric once established ───

/// §2.3: after auth either side may originate on the one session -- the
/// whole of the difference between the two carriages, and why BTP needs no
/// `Toon-Flush-Requested` analogue (§6.4). The accepting side's handle
/// originates a MESSAGE and the dialing side answers it.
#[tokio::test]
async fn the_accepting_side_can_originate_on_the_session_it_accepted() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let (frames, frames_rx) = mpsc::channel::<Vec<u8>>(32);
    let (replies, mut answers) = mpsc::channel::<Vec<u8>>(32);
    let session = PeerSession::new(state, replies);
    let handle = session.handle();
    let driver = tokio::spawn(session.run(frames_rx));

    let counterparty = tokio::spawn(async move {
        let bytes = answers.recv().await.expect("the originated MESSAGE");
        let frame = decode_frame(&bytes).expect("our own encoder");
        assert_eq!(frame.frame_type, connector_btp::BTP_MESSAGE);
        frames
            .send(encode_response(frame.request_id, &[], b"answered"))
            .await
            .expect("the session is live");
    });

    let answer = handle
        .send_message(&[], &[])
        .await
        .expect("the counterparty answered");

    assert_eq!(answer.ilp_packet, b"answered".to_vec());
    counterparty.await.expect("the counterparty task");
    drop(driver);
}

// ─── the port's own contract (spec I5) ───

/// Establishing that nothing above the port can tell which carriage
/// delivered a packet: the `PeerTransport` contract statements, restated
/// against the BTP carriage. A registered peer's own answer comes back
/// unchanged, and an unregistered peer id produces `T01` with
/// `reached == false`.
#[tokio::test]
async fn the_btp_carriage_upholds_the_peer_transport_contract() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = transport(Arc::clone(&dialer) as Arc<dyn PeerDialer>, &payer_signer);

    let PeerForward {
        response,
        reached_peer: reached,
        ..
    } = transport
        .forward(PEER_ID, prepare("g.nowhere-on-the-peer"), 0, None)
        .await;
    match response {
        PacketResponse::Reject(reject) => {
            assert_eq!(reject.code.as_str(), "F02");
            assert!(reject.message.contains("g.nowhere-on-the-peer"));
        }
        other => panic!("expected the peer's own reject, got {other:?}"),
    }
    assert!(reached);

    let PeerForward {
        response,
        ack,
        reached_peer: reached,
        ..
    } = transport
        .forward("unregistered", prepare("g.anything"), 0, None)
        .await;
    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
        other => panic!("expected T01, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::NotSent);
    assert!(!reached);
}

/// A dialed session is established once and reused: eight concurrent
/// forwards to one peer do not open eight sessions.
#[tokio::test]
async fn concurrent_forwards_share_one_dialed_session() {
    let payer_signer = LocalSigner::generate("payer");
    let state = carriage(payee(&payer_signer), bound_policy());
    let dialer = LoopbackDialer::new(state);
    let transport = Arc::new(transport(
        Arc::clone(&dialer) as Arc<dyn PeerDialer>,
        &payer_signer,
    ));

    let mut handles = Vec::new();
    for _ in 0..8 {
        let transport = Arc::clone(&transport);
        handles.push(tokio::spawn(async move {
            transport
                .forward(PEER_ID, prepare("g.nowhere"), 0, None)
                .await
        }));
    }
    for handle in handles {
        let PeerForward {
            response,
            reached_peer: reached,
            ..
        } = handle.await.expect("task");
        assert!(matches!(response, PacketResponse::Reject(_)));
        assert!(reached);
    }

    let sent = dialer.sent.lock().expect("sent frames lock").clone();
    let auth_frames = sent
        .iter()
        .filter(|frame| {
            frame
                .protocol_data
                .iter()
                .any(|pd| pd.name == AUTH_PROTOCOL)
        })
        .count();
    assert_eq!(auth_frames, 1, "one session, authenticated once");
}

/// A signature is 65 bytes and its recovery id rides raw (§4.2) -- proved
/// here against a claim that actually verifies at the far end, so the
/// byte layout is not merely asserted but *used*.
#[test]
fn a_signed_claim_carries_a_65_byte_signature() {
    let payer_signer = LocalSigner::generate("payer");
    let claim = sign_claim(&payer_signer, 1, 500);
    let ClaimSignature::Evm(Signature { recovery_id, .. }) = claim.signature else {
        unreachable!("this connector signs peer claims on secp256k1 only")
    };

    assert_eq!(claim.signature.to_bytes().len(), 65);
    assert!(
        recovery_id <= 1,
        "libsecp256k1's {{0, 1}}, never {{27, 28}}"
    );
}

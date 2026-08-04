//! The ILP-over-HTTP peer carriage end to end
//! (`docs/protocol/peer-carriage-spec.md`, issue #728): an
//! [`HttpPeerTransport`] **dials**, a [`PeerHttpState`] **accepts**, and the
//! requests and responses between them are the ones §3's table names.
//!
//! Nothing here is a fake shortcut past the thing under test. The two sides
//! are joined by an in-process client standing in for the socket and *only*
//! for the socket: every header is the one the shared name table declares,
//! every role decision is `connector_peer_auth::decide_role`'s, every claim
//! is judged by the real `ClaimBook` behind a real `Connector`, and the payer
//! reaches the payee only through the `PeerTransport` port. What is not
//! exercised is TLS and the socket itself.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use connector_btp::{
    ACCUMULATED_COST_HEADER, CLAIM_ACK_HEADER, CLAIM_HEADER, FLUSH_REQUESTED_HEADER,
    MINIMUM_DELIVERY_HEADER,
};
use connector_config::PeerCredential;
use connector_domain::{PacketResponse, Prepare};
use connector_peer_auth::{encode_base64, PeerAuthPolicy, PresentedCredential, PEER_AUTH_HEADER};
use connector_peer_btp::AcceptedClaims;
use connector_peer_http::accept::{FlushHints, PeerHttpPolicy, PeerHttpState};
use connector_peer_http::dial::{HttpDialError, PeerHttpClient, PeerRelation};
use connector_peer_http::headers::{Headers, PeerRequest, PeerResponse};
use connector_peer_http::{HttpPeerTransport, NAT_NOTE};
use connector_runtime::{
    ChannelDomain, ClaimAckOutcome, ClaimRejectReason, ClaimSignature, Clock, Connector,
    FakeAppClient, InProcessPeerTransport, PeerTransport, TestClock, WireClaim,
};
use connector_signer::{
    derive_evm_address, evm_balance_proof_digest, EvmBalanceProof, LocalSigner, Signer,
};
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
/// `lockedAmount`/`locksRoot` as zeros. Unchanged by carriage (§3.1).
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

/// A policy in which `PEER_ID` is configured, has a secret, and is channel
/// bound -- P1 and P2 both satisfiable.
fn bound_policy() -> Arc<PeerAuthPolicy> {
    let credential = PeerCredential::new(SECRET);
    Arc::new(PeerAuthPolicy::new(
        vec![(PEER_ID, &credential)],
        vec![PEER_ID],
    ))
}

fn accepting(connector: Arc<Connector>, policy: Arc<PeerAuthPolicy>) -> Arc<PeerHttpState> {
    accepting_with(connector, policy, Arc::new(FlushHints::new()))
}

fn accepting_with(
    connector: Arc<Connector>,
    policy: Arc<PeerAuthPolicy>,
    hints: Arc<FlushHints>,
) -> Arc<PeerHttpState> {
    Arc::new(PeerHttpState::new(
        connector,
        policy,
        Arc::new(AcceptedClaims::new()),
        hints,
        PeerHttpPolicy::default(),
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

// ─── the in-process client standing in for the socket ───

/// Hands each request straight to an accepting [`PeerHttpState`], recording
/// what actually went on the wire so a test can assert §3's table rather than
/// only what came back.
struct Loopback {
    peer: Arc<PeerHttpState>,
    sent: Mutex<Vec<PeerRequest>>,
    /// §7.2: the high-water mark of claim-bearing requests in flight at once.
    concurrent_claims: AtomicUsize,
    peak_concurrent_claims: AtomicUsize,
    /// How long each request dwells inside the peer, so overlapping requests
    /// would actually overlap if the in-flight rule were not enforced.
    dwell: Duration,
}

impl Loopback {
    fn new(peer: Arc<PeerHttpState>) -> Arc<Loopback> {
        Arc::new(Loopback {
            peer,
            sent: Mutex::new(Vec::new()),
            concurrent_claims: AtomicUsize::new(0),
            peak_concurrent_claims: AtomicUsize::new(0),
            dwell: Duration::ZERO,
        })
    }

    fn with_dwell(peer: Arc<PeerHttpState>, dwell: Duration) -> Arc<Loopback> {
        let mut loopback = Loopback::new(peer);
        Arc::get_mut(&mut loopback).expect("sole owner").dwell = dwell;
        loopback
    }

    fn sent(&self) -> Vec<PeerRequest> {
        self.sent.lock().expect("sent lock").clone()
    }

    fn last(&self) -> PeerRequest {
        self.sent().pop().expect("a request went out")
    }
}

#[async_trait]
impl PeerHttpClient for Loopback {
    async fn post(
        &self,
        _endpoint: &Url,
        request: PeerRequest,
    ) -> Result<PeerResponse, HttpDialError> {
        self.sent.lock().expect("sent lock").push(request.clone());
        let carries_claim = request.headers.get(CLAIM_HEADER).is_some();
        if carries_claim {
            let in_flight = self.concurrent_claims.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak_concurrent_claims
                .fetch_max(in_flight, Ordering::SeqCst);
        }
        if !self.dwell.is_zero() {
            tokio::time::sleep(self.dwell).await;
        }
        let response = self.peer.handle(request).await;
        if carries_claim {
            self.concurrent_claims.fetch_sub(1, Ordering::SeqCst);
        }
        Ok(response)
    }
}

/// A client that never reaches anybody -- the "the remote does not expose
/// what we dial" case §2.2 says is not locally detectable and must surface as
/// an ordinary dial failure.
struct Unreachable;

#[async_trait]
impl PeerHttpClient for Unreachable {
    async fn post(
        &self,
        endpoint: &Url,
        _request: PeerRequest,
    ) -> Result<PeerResponse, HttpDialError> {
        Err(HttpDialError {
            peer_id: PEER_ID.to_string(),
            endpoint: endpoint.to_string(),
            reason: "connection refused".to_string(),
        })
    }
}

/// A client that answers a status carrying no ILP body at all (§6.2's
/// `4xx`/`5xx`).
struct Status(u16);

#[async_trait]
impl PeerHttpClient for Status {
    async fn post(
        &self,
        _endpoint: &Url,
        _request: PeerRequest,
    ) -> Result<PeerResponse, HttpDialError> {
        Ok(PeerResponse::refused(self.0))
    }
}

fn relation() -> PeerRelation {
    let mut domains = HashMap::new();
    domains.insert(
        channel_id(),
        connector_peer_btp::PeerClaimDomain {
            chain_id: CHAIN_ID,
            token_network: TOKEN_NETWORK,
        },
    );
    PeerRelation::new(
        PEER_ID,
        Url::parse("https://peer.example:443/ilp").unwrap(),
        PresentedCredential::new(PEER_ID, SECRET),
        domains,
        Duration::from_millis(30_000),
        Duration::from_millis(30_000),
    )
}

fn transport(client: Arc<dyn PeerHttpClient>, payer: &dyn Signer) -> HttpPeerTransport {
    let mut transport = HttpPeerTransport::new(
        client,
        derive_evm_address(&payer.public_key().unwrap()),
        clock() as Arc<dyn Clock>,
    );
    transport.add_peer(relation());
    transport
}

/// One request, as a peer would send it by hand -- for the accept-side tests
/// that have no dialing transport in front of them.
fn request(
    credential: Option<(&str, &str)>,
    claim_json: Option<&str>,
    body: Vec<u8>,
) -> PeerRequest {
    let mut headers = Headers::new();
    if let Some((peer_id, secret)) = credential {
        headers.push(
            PEER_AUTH_HEADER,
            encode_base64(&PresentedCredential::new(peer_id, secret)),
        );
    }
    if let Some(json) = claim_json {
        headers.push(
            CLAIM_HEADER,
            connector_peer_http::headers::claim_header_value(json),
        );
    }
    PeerRequest { headers, body }
}

fn claim_as_json(claim: &WireClaim, payer: &dyn Signer) -> String {
    connector_peer_btp::claim_json::encode(
        claim,
        &derive_evm_address(&payer.public_key().unwrap()),
        None,
        Some(connector_peer_btp::PeerClaimDomain {
            chain_id: CHAIN_ID,
            token_network: TOKEN_NETWORK,
        }),
        "message-1",
        "2030-01-01T00:00:00.000Z",
    )
}

fn ack_on(response: &PeerResponse) -> Option<ClaimAckOutcome> {
    connector_peer_http::headers::claim_ack(&response.headers)
}

// ─── §3, §6: a claim rides a PREPARE and is acknowledged ───

/// §6.2, the property whose loss would silently destroy ADR 0024's
/// semantics: **the body answers the packet, the header answers the claim,
/// and the status is `200` regardless**. The packet is rejected (the payee
/// has no route for it) and the claim that rode it is accepted, on the one
/// response.
#[tokio::test]
async fn a_claim_riding_a_prepare_is_judged_independently_of_the_packet() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(peer);
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );
    let claim = sign_claim(&payer_signer, 1, 500);

    let (response, ack, reached) = transport
        .forward(PEER_ID, prepare("g.nowhere"), 0, Some(claim))
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "F02"),
        other => panic!("expected the payee's own reject, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::Accepted);
    assert!(reached, "the peer answered, so this hop forwarded");
}

/// §3's table, as bytes: the credential and the claim are `base64(JSON)`
/// headers, the minimum-delivery declaration is decimal ASCII, and the body
/// is the OER PREPARE unchanged (§8.1).
#[tokio::test]
async fn the_request_a_dialed_peering_puts_on_the_wire_is_the_one_section_3_names() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(peer);
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );
    let claim = sign_claim(&payer_signer, 1, 500);
    let prepare = prepare("g.nowhere");

    let _ = transport
        .forward(PEER_ID, prepare.clone(), 1_250, Some(claim.clone()))
        .await;

    let sent = client.last();
    // §1.4: the credential, on **every** request, since HTTP has no session.
    assert_eq!(
        sent.headers.get(PEER_AUTH_HEADER),
        Some(encode_base64(&PresentedCredential::new(PEER_ID, SECRET)).as_str())
    );
    // §4: `base64(JSON)` over exactly the JSON the BTP entry carries raw.
    let claim_json = base64_decode(sent.headers.get(CLAIM_HEADER).expect("a claim rode"));
    assert_eq!(
        connector_peer_btp::claim_json::parse(&claim_json).expect("the client edge's validator"),
        claim
    );
    // §5.1: decimal uint64 ASCII, one value, no list form.
    assert_eq!(sent.headers.get(MINIMUM_DELIVERY_HEADER), Some("1250"));
    // §8.1: `data` rides byte-for-byte unchanged, in the same OER encoding
    // every other carriage puts on a wire.
    assert_eq!(sent.body, prepare.encode());
    // §3: a peer connector MUST NOT invent additional headers.
    assert_eq!(sent.headers.len(), 3, "got {:?}", sent.headers);
}

/// §5.1: a zero floor rides as an **absent** header, because absent means
/// zero on receipt.
#[tokio::test]
async fn a_zero_minimum_delivery_rides_as_an_absent_header() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(peer);
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );

    let _ = transport
        .forward(PEER_ID, prepare("g.nowhere"), 0, None)
        .await;

    let sent = client.last();
    assert_eq!(sent.headers.get(MINIMUM_DELIVERY_HEADER), None);
    // §10.2 item 6: a claimless PREPARE is legal, and carries no claim
    // header rather than an empty one.
    assert_eq!(sent.headers.get(CLAIM_HEADER), None);
}

/// FLUSH (§3): **a POST with an empty ILP body plus the claim header** --
/// the standalone-claim shape of `client-edge-spec.md` §1.9 step 5 -- and
/// the ack rides the response that answers it.
#[tokio::test]
async fn a_flush_is_a_post_with_an_empty_body_and_the_claim_header() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(peer);
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );
    let claim = sign_claim(&payer_signer, 3, 900);

    let ack = transport.flush(PEER_ID, claim.clone()).await;

    assert_eq!(ack, ClaimAckOutcome::Accepted);
    let sent = client.last();
    assert!(sent.body.is_empty(), "a FLUSH carries no ILP packet");
    let carried = base64_decode(sent.headers.get(CLAIM_HEADER).expect("the claim rode"));
    assert_eq!(
        connector_peer_btp::claim_json::parse(&carried)
            .expect("valid")
            .cumulative_amount,
        claim.cumulative_amount
    );
}

// ─── §6.3: retransmission, and the idempotent re-ack ───

/// §6.3, the rule standing between a lost ack and a permanently wedged
/// peering -- **on both halves at once**.
///
/// The payer's half: the claim JSON carries a `timestamp`, so a payer that
/// re-rendered it with a fresh `now` could never produce a byte-identical
/// retransmission, and every one of its retransmissions would be a
/// *different* claim at the same nonce -- which a payee MUST refuse. The
/// payee's half: a claim byte-identical to the one already at the watermark
/// is answered `accepted`, and nothing is advanced or recorded.
#[tokio::test]
async fn a_byte_identical_retransmission_at_the_watermark_is_accepted_again() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(peer);
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );
    let claim = sign_claim(&payer_signer, 1, 500);

    // The first flush is answered; the payer then retransmits the same
    // pending claim, as it must when an ack goes missing.
    assert_eq!(
        transport.flush(PEER_ID, claim.clone()).await,
        ClaimAckOutcome::Accepted
    );
    // The clock moves. A payer that re-rendered the JSON here would emit
    // different bytes at the same nonce.
    let ack = transport.flush(PEER_ID, claim).await;

    assert_eq!(
        ack,
        ClaimAckOutcome::Accepted,
        "a retransmission at the watermark is accepted, never nonce_not_advancing"
    );
    let sent = client.sent();
    assert_eq!(
        sent[0].headers.get(CLAIM_HEADER),
        sent[1].headers.get(CLAIM_HEADER),
        "the retransmission was byte-identical (§6.3)"
    );
}

/// §6.3's other half: the **same nonce with any other field changed** is a
/// different claim, and is refused `nonce_not_advancing` exactly as §3.2's
/// strictly-advancing rule requires. Together with the test above this pins
/// the boundary.
#[tokio::test]
async fn the_same_nonce_with_different_bytes_is_refused_nonce_not_advancing() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::new(Arc::clone(&peer));
    let transport = transport(client as Arc<dyn PeerHttpClient>, &payer_signer);

    assert_eq!(
        transport
            .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
            .await,
        ClaimAckOutcome::Accepted
    );
    // Same nonce, a different cumulative: a different claim.
    let response = peer
        .handle(request(
            Some((PEER_ID, SECRET)),
            Some(&claim_as_json(
                &sign_claim(&payer_signer, 1, 900),
                &payer_signer,
            )),
            Vec::new(),
        ))
        .await;

    assert_eq!(
        ack_on(&response),
        Some(ClaimAckOutcome::Rejected(
            ClaimRejectReason::NonceNotAdvancing
        ))
    );
}

/// §6.3: **absence means NOT ACKNOWLEDGED** -- never accepted, never
/// rejected, never inferred from the packet's verdict.
#[tokio::test]
async fn a_response_carrying_no_ack_header_leaves_the_claim_not_acknowledged() {
    struct Silent;

    #[async_trait]
    impl PeerHttpClient for Silent {
        async fn post(
            &self,
            _endpoint: &Url,
            _request: PeerRequest,
        ) -> Result<PeerResponse, HttpDialError> {
            Ok(PeerResponse::ok(Vec::new()))
        }
    }

    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(Silent), &payer_signer);

    let ack = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
        .await;

    assert_eq!(ack, ClaimAckOutcome::NotSent);
}

/// §6.3: a malformed ack -- undecodable base64, undecodable JSON, an unknown
/// `result`, a `rejected` with no `reason` -- is likewise **not
/// acknowledged**, and MUST NOT be read as either verdict.
#[tokio::test]
async fn a_malformed_ack_header_leaves_the_claim_not_acknowledged() {
    struct Garbled(&'static str);

    #[async_trait]
    impl PeerHttpClient for Garbled {
        async fn post(
            &self,
            _endpoint: &Url,
            _request: PeerRequest,
        ) -> Result<PeerResponse, HttpDialError> {
            let mut response = PeerResponse::ok(Vec::new());
            response.headers.push(CLAIM_ACK_HEADER, self.0);
            Ok(response)
        }
    }

    for garbled in [
        "!!! not base64 !!!",
        "bm90IGpzb24=",                 // "not json"
        "eyJyZXN1bHQiOiJtYXliZSJ9",     // {"result":"maybe"}
        "eyJyZXN1bHQiOiJyZWplY3RlZCJ9", // {"result":"rejected"}
    ] {
        let payer_signer = LocalSigner::generate("payer");
        let transport = transport(Arc::new(Garbled(garbled)), &payer_signer);

        let ack = transport
            .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
            .await;

        assert_eq!(
            ack,
            ClaimAckOutcome::NotSent,
            "read a verdict from {garbled}"
        );
    }
}

/// §6.2: `4xx`/`5xx` are reserved for a request there is no ILP answer to.
/// A response like that is not an ILP verdict, is not a claim verdict, and
/// leaves the claim not acknowledged.
#[tokio::test]
async fn a_non_200_answer_is_no_ilp_answer_at_all() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(Status(400)), &payer_signer);

    let (response, ack, reached) = transport
        .forward(
            PEER_ID,
            prepare("g.nowhere"),
            0,
            Some(sign_claim(&payer_signer, 1, 500)),
        )
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
        other => panic!("expected T01, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::NotSent);
    assert!(
        !reached,
        "no fee of ours belongs on a hop that never forwarded"
    );
}

// ─── §2.2, §2.4, §6.4(1): what cannot be reached, and why ───

/// §2.2: whether the remote exposes what we dial is not locally detectable,
/// so it surfaces as an ordinary dial failure and the packet rejects `T01` --
/// never `T00`, and never a silent drop.
#[tokio::test]
async fn a_peer_that_cannot_be_reached_rejects_t01_and_was_never_reached() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(Unreachable), &payer_signer);

    let (response, ack, reached) = transport
        .forward(PEER_ID, prepare("g.nowhere"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => assert_eq!(reject.code.as_str(), "T01"),
        other => panic!("expected T01, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::NotSent);
    assert!(!reached);
}

/// §6.4(1) and §2.4, the two things an operator hits first and diagnoses
/// last. A peer this connector does not dial over HTTP can never be
/// originated to -- packets flow only in the dialing direction -- and the
/// `T01` says so, including that an HTTP-only peer can neither reach nor be
/// reached by a NAT'd peer.
#[tokio::test]
async fn a_peer_this_connector_cannot_originate_to_says_why_in_its_t01() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(Unreachable), &payer_signer);

    let (response, ack, reached) = transport
        .forward("accept-only", prepare("g.nowhere"), 0, None)
        .await;

    match response {
        PacketResponse::Reject(reject) => {
            assert_eq!(reject.code.as_str(), "T01");
            assert!(
                reject.message.contains("§6.4(1)"),
                "an operator must not have to infer unidirectional packet flow: {}",
                reject.message
            );
            assert!(
                reject.message.contains("NAT'd peer"),
                "the NAT consequence is the least obvious thing here: {}",
                reject.message
            );
        }
        other => panic!("expected T01, got {other:?}"),
    }
    assert_eq!(ack, ClaimAckOutcome::NotSent);
    assert!(!reached);
    assert!(NAT_NOTE.contains("must be BTP"));
}

/// An accept-only peering cannot flush either (§6.4(2)): the claim stays
/// pending until this connector can dial again, and its counterparty's
/// protection in that window is that counterparty's own ceiling.
#[tokio::test]
async fn an_accept_only_peering_cannot_flush() {
    let payer_signer = LocalSigner::generate("payer");
    let transport = transport(Arc::new(Unreachable), &payer_signer);

    let ack = transport
        .flush("accept-only", sign_claim(&payer_signer, 1, 500))
        .await;

    assert_eq!(ack, ClaimAckOutcome::NotSent);
}

// ─── §1: role is decided by authentication ───

/// **The named regression (§1.9).** `toon-sandbox` admitted an anonymous BTP
/// session with `btp_auth … success:true mode:"no-auth"` and then treated it
/// as a quasi-peer. Each of the five interactions below is classified
/// `client` and reaches **no peer handling whatsoever** -- testable, per
/// §1.9, as: no `Toon-Claim-Ack` was emitted, and the claim they carried
/// moved no peer watermark (proved by a subsequent *genuine* peer claim at
/// nonce 1 being accepted, which it could not be if any of these had
/// advanced anything).
#[tokio::test]
async fn the_named_regression_no_request_becomes_a_peer_without_p1_and_p2() {
    let payer_signer = LocalSigner::generate("payer");
    let credential = PeerCredential::new(SECRET);
    // `unbound` is configured and has a secret, but no `[[peer_channels]]`
    // row: P2 alone failing.
    let unbound = PeerCredential::new(SECRET);
    let policy = Arc::new(PeerAuthPolicy::new(
        vec![(PEER_ID, &credential), ("unbound", &unbound)],
        vec![PEER_ID],
    ));
    let peer = accepting(payee(&payer_signer), policy);
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
        let response = peer
            .handle(request(
                credential,
                Some(&json),
                prepare("g.nowhere").encode(),
            ))
            .await;

        // §1.6: not refused for the assertion alone -- refusing would make
        // the credential check an oracle for which peer ids are configured.
        assert_eq!(response.status, 200, "case {index}");
        assert!(
            ack_on(&response).is_none(),
            "case {index}: a client interaction gets no claim-ack (§1.7)"
        );
        assert!(
            response.headers.get(FLUSH_REQUESTED_HEADER).is_none(),
            "case {index}: a client interaction is never a peering relation (§6.4)"
        );
    }

    // Nothing above moved a peer watermark: a genuine peer's claim at nonce
    // 1 is still fresh.
    let response = peer
        .handle(request(Some((PEER_ID, SECRET)), Some(&json), Vec::new()))
        .await;

    assert_eq!(
        ack_on(&response),
        Some(ClaimAckOutcome::Accepted),
        "no client interaction had advanced this channel's peer watermark"
    );
}

/// §1.5's header-smuggling defence: **more than one `Toon-Peer-Auth` on one
/// request is refused, not resolved** -- `400`, with no ILP body, and never
/// the first, the last or a concatenation. Its absence is how "which
/// credential did we check?" becomes unanswerable.
#[tokio::test]
async fn two_credentials_on_one_request_are_refused_rather_than_resolved() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let mut headers = Headers::new();
    headers.push(
        PEER_AUTH_HEADER,
        encode_base64(&PresentedCredential::new(PEER_ID, SECRET)),
    );
    headers.push(
        PEER_AUTH_HEADER,
        encode_base64(&PresentedCredential::new(PEER_ID, "another")),
    );

    let response = peer
        .handle(PeerRequest {
            headers,
            body: prepare("g.nowhere").encode(),
        })
        .await;

    assert_eq!(response.status, 400);
    assert!(response.body.is_empty(), "a 400 carries no ILP body (§1.5)");
    assert!(ack_on(&response).is_none());
}

/// §1.4: because HTTP has no session, the credential is presented on **every**
/// request. One request proving a peering says nothing about the next.
#[tokio::test]
async fn a_request_without_the_credential_is_a_client_however_the_last_one_was_judged() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);

    let proven = peer
        .handle(request(Some((PEER_ID, SECRET)), Some(&json), Vec::new()))
        .await;
    let next = peer.handle(request(None, Some(&json), Vec::new())).await;

    assert_eq!(ack_on(&proven), Some(ClaimAckOutcome::Accepted));
    assert!(
        ack_on(&next).is_none(),
        "the previous request's role does not carry over (§1.4)"
    );
}

/// §1.7/§5.1: a client's `Toon-Minimum-Delivery` is **ignored** -- not
/// rejected and not applied -- so a client SDK setting an unrecognised header
/// is not broken by a peer feature, and no error discloses the peer surface.
#[tokio::test]
async fn a_client_roles_minimum_delivery_header_is_ignored_not_refused() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let mut request = request(None, None, prepare("g.nowhere").encode());
    request.headers.push(MINIMUM_DELIVERY_HEADER, "twelve");

    let response = peer.handle(request).await;

    assert_eq!(response.status, 200);
    // The client's packet reaches no peer handling: `F02`, not the `F01` a
    // peer's malformed declaration would provoke.
    let reject = connector_domain::Reject::decode(&response.body).expect("a reject");
    assert_eq!(reject.code.as_str(), "F02");
}

/// §5.1: on a **peer** request the same header is never silently zero -- a
/// malformed floor is `F01`, because zero is the weakest possible floor and
/// substituting it converts a framing bug into an under-delivery.
#[tokio::test]
async fn a_peers_malformed_minimum_delivery_is_f01_and_never_silently_zero() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let json = claim_as_json(&sign_claim(&payer_signer, 1, 500), &payer_signer);
    let mut request = request(
        Some((PEER_ID, SECRET)),
        Some(&json),
        prepare("g.nowhere").encode(),
    );
    request.headers.push(MINIMUM_DELIVERY_HEADER, "twelve");

    let response = peer.handle(request).await;

    assert_eq!(response.status, 200);
    let reject = connector_domain::Reject::decode(&response.body).expect("a reject");
    assert_eq!(reject.code.as_str(), "F01");
    // §6.2: the two verdicts are independent, so the claim that rode the
    // refused packet is still judged and still acknowledged.
    assert_eq!(ack_on(&response), Some(ClaimAckOutcome::Accepted));
    // §5.2: always emitted on a REJECT, even at zero.
    assert_eq!(response.headers.get(ACCUMULATED_COST_HEADER), Some("0"));
}

/// §1.10's bounded escape hatch: on a **dedicated** peer listener a request
/// that fails P1 or P2 is refused outright rather than downgraded, because
/// such a listener serves no clients -- there is no client to downgrade to
/// and no oracle to leak. Role is still decided by P1 and P2.
#[tokio::test]
async fn a_dedicated_peer_listener_refuses_rather_than_downgrades() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = Arc::new(PeerHttpState::new(
        payee(&payer_signer),
        bound_policy(),
        Arc::new(AcceptedClaims::new()),
        Arc::new(FlushHints::new()),
        PeerHttpPolicy {
            mandatory_auth: true,
        },
    ));

    let refused = peer
        .handle(request(None, None, prepare("g.nowhere").encode()))
        .await;
    let admitted = peer
        .handle(request(
            Some((PEER_ID, SECRET)),
            None,
            prepare("g.nowhere").encode(),
        ))
        .await;

    assert_eq!(refused.status, 401);
    assert!(refused.body.is_empty());
    assert_eq!(admitted.status, 200, "P1 and P2 still decide the role");
}

// ─── §6.4: the flush prompt, and only a prompt ───

/// §6.4: a payee that cannot originate MAY prompt a payer, one channel id
/// per occurrence, and a payer holding that pending claim sends it on its
/// next request. It **creates no obligation**: nothing is refused, rejected
/// or re-accounted because a hint went unanswered.
#[tokio::test]
async fn a_flush_prompt_is_read_by_the_payer_and_obliges_nothing() {
    let payer_signer = LocalSigner::generate("payer");
    let hints = Arc::new(FlushHints::new());
    let peer = accepting_with(payee(&payer_signer), bound_policy(), Arc::clone(&hints));
    let client = Loopback::new(Arc::clone(&peer));
    let transport = transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    );

    // The payer has a pending, unacknowledged claim: the payee answered it
    // with nothing at all, which §6.3 makes "not acknowledged".
    let response = peer
        .handle(request(
            Some((PEER_ID, SECRET)),
            None,
            prepare("g.nowhere").encode(),
        ))
        .await;
    assert!(
        response.headers.get(FLUSH_REQUESTED_HEADER).is_none(),
        "no hint was requested yet"
    );

    // A claim goes out and is accepted, so nothing is pending; a hint for it
    // is then ignored, exactly as §6.4 requires of a channel the payer holds
    // no pending claim on.
    let _ = transport
        .flush(PEER_ID, sign_claim(&payer_signer, 1, 500))
        .await;
    hints.request(PEER_ID, &channel_id());
    let _ = transport
        .forward(PEER_ID, prepare("g.nowhere"), 0, None)
        .await;

    assert!(
        transport.flush_hints(PEER_ID).is_empty(),
        "a hint for a channel with no pending claim is ignored (§6.4)"
    );
}

/// §6.4: the prompt rides a response to a **peer**, one occurrence per
/// channel, and is drained rather than repeated for ever.
#[tokio::test]
async fn a_payee_names_one_channel_per_occurrence_and_only_to_a_peer() {
    let payer_signer = LocalSigner::generate("payer");
    let hints = Arc::new(FlushHints::new());
    let peer = accepting_with(payee(&payer_signer), bound_policy(), Arc::clone(&hints));
    hints.request(PEER_ID, &channel_id());
    hints.request(PEER_ID, &format!("0x{:064x}", 9));

    let prompted = peer
        .handle(request(
            Some((PEER_ID, SECRET)),
            None,
            prepare("g.nowhere").encode(),
        ))
        .await;
    let again = peer
        .handle(request(
            Some((PEER_ID, SECRET)),
            None,
            prepare("g.nowhere").encode(),
        ))
        .await;

    let named = prompted.headers.get_all(FLUSH_REQUESTED_HEADER);
    assert_eq!(
        named.len(),
        2,
        "one channel id per occurrence, no list form"
    );
    assert!(named.contains(&channel_id().as_str()));
    assert!(
        again.headers.get(FLUSH_REQUESTED_HEADER).is_none(),
        "a hint is drained when it is emitted"
    );

    // §6.4: never on a response to a client interaction.
    hints.request(PEER_ID, &channel_id());
    let client_response = peer
        .handle(request(None, None, prepare("g.nowhere").encode()))
        .await;
    assert!(client_response
        .headers
        .get(FLUSH_REQUESTED_HEADER)
        .is_none());
}

// ─── §7.2: the claim race, and its mitigation ───

/// §7.2: **no more than one claim-bearing request in flight to a peer per
/// channel.** The race is a property of the carriage an operator chose, and
/// this is the normative mitigation the client edge already ships; without it
/// parallel requests at nonces *n* and *n+1* reach the payee's watermark lock
/// in either order and the loser is refused `nonce_not_advancing` for
/// nothing.
#[tokio::test]
async fn only_one_claim_bearing_request_is_in_flight_per_channel() {
    let payer_signer = LocalSigner::generate("payer");
    let peer = accepting(payee(&payer_signer), bound_policy());
    let client = Loopback::with_dwell(peer, Duration::from_millis(20));
    let transport = Arc::new(transport(
        Arc::clone(&client) as Arc<dyn PeerHttpClient>,
        &payer_signer,
    ));

    let flushes = (1..=4).map(|nonce| {
        let transport = Arc::clone(&transport);
        let claim = sign_claim(&payer_signer, nonce, nonce * 100);
        tokio::spawn(async move { transport.flush(PEER_ID, claim).await })
    });
    let acks: Vec<ClaimAckOutcome> = futures_join(flushes).await;

    assert_eq!(
        client.peak_concurrent_claims.load(Ordering::SeqCst),
        1,
        "two claim-bearing requests were in flight to one channel at once (§7.2)"
    );
    assert!(
        acks.iter().all(|ack| *ack == ClaimAckOutcome::Accepted),
        "serialized claims cannot race each other into nonce_not_advancing: {acks:?}"
    );
}

async fn futures_join<T>(handles: impl IntoIterator<Item = tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("the task did not panic"));
    }
    results
}

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.decode(value).expect("standard base64")
}

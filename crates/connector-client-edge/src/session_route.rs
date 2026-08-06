//! The fourth routing arm `session_registry.rs`'s own module doc deferred:
//! wiring [`crate::session_registry::SessionRegistry`] into the packet path
//! so a PREPARE addressed to a live, bound client session is delivered
//! through it rather than answered `F02` (issue #736, toon-meta#262's
//! job-dispatch work). `connector_runtime::Connector::handle_prepare` cannot
//! see the registry at all -- `connector-client-edge` depends on
//! `connector-runtime`, never the reverse -- so this arm lives here,
//! wrapped around `handle_prepare` rather than folded into it.
//!
//! **Precedence.** A configured route (app, peer or leased) always wins:
//! [`route_prepare`] calls `handle_prepare` first, and only falls through to
//! the session registry when that call's own answer is `F02` (no route at
//! all). A session therefore never shadows an operator's own routing table,
//! and -- since `F02` is the only answer this arm ever overrides -- a
//! configured route is never silently shadowed by one either.
//!
//! **`T01` vs `F02`.** [`crate::session_registry::SessionRegistry::resolve`]
//! decides, cheaply and without side effects, whether this destination is
//! even a session candidate: if nothing is currently bound there, the
//! original `F02` is returned unchanged -- "matches nothing at all" per
//! issue #736's own wording. If something IS bound, delivery is attempted
//! through it, and `SessionRegistry::deliver`'s own contract answers every
//! failure past that point -- including the session disappearing in the
//! interval between this check and the send itself -- with `T01`
//! (`RejectCode::t01_peer_unreachable`), never `F02`.
//!
//! **Charging.** Unchanged: both ingresses (`lib.rs`'s `POST /ilp`,
//! `btp.rs`'s BTP carriage) already compute `price` from
//! `Connector::app_route` and admit any claim against it before routing is
//! attempted at all. A destination this arm ever delivers through has, by
//! construction, no matching app route -- one that did would already have
//! answered non-`F02` above and never reached here -- so `price` is `0` on
//! every real deployment today, and a `T01` this arm answers keeps nothing,
//! exactly like `Connector::deliver_to_app`'s own `AppOutcome::Unreachable`.

use connector_btp::{BtpFrame, BTP_RESPONSE};
use connector_domain::{
    fulfillment_matches_condition, Fulfill, PacketResponse, Prepare, Reject, RejectCode,
};
use connector_runtime::ClaimAckOutcome;

use crate::btp::payout_claim_protocol_data;
use crate::ClientEdgeState;

/// Route `prepare` through `state`: a configured route (app/peer/leased)
/// first, and -- only if that answers `F02` -- whatever client session
/// [`crate::session_registry::SessionRegistry`] currently has bound to its
/// destination. `price` is the same figure both ingresses already computed
/// from `Connector::app_route` before admitting any claim; it is only
/// consulted here to price a mismatched fulfilment the same way a
/// terminated app route's own would be (issue #736's charging AC).
///
/// **Issue #770.** A genuine fulfilment from a client session means that
/// client has just earned `prepare`'s own amount: this connector credits
/// its payout ledger and hands it a fresh signed claim over the same
/// session, so `credited` (and therefore `available`, `client-edge-spec.md`
/// §1.10) actually rises instead of staying a figure only a unit test ever
/// produces. See [`credit_session_earnings`] for both steps and why each is
/// best-effort past the point the packet's own answer is already decided.
pub(crate) async fn route_prepare(
    state: &ClientEdgeState,
    prepare: Prepare,
    price: u64,
) -> PacketResponse {
    let now = crate::now_unix();
    let Some(lease) = state.session_registry.resolve(&prepare.destination, now) else {
        // No session is bound here right now -- not even a candidate for
        // this arm, so the ordinary three-source answer (most likely `F02`)
        // stands unchanged.
        return state.connector.handle_prepare(prepare, 0).await;
    };

    let destination = prepare.destination.clone();
    let condition = prepare.execution_condition;
    let amount = prepare.amount;
    let encoded = prepare.encode();
    let response = state.connector.handle_prepare(prepare, 0).await;
    if !is_unreachable(&response) {
        // A configured route decided this packet -- never silently
        // overridden by a live session (issue #736's precedence AC).
        return response;
    }

    let response = match state
        .session_registry
        .deliver(&destination, Some(lease.generation), &[], &encoded, now)
        .await
    {
        Ok(frame) => session_answer(frame, &condition, price),
        Err(reject) => return PacketResponse::Reject(reject),
    };

    if matches!(response, PacketResponse::Fulfill(_)) {
        credit_session_earnings(
            state,
            &destination,
            lease.generation,
            &condition,
            amount,
            now,
        )
        .await;
    }

    response
}

/// Issue #770's wiring point: `destination` (the address `prepare` was
/// just genuinely fulfilled at) is a client session's own bound *ILP
/// address* (issue #736/toon-client#503) -- never a channel id, in any
/// production deployment. Issue #787 found that #770's and #780's own
/// tests bound a session under a channel id instead, which made
/// `destination == channel id` look like a free equivalence when it never
/// held in production: a real session's bound address cannot be decoded as
/// one. [`crate::claim_gate::ClientClaimGate::credit_session_payout`]
/// resolves the one from the other, through whatever channel id an
/// earlier inbound claim on this same session already taught this gate.
///
/// Both steps are best-effort once reached, and neither holds up
/// `route_prepare`'s own answer (already decided by the time this runs):
///
/// 1. [`crate::claim_gate::ClientClaimGate::credit_session_payout`] resolves
///    `destination` -- this session's own bound ILP address -- to the
///    channel id an earlier inbound claim on this same session taught this
///    gate (issue #787), then credits `amount` through
///    [`crate::claim_gate::ClientClaimGate::credit_payout`], deduped
///    against `condition` (AC3) so a duplicate or retransmitted fulfilment
///    of the same job cannot double-credit -- resolving the channel's
///    payout domain on demand first if this is a self-opened channel this
///    connector has not seen before (issue #780). A node with no payout
///    ledger configured, or a destination with no known channel yet, does
///    nothing here.
/// 2. [`deliver_pending_claim`] flushes whatever `pending_claim` currently
///    owes this channel -- called unconditionally, whether or not step 1
///    itself produced a fresh claim (issue #779). A deduped retry (the same
///    execution condition as an earlier delivery) still reaches this line,
///    and a claim is cumulative (ADR 0024), so the latest pending one
///    already carries forward anything an earlier delivery on this channel
///    failed to hand off -- this is how a payout claim whose delivery
///    failed gets resent rather than stranded forever.
async fn credit_session_earnings(
    state: &ClientEdgeState,
    destination: &str,
    generation: u64,
    condition: &[u8; 32],
    amount: u64,
    now: u64,
) {
    let _ = state
        .claim_gate
        .credit_session_payout(destination, condition, amount, chrono::Utc::now())
        .await;
    deliver_pending_claim(state, destination, Some(generation), now).await;
}

/// Issue #779: `pending_claim` had signing and delivery logic but no
/// production caller at all -- a client whose BTP session dropped between
/// the credit and the TRANSFER was left able to spend (`credited` had
/// risen) but unable to redeem (it held no signed claim for the increment).
/// This is the resend: whatever [`crate::outbound_ledger::ClientPayoutLedger::pending_claim`]
/// currently owes `destination`'s associated channel is (re)sent over its
/// currently bound session, fenced against `expected_generation` exactly
/// like every other delivery this module makes.
///
/// The TRANSFER's own `amount` field carries the claim's cumulative amount
/// rather than any one job's increment: this call has no specific job to
/// attach to (a stranded claim from an earlier failed delivery, or a bare
/// reconnect with no job in sight at all), and the claim itself -- not this
/// field, which `client-edge-spec.md` §1.9 step 7 leaves without netting
/// meaning of its own -- is what a client actually redeems.
///
/// Best-effort like every step this module takes past a packet's own
/// answer: no live session for `destination`, no channel association yet,
/// no payout ledger configured, or nothing currently pending all leave
/// `pending_claim` exactly where it was for the next caller to find.
/// Acknowledgement -- which alone clears `pending_claim`, never `credited`
/// -- happens only once the client answers the TRANSFER with a RESPONSE,
/// so every other outcome (no session, a write that never lands, a timeout,
/// or the client's own ERROR) leaves the claim armed to be resent.
///
/// Two production call sites: [`credit_session_earnings`] above (every
/// fulfilled delivery, deduped or not) and `crate::btp::handle_frame`'s auth
/// branch, once a session (re)establishes -- so a stranded claim need not
/// wait for the next job to land on the very same channel. The two can run
/// at once (the auth-branch call is spawned), which costs at worst one
/// duplicate TRANSFER of the *same* nonce: a claim is cumulative, so a
/// client that sees it twice redeems the same figure either way, and the
/// second acknowledgement is a no-op once the first has cleared the claim
/// that nonce named.
pub(crate) async fn deliver_pending_claim(
    state: &ClientEdgeState,
    destination: &str,
    expected_generation: Option<u64>,
    now: u64,
) {
    let Some((channel_id, ledger)) = state.claim_gate.payout_channel_for_session(destination)
    else {
        return;
    };
    let Some(claim) = ledger.pending_claim(&channel_id) else {
        return;
    };
    let answer = state
        .session_registry
        .deliver_transfer(
            destination,
            expected_generation,
            claim.cumulative_amount,
            &[payout_claim_protocol_data(&claim)],
            now,
        )
        .await;
    // Only a RESPONSE is an acknowledgement. `deliver_transfer` answers
    // `Ok` with whatever frame the client correlated back, and RFC-0023's
    // ERROR is "could not accept this request" -- clearing `pending_claim`
    // on one would strand the very claim this function exists to resend.
    if answer.is_ok_and(|frame| frame.frame_type == BTP_RESPONSE) {
        ledger.acknowledge(&channel_id, claim.nonce, ClaimAckOutcome::Accepted);
    }
}

fn is_unreachable(response: &PacketResponse) -> bool {
    matches!(
        response,
        PacketResponse::Reject(reject) if reject.code == RejectCode::f02_unreachable()
    )
}

/// Turn a session's own RESPONSE frame into this hop's [`PacketResponse`]:
/// its `ilp_packet` is a FULFILL or a REJECT, the same as any answer to a
/// PREPARE this connector originated would be. A candidate FULFILL is
/// checked against the sender's own execution condition before being
/// trusted -- the same check `Connector::forward_via_peer_route` runs on a
/// peer's relayed fulfilment -- since the session on the other end is
/// exactly as untrusted as a peer is. A REJECT the session raised itself
/// rides home unchanged. Content this carriage cannot decode as either is
/// treated as unreachable (`T01`), the same as no answer at all.
fn session_answer(frame: BtpFrame, condition: &[u8; 32], price: u64) -> PacketResponse {
    if let Ok(fulfill) = Fulfill::decode(&frame.ilp_packet) {
        return accept_if_fulfilled(condition, fulfill, price);
    }
    match Reject::decode(&frame.ilp_packet) {
        Ok(reject) => PacketResponse::Reject(reject),
        Err(_) => PacketResponse::Reject(undecodable_session_answer()),
    }
}

/// As `Connector::accept_if_fulfilled` (`connector-runtime`, private to that
/// crate): a candidate FULFILL is trusted only once its fulfilment is
/// checked against the sender's own execution condition, never on the
/// remote session's say-so alone.
fn accept_if_fulfilled(
    condition: &[u8; 32],
    candidate: Fulfill,
    price_on_reject: u64,
) -> PacketResponse {
    if fulfillment_matches_condition(condition, &candidate.fulfillment) {
        PacketResponse::Fulfill(candidate)
    } else {
        PacketResponse::Reject(Reject {
            code: RejectCode::f99_application_error(),
            triggered_by: String::new(),
            message: "fulfillment does not match execution condition".to_string(),
            data: Vec::new(),
            accumulated_cost: price_on_reject,
        })
    }
}

fn undecodable_session_answer() -> Reject {
    Reject {
        code: RejectCode::t01_peer_unreachable(),
        triggered_by: String::new(),
        message: "client session answered with a packet that is neither a fulfill nor a reject"
            .to_string(),
        data: Vec::new(),
        accumulated_cost: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use connector_btp::{
        decode_frame, BtpSessionHandle, OutboundRequests, BTP_ERROR, BTP_RESPONSE, BTP_TRANSFER,
        PAYOUT_CLAIM_PROTOCOL,
    };
    use connector_config::StaticRoute;
    use connector_domain::derive_condition;
    use connector_runtime::{
        ChannelDomain, Connector, FakeAppClient, InMemoryJournal, InProcessPeerTransport, TestClock,
    };
    use connector_signer::{
        derive_evm_address, verify_evm_balance_proof, EvmBalanceProof, LocalSigner, Signer,
    };
    use std::sync::Arc;
    use tokio::sync::mpsc;

    use crate::channels::test_source::FakeChannelSource;
    use crate::channels::{decode_hex_bytes, ClientChannelRegistry, DepositFloor, EvmChannel};
    use crate::claim_gate::ClientClaimGate;
    use crate::outbound_ledger::ClientPayoutLedger;
    use crate::session_registry::SessionRegistry;

    const FULFILLMENT: [u8; 32] = [7u8; 32];

    fn test_clock() -> Arc<TestClock> {
        Arc::new(TestClock::new(
            Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
        ))
    }

    fn test_signer() -> Arc<dyn Signer> {
        Arc::new(LocalSigner::generate("session-route-test"))
    }

    fn test_state(connector: Arc<Connector>, session_registry: SessionRegistry) -> ClientEdgeState {
        test_state_with_gate(
            connector,
            session_registry,
            ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
                .expect("a fresh in-memory journal has nothing to replay"),
        )
    }

    /// As [`test_state`], but with a caller-supplied [`ClientClaimGate`] --
    /// issue #770's own tests need one carrying a real
    /// [`crate::outbound_ledger::ClientPayoutLedger`], which [`test_state`]
    /// deliberately never configures (every pre-#770 session-routing test
    /// relies on that).
    fn test_state_with_gate(
        connector: Arc<Connector>,
        session_registry: SessionRegistry,
        claim_gate: ClientClaimGate,
    ) -> ClientEdgeState {
        ClientEdgeState {
            connector,
            signer: test_signer(),
            claim_gate,
            wrap_receiver_secret: None,
            settlement_terms: None,
            settlements: Vec::new(),
            btp_session_window: crate::DEFAULT_BTP_SESSION_WINDOW,
            session_registry: Arc::new(session_registry),
            // A node that mounts no peer carriage (issue #678): every
            // interaction on its listeners is a client's, which is the only
            // audience session routing has.
            peers: None,
        }
    }

    fn empty_connector() -> Arc<Connector> {
        Arc::new(Connector::new(
            vec![],
            vec![],
            Arc::new(FakeAppClient::new()),
            Arc::new(InProcessPeerTransport::new()),
            test_clock(),
        ))
    }

    fn sample_prepare(destination: &str, condition: [u8; 32]) -> Prepare {
        Prepare {
            amount: 0,
            expires_at: Utc.with_ymd_and_hms(2031, 1, 1, 0, 0, 0).unwrap(),
            execution_condition: condition,
            destination: destination.to_string(),
            data: Vec::new(),
        }
    }

    /// A handle over a real channel pair, mirroring
    /// `session_registry.rs`'s own `test_handle` -- the reply half a test
    /// can act as "the client" over, and the same `OutboundRequests` the
    /// handle wraps, kept alongside to answer through `outbound.resolve`.
    fn test_handle() -> (
        BtpSessionHandle,
        mpsc::Receiver<Vec<u8>>,
        Arc<OutboundRequests>,
    ) {
        let (replies, reply_rx) = mpsc::channel::<Vec<u8>>(4);
        let outbound = Arc::new(OutboundRequests::new());
        let handle = BtpSessionHandle::new(replies, Arc::clone(&outbound));
        (handle, reply_rx, outbound)
    }

    /// A handle whose send half is already gone -- simulates a session that
    /// died between `resolve` finding it and delivery reaching it.
    fn dead_handle() -> BtpSessionHandle {
        let (replies, reply_rx) = mpsc::channel::<Vec<u8>>(4);
        drop(reply_rx);
        BtpSessionHandle::new(replies, Arc::new(OutboundRequests::new()))
    }

    /// Read the one written MESSAGE off `reply_rx` and answer it with a
    /// RESPONSE carrying `ilp_packet`, exactly what a live client session
    /// does after receiving a forwarded PREPARE.
    async fn answer_next_message(
        reply_rx: &mut mpsc::Receiver<Vec<u8>>,
        outbound: &OutboundRequests,
        ilp_packet: Vec<u8>,
    ) {
        let sent = reply_rx.recv().await.expect("the MESSAGE was written");
        let decoded = decode_frame(&sent).expect("the connector's own encoder");
        outbound.resolve(BtpFrame {
            frame_type: BTP_RESPONSE,
            request_id: decoded.request_id,
            amount: None,
            protocol_data: Vec::new(),
            ilp_packet,
        });
    }

    #[tokio::test]
    async fn a_destination_with_no_session_and_no_route_answers_the_ordinary_f02() {
        let state = test_state(empty_connector(), SessionRegistry::new());
        let prepare = sample_prepare("g.nowhere", derive_condition(&FULFILLMENT));

        let response = route_prepare(&state, prepare, 0).await;

        let PacketResponse::Reject(reject) = response else {
            panic!("expected a reject");
        };
        assert_eq!(reject.code, RejectCode::f02_unreachable());
        assert_eq!(
            reject.accumulated_cost, 0,
            "an F02 that never reached a session keeps nothing"
        );
    }

    #[tokio::test]
    async fn a_prepare_to_a_bound_session_is_delivered_and_fulfilled() {
        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind("g.provider.one", handle, crate::now_unix());
        let state = test_state(empty_connector(), registry);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = sample_prepare("g.provider.one", condition);

        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
        });

        let response = route_prepare(&state, prepare, 0).await;
        peer.await.expect("the peer task");

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "a live session's own fulfilment is trusted once it matches the condition"
        );
    }

    #[tokio::test]
    async fn a_fulfilment_that_does_not_match_the_condition_is_rejected_and_priced() {
        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind("g.provider.two", handle, crate::now_unix());
        let state = test_state(empty_connector(), registry);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = sample_prepare("g.provider.two", condition);
        let wrong_fulfillment = [9u8; 32];

        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: wrong_fulfillment,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
        });

        let response = route_prepare(&state, prepare, 42).await;
        peer.await.expect("the peer task");

        let PacketResponse::Reject(reject) = response else {
            panic!("expected a reject");
        };
        assert_eq!(reject.code, RejectCode::f99_application_error());
        assert_eq!(
            reject.accumulated_cost, 42,
            "the session was genuinely reached, so this hop's price is still charged"
        );
    }

    #[tokio::test]
    async fn a_session_that_dies_between_resolve_and_delivery_answers_t01_not_f02() {
        let registry = SessionRegistry::new();
        registry.bind("g.provider.three", dead_handle(), crate::now_unix());
        let state = test_state(empty_connector(), registry);

        let prepare = sample_prepare("g.provider.three", derive_condition(&FULFILLMENT));
        let response = route_prepare(&state, prepare, 0).await;

        let PacketResponse::Reject(reject) = response else {
            panic!("expected a reject");
        };
        assert_eq!(
            reject.code,
            RejectCode::t01_peer_unreachable(),
            "a destination that looked like a live session but had no live binding is T01, not F02"
        );
        assert_eq!(
            reject.accumulated_cost, 0,
            "no value is kept for an unreachable session"
        );
    }

    #[tokio::test]
    async fn a_configured_app_route_is_never_shadowed_by_an_overlapping_session() {
        let route = StaticRoute::new("g.example.app", "http://localhost:4000").unwrap();
        let app_client = Arc::new(FakeAppClient::new());
        app_client.respond(
            route.handler_url(),
            connector_runtime::AppOutcome::Answered {
                response: connector_domain::EnvelopeResponse {
                    status: 200,
                    headers: vec![],
                    body: b"the configured app, not the session".to_vec(),
                },
            },
        );
        let signer = test_signer();
        let connector = Arc::new(
            Connector::new(
                vec![route],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                test_clock(),
            )
            .with_identity_signer(signer.clone()),
        );

        // A session is ALSO bound at the exact address the app route
        // covers -- if this arm ever won, the peer task below would
        // receive the forwarded MESSAGE and this test would hang waiting
        // for an answer nobody sends.
        let registry = SessionRegistry::new();
        let (handle, _reply_rx, _outbound) = test_handle();
        registry.bind("g.example.app", handle, crate::now_unix());
        let mut state = test_state(Arc::clone(&connector), registry);
        state.signer = signer.clone();

        let envelope = connector_domain::EnvelopeRequest {
            method: "POST".to_string(),
            target: "/".to_string(),
            headers: vec![],
            body: b"hello".to_vec(),
        }
        .encode();
        let (data, shared_secret) =
            connector_signer::giftwrap::seal_request(&envelope, &signer.public_key().unwrap())
                .expect("seal");
        let condition = derive_condition(&connector_signer::giftwrap::derive_fulfillment(
            &shared_secret,
        ));
        let prepare = Prepare {
            data,
            ..sample_prepare("g.example.app", condition)
        };

        let response = route_prepare(&state, prepare, 0).await;

        assert!(
            matches!(response, PacketResponse::Fulfill(_)),
            "the configured app route must answer, never the overlapping session"
        );
    }

    #[tokio::test]
    async fn delivery_after_a_reconnect_reaches_only_the_newer_session() {
        let registry = SessionRegistry::new();
        let (old_handle, mut old_rx, _old_outbound) = test_handle();
        registry.bind("g.provider.four", old_handle, crate::now_unix());

        let (new_handle, mut new_rx, new_outbound) = test_handle();
        registry.bind("g.provider.four", new_handle, crate::now_unix());

        let state = test_state(empty_connector(), registry);
        let condition = derive_condition(&FULFILLMENT);
        let prepare = sample_prepare("g.provider.four", condition);

        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut new_rx,
                &new_outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
        });

        let response = route_prepare(&state, prepare, 0).await;
        peer.await.expect("the peer task");

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        assert!(
            old_rx.try_recv().is_err(),
            "the superseded session never receives a delivery meant for the newer one"
        );
    }

    // ─── issue #770: a fulfilled session delivery credits and pays out ───

    /// The production wiring this issue adds: a real
    /// [`crate::outbound_ledger::ClientPayoutLedger`], attached to the gate
    /// through the exact same `with_payout_ledger` seam a real node's
    /// startup uses, is credited by [`route_prepare`] itself -- not by a
    /// test calling `record_payout` directly, per the issue's own AC4 ("a
    /// test that fails if the production call site is deleted"). The
    /// payout claim that follows is verified end to end: decoded off the
    /// wire, parsed back to JSON, and checked against the connector's own
    /// signing key, the same round trip `btp.rs`'s own payout test runs.
    ///
    /// **Issue #787.** The session is bound under an ILP address
    /// (`g.provider.nine`), never under `channel_id` itself -- the shape
    /// production actually reaches (issue #736/toon-client#503). The
    /// address-to-channel association is taught via
    /// `ClientClaimGate::record_session_channel`, exactly what
    /// `crate::btp::record_accepted_claim` does once a genuine inbound
    /// claim on this same session has cleared `admit`. Before #787's fix,
    /// this shape credited nothing at all: `credit_payout` was called with
    /// the ILP address itself, which does not decode as a channel id.
    #[tokio::test]
    async fn a_fulfilled_session_delivery_credits_the_payout_ledger_and_sends_a_signed_claim() {
        let address = "g.provider.nine";
        let channel_id = format!("0x{:064x}", 9);
        let payout_signer = Arc::new(LocalSigner::generate("payout-key"));
        let connector_address = derive_evm_address(&payout_signer.public_key().unwrap());
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x44; 20],
        };
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(payout_signer);
        ledger
            .set_channel_domain(channel_id.clone(), domain)
            .expect("valid channel id");
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 42_000,
            ..sample_prepare(address, condition)
        };

        let expected_channel_id = channel_id.clone();
        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;

            let sent = reply_rx
                .recv()
                .await
                .expect("the payout TRANSFER was written");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            assert_eq!(decoded.frame_type, BTP_TRANSFER);
            assert_eq!(decoded.amount, Some(42_000));

            let pd = decoded
                .protocol_data
                .iter()
                .find(|pd| pd.name == PAYOUT_CLAIM_PROTOCOL)
                .expect("the payout claim rode the TRANSFER");
            let json: serde_json::Value = serde_json::from_slice(&pd.data).expect("valid JSON");
            assert_eq!(json["channelId"], expected_channel_id);
            assert_eq!(json["cumulativeAmount"], 42_000);
            let signature_hex = json["signature"].as_str().unwrap();
            let signature_bytes = hex::decode(signature_hex.strip_prefix("0x").unwrap()).unwrap();

            let mut on_chain_id = [0u8; 32];
            on_chain_id[31] = 9;
            let proof = EvmBalanceProof {
                channel_id: on_chain_id,
                nonce: json["nonce"].as_u64().unwrap(),
                transferred_amount: u128::from(json["cumulativeAmount"].as_u64().unwrap()),
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: domain.chain_id,
                token_network_address: domain.token_network_address,
            };
            assert!(verify_evm_balance_proof(
                &proof,
                &signature_bytes,
                &connector_address
            ));

            outbound.resolve(BtpFrame {
                frame_type: BTP_RESPONSE,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Vec::new(),
            });
        });

        let response = route_prepare(&state, prepare, 0).await;
        peer.await.expect("the peer task");

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "the original packet still answers fulfilled -- crediting rides alongside it, never blocking it"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            42_000,
            "the earning session's own channel is credited exactly the delivered amount"
        );
    }

    /// Issue #770's AC3, exercised at the real call site: a job delivered
    /// twice to the same live session (the shape a sender's own retry
    /// takes -- the same execution condition, and therefore the same
    /// fulfilment, both times) must raise `credited` once, not twice, even
    /// though the session answers both deliveries as genuine fulfilments.
    ///
    /// Issue #787: the session is bound under an ILP address, not
    /// `channel_id`, per that issue's own test requirement.
    #[tokio::test]
    async fn a_retried_delivery_of_the_same_job_does_not_credit_twice() {
        let address = "g.provider.eleven";
        let channel_id = format!("0x{:064x}", 11);
        let payout_signer = Arc::new(LocalSigner::generate("payout-key"));
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x55; 20],
        };
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(payout_signer);
        ledger
            .set_channel_domain(channel_id.clone(), domain)
            .expect("valid channel id");
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let condition = derive_condition(&FULFILLMENT);

        // The session answers whatever it is sent -- a MESSAGE with a
        // genuine FULFILL, a TRANSFER with an empty ack -- exactly as a
        // real client's BTP session would for a job it has already done
        // once and is now being asked about again.
        let peer = tokio::spawn(async move {
            for _ in 0..3 {
                let sent = reply_rx.recv().await.expect("a frame was written");
                let decoded = decode_frame(&sent).expect("the connector's own encoder");
                let ilp_packet = if decoded.frame_type == BTP_TRANSFER {
                    Vec::new()
                } else {
                    Fulfill {
                        fulfillment: FULFILLMENT,
                        data: Vec::new(),
                    }
                    .encode()
                };
                outbound.resolve(BtpFrame {
                    frame_type: BTP_RESPONSE,
                    request_id: decoded.request_id,
                    amount: None,
                    protocol_data: Vec::new(),
                    ilp_packet,
                });
            }
        });

        let first = Prepare {
            amount: 5_000,
            ..sample_prepare(address, condition)
        };
        let response_first = route_prepare(&state, first, 0).await;

        let retry = Prepare {
            amount: 5_000,
            ..sample_prepare(address, condition)
        };
        let response_retry = route_prepare(&state, retry, 0).await;

        peer.await.expect("the peer task");

        assert!(matches!(response_first, PacketResponse::Fulfill(_)));
        assert!(
            matches!(response_retry, PacketResponse::Fulfill(_)),
            "the session itself still answers a retried job normally -- only crediting is deduped"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            5_000,
            "a retried delivery of the same job must not raise credited a second time"
        );
    }

    // ─── issue #780: a self-opened channel with no config row is still credited ───

    /// Issue #780's AC1, exercised at the real call site exactly as #770's
    /// own tests are: a channel this connector never declared in
    /// `[[client_channels]]` -- the shape a self-opened agent channel takes
    /// (toon-meta#261, ADR 0005/0006) -- is still credited when a PREPARE
    /// it served is FULFILLed. Before this issue's fix, this is exactly
    /// `outbound_ledger.rs`'s own `a_payout_on_an_unregistered_channel_produces_nothing`
    /// shape: the ledger has a signer but was never told this channel's
    /// domain, so `record_payout_once` always answered `None`. The only
    /// thing this test tells the connector about the channel at all is
    /// through the `ClientChannelRegistry`'s chain source -- the same
    /// budgeted resolver `verify_evm_claim_signature` already uses on the
    /// inbound side -- proving `credit_payout` reaches it rather than
    /// stopping at the ledger's own pre-seeded set.
    ///
    /// Issue #787: the session is bound under an ILP address, and the
    /// address-to-channel association is taught via
    /// `record_session_channel`, the same as every other test in this
    /// module now does.
    #[tokio::test]
    async fn a_self_opened_channel_with_no_config_row_is_credited_via_chain_resolution() {
        let address = "g.provider.forty-two";
        let channel_id = format!("0x{:064x}", 42);
        let on_chain_id = decode_hex_bytes::<32>(&channel_id).expect("valid test channel id");

        let payout_signer = Arc::new(LocalSigner::generate("payout-key"));
        let connector_address = derive_evm_address(&payout_signer.public_key().unwrap());
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x66; 20],
        };

        // No `set_channel_domain` call: this ledger has never heard of the
        // channel, only who it signs as.
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(payout_signer);
        let ledger = Arc::new(ledger);

        let source = Arc::new(FakeChannelSource::knowing(vec![(
            on_chain_id,
            EvmChannel {
                counterparty: [0x11; 20],
                chain_id: domain.chain_id,
                token_network_address: domain.token_network_address,
                deposit_floor: DepositFloor::AtLeast(1_000_000),
            },
        )]));
        let channel_registry = ClientChannelRegistry::new().with_source(source);

        let gate = ClientClaimGate::restore(channel_registry, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let session_registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        session_registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), session_registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 7_000,
            ..sample_prepare(address, condition)
        };

        let expected_channel_id = channel_id.clone();
        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;

            let sent = reply_rx
                .recv()
                .await
                .expect("the payout TRANSFER was written");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            assert_eq!(decoded.frame_type, BTP_TRANSFER);
            assert_eq!(decoded.amount, Some(7_000));

            let pd = decoded
                .protocol_data
                .iter()
                .find(|pd| pd.name == PAYOUT_CLAIM_PROTOCOL)
                .expect("the payout claim rode the TRANSFER");
            let json: serde_json::Value = serde_json::from_slice(&pd.data).expect("valid JSON");
            assert_eq!(json["channelId"], expected_channel_id);
            assert_eq!(json["cumulativeAmount"], 7_000);
            let signature_hex = json["signature"].as_str().unwrap();
            let signature_bytes = hex::decode(signature_hex.strip_prefix("0x").unwrap()).unwrap();

            let proof = EvmBalanceProof {
                channel_id: on_chain_id,
                nonce: json["nonce"].as_u64().unwrap(),
                transferred_amount: u128::from(json["cumulativeAmount"].as_u64().unwrap()),
                locked_amount: 0,
                locks_root: [0u8; 32],
                chain_id: domain.chain_id,
                token_network_address: domain.token_network_address,
            };
            assert!(
                verify_evm_balance_proof(&proof, &signature_bytes, &connector_address),
                "the claim is signed under the chain-resolved domain, not a defaulted one"
            );

            outbound.resolve(BtpFrame {
                frame_type: BTP_RESPONSE,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Vec::new(),
            });
        });

        let response = route_prepare(&state, prepare, 0).await;
        peer.await.expect("the peer task");

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "the original packet still answers fulfilled -- resolution rides alongside it"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            7_000,
            "a channel with no [[client_channels]] row is still credited once its domain resolves on chain"
        );
    }

    /// Issue #780's AC3: a channel that genuinely does not exist -- the
    /// chain source answers `Ok(None)` for it, same as a settled or never-opened
    /// channel -- still produces no claim and no credit. Resolution failure
    /// must never become a free credit.
    ///
    /// Issue #787: session bound under an ILP address, with the
    /// association to `channel_id` already taught, exactly as the two
    /// tests above -- this test is about chain resolution failing, not
    /// about the address/channel join, which is covered separately by
    /// `a_destination_with_no_known_channel_is_not_credited`.
    #[tokio::test]
    async fn a_channel_that_does_not_resolve_on_chain_is_not_credited() {
        let address = "g.provider.forty-three";
        let channel_id = format!("0x{:064x}", 43);

        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("payout-key")));
        let ledger = Arc::new(ledger);

        // A source that knows about no channels at all -- the chain's own
        // honest answer for one that was never opened.
        let source = Arc::new(FakeChannelSource::knowing(vec![]));
        let channel_registry = ClientChannelRegistry::new().with_source(source);

        let gate = ClientClaimGate::restore(channel_registry, Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let session_registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        session_registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), session_registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 3_000,
            ..sample_prepare(address, condition)
        };

        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
            reply_rx
        });

        let response = route_prepare(&state, prepare, 0).await;
        // `route_prepare` only returns once `credit_session_earnings` (and
        // therefore any payout TRANSFER it would send) has already been
        // awaited to completion -- so if nothing was queued by now, nothing
        // ever will be for this delivery.
        let mut reply_rx = peer.await.expect("the peer task");
        assert!(
            reply_rx.try_recv().is_err(),
            "a channel that never resolves must never receive a payout TRANSFER"
        );

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "the original packet still answers fulfilled even though nothing could be credited"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            0,
            "a channel that fails to resolve must never be credited"
        );
    }

    /// Issue #787's own scenario, reproduced directly: a session bound
    /// under its ILP address that has never itself presented a claim on
    /// this connector -- an earning agent whose counterparty has not yet
    /// paid it anything -- has no `record_session_channel` association at
    /// all. `credit_session_payout` must decide that case explicitly
    /// rather than by omission (the issue's own wording): no credit, and
    /// no payout TRANSFER, but the original packet still answers
    /// fulfilled. This is the exact production shape the issue's rig#59
    /// failure reproduced: before this fix, `credit_payout` was called
    /// with the ILP address itself, silently found nothing, and the very
    /// same "no credit, no claim, silently" outcome resulted -- for every
    /// session, not just an unassociated one. This test is what tells the
    /// two apart: this case is *supposed* to answer `None`.
    #[tokio::test]
    async fn a_destination_with_no_known_channel_is_not_credited() {
        let address = "g.provider.unpaid";

        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("payout-key")));
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        // Deliberately no `record_session_channel` call: this session has
        // never presented a claim this connector could learn a channel
        // from.

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 3_000,
            ..sample_prepare(address, condition)
        };

        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
            reply_rx
        });

        let response = route_prepare(&state, prepare, 0).await;
        // As `a_channel_that_does_not_resolve_on_chain_is_not_credited`:
        // `route_prepare` only returns once crediting has already been
        // awaited to completion.
        let mut reply_rx = peer.await.expect("the peer task");
        assert!(
            reply_rx.try_recv().is_err(),
            "a session with no known channel must never receive a payout TRANSFER"
        );

        assert!(
            matches!(response, PacketResponse::Fulfill(fulfill) if fulfill.fulfillment == FULFILLMENT),
            "the original packet still answers fulfilled even though nothing could be credited"
        );
    }

    // ─── issue #779: a payout claim whose delivery fails is resent ───

    /// The production wiring this issue adds, exercised through the real
    /// call site (`credit_session_earnings`), not by calling
    /// `deliver_pending_claim` directly -- per the issue's own AC4, this
    /// fails if that call site is deleted. A first delivery credits the
    /// ledger and then loses its payout TRANSFER (the session's reply
    /// channel is dropped right after it answers the FULFILL, simulating a
    /// socket that dies in exactly the window #779 describes): `credited`
    /// still rose and `pending_claim` still holds the stranded claim. A
    /// second delivery of the *same job* -- a retry, deduped by
    /// `credit_session_payout`'s own `record_payout_once` so it produces no
    /// fresh claim at all -- must still flush that stranded claim, proving
    /// the resend runs unconditionally rather than only alongside a fresh
    /// credit.
    #[tokio::test]
    async fn a_stranded_payout_claim_is_resent_on_the_next_successful_delivery_even_when_deduped() {
        let address = "g.provider.stranded";
        let channel_id = format!("0x{:064x}", 99);
        let payout_signer = Arc::new(LocalSigner::generate("payout-key"));
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x88; 20],
        };
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(payout_signer);
        ledger
            .set_channel_domain(channel_id.clone(), domain)
            .expect("valid channel id");
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let first = Prepare {
            amount: 5_000,
            ..sample_prepare(address, condition)
        };

        // Answer the FULFILL MESSAGE, then drop the reply channel before
        // the payout TRANSFER can even be written -- the credit must not
        // depend on this socket still being alive.
        let peer = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx,
                &outbound,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;
            drop(reply_rx);
        });

        let response_first = route_prepare(&state, first, 0).await;
        peer.await.expect("the peer task");

        assert!(matches!(response_first, PacketResponse::Fulfill(_)));
        assert_eq!(
            ledger.credited(&channel_id),
            5_000,
            "the credit must not depend on the payout TRANSFER's own delivery succeeding"
        );
        assert!(
            ledger.pending_claim(&channel_id).is_some(),
            "a failed delivery leaves the claim pending for the next caller to find"
        );

        // A fresh session reaches the same address (a reconnect, or simply
        // the next delivery landing on a working socket) and is sent a
        // RETRY of the exact same job.
        let (handle2, mut reply_rx2, outbound2) = test_handle();
        state
            .session_registry
            .bind(address, handle2, crate::now_unix());

        let retry = Prepare {
            amount: 5_000,
            ..sample_prepare(address, condition)
        };
        let expected_channel_id = channel_id.clone();
        let peer2 = tokio::spawn(async move {
            answer_next_message(
                &mut reply_rx2,
                &outbound2,
                Fulfill {
                    fulfillment: FULFILLMENT,
                    data: Vec::new(),
                }
                .encode(),
            )
            .await;

            let sent = reply_rx2
                .recv()
                .await
                .expect("the stranded payout TRANSFER was resent");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            assert_eq!(decoded.frame_type, BTP_TRANSFER);
            let pd = decoded
                .protocol_data
                .iter()
                .find(|pd| pd.name == PAYOUT_CLAIM_PROTOCOL)
                .expect("the stranded claim rode this TRANSFER");
            let json: serde_json::Value = serde_json::from_slice(&pd.data).expect("valid JSON");
            assert_eq!(json["channelId"], expected_channel_id);
            assert_eq!(json["cumulativeAmount"], 5_000);

            outbound2.resolve(BtpFrame {
                frame_type: BTP_RESPONSE,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Vec::new(),
            });
            reply_rx2
        });

        let response_retry = route_prepare(&state, retry, 0).await;
        let mut reply_rx2 = peer2.await.expect("the peer task");

        assert!(
            matches!(response_retry, PacketResponse::Fulfill(_)),
            "the session itself still answers a retried job normally"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            5_000,
            "a deduped retry must not credit a second time"
        );
        assert!(
            ledger.pending_claim(&channel_id).is_none(),
            "the successful resend acknowledged the claim, clearing pending_claim"
        );
        assert!(
            reply_rx2.try_recv().is_err(),
            "only one payout TRANSFER goes out -- no double send"
        );
    }

    /// The other half of "acknowledged only when the client actually took
    /// it": a client that answers the payout TRANSFER with an ERROR frame
    /// (RFC-0023's "could not accept this request") never received the
    /// claim, so it must stay pending for the next delivery or reconnect to
    /// resend. `deliver_transfer` answers `Ok` for an ERROR exactly as it
    /// does for a RESPONSE -- both correlate back against the originated
    /// requestId -- so treating "answered at all" as acceptance would
    /// strand precisely the claim this wiring exists to rescue.
    #[tokio::test]
    async fn a_payout_transfer_the_client_answers_with_an_error_leaves_the_claim_pending() {
        let address = "g.provider.refuses";
        let channel_id = format!("0x{:064x}", 77);

        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(Arc::new(LocalSigner::generate("payout-key")));
        ledger
            .set_channel_domain(
                channel_id.clone(),
                ChannelDomain {
                    chain_id: 84_532,
                    token_network_address: [0x88; 20],
                },
            )
            .expect("valid channel id");
        let stranded = ledger
            .record_payout(&channel_id, 4_000, "2030-01-01T00:00:00Z".parse().unwrap())
            .expect("signer and domain configured");
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));
        gate.record_session_channel(address, channel_id.clone());

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(address, handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let peer = tokio::spawn(async move {
            let sent = reply_rx.recv().await.expect("the TRANSFER was written");
            let decoded = decode_frame(&sent).expect("the connector's own encoder");
            assert_eq!(decoded.frame_type, BTP_TRANSFER);
            outbound.resolve(BtpFrame {
                frame_type: BTP_ERROR,
                request_id: decoded.request_id,
                amount: None,
                protocol_data: Vec::new(),
                ilp_packet: Vec::new(),
            });
        });

        deliver_pending_claim(&state, address, None, crate::now_unix()).await;
        peer.await.expect("the peer task");

        assert_eq!(
            ledger.pending_claim(&channel_id).map(|claim| claim.nonce),
            Some(stranded.nonce),
            "a refused TRANSFER leaves the same claim armed for the next attempt"
        );
        assert_eq!(
            ledger.credited(&channel_id),
            4_000,
            "a refused TRANSFER disturbs credited no more than an accepted one does"
        );
    }
}

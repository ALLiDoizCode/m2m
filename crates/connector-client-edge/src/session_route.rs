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

use connector_btp::BtpFrame;
use connector_domain::{
    fulfillment_matches_condition, Fulfill, PacketResponse, Prepare, Reject, RejectCode,
};

use crate::ClientEdgeState;

/// Route `prepare` through `state`: a configured route (app/peer/leased)
/// first, and -- only if that answers `F02` -- whatever client session
/// [`crate::session_registry::SessionRegistry`] currently has bound to its
/// destination. `price` is the same figure both ingresses already computed
/// from `Connector::app_route` before admitting any claim; it is only
/// consulted here to price a mismatched fulfilment the same way a
/// terminated app route's own would be (issue #736's charging AC).
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
    let encoded = prepare.encode();
    let response = state.connector.handle_prepare(prepare, 0).await;
    if !is_unreachable(&response) {
        // A configured route decided this packet -- never silently
        // overridden by a live session (issue #736's precedence AC).
        return response;
    }

    match state
        .session_registry
        .deliver(&destination, Some(lease.generation), &[], &encoded, now)
        .await
    {
        Ok(frame) => session_answer(frame, &condition, price),
        Err(reject) => PacketResponse::Reject(reject),
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
    use connector_btp::{decode_frame, BtpSessionHandle, OutboundRequests, BTP_RESPONSE};
    use connector_config::StaticRoute;
    use connector_domain::derive_condition;
    use connector_runtime::{
        Connector, FakeAppClient, InMemoryJournal, InProcessPeerTransport, TestClock,
    };
    use connector_signer::{LocalSigner, Signer};
    use std::sync::Arc;
    use tokio::sync::mpsc;

    use crate::claim_gate::ClientClaimGate;
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
        ClientEdgeState {
            connector,
            signer: test_signer(),
            claim_gate: ClientClaimGate::restore(
                Default::default(),
                Arc::new(InMemoryJournal::new()),
            )
            .expect("a fresh in-memory journal has nothing to replay"),
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
}

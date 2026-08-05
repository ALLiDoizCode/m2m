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
use connector_runtime::ClaimAckOutcome;

use crate::btp::payout_claim_protocol_data;
use crate::outbound_ledger::ClientPayoutLedger;
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
/// just genuinely fulfilled at) is a client session's own bound address,
/// which -- per `outbound_ledger.rs`'s own module doc, "a client-edge
/// channel has no separate peer identity" -- is also that channel's id.
/// No separate lookup exists or is needed: the same string that routed
/// this delivery names the channel to credit.
///
/// Both steps are best-effort once reached, and neither holds up
/// `route_prepare`'s own answer (already decided by the time this runs):
///
/// 1. [`crate::outbound_ledger::ClientPayoutLedger::record_payout_once`]
///    credits `amount`, deduped against `condition` (AC3) so a duplicate or
///    retransmitted fulfilment of the same job cannot double-credit. A node
///    with no payout ledger configured (`ClientClaimGate::payout_ledger`
///    returns `None`) does nothing here -- exactly its pre-#770 behaviour.
/// 2. [`deliver_pending_claim`] delivers whatever claim is now pending on
///    this channel as a payout TRANSFER over the same session, fenced
///    against the generation this delivery already used. This is
///    deliberately `pending_claim`, not just the claim `record_payout_once`
///    may have signed above: since a claim is cumulative, the one currently
///    pending already carries forward anything an earlier delivery on this
///    channel failed to hand off (issue #779) -- a job that itself was
///    deduped (no fresh claim signed) still gets a chance to flush a
///    previously stranded one. A session that has died in the meantime
///    loses only this delivery attempt, never the credit: `pending_claim`
///    stays armed for whatever next reaches this channel, whether that is
///    the next fulfilled job or a plain reconnect (see
///    [`resend_pending_claim`]).
async fn credit_session_earnings(
    state: &ClientEdgeState,
    destination: &str,
    generation: u64,
    condition: &[u8; 32],
    amount: u64,
    now: u64,
) {
    let Some(ledger) = state.claim_gate.payout_ledger() else {
        return;
    };
    ledger.record_payout_once(destination, condition, amount, chrono::Utc::now());
    deliver_pending_claim(state, ledger, destination, generation, now).await;
}

/// Issue #779: resend whatever payout claim is still owed to `destination`
/// on a client session (re)establishing there -- the other half of
/// `pending_claim`'s promise, alongside [`credit_session_earnings`]'s own
/// retry on the next fulfilled job. A session can otherwise go quiet for a
/// long time on a channel with nothing new to earn, and a claim stranded by
/// one failed delivery would then sit unpaid until it happened to earn
/// again. Production caller: `btp::handle_frame`'s auth branch, once
/// `SessionRegistry::bind` has installed the fresh generation this delivery
/// fences against.
///
/// A no-op with no payout ledger configured, or nothing pending -- the
/// common case, since [`deliver_pending_claim`] already acknowledges (and
/// therefore clears) every claim this connector knows it delivered.
pub(crate) async fn resend_pending_claim(
    state: &ClientEdgeState,
    destination: &str,
    generation: u64,
    now: u64,
) {
    let Some(ledger) = state.claim_gate.payout_ledger() else {
        return;
    };
    deliver_pending_claim(state, ledger, destination, generation, now).await;
}

/// Deliver `destination`'s current [`ClientPayoutLedger::pending_claim`], if
/// any, as a payout TRANSFER over its live session, and
/// [`ClientPayoutLedger::acknowledge`] it -- clearing `pending_claim` while
/// leaving `credited` untouched (`outbound_ledger.rs`'s own
/// `credited_survives_acknowledgement_unlike_pending_claim`) -- only once
/// delivery genuinely succeeds. A delivery that fails (dead session,
/// timeout, no session at all) leaves the claim pending exactly as it was,
/// so the next caller -- another fulfilled job or a reconnect -- tries
/// again with the same cumulative claim.
async fn deliver_pending_claim(
    state: &ClientEdgeState,
    ledger: &ClientPayoutLedger,
    destination: &str,
    generation: u64,
    now: u64,
) {
    let Some(claim) = ledger.pending_claim(destination) else {
        return;
    };
    let delivered = state
        .session_registry
        .deliver_transfer(
            destination,
            Some(generation),
            claim.cumulative_amount,
            &[payout_claim_protocol_data(&claim)],
            now,
        )
        .await;
    if delivered.is_ok() {
        ledger.acknowledge(destination, claim.nonce, ClaimAckOutcome::Accepted);
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
        decode_frame, BtpSessionHandle, OutboundRequests, BTP_RESPONSE, BTP_TRANSFER,
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
    #[tokio::test]
    async fn a_fulfilled_session_delivery_credits_the_payout_ledger_and_sends_a_signed_claim() {
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

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(channel_id.clone(), handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        let condition = derive_condition(&FULFILLMENT);
        let prepare = Prepare {
            amount: 42_000,
            ..sample_prepare(&channel_id, condition)
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
    #[tokio::test]
    async fn a_retried_delivery_of_the_same_job_does_not_credit_twice() {
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

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(channel_id.clone(), handle, crate::now_unix());
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
            ..sample_prepare(&channel_id, condition)
        };
        let response_first = route_prepare(&state, first, 0).await;

        let retry = Prepare {
            amount: 5_000,
            ..sample_prepare(&channel_id, condition)
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

    // ─── issue #779: a stranded payout claim gets a second chance ───

    /// The production call site this issue adds: `credit_session_earnings`
    /// now flushes whatever `pending_claim` is currently owed on every
    /// delivery, not only when this delivery itself signed a fresh one. A
    /// prior delivery is simulated the way `outbound_ledger.rs`'s own tests
    /// already model "credited but never acknowledged" -- `record_payout_once`
    /// called directly, arming `pending_claim` with nothing to clear it --
    /// standing in for a session that died between crediting and its own
    /// TRANSFER landing.
    ///
    /// This test would pass under the pre-#779 code too if the retry
    /// signed a fresh claim, since that claim IS what got delivered; it is
    /// deliberately a *deduped* retry of the exact same job instead, so
    /// `record_payout_once` signs nothing new and the only way this
    /// delivery can carry anything is by consulting `pending_claim`
    /// itself -- the call `deliver_pending_claim` (and therefore this
    /// test) is built to prove exists.
    #[tokio::test]
    async fn a_stranded_payout_claim_is_resent_on_the_next_successful_delivery_even_when_deduped() {
        let channel_id = format!("0x{:064x}", 33);
        let payout_signer = Arc::new(LocalSigner::generate("payout-key"));
        let domain = ChannelDomain {
            chain_id: 84_532,
            token_network_address: [0x77; 20],
        };
        let mut ledger = ClientPayoutLedger::new();
        ledger.set_signer(payout_signer);
        ledger
            .set_channel_domain(channel_id.clone(), domain)
            .expect("valid channel id");

        let condition = derive_condition(&FULFILLMENT);
        // Job 1 already credited this channel through the real production
        // dedupe path; what never happened is the client seeing the claim
        // it armed.
        let stranded = ledger
            .record_payout_once(
                &channel_id,
                &condition,
                3_000,
                Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap(),
            )
            .expect("first delivery of this job");
        let ledger = Arc::new(ledger);

        let gate = ClientClaimGate::restore(Default::default(), Arc::new(InMemoryJournal::new()))
            .expect("a fresh in-memory journal has nothing to replay")
            .with_payout_ledger(Arc::clone(&ledger));

        let registry = SessionRegistry::new();
        let (handle, mut reply_rx, outbound) = test_handle();
        registry.bind(channel_id.clone(), handle, crate::now_unix());
        let state = test_state_with_gate(empty_connector(), registry, gate);

        // Job 2 is a retry of job 1 (same execution condition) delivered
        // through a live session -- `record_payout_once` dedupes it and
        // signs no fresh claim, so the only claim this delivery can carry
        // is the one job 1 left pending.
        let peer = tokio::spawn(async move {
            for _ in 0..2 {
                let sent = reply_rx.recv().await.expect("a frame was written");
                let decoded = decode_frame(&sent).expect("the connector's own encoder");
                let ilp_packet = if decoded.frame_type == BTP_TRANSFER {
                    let pd = decoded
                        .protocol_data
                        .iter()
                        .find(|pd| pd.name == PAYOUT_CLAIM_PROTOCOL)
                        .expect("the stranded claim rode this TRANSFER");
                    let json: serde_json::Value =
                        serde_json::from_slice(&pd.data).expect("valid JSON");
                    assert_eq!(
                        json["nonce"], stranded.nonce,
                        "the same claim job 1 signed, not a new one"
                    );
                    assert_eq!(json["cumulativeAmount"], 3_000);
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

        let retry = Prepare {
            amount: 3_000,
            ..sample_prepare(&channel_id, condition)
        };
        let response = route_prepare(&state, retry, 0).await;
        peer.await.expect("the peer task");

        assert!(matches!(response, PacketResponse::Fulfill(_)));
        assert_eq!(
            ledger.credited(&channel_id),
            3_000,
            "a deduped retry must not credit a second time"
        );
        assert!(
            ledger.pending_claim(&channel_id).is_none(),
            "the stranded claim was finally delivered and acknowledged"
        );
    }
}

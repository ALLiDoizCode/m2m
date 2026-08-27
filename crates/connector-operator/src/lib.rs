//! Operator router, mountable rather than a server. See ADR 0001, ADR 0008.
//!
//! ADR 0008 splits the operator surface into a read half and a write
//! half. The read half (issue #420) is `GET` endpoints -- peers, routes,
//! channels, claims, node identity, this crate's own write audit log, and
//! the metrics surface (`GET /metrics`, ADR 0014) -- gated by a bearer
//! token and nothing else.
//!
//! This crate also carries the write half's authentication mechanism
//! (issue #421): [`rfc9421`] verifies an RFC 9421 signature from a key on
//! an operator write allowlist, with the body bound by RFC 9530
//! Content-Digest, and [`write_auth::WriteAuth`] adds replay rejection and
//! retains every accepted signature as its write's audit record (ADR
//! 0012), exposed for inspection at `GET /audit-log`.
//!
//! `POST /packets` -- originating a packet outward -- `POST /routes/leased`
//! -- creating or renewing a leased route (issue #427) -- and
//! `POST /channels`, `POST /channels/:id/fund`, `POST /channels/:id/redeem`,
//! `POST /channels/:id/close` (channel lifecycle, ADR 0008's third write,
//! issue #459), `POST /channels/:id/settle` (issue #1129 -- the write that
//! *finishes* a close, once its challenge period has elapsed),
//! `POST /channels/:id/redeem-latest` and
//! `POST /channels/:id/cooperative-close` (on-chain redemption and
//! cooperative close of whatever claim this node already holds, issue #425)
//! -- are this crate's write endpoints. Every one calls
//! [`write_auth::authenticate_write`] first and nothing else in this
//! crate accepts a body, so a write cannot reach [`Connector`] without a
//! valid, allowlisted, unexpired, non-replayed signature. Bearer tokens
//! gate reads and reads only; no shared secret is ever sufficient to move
//! value. Channel writes 503 rather than reach [`Connector`] at all on a
//! node with no settlement backend configured
//! ([`connector_runtime::ChannelOperationError::NoSettlementBackend`]).
//!
//! Per ADR 0001, each read handler below deserializes nothing beyond the
//! bearer token (a GET request has no body) and calls exactly one
//! [`Connector`] method. Every read serializes its result as JSON except
//! `GET /metrics`, which is Prometheus text exposition format (ADR 0014)
//! -- the one format Prometheus itself can scrape.

mod rfc9421;
mod write_auth;

/// Signing helpers for constructing a validly-signed operator write from
/// outside this crate.
///
/// Ungated. These were behind `test-util` while the only callers were tests,
/// but `connector send` (the binary's third verb) signs a real
/// `POST /packets` with exactly these, so they are shipped code now. The
/// verification half is unaffected and stays private to this crate.
pub mod signing {
    pub use crate::rfc9421::{compute_content_digest, keyid_hex, sign_request};
}

/// The old name for [`signing`], kept so the `test-util` feature keeps
/// meaning what it meant to existing callers (`connector-cli`'s settlement
/// lifecycle test, issue #542). New code should use [`signing`] directly --
/// there is nothing test-only about it any more.
#[cfg(feature = "test-util")]
pub mod test_support {
    pub use crate::signing::{compute_content_digest, keyid_hex, sign_request};
}

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, Request, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use connector_domain::{PacketResponse, Prepare, Price};
use connector_runtime::{
    ChannelOperationError, ChannelView, ClaimView, Connector, EstablishPeeringError,
    LeaseRouteError, LeasedRouteView, PeerRouteTableError, PeerRouteView, PeerView, RouteView,
    SettlementChain,
};
use connector_settlement::Claim;
use connector_signer::{derive_evm_address, to_hex, Signer, SignerError};
use url::Url;
use write_auth::{authenticate_write, AuditRecord, WriteAuth};

const OCTET_STREAM: &str = "application/octet-stream";

/// This node's own identity: the active signing key and the address
/// derived from it (ADR 0012's signer, read rather than exercised).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeIdentity {
    pub key_id: String,
    pub address: String,
}

#[derive(Clone)]
struct OperatorState {
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    bearer_token: Arc<str>,
    write_auth: Arc<WriteAuth>,
}

/// Mount the operator surface's read-only half at `connector`: `GET`
/// endpoints for peers, routes, channels, claims, node identity and the
/// write audit log, each requiring the bearer token
/// `bearer_token` and nothing more (ADR 0008). `write_keys` is the
/// allowlist of ed25519 public keys permitted to sign a write once a
/// write endpoint lands (issue #421); removing a key from this list and
/// restarting revokes it, with no other change.
pub fn router(
    connector: Arc<Connector>,
    signer: Arc<dyn Signer>,
    bearer_token: impl Into<String>,
    write_keys: Vec<[u8; 32]>,
) -> Router {
    let state = OperatorState {
        connector,
        signer,
        bearer_token: Arc::from(bearer_token.into()),
        write_auth: Arc::new(WriteAuth::new(write_keys)),
    };

    // Reads: gated by the bearer token and nothing else. Writes: gated by
    // an RFC 9421 signature and nothing else (ADR 0008) -- `route_layer`
    // only wraps the routes already added to `reads` when it is called,
    // so `writes`, merged in afterward, is never behind the bearer token.
    let reads = Router::new()
        .route("/peers", get(peers))
        .route("/routes", get(routes))
        .route("/routes/leased", get(leased_routes))
        .route("/routes/peers", get(peer_routes))
        .route("/channels", get(channels))
        .route("/claims", get(claims))
        .route("/identity", get(identity))
        .route("/audit-log", get(audit_log))
        .route("/metrics", get(metrics))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer_token,
        ));

    let writes = Router::new()
        .route("/packets", post(originate_packet))
        .route("/routes/leased", post(create_leased_route))
        .route("/peers", post(upsert_peer))
        .route("/peers/:id", delete(remove_peer))
        .route("/routes/peers", post(upsert_peer_route))
        .route("/routes/peers/:prefix", delete(remove_peer_route))
        .route("/channels", post(open_channel))
        .route("/channels/:id/fund", post(fund_channel))
        .route("/channels/:id/redeem", post(redeem_channel))
        .route("/channels/:id/redeem-latest", post(redeem_latest_claim))
        .route("/channels/:id/close", post(close_channel))
        .route("/channels/:id/settle", post(settle_channel))
        .route("/channels/:id/cooperative-close", post(cooperative_close));

    reads.merge(writes).with_state(state)
}

/// Authenticate a write request against `state`'s [`WriteAuth`], returning
/// the `401 Unauthorized` status and body to send back immediately on
/// failure (kept as a plain `(StatusCode, String)` here rather than a
/// pre-built [`Response`] so this stays a small `Result::Err`, matching
/// [`write_auth::authenticate_write`]'s own reasoning for returning a plain
/// [`write_auth::WriteAuthError`] instead). Every write handler below calls
/// this first, before touching the body for anything else -- see the
/// module docs.
fn require_write_auth(
    state: &OperatorState,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<(), (StatusCode, String)> {
    authenticate_write(
        &state.write_auth,
        method.as_str(),
        uri.path(),
        headers,
        body,
    )
    .map(|_| ())
    .map_err(|error| (StatusCode::UNAUTHORIZED, error.to_string()))
}

async fn require_bearer_token<B>(
    State(state): State<OperatorState>,
    request: Request<B>,
    next: Next<B>,
) -> Response {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "));

    match presented {
        Some(token) if token == state.bearer_token.as_ref() => next.run(request).await,
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

async fn peers(State(state): State<OperatorState>) -> Json<Vec<PeerView>> {
    Json(state.connector.peers())
}

async fn routes(State(state): State<OperatorState>) -> Json<Vec<RouteView>> {
    Json(state.connector.routes())
}

/// `GET /routes/leased`: every leased route (issue #427) not yet lapsed as
/// of this node's own clock -- the read side of the same table
/// `POST /routes/leased` writes to.
async fn leased_routes(State(state): State<OperatorState>) -> Json<Vec<LeasedRouteView>> {
    Json(state.connector.leased_routes())
}

async fn channels(State(state): State<OperatorState>) -> Json<Vec<ChannelView>> {
    Json(state.connector.channels().await)
}

async fn claims(State(state): State<OperatorState>) -> Json<Vec<ClaimView>> {
    Json(state.connector.claims())
}

async fn audit_log(State(state): State<OperatorState>) -> Json<Vec<AuditRecord>> {
    Json(state.write_auth.audit_log())
}

/// `GET /metrics`: the decided metrics surface (ADR 0014) -- packets,
/// rejects, fees, exposure and settlement -- in Prometheus text exposition
/// format. A read like any other on this surface: gated by the bearer
/// token and nothing else, per ADR 0008.
async fn metrics(State(state): State<OperatorState>) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.connector.metrics().encode(),
    )
        .into_response()
}

/// `POST /packets`: an operator originates a packet outward, exactly as
/// the client edge does for an external caller -- decode a [`Prepare`],
/// call [`Connector::handle_prepare`] once, encode the outcome. The one
/// difference is what happens first: [`authenticate_write`] must accept
/// the request's RFC 9421 signature before any of that runs.
async fn originate_packet(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let prepare = match Prepare::decode(&body) {
        Ok(prepare) => prepare,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    // An operator-originated packet is handed to the connector exactly as
    // a client's is. It declares no floor of its own: the
    // `minimum_delivery = prepare.amount` convention that used to live
    // here was a third convention no record ever carried, and it made
    // `amount - fee >= minimum_delivery` unsatisfiable for any non-zero
    // fee, so a fee-charging peering could never carry an operator's
    // packet at all (ADR 0057, issue #1143). What bounds erosion now is
    // the claim covering each crossing.
    let encoded = match state.connector.handle_prepare(prepare).await {
        PacketResponse::Fulfill(fulfill) => fulfill.encode(),
        PacketResponse::Reject(reject) => reject.encode(),
    };

    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, OCTET_STREAM)],
        encoded,
    )
        .into_response()
}

/// A `POST /routes/leased` request body: create or renew a leased route
/// (ADR 0006, issue #427) forwarding `prefix` to peer `peer_id` for
/// `ttl_seconds` from this node's own clock. Posting the same `prefix`
/// again before it lapses renews it to a fresh `ttl_seconds` from whenever
/// the renewal is received -- that is the only way a leased route stays
/// alive, since nothing in the runtime extends one on its own.
///
/// Carries no `fee`: what this hop retains for carrying a packet to
/// `peer_id` is that peering's own fee, written on the `[[peers]]` row or
/// posted to `POST /peers` (ADR 0061). A controller that leased a route at
/// its own fee was setting a peering's terms through a route, which is
/// exactly what that record moved.
#[derive(Debug, Deserialize)]
struct CreateLeasedRouteRequest {
    prefix: String,
    peer_id: String,
    ttl_seconds: i64,
}

/// `POST /routes/leased`: a controller outside this connector pushes a
/// route to a peer with a time limit. Authenticated exactly like
/// `POST /packets` -- [`authenticate_write`] first, nothing else in this
/// handler accepts the request until that succeeds.
async fn create_leased_route(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: CreateLeasedRouteRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    match state.connector.upsert_leased_route(
        request.prefix,
        request.peer_id,
        chrono::Duration::seconds(request.ttl_seconds),
    ) {
        Ok(view) => Json(view).into_response(),
        Err(LeaseRouteError::InvalidPrefix(prefix)) => (
            StatusCode::BAD_REQUEST,
            format!("invalid ILP address: '{prefix}'"),
        )
            .into_response(),
    }
}

/// `GET /routes/peers`: every peer-forwarding route this node knows (issue
/// #884) -- config-file and runtime alike, each tagged with its
/// [`connector_runtime::RouteSource`]. Deliberately distinct from
/// `GET /routes/leased`: a lease carries no price and does not survive a
/// restart, so it is not part of this table.
async fn peer_routes(State(state): State<OperatorState>) -> Json<Vec<PeerRouteView>> {
    Json(state.connector.peer_routes_view())
}

/// Map a [`PeerRouteTableError`] to the response `POST`/`DELETE`
/// `/peers*` and `/routes/peers*` answer with. `OwnedByConfig` and
/// `PeerInUse` are `409 Conflict` -- the request is refused because of the
/// table's *current state*, not because the request itself is malformed.
/// `UnknownPeerId`/`InvalidPrefix`/`InvalidPeerId` are `400 Bad Request` --
/// the request names something that cannot resolve to a valid row no
/// matter the table's state. `PeerNotFound`/`RouteNotFound` are `404`.
/// `Persistence` is `500` -- the durable write itself failed, so the
/// mutation was refused rather than applied in memory only.
fn peer_route_table_error_response(error: PeerRouteTableError) -> Response {
    match error {
        PeerRouteTableError::OwnedByConfig(_) | PeerRouteTableError::PeerInUse(_) => {
            (StatusCode::CONFLICT, error.to_string()).into_response()
        }
        // The last two are ADR 0058's runtime twins: a peering with no
        // channel bound to it, and a route forwarding to a peering with no
        // channel to pay from. `400`, beside `UnknownPeerId` -- the
        // request names something that cannot resolve to a valid row
        // whatever the table's current state is, which is the line this
        // function already draws.
        PeerRouteTableError::UnknownPeerId { .. }
        | PeerRouteTableError::InvalidPrefix(_)
        | PeerRouteTableError::InvalidPeerId
        | PeerRouteTableError::PeerChannelUnbound(_)
        | PeerRouteTableError::PeerHasNoPayChannel { .. } => {
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
        PeerRouteTableError::PeerNotFound(_) | PeerRouteTableError::RouteNotFound(_) => {
            (StatusCode::NOT_FOUND, error.to_string()).into_response()
        }
        PeerRouteTableError::Persistence(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

/// A `POST /peers` request body: **establish a peering** (ADR 0058).
///
/// ```json
/// { "id": "apex-relay-2",
///   "url": "https://relay.example/ilp",
///   "fee": 100,
///   "max_packet_amount": 5000 }
/// ```
///
/// * `url` is the counterparty's connector URL. The node `GET`s the
///   self-description there (ADR 0050) and takes from it the endpoint, the
///   carriage that endpoint's scheme implies, the edge identity, and the
///   per-chain settlement addresses and chain facts. **Whatever that URL
///   serves is who the peering is with:** the fetched identity is not
///   checked against anything in this request, and ADR 0058 considered
///   requiring such a check and rejected it. The operator's vetting of the
///   URL is the whole of the assurance.
/// * `id` is the operator's own **local label** for the peering. Never
///   derived from the peer's ILP address -- that is self-asserted, a claim
///   and not a grant -- nor from the URL host. Refused (`409`) when the
///   config file already defines it (ADR 0034).
/// * `fee` is this peering's flat per-packet fee (ADR 0010, ADR 0061):
///   what this connector retains for carrying one packet to `id`,
///   whichever prefix the packet was addressed to. Omitted is zero -- free
///   carriage -- and a later post of the same `id` with a different `fee`
///   reprices the peering, since the packet path reads the fee off the
///   peering on every forward rather than off a copy baked into each
///   route.
/// * `max_packet_amount` is ADR 0049's **cap**: the largest amount this
///   connector will forward to `id` in one packet, refused `T04` above it.
///   Omitted -- or zero -- keeps `DEFAULT_MAX_PACKET_AMOUNT`; no value
///   here removes the bound.
/// * `chain` disambiguates the one case with no honest default: two nodes
///   settling on more than one chain in common. Left out, a single shared
///   chain is used and several are refused by name rather than resolved
///   silently, the same posture `POST /channels` takes.
///
/// `fee` and `max_packet_amount` are the operator's policy about this
/// counterparty, and are in this request precisely because no document can
/// supply them (ADR 0006).
#[derive(Debug, Deserialize)]
struct UpsertPeerRequest {
    id: String,
    url: String,
    #[serde(default)]
    fee: u64,
    #[serde(default)]
    max_packet_amount: u64,
    #[serde(default)]
    chain: Option<String>,
}

/// Map an [`EstablishPeeringError`] to the response `POST /peers` answers
/// with.
///
/// The distinction that matters: `502 Bad Gateway` for everything the
/// **counterparty's host** did -- unreachable, redirecting, oversized,
/// malformed, or describing a node this one cannot peer with -- and `400`
/// for what this request itself got wrong. An operator reading a `502`
/// knows to go and look at the URL they named; a `400` is theirs to fix
/// here.
fn establish_peering_error_response(error: EstablishPeeringError) -> Response {
    match error {
        EstablishPeeringError::SelfDescription(_)
        | EstablishPeeringError::NoDialableEndpoint { .. }
        | EstablishPeeringError::NoSharedChain { .. }
        | EstablishPeeringError::UnreadableSettlementAddress { .. } => {
            (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
        }
        EstablishPeeringError::AmbiguousChain { .. } => {
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
        EstablishPeeringError::Channel(error) => channel_operation_error_response(error),
        EstablishPeeringError::Table(error) => peer_route_table_error_response(error),
    }
}

/// `POST /peers`: ADR 0058's one operator write. Authenticated exactly
/// like every other write on this surface -- [`authenticate_write`] first,
/// nothing else in this handler accepts the request until that succeeds.
/// No bearer token reaches it: establishing a peering moves value.
///
/// **This endpoint can spend gas.** It may open a payment channel and wait
/// for it to confirm, so it is deliberately safe to retry: repeating the
/// same request against a peering already established finds the same
/// channel and is a success, not a second channel (ADR 0059's derivation
/// makes that structural). The answer says which branch it took --
/// `channel: { id, status: "found" | "created" }` -- so an unintended
/// second channel is visible in the operator's own output rather than
/// discovered later on a block explorer.
async fn upsert_peer(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: UpsertPeerRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let url = match Url::parse(&request.url) {
        Ok(url) => url,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                format!("'{}' is not a URL: {error}", request.url),
            )
                .into_response()
        }
    };
    let chain = match request.chain.as_deref().map(str::parse::<SettlementChain>) {
        None => None,
        Some(Ok(chain)) => Some(chain),
        Some(Err(error)) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    match state
        .connector
        .establish_peering(
            request.id,
            &url,
            request.fee,
            request.max_packet_amount,
            chain,
        )
        .await
    {
        Ok(established) => Json(established).into_response(),
        Err(error) => establish_peering_error_response(error),
    }
}

/// `DELETE /peers/:id`: remove a runtime peer row (issue #884). No request
/// body; authenticated over the path and method exactly like every other
/// write, since `authenticate_write` binds the signature to the whole
/// request rather than to a body a `DELETE` need not carry.
async fn remove_peer(
    State(state): State<OperatorState>,
    Path(id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    match state.connector.remove_runtime_peer(&id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => peer_route_table_error_response(error),
    }
}

/// A `POST /routes/peers` request body: add or update a runtime
/// peer-forwarding route (issue #884), keyed by `prefix` exactly like
/// `POST /routes/leased` -- posting the same prefix again updates the row
/// rather than adding a duplicate.
///
/// `price` is what this node's client edge charges a client for a packet to
/// `prefix` (ADR 0028). What this hop retains of it is `peer_id`'s own fee,
/// written on the peering by `POST /peers` and never here (ADR 0061).
///
/// It takes the config file's own spelling (ADR 0065): a bare integer for a
/// flat price, `{ "base": .., "per_kib": .. }` for one with a slope. A body
/// written before schedules existed carries the former and still means what
/// it meant.
#[derive(Debug, Deserialize)]
struct UpsertPeerRouteRequest {
    prefix: String,
    peer_id: String,
    price: Price,
}

/// `POST /routes/peers`: issue #884's runtime peer-route write.
/// Authenticated exactly like every other write on this surface.
async fn upsert_peer_route(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: UpsertPeerRouteRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    match state
        .connector
        .upsert_runtime_peer_route(request.prefix, request.peer_id, request.price)
    {
        Ok(view) => Json(view).into_response(),
        Err(error) => peer_route_table_error_response(error),
    }
}

/// `DELETE /routes/peers/:prefix`: remove a runtime peer-forwarding route
/// (issue #884). No request body, authenticated exactly like
/// `DELETE /peers/:id`.
async fn remove_peer_route(
    State(state): State<OperatorState>,
    Path(prefix): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    match state.connector.remove_runtime_peer_route(&prefix) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => peer_route_table_error_response(error),
    }
}

/// A `POST /channels` request body: open a channel to `counterparty_hex`
/// (arbitrary bytes, hex-encoded -- an EVM backend expects a 20-byte
/// address, a Solana one a 32-byte pubkey, but the port itself takes
/// opaque bytes) with a `settlement_timeout_seconds`-second
/// withdrawal-safety window (issue #459, ADR 0008). `chain` names which
/// configured settlement backend opens it (`"evm"` or `"solana"`, the
/// config file's own chain names, issue #630); omitted, it means "the
/// configured backend", which a node settling on more than one chain
/// refuses as ambiguous rather than resolving silently.
#[derive(Debug, Deserialize)]
struct OpenChannelRequest {
    counterparty_hex: String,
    settlement_timeout_seconds: i64,
    #[serde(default)]
    chain: Option<String>,
}

/// A `POST /channels/:id/fund` request body: deposit `amount` into the
/// channel named by the path.
#[derive(Debug, Deserialize)]
struct FundChannelRequest {
    amount: u128,
}

/// A `POST /channels/:id/redeem` request body: redeem a claim of
/// `cumulative_amount` at `nonce` (issue #573 -- without it, nothing this
/// submits is redeemable on any real chain), authorized by `signature_hex`
/// (opaque, hex-encoded -- this port does not verify it; see
/// `connector_settlement::Claim`).
#[derive(Debug, Deserialize)]
struct RedeemChannelRequest {
    nonce: u64,
    cumulative_amount: u128,
    signature_hex: String,
}

fn channel_operation_response(result: Result<ChannelView, ChannelOperationError>) -> Response {
    match result {
        Ok(view) => Json(view).into_response(),
        Err(error) => channel_operation_error_response(error),
    }
}

/// The status a failed channel operation answers with, shared by every
/// endpoint that drives one -- the channel lifecycle writes, and
/// `POST /peers`, which opens a channel of its own (ADR 0058).
fn channel_operation_error_response(error: ChannelOperationError) -> Response {
    match error {
        // Both "no backend at all" and "no backend on that chain" are the
        // node's own configuration lacking what the request needs -- 503,
        // not a caller error.
        ChannelOperationError::NoSettlementBackend
        | ChannelOperationError::NoSettlementBackendForChain(_) => {
            (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response()
        }
        ChannelOperationError::NoClaimToRedeem
        | ChannelOperationError::AmbiguousSettlementChain
        | ChannelOperationError::Settlement(_) => {
            (StatusCode::BAD_REQUEST, error.to_string()).into_response()
        }
    }
}

/// Decode `0x`-optional hex into raw bytes; `Err` on odd length or a
/// non-hex character.
fn decode_hex(input: &str) -> Result<Vec<u8>, ()> {
    let trimmed = input.strip_prefix("0x").unwrap_or(input);
    if !trimmed.len().is_multiple_of(2) {
        return Err(());
    }
    (0..trimmed.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&trimmed[i..i + 2], 16).map_err(|_| ()))
        .collect()
}

/// `POST /channels`: open a new payment channel (issue #459, ADR 0008).
/// Authenticated exactly like every other write on this surface --
/// [`authenticate_write`] first, nothing else in this handler accepts the
/// request until that succeeds.
async fn open_channel(
    State(state): State<OperatorState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: OpenChannelRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let counterparty = match decode_hex(&request.counterparty_hex) {
        Ok(bytes) => bytes,
        Err(()) => {
            return (StatusCode::BAD_REQUEST, "counterparty_hex must be hex").into_response()
        }
    };
    let chain = match request.chain.as_deref().map(str::parse::<SettlementChain>) {
        None => None,
        Some(Ok(chain)) => Some(chain),
        Some(Err(error)) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    channel_operation_response(
        state
            .connector
            .open_channel(
                chain,
                counterparty,
                chrono::Duration::seconds(request.settlement_timeout_seconds),
            )
            .await,
    )
}

/// `POST /channels/:id/fund`: deposit into an existing channel (issue
/// #459, ADR 0008).
async fn fund_channel(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: FundChannelRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };

    channel_operation_response(
        state
            .connector
            .fund_channel(&channel_id, request.amount)
            .await,
    )
}

/// `POST /channels/:id/redeem`: redeem a claim against an existing channel
/// (issue #459, ADR 0008).
async fn redeem_channel(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    let request: RedeemChannelRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => return (StatusCode::BAD_REQUEST, error.to_string()).into_response(),
    };
    let signature = match decode_hex(&request.signature_hex) {
        Ok(bytes) => bytes,
        Err(()) => return (StatusCode::BAD_REQUEST, "signature_hex must be hex").into_response(),
    };

    channel_operation_response(
        state
            .connector
            .redeem_channel(
                &channel_id,
                Claim {
                    nonce: request.nonce,
                    cumulative_amount: request.cumulative_amount,
                    signature,
                },
            )
            .await,
    )
}

/// `POST /channels/:id/close`: close an existing channel (issue #459, ADR
/// 0008). No request body.
async fn close_channel(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    channel_operation_response(state.connector.close_channel(&channel_id).await)
}

/// `POST /channels/:id/settle`: settle a closed channel whose challenge
/// period has elapsed, paying each side's remaining deposit back out on
/// chain and making the channel permanently done (issue #1129). No request
/// body.
///
/// The seventh channel write, and the one that finishes what
/// `POST /channels/:id/close` starts. Before it, `close` began a challenge
/// period no operator surface could then settle: `cooperative-close` is a
/// redeem plus that same close, so it did not finish one either, and the
/// remainder came back only by calling the chain directly -- possible with
/// `cast send` against `TokenNetwork.settleChannel`, and possible with
/// *nothing* on Solana, whose CLI cannot build a `SettleChannel`
/// instruction. That is the same argument that made `POST /channels` a
/// write rather than a runbook (issue #459).
///
/// Authenticated like every other write here (ADR 0008), even though both
/// chains make settling permissionless -- `TokenNetwork.settleChannel` and
/// `packages/solana-program`'s `SettleChannel` each let any caller settle
/// once the window has passed. The signature is not guarding who may
/// settle; it is guarding this node's settlement key, which pays the gas
/// and whose nonce sequence the transaction joins.
///
/// Settling before the window closes answers `400` with
/// `SettlementError::SettlementNotYetDue` named in the body, exactly like
/// every other settlement refusal on this surface -- a retry-later answer,
/// not a different status code.
async fn settle_channel(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    channel_operation_response(state.connector.settle_channel(&channel_id).await)
}

/// `POST /channels/:id/redeem-latest`: redeem the latest claim this node
/// has itself verified and accepted on the channel named by the path
/// (issue #425) -- unlike `POST /channels/:id/redeem`, the caller supplies
/// no claim; the connector submits whichever one it already holds. No
/// request body.
async fn redeem_latest_claim(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    channel_operation_response(state.connector.redeem_latest_claim(&channel_id).await)
}

/// `POST /channels/:id/cooperative-close`: redeem whatever claim this node
/// last accepted on the channel named by the path, then close it -- one
/// write instead of two, and no dispute window to wait out (issue #425,
/// story 37). No request body.
async fn cooperative_close(
    State(state): State<OperatorState>,
    Path(channel_id): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(error) = require_write_auth(&state, &method, &uri, &headers, &body) {
        return error.into_response();
    }

    channel_operation_response(state.connector.cooperative_close(&channel_id).await)
}

async fn identity(State(state): State<OperatorState>) -> Response {
    match node_identity(state.signer.as_ref()) {
        Ok(identity) => Json(identity).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

fn node_identity(signer: &dyn Signer) -> Result<NodeIdentity, SignerError> {
    let public_key = signer.public_key()?;
    Ok(NodeIdentity {
        key_id: signer.key_id(),
        address: to_hex(&derive_evm_address(&public_key)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use connector_config::StaticRoute;
    use connector_runtime::{
        ClaimStateDomain, ClaimStateSource, ClaimWatermark, EvmDomain, FakeAppClient,
        InProcessPeerTransport, OutboundClientError, OutboundClientLedger, RouteSource, TestClock,
    };
    use connector_signer::LocalSigner;
    use tower::ServiceExt;

    /// A next hop reporting where this node's claims on a channel stand --
    /// the authority every covering claim is priced off (see
    /// `connector_runtime::outbound_client`'s header). A fake upholding the
    /// port's contract, not a stub with expectations (ADR 0007).
    struct ReportsAWatermark;

    #[axum::async_trait]
    impl ClaimStateSource for ReportsAWatermark {
        async fn watermark(
            &self,
            _channel: &[u8; 32],
            _domain: &ClaimStateDomain,
        ) -> Result<ClaimWatermark, OutboundClientError> {
            Ok(ClaimWatermark {
                nonce: 0,
                cumulative: 0,
                available: Some(u128::MAX),
            })
        }
    }

    /// The `[[pay_channels]]` half of a peering, which ADR 0042 requires of
    /// every peering a node forwards to and issue #1145 made unavoidable: a
    /// forward this node cannot cover is refused `T00` before the transport
    /// is reached at all. A fixture that forwards to a peer without this is
    /// not a simpler fixture, it is one no config can produce
    /// (`ConfigError::PayChannelUnbound`).
    fn covering(connector: Connector, peer_id: &str) -> Connector {
        connector
            .with_signer(Arc::new(LocalSigner::generate("operator-test-settlement")))
            .with_outbound_client_ledger(Arc::new(OutboundClientLedger::in_memory()))
            .with_outbound_client_hop(
                peer_id,
                format!("0x{:064x}", 1),
                EvmDomain {
                    chain_id: 84_532,
                    token_network: [0x1E; 20],
                },
                Arc::new(ReportsAWatermark),
            )
            .expect("a valid on-chain channel id")
    }

    fn test_router(routes: Vec<StaticRoute>, bearer_token: &str) -> Router {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = Arc::new(TestClock::new(
            chrono::Utc::now(), // only used to satisfy the Connector constructor; unread here
        ));
        let connector = Arc::new(Connector::new(
            routes,
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        ));
        let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
        router(connector, signer, bearer_token.to_string(), vec![])
    }

    async fn get(app: Router, path: &str, bearer_token: Option<&str>) -> Response {
        let mut builder = Request::builder().method("GET").uri(path);
        if let Some(token) = bearer_token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        let request = builder.body(Body::empty()).unwrap();
        app.oneshot(request).await.unwrap()
    }

    #[tokio::test]
    async fn a_request_with_no_bearer_token_is_rejected() {
        let app = test_router(vec![], "correct-token");
        let response = get(app, "/routes", None).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_request_with_the_wrong_bearer_token_is_rejected() {
        let app = test_router(vec![], "correct-token");
        let response = get(app, "/routes", Some("wrong-token")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn routes_reports_the_connectors_configured_static_routes() {
        let route = StaticRoute::new_priced("g.example.app", "http://localhost:4000", 25).unwrap();
        let app = test_router(vec![route], "correct-token");

        let response = get(app, "/routes", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let routes: Vec<RouteView> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(routes.len(), 1);
        assert_eq!(routes[0].prefix, "g.example.app");
        assert_eq!(routes[0].handler_url, "http://localhost:4000/");
        assert_eq!(routes[0].price, Price::flat(25));
    }

    #[tokio::test]
    async fn peers_channels_claims_and_audit_log_read_as_empty_lists() {
        let app = test_router(vec![], "correct-token");

        for path in ["/peers", "/channels", "/claims", "/audit-log"] {
            let response = get(app.clone(), path, Some("correct-token")).await;
            assert_eq!(response.status(), StatusCode::OK, "path {path}");
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(body, serde_json::json!([]), "path {path}");
        }
    }

    #[tokio::test]
    async fn metrics_reports_prometheus_text_and_requires_the_bearer_token() {
        let app = test_router(vec![], "correct-token");

        let unauthenticated = get(app.clone(), "/metrics", None).await;
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);

        let response = get(app, "/metrics", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains("toon_fees_earned_total"));
    }

    #[tokio::test]
    async fn identity_reports_the_signers_key_id_and_derived_address() {
        let app_client = Arc::new(FakeAppClient::new());
        let clock = Arc::new(TestClock::new(chrono::Utc::now()));
        let connector = Arc::new(Connector::new(
            vec![],
            vec![],
            app_client,
            Arc::new(InProcessPeerTransport::new()),
            clock,
        ));
        let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
        let expected = node_identity(signer.as_ref()).unwrap();
        let app = router(connector, signer, "correct-token".to_string(), vec![]);

        let response = get(app, "/identity", Some("correct-token")).await;
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
        let identity: NodeIdentity = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(identity, expected);
    }

    #[tokio::test]
    async fn there_is_no_write_endpoint_to_change_state_through() {
        let app = test_router(vec![], "correct-token");

        let request = Request::builder()
            .method("POST")
            .uri("/routes")
            .header(header::AUTHORIZATION, "Bearer correct-token")
            .body(Body::empty())
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    /// The write-authentication mechanism (issue #421), exercised end to
    /// end over real HTTP against the actual production `router()` and
    /// its one write endpoint, `POST /packets`. Every AC is driven as an
    /// external caller, matching #420's precedent: no port bound, no
    /// privileged in-process access, just requests through
    /// `tower::ServiceExt::oneshot`.
    mod write_authentication {
        use super::*;
        use crate::rfc9421::{keyid_hex, sign_request};
        use connector_domain::{derive_condition, RejectCode};
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;

        // An arbitrary preimage, used only to derive a well-formed,
        // non-all-zero execution condition -- `reject_ineligible` (issue
        // #417) rejects an all-zero condition before routing is ever
        // reached, so these tests need a real one to exercise routing at
        // all.
        const FULFILLMENT: [u8; 32] = [7u8; 32];

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        fn sample_prepare() -> Prepare {
            Prepare {
                amount: 0,
                expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
                execution_condition: derive_condition(&FULFILLMENT),
                destination: "g.example.nowhere".to_string(),
                data: b"originated by the operator".to_vec(),
            }
        }

        /// Sign an OER-encoded write body bound for `/packets`, returning
        /// the three headers a caller presents.
        fn sign(keypair: &Keypair, body: &[u8], expires: u64) -> (String, String, String) {
            sign_request(keypair, "POST", "/packets", body, 1_000, Some(expires))
        }

        fn packets_request(
            body: Vec<u8>,
            signature_input: Option<&str>,
            signature: Option<&str>,
            content_digest: Option<&str>,
            bearer_token: Option<&str>,
        ) -> Request<Body> {
            let mut builder = Request::builder().method("POST").uri("/packets");
            if let Some(v) = signature_input {
                builder = builder.header("signature-input", v);
            }
            if let Some(v) = signature {
                builder = builder.header("signature", v);
            }
            if let Some(v) = content_digest {
                builder = builder.header("content-digest", v);
            }
            if let Some(token) = bearer_token {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
            builder.body(Body::from(body)).unwrap()
        }

        fn router_with_write_keys(write_keys: Vec<[u8; 32]>) -> Router {
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(Connector::new(
                vec![],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                clock,
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            router(connector, signer, "correct-token".to_string(), write_keys)
        }

        #[tokio::test]
        async fn a_write_with_no_signature_at_all_is_rejected() {
            let app = router_with_write_keys(vec![]);
            let body = sample_prepare().encode();

            let response = app
                .oneshot(packets_request(body, None, None, None, None))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_bearer_token_alone_does_not_authorize_a_write() {
            // Bearer tokens gate reads; they must never substitute for a
            // write's signature (ADR 0008).
            let app = router_with_write_keys(vec![]);
            let body = sample_prepare().encode();

            let response = app
                .oneshot(packets_request(
                    body,
                    None,
                    None,
                    None,
                    Some("correct-token"),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// `POST /channels/:id/settle` is a write (issue #1129), so it is
        /// behind a signature like every other one -- an unsigned call is
        /// refused before it reaches a settlement backend at all. Both
        /// chains let *anyone* settle a channel whose window has passed,
        /// which is exactly why this needs saying out loud: the signature
        /// is not guarding the settlement, it is guarding this node's
        /// settlement key and the gas it spends.
        #[tokio::test]
        async fn settling_a_channel_with_no_signature_at_all_is_rejected() {
            let app = router_with_write_keys(vec![]);

            let request = Request::builder()
                .method("POST")
                .uri("/channels/0xdeadbeef/settle")
                .body(Body::empty())
                .unwrap();

            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// The read token is not a write credential, on this endpoint as on
        /// every other (ADR 0008): no shared secret is ever sufficient to
        /// move value, and settling moves every un-claimed deposit in a
        /// channel.
        #[tokio::test]
        async fn a_bearer_token_alone_does_not_authorize_settling_a_channel() {
            let app = router_with_write_keys(vec![]);

            let request = Request::builder()
                .method("POST")
                .uri("/channels/0xdeadbeef/settle")
                .header(header::AUTHORIZATION, "Bearer correct-token")
                .body(Body::empty())
                .unwrap();

            let response = app.oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_validly_signed_write_from_an_allowlisted_key_originates_the_packet() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // No route matches -- the packet was genuinely originated
            // into the connector's packet plane, not short-circuited.
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::f02_unreachable());
        }

        #[tokio::test]
        async fn a_signature_from_a_key_not_on_the_allowlist_is_rejected() {
            let signer = keypair();
            let app = router_with_write_keys(vec![]); // signer's key is not allowlisted
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&signer, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn removing_a_key_from_the_allowlist_revokes_it_with_no_other_change() {
            let keypair = keypair();
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let allowed = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let response = allowed
                .oneshot(packets_request(
                    body.clone(),
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // Identical request, identical signature -- only the
            // configured allowlist changed.
            let revoked = router_with_write_keys(vec![]);
            let response = revoked
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn an_expired_signature_is_rejected() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            // Already expired relative to any wall-clock "now".
            let (sig_input, sig, digest) = sign(&keypair, &body, 1);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_replayed_signature_is_rejected_the_second_time() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let first = app
                .clone()
                .oneshot(packets_request(
                    body.clone(),
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(first.status(), StatusCode::OK);

            let replay = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_captured_request_cannot_be_replayed_with_altered_contents() {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let original = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &original, 9_999_999_999);

            let mut tampered_prepare = sample_prepare();
            tampered_prepare.destination = "g.attacker.somewhere.else".to_string();
            let tampered = tampered_prepare.encode();

            let response = app
                .oneshot(packets_request(
                    tampered,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn every_accepted_write_is_retained_in_the_audit_log_and_read_back_over_the_operator_surface(
        ) {
            let keypair = keypair();
            let app = router_with_write_keys(vec![keypair.public.to_bytes()]);
            let body = sample_prepare().encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let write_response = app
                .clone()
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);

            let audit_response = get(app, "/audit-log", Some("correct-token")).await;
            assert_eq!(audit_response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(audit_response.into_body())
                .await
                .unwrap();
            let log: Vec<serde_json::Value> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(log.len(), 1);
            assert_eq!(log[0]["keyid"], keyid_hex(&keypair));
            assert_eq!(log[0]["path"], "/packets");
        }

        #[tokio::test]
        async fn a_read_route_still_requires_the_bearer_token_and_not_a_write_signature() {
            let app = router_with_write_keys(vec![]);
            let response = get(app, "/routes", None).await;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// ADR 0057, issue #1143: an originated packet declares no floor,
        /// so a fee-charging peering is one an operator's packet can
        /// actually cross. The old `minimum_delivery = prepare.amount`
        /// convention made `amount - fee >= minimum_delivery` unsatisfiable
        /// for any non-zero fee and refused this packet here, without ever
        /// reaching the peer. It now reaches the transport -- and the peer
        /// is simply not registered, which is `T01` and not a verdict on
        /// the amount.
        #[tokio::test]
        async fn an_originated_packet_crosses_a_fee_charging_peering() {
            use connector_runtime::PeerRoute;

            let keypair = keypair();
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(covering(
                Connector::new(
                    vec![],
                    vec![PeerRoute::new("g.example", "peer-1")],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    clock,
                )
                .with_peer_fees([("peer-1".to_string(), 5)]),
                "peer-1",
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            let app = router(
                connector,
                signer,
                "correct-token".to_string(),
                vec![keypair.public.to_bytes()],
            );

            let mut prepare = sample_prepare();
            prepare.amount = 100;
            let body = prepare.encode();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(packets_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                    None,
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::t01_peer_unreachable());
            assert!(reject.message.contains("peer-1"), "{}", reject.message);
        }
    }

    /// `POST /routes/leased` (issue #427): a controller outside this
    /// connector pushes a route to a peer with a time limit, driven end to
    /// end over real HTTP exactly like `POST /packets`'s write-auth suite
    /// above -- no signature, no write.
    mod leased_route_writes {
        use super::*;
        use crate::rfc9421::sign_request;
        use chrono::TimeZone;
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        fn sign(keypair: &Keypair, body: &[u8], expires: u64) -> (String, String, String) {
            sign_request(
                keypair,
                "POST",
                "/routes/leased",
                body,
                1_000,
                Some(expires),
            )
        }

        fn leased_route_request(
            body: Vec<u8>,
            signature_input: Option<&str>,
            signature: Option<&str>,
            content_digest: Option<&str>,
        ) -> Request<Body> {
            let mut builder = Request::builder().method("POST").uri("/routes/leased");
            if let Some(v) = signature_input {
                builder = builder.header("signature-input", v);
            }
            if let Some(v) = signature {
                builder = builder.header("signature", v);
            }
            if let Some(v) = content_digest {
                builder = builder.header("content-digest", v);
            }
            builder.body(Body::from(body)).unwrap()
        }

        fn router_with(clock: Arc<TestClock>, write_keys: Vec<[u8; 32]>) -> Router {
            let app_client = Arc::new(FakeAppClient::new());
            // A leased route reaches `forward_via_peer_route` without ever
            // passing `Config::load`, so ADR 0042's covering configuration
            // has to be supplied here for a packet on one to be deliverable
            // at all (issue #1145).
            let connector = Arc::new(covering(
                Connector::new(
                    vec![],
                    vec![],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    clock,
                ),
                "peer-1",
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            router(connector, signer, "correct-token".to_string(), write_keys)
        }

        #[tokio::test]
        async fn creating_a_leased_route_requires_a_valid_write_signature() {
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let app = router_with(clock, vec![]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();

            let response = app
                .oneshot(leased_route_request(body, None, None, None))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_validly_signed_write_creates_a_leased_route_visible_over_the_read_surface() {
            let start = chrono::Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
            let clock = Arc::new(TestClock::new(start));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let write_response = app
                .clone()
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(write_response.into_body())
                .await
                .unwrap();
            let created: LeasedRouteView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(created.prefix, "g.example.leased");
            assert_eq!(created.peer_id, "peer-1");
            assert_eq!(created.expires_at, start + chrono::Duration::seconds(60));

            let read_response = get(app, "/routes/leased", Some("correct-token")).await;
            assert_eq!(read_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let leases: Vec<LeasedRouteView> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(leases, vec![created]);
        }

        #[tokio::test]
        async fn renewing_a_leased_route_extends_its_expiry_from_the_renewal_time() {
            let start = chrono::Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
            let clock = Arc::new(TestClock::new(start));
            let keypair = keypair();
            let app = router_with(clock.clone(), vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);
            let response = app
                .clone()
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            clock.advance(chrono::Duration::seconds(30));
            // A different `ttl_seconds` than the original request, both to
            // avoid signing an identical body (which the replay cache
            // would reject) and to prove the renewed expiry is computed
            // from *this* request's ttl, not the original's.
            let renewal_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 90,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &renewal_body, 9_999_999_999);
            let response = app
                .oneshot(leased_route_request(
                    renewal_body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let renewed: LeasedRouteView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                renewed.expires_at,
                start + chrono::Duration::seconds(30) + chrono::Duration::seconds(90)
            );
        }

        #[tokio::test]
        async fn an_invalid_prefix_is_rejected_with_bad_request() {
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g..leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &body, 9_999_999_999);

            let response = app
                .oneshot(leased_route_request(
                    body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        /// AC: "A route can be created over the operator surface with a
        /// time limit" -- proven end to end by creating one, then routing
        /// a packet that only matches it. `peer-1` is unregistered on this
        /// test's `InProcessPeerTransport`, so a successful *match*
        /// surfaces as T01 (peer unreachable) rather than F02 (no route)
        /// -- exactly the distinction issue #427's connector-level tests
        /// use to prove selection without standing up a second connector.
        #[tokio::test]
        async fn a_leased_route_created_over_the_operator_surface_is_used_for_routing() {
            use connector_domain::{derive_condition, RejectCode};

            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let keypair = keypair();
            let app = router_with(clock, vec![keypair.public.to_bytes()]);
            let route_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.leased",
                "peer_id": "peer-1",
                "fee": 0,
                "ttl_seconds": 60,
            }))
            .unwrap();
            let (sig_input, sig, digest) = sign(&keypair, &route_body, 9_999_999_999);
            let response = app
                .clone()
                .oneshot(leased_route_request(
                    route_body,
                    Some(&sig_input),
                    Some(&sig),
                    Some(&digest),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            let prepare = Prepare {
                amount: 0,
                expires_at: chrono::Utc::now() + chrono::Duration::minutes(1),
                execution_condition: derive_condition(&[7u8; 32]),
                destination: "g.example.leased".to_string(),
                data: b"routed over a freshly created lease".to_vec(),
            };
            let packet_body = prepare.encode();
            let (sig_input, sig, digest) = sign_request(
                &keypair,
                "POST",
                "/packets",
                &packet_body,
                1_000,
                Some(9_999_999_999),
            );
            let mut packet_request = Request::builder().method("POST").uri("/packets");
            packet_request = packet_request
                .header("signature-input", &sig_input)
                .header("signature", &sig)
                .header("content-digest", &digest);
            let response = app
                .oneshot(packet_request.body(Body::from(packet_body)).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let reject = connector_domain::Reject::decode(&bytes).expect("decode reject");
            assert_eq!(reject.code, RejectCode::t01_peer_unreachable());
        }
    }

    /// Issue #884's runtime peer/route table writes: `POST`/`DELETE`
    /// `/peers*` and `/routes/peers*`. Same authentication contract as
    /// every other write on this surface (ADR 0008), exercised end to end
    /// over real HTTP against the actual production `router()`.
    mod runtime_peer_route_writes {
        use super::*;
        use crate::rfc9421::sign_request;
        use connector_domain::x402::{X402ChainSettlementTerms, X402SettlementTerms};
        use connector_domain::{EdgeIdentity, NodeFacts, NodeSelfDescription};
        use connector_runtime::{BoundedHttpSelfDescription, PeerRouteView};
        use connector_settlement::InMemorySettlementBackend;
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;
        use std::net::SocketAddr;

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        /// A **real** node self-description on a **real** socket, served
        /// by axum on loopback.
        ///
        /// `POST /peers` establishes a peering by fetching this document
        /// (ADR 0058), and what it does with the answer -- which endpoint
        /// it dials, which settlement address it derives a channel from --
        /// is the behaviour under test. A fake handing back a value would
        /// skip the fetch, which is the half that is new.
        fn serve_self_description(settlement_address: &str) -> SocketAddr {
            let document = NodeSelfDescription::describe(
                &NodeFacts {
                    ilp_addresses: vec!["g.example.counterparty".to_string()],
                    http_endpoint: Some("http://counterparty.example/ilp".to_string()),
                    btp_endpoint: None,
                    peer_carriages: vec!["http".to_string()],
                    settlements: vec![X402ChainSettlementTerms::Evm(X402SettlementTerms {
                        chain: "evm:31337".to_string(),
                        settlement_address: settlement_address.to_string(),
                        token_network_registry: "0x00000000000000000000000000000000000000cc"
                            .to_string(),
                        token_network: "0x00000000000000000000000000000000000000bb".to_string(),
                        token_address: "0x00000000000000000000000000000000000000dd".to_string(),
                        decimals: 6,
                    })],
                },
                Some(EdgeIdentity {
                    key_id: "counterparty-key".to_string(),
                    public_key: "0x04ab".to_string(),
                }),
                Vec::new(),
                None,
            );
            let app = Router::new().route(
                "/ilp",
                axum::routing::get(move || {
                    let document = document.clone();
                    async move { Json(document) }
                }),
            );
            let server = axum::Server::bind(&"127.0.0.1:0".parse().expect("loopback"))
                .serve(app.into_make_service());
            let addr = server.local_addr();
            tokio::spawn(async move {
                let _ = server.await;
            });
            addr
        }

        /// The counterparty's EVM settlement address, as its document
        /// publishes it. Deliberately not this node's own and deliberately
        /// not an edge identity: the channel derives from the settlement
        /// address of the chain in question.
        const COUNTERPARTY_SETTLEMENT: &str = "0x00000000000000000000000000000000000000aa";

        /// A `POST /peers` body: the operator's label, the counterparty's
        /// URL, and the operator's own policy about them.
        fn peer_body(id: &str, addr: SocketAddr, fee: u64) -> Vec<u8> {
            serde_json::to_vec(&serde_json::json!({
                "id": id,
                "url": format!("http://{addr}/ilp"),
                "fee": fee,
            }))
            .unwrap()
        }

        fn router_with(write_keys: Vec<[u8; 32]>) -> Router {
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(
                Connector::new(
                    vec![],
                    vec![],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    clock,
                )
                // The in-memory backend is the first implementation to
                // pass the settlement port's contract suite, `live_channel_with`
                // included -- so the derive-or-open branch these tests
                // drive is the same one a chain-backed backend takes.
                .with_settlement(
                    SettlementChain::Evm,
                    Arc::new(InMemorySettlementBackend::new()),
                )
                // Loopback is `http://`, so these tests are a node that
                // opted into plaintext peer endpoints -- the same opt-in
                // every `local/` topology takes for the same reason.
                .with_self_description_source(Arc::new(BoundedHttpSelfDescription::new(true)))
                .with_peer_allow_plaintext_endpoints(true),
            );
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            router(connector, signer, "correct-token".to_string(), write_keys)
        }

        fn signed(keypair: &Keypair, method: &str, path: &str, body: Vec<u8>) -> Request<Body> {
            let (sig_input, sig, digest) =
                sign_request(keypair, method, path, &body, 1_000, Some(9_999_999_999));
            Request::builder()
                .method(method)
                .uri(path)
                .header("signature-input", sig_input)
                .header("signature", sig)
                .header("content-digest", digest)
                .body(Body::from(body))
                .unwrap()
        }

        fn unsigned(method: &str, path: &str, body: Vec<u8>) -> Request<Body> {
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::from(body))
                .unwrap()
        }

        #[tokio::test]
        async fn upserting_a_peer_requires_a_valid_write_signature() {
            let app = router_with(vec![]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);

            let response = app
                .oneshot(unsigned(
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 0),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        #[tokio::test]
        async fn a_validly_signed_write_creates_a_peer_visible_over_the_read_surface() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);

            let write_response = app
                .clone()
                .oneshot(signed(
                    &keypair,
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 0),
                ))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(write_response.into_body())
                .await
                .unwrap();
            let established: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(established["id"], "runtime-hop");
            assert_eq!(established["source"], "runtime");
            // The answer says which branch the derive-or-open took, so an
            // unintended second channel is visible here (ADR 0058).
            assert_eq!(established["channel"]["status"], "created");
            assert_eq!(established["channel"]["chain"], "evm");
            let created: PeerView = serde_json::from_value(established).unwrap();

            let read_response = get(app, "/peers", Some("correct-token")).await;
            assert_eq!(read_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let peers: Vec<PeerView> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(peers, vec![created]);
        }

        #[tokio::test]
        async fn a_validly_signed_write_creates_a_peer_route_visible_over_the_read_surface() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);
            app.clone()
                .oneshot(signed(
                    &keypair,
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 3),
                ))
                .await
                .unwrap();
            let route_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.runtime",
                "peer_id": "runtime-hop",
                "price": 25,
            }))
            .unwrap();

            let write_response = app
                .clone()
                .oneshot(signed(&keypair, "POST", "/routes/peers", route_body))
                .await
                .unwrap();
            assert_eq!(write_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(write_response.into_body())
                .await
                .unwrap();
            let created: PeerRouteView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(created.prefix, "g.example.runtime");
            assert_eq!(created.peer_id, "runtime-hop");
            assert_eq!(created.price, Price::flat(25));
            assert_eq!(created.source, RouteSource::Runtime);

            let read_response = get(app, "/routes/peers", Some("correct-token")).await;
            assert_eq!(read_response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let routes: Vec<PeerRouteView> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(routes, vec![created]);
        }

        /// A route naming a peer id nothing recognizes -- the runtime
        /// analogue of `connector-config`'s load-time `UnknownPeerId` --
        /// is `400`, not silently accepted as an orphaned row.
        #[tokio::test]
        async fn a_peer_route_naming_an_unknown_peer_id_is_a_bad_request() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.runtime",
                "peer_id": "nobody",
                "price": 0,
            }))
            .unwrap();

            let response = app
                .oneshot(signed(&keypair, "POST", "/routes/peers", body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }

        /// A validly signed `DELETE /peers/:id` removes a runtime peer
        /// (issue #884); it no longer appears over `GET /peers`.
        #[tokio::test]
        async fn a_validly_signed_delete_removes_a_peer() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);
            app.clone()
                .oneshot(signed(
                    &keypair,
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 0),
                ))
                .await
                .unwrap();

            let delete_response = app
                .clone()
                .oneshot(signed(&keypair, "DELETE", "/peers/runtime-hop", Vec::new()))
                .await
                .unwrap();
            assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

            let read_response = get(app, "/peers", Some("correct-token")).await;
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let peers: Vec<PeerView> = serde_json::from_slice(&bytes).unwrap();
            assert!(peers.is_empty());
        }

        #[tokio::test]
        async fn deleting_a_peer_requires_a_valid_write_signature() {
            let app = router_with(vec![]);

            let response = app
                .oneshot(unsigned("DELETE", "/peers/runtime-hop", Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// A validly signed `DELETE /routes/peers/:prefix` removes a
        /// runtime peer route; it no longer appears over
        /// `GET /routes/peers`.
        #[tokio::test]
        async fn a_validly_signed_delete_removes_a_peer_route() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);
            app.clone()
                .oneshot(signed(
                    &keypair,
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 0),
                ))
                .await
                .unwrap();
            let route_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.runtime",
                "peer_id": "runtime-hop",
                "fee": 0,
                "price": 0,
            }))
            .unwrap();
            app.clone()
                .oneshot(signed(&keypair, "POST", "/routes/peers", route_body))
                .await
                .unwrap();

            let delete_response = app
                .clone()
                .oneshot(signed(
                    &keypair,
                    "DELETE",
                    "/routes/peers/g.example.runtime",
                    Vec::new(),
                ))
                .await
                .unwrap();
            assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

            let read_response = get(app, "/routes/peers", Some("correct-token")).await;
            let bytes = hyper::body::to_bytes(read_response.into_body())
                .await
                .unwrap();
            let routes: Vec<PeerRouteView> = serde_json::from_slice(&bytes).unwrap();
            assert!(routes.is_empty());
        }

        /// A `DELETE /peers/:id` naming a peer still referenced by a
        /// runtime route is `409`, not a silently orphaned route.
        #[tokio::test]
        async fn deleting_a_peer_still_referenced_by_a_route_is_a_conflict() {
            let keypair = keypair();
            let app = router_with(vec![keypair.public.to_bytes()]);
            let addr = serve_self_description(COUNTERPARTY_SETTLEMENT);
            app.clone()
                .oneshot(signed(
                    &keypair,
                    "POST",
                    "/peers",
                    peer_body("runtime-hop", addr, 0),
                ))
                .await
                .unwrap();
            let route_body = serde_json::to_vec(&serde_json::json!({
                "prefix": "g.example.runtime",
                "peer_id": "runtime-hop",
                "fee": 0,
                "price": 0,
            }))
            .unwrap();
            app.clone()
                .oneshot(signed(&keypair, "POST", "/routes/peers", route_body))
                .await
                .unwrap();

            let response = app
                .oneshot(signed(&keypair, "DELETE", "/peers/runtime-hop", Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }

    /// Channel lifecycle (issue #459, ADR 0008) driven entirely through
    /// this operator surface, against a real, disposable `anvil` chain --
    /// not a fake settlement backend. Skips itself (rather than failing
    /// the gate) if `anvil` is not on `PATH`; see
    /// `connector-settlement-evm/tests/support/mod.rs` for why this crate
    /// spawns one directly instead of going through `make anvil-up`.
    mod channel_lifecycle {
        use super::*;
        use crate::rfc9421::sign_request;
        use connector_runtime::{ChannelDomain, ChannelViewStatus, WireClaim};
        use connector_settlement::SettlementBackend;
        use connector_settlement_evm::EvmSettlementBackend;
        use connector_signer::{derive_evm_address, evm_balance_proof_digest, EvmBalanceProof};
        use ed25519_dalek::Keypair;
        use rand::rngs::OsRng;
        use std::process::{Child, Command, Stdio};

        const DEPLOYER_PRIVATE_KEY: &str =
            "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

        fn anvil_available() -> bool {
            Command::new("anvil")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        }

        /// "Fail loudly in CI, skip locally" (issue #471), the same rule
        /// `connector_settlement_evm::test_support::require_anvil` states
        /// for the shared harness. This module keeps its own `Anvil` rather
        /// than depending on that one, and until issue #1129 it kept the
        /// bare availability check too -- which meant a CI run with no
        /// Foundry would have skipped these tests and reported success. A
        /// guard that returns early and reports `passed` in `0.00s` is
        /// worse than a missing test.
        fn require_anvil() -> bool {
            if anvil_available() {
                return true;
            }
            if std::env::var_os("CI").is_some() {
                panic!(
                    "anvil is not on PATH, but CI is set -- the Rust Workspace Gate must \
                     install Foundry (foundry-rs/foundry-toolchain) before this test runs. \
                     Refusing to silently skip and report success here; see issue #471."
                );
            }
            eprintln!(
                "skipping: anvil is not on PATH (install Foundry: https://getfoundry.sh) -- \
                 this test needs a real chain and only skips because this is not a CI run"
            );
            false
        }

        struct Anvil {
            child: Child,
            rpc_url: String,
        }

        /// Distinguishes concurrently spawned `Anvil` instances *within this
        /// same test binary* -- `std::process::id()` alone is constant for
        /// every test in it, so two anvil-spawning tests (this module now
        /// has two, issue #425) running concurrently would otherwise both
        /// compute the identical port and race to bind it. Mirrors
        /// `connector-settlement-evm/tests/support/mod.rs`'s own
        /// `NEXT_PORT_OFFSET`.
        static NEXT_PORT_OFFSET: std::sync::atomic::AtomicU16 =
            std::sync::atomic::AtomicU16::new(0);

        impl Anvil {
            async fn spawn() -> Self {
                let offset = NEXT_PORT_OFFSET.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let port = 18_900u16
                    .wrapping_add((std::process::id() as u16) % 1_000)
                    .wrapping_add(offset);
                let rpc_url = format!("http://127.0.0.1:{port}");
                let child = Command::new("anvil")
                    .args(["--host", "127.0.0.1", "--port"])
                    .arg(port.to_string())
                    .args([
                        "--chain-id",
                        "31337",
                        "--accounts",
                        "1",
                        "--balance",
                        "10000",
                    ])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("spawn anvil");

                use ethers::providers::{Http, Middleware, Provider};
                let provider = Provider::<Http>::try_from(rpc_url.as_str()).expect("provider");
                for _ in 0..200 {
                    if provider.get_chainid().await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                Self { child, rpc_url }
            }
        }

        impl Drop for Anvil {
            fn drop(&mut self) {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }

        fn keypair() -> Keypair {
            Keypair::generate(&mut OsRng)
        }

        fn signed_post(keypair: &Keypair, path: &str, body: Vec<u8>) -> Request<Body> {
            let (sig_input, sig, digest) =
                sign_request(keypair, "POST", path, &body, 1_000, Some(9_999_999_999));
            Request::builder()
                .method("POST")
                .uri(path)
                .header("signature-input", sig_input)
                .header("signature", sig)
                .header("content-digest", digest)
                .body(Body::from(body))
                .unwrap()
        }

        /// A signature from a key that is not on `[operator] write_keys`
        /// buys nothing on `POST /channels/:id/settle` (issue #1129): the
        /// allowlist is what revocation acts on, so a well-formed RFC 9421
        /// signature from a retired operator must be as useless as none at
        /// all. No chain is needed to prove it -- the refusal happens
        /// before any settlement backend is consulted, which is why this
        /// test has no `anvil` gate and still runs everywhere.
        #[tokio::test]
        async fn settling_a_channel_signed_by_a_key_not_on_the_allowlist_is_rejected() {
            let stranger = keypair();
            let allowed = keypair();
            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(Connector::new(
                vec![],
                vec![],
                app_client,
                Arc::new(InProcessPeerTransport::new()),
                clock,
            ));
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            let app = router(
                connector,
                signer,
                "correct-token".to_string(),
                vec![allowed.public.to_bytes()],
            );

            let response = app
                .oneshot(signed_post(
                    &stranger,
                    "/channels/0xdeadbeef/settle",
                    Vec::new(),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        /// AC: "an EVM implementation opens, funds and closes a payment
        /// channel against a real chain", "channel lifecycle is driven
        /// entirely through the operator surface". Every step below is a
        /// real, signed HTTP write against this crate's actual `router()`,
        /// reaching a real `TokenNetwork` contract on a real (if
        /// disposable) chain -- nothing here is faked.
        #[tokio::test]
        async fn opening_funding_and_closing_a_channel_over_the_operator_surface_reaches_a_real_chain(
        ) {
            if !require_anvil() {
                return;
            }

            let anvil = Anvil::spawn().await;
            let token = EvmSettlementBackend::deploy_mock_token(
                &anvil.rpc_url,
                DEPLOYER_PRIVATE_KEY,
                1_000_000,
            )
            .await
            .expect("deploy mock USDC");
            let settlement =
                EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                    .await
                    .expect("deploy a TokenNetwork through a fresh registry");

            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(
                Connector::new(
                    vec![],
                    vec![],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    clock,
                )
                .with_settlement(SettlementChain::Evm, Arc::new(settlement)),
            );
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            let keypair = keypair();
            let app = router(
                connector,
                signer,
                "correct-token".to_string(),
                vec![keypair.public.to_bytes()],
            );

            // Open.
            let open_body = serde_json::to_vec(&serde_json::json!({
                "counterparty_hex": "0x00000000000000000000000000000000000000aa",
                "settlement_timeout_seconds": 3600,
            }))
            .unwrap();
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, "/channels", open_body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let opened: ChannelView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(opened.deposited, 0);

            // Fund.
            let fund_body = serde_json::to_vec(&serde_json::json!({ "amount": 1_000 })).unwrap();
            let fund_path = format!("/channels/{}/fund", opened.id);
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &fund_path, fund_body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let funded: ChannelView = serde_json::from_slice(&bytes).unwrap();
            // `POST /channels/:id/fund` is a SELF-deposit (issue #1118):
            // it puts this node's own collateral behind its own claims. It
            // does not, and on Solana never could, credit the
            // counterparty's side -- that deposit is the counterparty's
            // own transaction from their own wallet.
            assert_eq!(funded.own_deposited, 1_000);
            assert_eq!(funded.deposited, 0);

            // The freshly opened, freshly funded channel is visible over
            // the read surface too, reported fresh from the real chain.
            let response = get(app.clone(), "/channels", Some("correct-token")).await;
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let channels: Vec<ChannelView> = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(channels, vec![funded.clone()]);

            // Close.
            let close_path = format!("/channels/{}/close", opened.id);
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &close_path, Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let closed: ChannelView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(closed.status, ChannelViewStatus::Closed);

            // Terminal: funding a closed channel is rejected, not silently
            // accepted.
            let fund_again_body = serde_json::to_vec(&serde_json::json!({ "amount": 1 })).unwrap();
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &fund_path, fund_again_body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);

            // `close` above started a one-hour challenge period, and no
            // time has passed: `POST /channels/:id/settle` must refuse, and
            // refuse by name (issue #1129). The refusal is the interesting
            // half here -- that the settle *succeeds* once the window has
            // genuinely elapsed is proven against real chains, on both
            // backends, from a config-driven node in
            // `connector-cli/tests/settlement_lifecycle.rs`.
            let settle_path = format!("/channels/{}/settle", opened.id);
            let response = app
                .oneshot(signed_post(&keypair, &settle_path, Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let message = String::from_utf8(bytes.to_vec()).unwrap();
            assert!(
                message.contains("not yet due"),
                "an early settle must say the window is still open, not fail \
                 generically: {message}"
            );
        }

        /// AC (issue #425): "the latest received claim can be redeemed on
        /// chain through the operator surface" and "a cooperative close
        /// path settles without waiting out a dispute window" -- both
        /// driven entirely through this crate's actual `router()` against a
        /// real, disposable `anvil` chain, exactly like the lifecycle test
        /// above. The claim itself is fed in via
        /// `Connector::handle_peer_claim` directly rather than a real peer
        /// wire connection -- the peer semantics (#416) is a separate concern
        /// from this ticket's settlement-side one, and `handle_peer_claim`
        /// is the same entry point a real inbound PREPARE's piggybacked
        /// claim reaches.
        #[tokio::test]
        async fn redeeming_the_latest_claim_and_closing_cooperatively_reach_a_real_chain() {
            if !require_anvil() {
                return;
            }

            let anvil = Anvil::spawn().await;
            let token = EvmSettlementBackend::deploy_mock_token(
                &anvil.rpc_url,
                DEPLOYER_PRIVATE_KEY,
                1_000_000,
            )
            .await
            .expect("deploy mock USDC");
            let settlement =
                EvmSettlementBackend::deploy(&anvil.rpc_url, DEPLOYER_PRIVATE_KEY, token)
                    .await
                    .expect("deploy a TokenNetwork through a fresh registry");
            // The real EIP-712 domain a claim against this backend's own
            // `TokenNetwork` must be signed under (issue #576) -- `anvil`'s
            // own default chain id, and the real deployed contract address,
            // not a Base Sepolia placeholder nothing here actually talks to.
            let peer_channel_domain = ChannelDomain {
                chain_id: 31_337,
                token_network_address: settlement.address().to_fixed_bytes(),
            };

            // `TokenNetwork.claimFromChannel` verifies a real signature
            // recovering to the channel's actual counterparty (issue #576),
            // so that counterparty must be an address `peer_signer` holds
            // the key for -- not an arbitrary placeholder. The channel is
            // opened directly against the backend (rather than through this
            // surface's own `/channels`, already covered by the lifecycle
            // test above) so its real, keccak-derived id is known before
            // configuring the claim verification key and domain against it.
            let peer_signer = LocalSigner::generate("peer-claim-key");
            let peer_address = derive_evm_address(&peer_signer.public_key().unwrap());
            let settlement = Arc::new(settlement);
            let channel_id = settlement
                .open(peer_address.to_vec(), chrono::Duration::seconds(3600))
                .await
                .expect("open a real channel directly against the backend");

            let app_client = Arc::new(FakeAppClient::new());
            let clock = Arc::new(TestClock::new(chrono::Utc::now()));
            let connector = Arc::new(
                Connector::new(
                    vec![],
                    vec![],
                    app_client,
                    Arc::new(InProcessPeerTransport::new()),
                    clock,
                )
                .with_settlement(
                    SettlementChain::Evm,
                    Arc::clone(&settlement) as Arc<dyn connector_settlement::SettlementBackend>,
                )
                .with_channel_verification_key(channel_id.0.clone(), peer_address)
                .with_channel_domain(channel_id.0.clone(), peer_channel_domain)
                .unwrap(),
            );
            let signer: Arc<dyn Signer> = Arc::new(LocalSigner::generate("operator-test-key"));
            let keypair = keypair();
            let app = router(
                connector.clone(),
                signer,
                "correct-token".to_string(),
                vec![keypair.public.to_bytes()],
            );

            // Fund, through the operator surface, exactly like the
            // lifecycle test above -- the channel itself was already opened
            // directly against the backend above. This is the node's own
            // collateral (issue #1118), so it is not what the peer's claim
            // below is redeemed out of.
            let fund_body = serde_json::to_vec(&serde_json::json!({ "amount": 1_000 })).unwrap();
            let fund_path = format!("/channels/{}/fund", channel_id.0);
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &fund_path, fund_body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);

            // The peer's own deposit -- the side a claim signed by the peer
            // is drawn from, and the one no operator write on this node can
            // make. On a real deployment the peer submits it themselves;
            // here the fixture-only delegate deposit stands in.
            settlement
                .fund_counterparty(&channel_id, 1_000)
                .await
                .expect("the peer deposits on their own side");

            // A genuine claim from the channel's counterparty, accepted
            // exactly as an inbound PREPARE's piggybacked claim would be.
            let mut on_chain_id = [0u8; 32];
            let hex_digits = channel_id.0.trim_start_matches("0x");
            for (i, byte) in on_chain_id.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&hex_digits[i * 2..i * 2 + 2], 16)
                    .expect("channel id is 0x-prefixed 64-hex");
            }
            let sign_claim = |nonce: u64, amount: u64| {
                let proof = EvmBalanceProof {
                    channel_id: on_chain_id,
                    nonce,
                    transferred_amount: u128::from(amount),
                    locked_amount: 0,
                    locks_root: [0u8; 32],
                    chain_id: peer_channel_domain.chain_id,
                    token_network_address: peer_channel_domain.token_network_address,
                };
                // `peer_signer.sign` produces a recovery id in
                // `libsecp256k1`'s own `{0, 1}` convention
                // (`connector_signer::crypto::sign_digest`), exactly what
                // the wire carries (peer-semantics-pre-868.md §3.5). No `+ 27`
                // here: `EvmSettlementBackend::redeem` is the one place
                // that gets normalized to the Ethereum-wallet `{27, 28}`
                // range `TokenNetwork`'s on-chain `ECDSA.recover` requires
                // (issue #590) -- this test proves that normalization by
                // signing through the production path unmodified and
                // still redeeming against the real chain below.
                let signature = peer_signer.sign(&evm_balance_proof_digest(&proof)).unwrap();
                WireClaim {
                    channel_id: channel_id.0.clone(),
                    nonce,
                    cumulative_amount: amount,
                    signature: connector_runtime::ClaimSignature::Evm(signature),
                }
            };
            assert_eq!(
                connector.handle_peer_claim(sign_claim(1, 400)),
                connector_runtime::ClaimAckOutcome::Accepted
            );

            // Redeem the latest claim through the operator surface -- no
            // claim in the request body, unlike `POST /channels/:id/redeem`.
            let redeem_latest_path = format!("/channels/{}/redeem-latest", channel_id.0);
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &redeem_latest_path, Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let redeemed: ChannelView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(redeemed.redeemed, 400);

            // A fresher claim arrives, then a single cooperative-close
            // write redeems it and closes in one step -- no separate
            // dispute window to wait out.
            assert_eq!(
                connector.handle_peer_claim(sign_claim(2, 900)),
                connector_runtime::ClaimAckOutcome::Accepted
            );
            let cooperative_close_path = format!("/channels/{}/cooperative-close", channel_id.0);
            let response = app
                .clone()
                .oneshot(signed_post(&keypair, &cooperative_close_path, Vec::new()))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = hyper::body::to_bytes(response.into_body()).await.unwrap();
            let closed: ChannelView = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(closed.redeemed, 900);
            assert_eq!(closed.status, ChannelViewStatus::Closed);

            // Redeeming a channel this node never received a claim on is
            // refused rather than reaching the settlement backend at all.
            let no_claim_response = app
                .oneshot(signed_post(
                    &keypair,
                    "/channels/no-such-channel/redeem-latest",
                    Vec::new(),
                ))
                .await
                .unwrap();
            assert_eq!(no_claim_response.status(), StatusCode::BAD_REQUEST);
        }
    }
}

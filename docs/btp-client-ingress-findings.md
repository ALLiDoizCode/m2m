# Findings: client BTP paid writes fail at the devnet apex — and why the fix is not a middleware port

Status: findings only, no code change. Written 2026-07-31 against the live
devnet apex (`toon` box, image `connector:rust-sha-18413d9`) and the
paid-write-over-BTP prototype in toon-meta branch `proto/huddle-over-ilp`
(RESULTS.md, Phase D; raw logs `prototypes/huddle-over-ilp/run4-btp.log`,
`run5-btp.log`).

## The measured failure (live devnet, 2026-07-31)

A client BTP session to `wss://proxy.devnet.toonprotocol.dev:443` connects,
authenticates (empty token) and exchanges ILP prepares/rejects — the BTP
conversation is healthy. But:

- every **paid publish** over the session is refused
  `F01 Invalid HTTP envelope: malformed request-line: "<ciphertext>"`;
- a claimless announce is refused `F06 No payment channel claim attached`.

The same identity, channel and event succeed over ILP-over-HTTP at
`https://proxy.devnet.toonprotocol.dev/rust/ilp`.

## Root cause: the BTP front door is the _retired TypeScript connector_, not the Rust edge

The working hypothesis coming in was "the Rust connector's BTP ingress lacks
the HTTP ingress's unwrap + claim middleware — port the middleware across."
That hypothesis is **wrong in a load-bearing way**: the Rust connector has no
BTP ingress at all, and the BTP traffic never reaches the Rust connector.

Verified facts, with anchors:

1. **The apex box runs two connectors.** `docker ps` on the `toon` box:
   - `linode-node-connector-1` — `ghcr.io/toon-protocol/connector:3.36.3-solchan.0`
     (the TypeScript connector), ports 3000/8080;
   - `linode-node-connector-rust-1` — `ghcr.io/toon-protocol/connector:rust-sha-18413d9`,
     bound to `127.0.0.1:4000`.

2. **nginx routes websocket upgrades to the TS connector.** In
   `infra/linode-node/nginx/conf.d/node.conf` (matches the live box config):
   `proxy.devnet.toonprotocol.dev` maps to `http://connector:3000` via the
   catch-all `location /` — the only block that forwards `Upgrade`/
   `Connection` headers. The Rust edge is reachable only via
   `location /rust/ilp` (plain HTTP POST, no upgrade — hence the observed
   405 to Upgrade attempts on `/rust/ilp`). So `wss://…:443` _is_ the TS
   connector's BTP server.

3. **The TS connector's own logs confirm it terminated the prototype's
   session.** `linode-node-connector-1` logs the client session:
   `BTPServer … btp_auth peerId:"toon-sandbox" success:true mode:"no-auth"` —
   any anonymous client is admitted as a quasi-peer, and its prepares are
   routed with `prepare.data` untouched.

4. **The TS connector cannot terminate a modern client write.** The client
   seals its HTTP envelope to the _Rust_ edge's identity key (fetched from
   `GET /rust/ilp/identity`, per ADR 0018). The TS connector terminates
   `g.toon.relay` itself and parses `prepare.data` as a plaintext HTTP
   envelope — it has neither the Rust seal format nor the Rust key, so it
   sees ciphertext where a request-line should be. That is the exact F01
   text observed. The F06 on the claimless announce is the same story on the
   claim side: the TS inbound-claim validator prices the route and finds no
   claim in the shape it expects.

5. **The Rust connector has no BTP/websocket ingress to patch.** Its only
   ingresses are:
   - the axum client edge — `POST /ilp` (`crates/connector-client-edge/src/lib.rs`,
     `router()` at line ~201, `handle_ilp` at line ~680), where claim
     extraction + `ClientClaimGate` validation happen before
     `Connector::handle_prepare`;
   - the raw-TCP **peer wire** (`crates/connector-runtime/src/peer_wire.rs`,
     length-prefixed frames per `docs/protocol/peer-wire-spec.md`) — a
     clean-room connector↔connector protocol, not BTP and not websocket.
     `crates/connector-bin/src/main.rs` serves exactly these two. There is no
     tungstenite/`WebSocketUpgrade`/BTP code anywhere in the workspace
     (`grep -ri 'btp\|websocket'` over `crates/` matches only
     `connector-domain/src/client_claim.rs` doc-comments and the free-read
     test helper's `tokio-tungstenite` dep in `connector-bin`).

6. **The TS connector is retired and its source is gone.** Commit
   `2d981565` ("chore: retire the TypeScript connector and its npm/CI
   machinery (ADR 0017) (#543)") deleted `packages/connector`. The running
   `3.36.3-solchan.0` image is a frozen historical build; there is no tree
   to patch and ADR 0017 forbids resurrecting it.

Conclusion: "port the client-edge middleware to the BTP session ingress" has
no target. Client-facing BTP parity requires building a **new transport** in
the Rust connector.

## A useful correction to the middleware framing

In the Rust architecture the giftwrap unseal is **not ingress middleware**:
`handle_ilp` never touches the sealed payload. The seal is opened at route
termination inside `Connector::handle_prepare`
(`crates/connector-runtime/src/connector.rs`, `open_request` from
`connector_signer::giftwrap`), per ADR 0018/0019. What the HTTP ingress
actually contributes is (a) claim extraction from the
`ilp-payment-channel-claim[-wrapped]` headers, (b) `ClientClaimGate`
validation against the priced route, (c) the x402 greeting for unpaid
prepares to priced routes. A future BTP ingress therefore needs **only the
claim/greeting pipeline plus BTP framing** — once a prepare enters
`Connector::handle_prepare`, termination unseal works unchanged. The
prototype's F01 was never a missing-unwrap-on-ingress bug; it was the packet
terminating in the wrong (retired) connector.

## What parity actually requires

### In this repo (the real fix)

A client-facing BTP websocket ingress on the Rust client edge:

- **Transport**: websocket endpoint on the client edge (axum
  `WebSocketUpgrade`), speaking BTP 2.0 framing (auth message; ILP
  PREPARE/FULFILL/REJECT in BTP `MessagePayload`/`ResponsePayload`
  protocolData; requestId correlation).
- **Session classification is free**: Rust peers use the raw-TCP peer wire,
  so _every_ BTP websocket session is a client session by construction —
  the peer/client ambiguity the TS connector had (and that admitted the
  prototype as peer `toon-sandbox`) does not arise. No client middleware can
  leak onto peer traffic because peers never enter this ingress.
- **Claim carriage**: the client already sends claims over BTP as
  `payment-channel-claim` protocolData entries (JSON), see
  `@toon-protocol/client` `adapters/BtpRuntimeClient.ts`
  (`_sendIlpPacketWithClaimOnce`). The wire shapes are already ported:
  `crates/connector-domain/src/client_claim.rs` is the Rust port of the TS
  `btp-claim-types.ts`. The ingress maps that protocolData entry to the same
  `ClientClaimGate` path `handle_ilp` uses (`extract_and_validate_claim`
  refactored to accept a claim from either carrier), so watermarks, journal
  and per-channel accounting are shared — one gate, two carriages.
- **Unpaid-prepare greeting**: BTP cannot answer HTTP 402; the x402 greeting
  (`payment_required(...)`) needs a BTP-shaped reject carrying the same
  terms (protocolData on the REJECT, mirroring how
  `TOON-Accumulated-Cost` rides beside the OER body on HTTP).
- **Spec + vectors first**: per repo discipline (ADR 0003, ADR 0021) this is
  a new §-level section of `docs/protocol/client-edge-spec.md` (framing,
  auth, claim carriage, greeting shape) plus wire vectors, before code.

Estimated shape: a new `btp` module in `connector-client-edge` + spec + an
ADR ("client BTP rides the client edge; peers stay on the peer wire") +
vectors. This is several tickets, not one PR.

### On the box (deploy-side, after the above ships)

- nginx: route websocket upgrades on `proxy.devnet.toonprotocol.dev` to
  `connector-rust:4000` instead of `connector:3000` (today's catch-all
  `location /` is also the TS connector's ILP-over-HTTP surface — the swap
  is part of the wider TS-container retirement, same family as the
  ADR 0013 / #431 cutover blocker).
- The hand-tuned bind-mounted `connector.yaml` on the box is unaffected.

## Interim guidance (for the Phase D rerun and anyone else)

- Client-facing **BTP cannot carry paid writes on devnet today**, and no
  deploy of the current Rust image changes that. Do not re-run the BTP probe
  expecting different results until the ingress above ships.
- The paid-write path remains ILP-over-HTTP at
  `https://proxy.devnet.toonprotocol.dev/rust/ilp`.
- The prototype's real ceiling (nginx 503 shedding on POST /ilp well below
  50 rps) is an nginx rate-limit/tuning question
  (`limit_req zone=node burst=60`), separable from BTP work.

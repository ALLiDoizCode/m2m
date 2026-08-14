# Cutting the apex edge over to Rust, and removing the TypeScript connectors

> **HISTORY — do not execute (issue #872).** This runbook was written against a live apex box
> (`104.237.150.177`, `linode-node-*`) that has since been cut over, then destroyed
> (toon-meta#310 / toon-meta#313), and its repo files deleted along with the rest of
> `infra/linode-node/`. The store box's own TypeScript connector went with issue #901. Nothing at
> bare `g.toon` answers any more — where the verification steps below say "today `g.toon` returns
> 200 with an ILP REJECT", read that as what the apex answered on 2026-08-04, not as a check to
> run. Kept as the record of how the edge was moved to Rust; the current fleet is two boxes, store
> and relay, each terminating its own prefix (see [`../devnet-pricing.md`](../devnet-pricing.md)).
>
> The "Nothing in this document has been executed" line immediately below was true when it was
> written and is no longer.

Execution runbook for [#714](https://github.com/toon-protocol/connector/issues/714) (the gated
tracking ticket — **it stays open**; this document is its execution child, issue
[#737](https://github.com/toon-protocol/connector/issues/737)). Written for whoever holds the
window, against a live audit of `root@104.237.150.177` (apex, `linode-node-*`) and
`root@45.79.173.113` (store, `linode-store-*`) taken 2026-08-04. Nothing in this document has been
executed: no container has been stopped and no box config has been written yet. It supersedes no
prior plan for this step — #714 is the first place this order was written down.

Relies on [ADR 0027](../adr/0027-connectors-peer-over-btp-or-http-and-the-raw-tcp-peer-wire-is-deleted.md)
(peer carriage), [ADR 0013](../adr/0013-cut-over-through-a-parallel-address-space.md) (the parallel
`/rust` prefix this runbook retires) and [ADR 0017](../adr/0017-the-typescript-connector-is-a-prototype.md).
Related: [#678](https://github.com/toon-protocol/connector/issues/678),
[#732](https://github.com/toon-protocol/connector/issues/732),
[#620](https://github.com/toon-protocol/connector/issues/620),
[#625](https://github.com/toon-protocol/connector/issues/625),
[#665](https://github.com/toon-protocol/connector/issues/665),
[#668](https://github.com/toon-protocol/connector/issues/668),
[#669](https://github.com/toon-protocol/connector/issues/669),
[#535](https://github.com/toon-protocol/connector/issues/535).

**See also:** [`prefix-retirement-checklist.md`](prefix-retirement-checklist.md) states the
general conditions (traffic, clients, channels) under which any old-prefix fleet is safe to
delete — check those before opening this window, not only the box-specific state audited below.
[`btp-peer-transport-bringup.md`](btp-peer-transport-bringup.md) is the separate runbook for
proving out a real Rust↔Rust peer link (Shape A in §4); this document does not require it.

## 1. What is actually load-bearing about the TypeScript connectors

### Apex — `linode-node-connector-1` (`connector:3.36.3-solchan.0`)

| Surface                                                                                          | Served by | Dies with the TS container                    |
| ------------------------------------------------------------------------------------------------ | --------- | --------------------------------------------- |
| `POST https://proxy.devnet.toonprotocol.dev/ilp` (default edge, `location /` → `connector:3000`) | TS        | yes — replaced by Rust in §3                  |
| `wss://proxy.devnet.toonprotocol.dev/` BTP (same `location /`)                                   | TS        | yes — **the store box's peer dial**, see §2.2 |
| `GET /health` → `connector:8080/health`                                                          | TS        | yes — resolved in §2.1                        |
| `GET /admin/metrics.json` → `connector:8081`                                                     | TS        | yes — **not named in #714**, see §2.3         |

The Rust connector (`connector:rust-sha-54a967d`, `connector-rust:4000`, loopback-bound) currently
serves only `/rust/ilp*` through nginx.

### Store — `linode-store-connector-1` (same TS image)

Its TypeScript config (deleted from the repo by issue #901; this section documents the box's
pre-cutover state as audited 2026-08-04):

- terminates `g.toon.ario` and `g.toon.relay.ario` → `http://store:3300` at price `1000`
- forwards `g.toon.relay` → peer `relay-connector` = `wss://proxy.devnet.toonprotocol.dev:443` (the
  apex TS connector)
- `selfAnnounce.enabled: true` — publishes its own kind:10032 every 5 minutes as a **paid remote**
  write through that peer link, advertising `httpEndpoint: https://proxy.store.devnet.toonprotocol.dev/ilp`
  and `btpEndpoint: wss://proxy.store.devnet.toonprotocol.dev:443`

There is **no Rust connector on the store box** — confirmed live: `docker ps` shows only
`connector` (TS), `store`, `nginx`, `certbot`. `infra/linode-store/docker-compose.store.rust.yml`
exists in the repo but its own header records that it has never been deployed, and the box's
compose label lists only `docker-compose.store.yml`.

## 2. The four things that break, and what each becomes

### 2.1 `/health` — resolved by repointing at `/ilp/identity`

The Rust connector has no health, readiness or metrics surface. The whole public router
(`crates/connector-client-edge/src/lib.rs:281-287`) is `POST /ilp`, `GET /ilp/btp`,
`POST /ilp/probe`, `GET /ilp/identity`, `GET /ilp/routes/price`, `POST /ilp/claim-state` — nothing
else. Live, from inside the nginx container against `connector-rust:4000`: `/health` → 404,
`/ilp/routes/price` → 400 (needs a query), `/ilp/identity` → 200 with
`{"keyId":"connector-signer","publicKey":"0x040a2a82eaae34a8...ab95c3"}`.

**Decision: repoint `$health_backend` for `proxy.devnet` at `http://connector-rust:4000/ilp/identity`.**

- **Kept, and strengthened.** A 200 from `/ilp/identity` proves the process is up _and_ its signer
  key loaded — strictly more than the TS `/health`'s static status document, and it is already a
  proven-live dependency (the announcer sidecar polls exactly this path every 5 minutes,
  `ANNOUNCER_RUST_EDGE_URL=http://connector-rust:4000`).
- **Lost.** The body shape changes: today
  `{"status":"healthy","nodeId":"toon-devnet-proxy","version":"3.36.3-solchan.0",...}`, after
  `{"keyId":…,"publicKey":…}`. An org-wide sweep found exactly one consumer of the apex `/health`,
  and it does not read the body: `infra/devnet-manage.sh:417` — `probe "https://proxy.$DOMAIN/health" "proxy/connector"`
  checks reachability only, and is operator-invoked, not scheduled. No CI workflow, dashboard,
  faucet UI or client polls it, so the body-shape change costs nothing measurable.
- **The real `/health` hazard is the compose healthcheck, not the body.**
  `infra/linode-node/docker-compose.node.yml:26` gives the TS `connector` service
  `test: ['CMD-SHELL', 'wget -q --spider http://localhost:8080/health || exit 1']`, and `nginx` has
  `depends_on: connector: {condition: service_healthy}` at :120-122. Deleting the `connector`
  service **without also deleting that `depends_on`** breaks nginx startup on the next
  `docker compose up` — the whole apex goes dark, not just `/health`. This is the single loudest
  failure mode in the whole cutover; see Edit 6.
- **Newly exposed.** `/health` would return the connector's public key to the anonymous internet.
  That key is already published by the kind:10032 announce, so this leaks nothing new — but it
  should be a conscious choice.

**Alternatives considered and rejected:**

- _Enable `[operator]` to get `GET /metrics`._ Rejected on two counts. (a)
  `crates/connector-cli/src/runtime.rs:822` merges the operator router into the same router on the
  same `client_edge_addr` port — the nginx comment on the `/rust/ilp` block already scopes the proxy
  to `/rust/ilp*` for exactly this reason. (b) `crates/connector-operator/src/lib.rs:117-140` — the
  bearer-token `route_layer` wraps only the read routes; `writes`, merged in afterward, is never
  behind the bearer token. Turning `[operator]` on to get a health endpoint would stand up
  `POST /packets`, `POST /channels`, `/channels/:id/close` beside the client edge, and `/metrics` is
  bearer-gated anyway so it still couldn't serve as a public health endpoint.
- _`location = /health { return 200; }` in nginx._ Rejected: it reports healthy with the connector
  dead, which is worse than no endpoint.

**Follow-up to file (not a blocker for this window):** an unauthenticated `GET /ilp/health` on the
Rust client edge returning `{status, nodeId, version}`, so `$health_backend` can repoint without a
body-shape change.

### 2.2 The store box's BTP peer dial — real, and it couples the two boxes

The store box dials `wss://proxy.devnet.toonprotocol.dev:443`, which lands on the apex nginx's
`location /` and proxies to `connector:3000` with `Upgrade` headers. The moment `location /` moves
to `connector-rust:4000`, that dial breaks — the Rust edge serves BTP at `/ilp/btp`, not at `/`.
The store box then loses its `g.toon.relay` forward route and its self-announce, which is a paid
write through that same link.

**The apex `location /` flip and the store-box retirement cannot be independent windows.** Either
do both in one window, or accept that the store's kind:10032 announce goes stale (600s expiry)
between them.

### 2.3 `/admin/metrics.json` and the public `/dash` — real, and not named in #714

`location = /admin/metrics.json` proxies to `connector:8081`, the TypeScript admin API. The public
dashboard bundle (`/etc/nginx/conf.d/dashsite/assets/index-CfEBTMCa.js`) references
`/admin/metrics.json` (plus `earnings.json`, `routes`, `peers`, `channels`, already 404'd by #665).
Removing the TS connector kills the dashboard's live flow strip on **both** boxes — the store box's
nginx carries a byte-identical block.

The Rust `/metrics` is bearer-gated behind the unconfigured `[operator]` section, so there is no
drop-in. [#669](https://github.com/toon-protocol/connector/issues/669) already owns this shape of
problem. **Decision needed from the owner** — pick one:

1. Accept the loss: delete the `location = /admin/metrics.json` block and let
   `location ^~ /admin { return 404; }` cover the whole surface. The `/dash` flow strip goes dead.
   Cheapest, honest, reversible.
2. Fold it into #669 and land that first — blocks the cutover on unrelated work.
3. Keep the TS connector alive solely as a metrics source — rejected here; it defeats the ticket.

**This runbook assumes (1)** and records it as a deliberate, recorded loss.

> **Resolved 2026-08-05 ([#753](https://github.com/toon-protocol/connector/issues/753)):** decision
> (1), as assumed — but Edit 5 was not executed in the window, so the block stayed and has been
> answering **502** rather than 404 since the cutover (the exact-match `location` outranks
> `^~ /admin`, so the refusal below never applied to it). #753 deletes it on both boxes and settles
> the question the runbook could only defer: **the Rust connector exposes no anonymous metrics, by
> decision, not by omission.** ADR 0014 fixes the metrics surface behind the operator bearer token
> and says so in as many words; ADR 0022's answering-is-not-announcing line covers configuration
> facts, not operational history; and enabling `[operator]` on these boxes to open a gated path
> would publish the write half through `location /` unless nginx also grew a deny list, since the
> Rust operator paths carry no `/admin` prefix. The dashboard-side repair is
> [#669](https://github.com/toon-protocol/connector/issues/669)'s same-origin authenticated proxy.

### 2.4 `X-TOON-Payer/Amount/Chain` — benign, confirmed

#714's premise that the relay depends on these is false.
`relay/packages/relay/src/launcher/handlers/write-handler.ts:145-196`: the three headers are read
into `payer`/`amount`/`chain`, written to one `console.log` line, and echoed in the 200 JSON body —
no validation, no required-field check, no rejection path. Pinned by a regression test
(`write-handler.test.ts:176`, _"still returns 200 when the X-TOON headers are absent
(trusted-but-optional)"_). Losing them degrades attribution only. Already tracked as
[#535](https://github.com/toon-protocol/connector/issues/535) — link this cutover from there and
record the date the loss became real.

## 3. Exact nginx edits — apex box

File on the box: `/root/connector/infra/linode-node/nginx/conf.d/node.conf`.

> **[#668](https://github.com/toon-protocol/connector/issues/668) applies.** The box copy is not
> what is in git — the repo copy (`infra/linode-node/nginx/conf.d/node.conf`) has no
> `/admin/metrics.json`, no `location ^~ /admin`, no `/dash`, and no `location = /rust/ilp/btp`.
> **Edit the box copy in place. Do not `scp` the repo copy over it.** Reconcile the repo copy in a
> separate, reviewed PR (§6 step 15) — not as part of this window.

**Edit 1 — default edge → Rust.** In `map $host $backend`:

```diff
-    proxy.devnet.toonprotocol.dev       "http://connector:3000";
+    proxy.devnet.toonprotocol.dev       "http://connector-rust:4000";
```

**Edit 2 — health → identity.** In `map $host $health_backend`, and update the stale comment above
it (it says "the connector health port (8080)"):

```diff
-    proxy.devnet.toonprotocol.dev       "http://connector:8080/health";
+    proxy.devnet.toonprotocol.dev       "http://connector-rust:4000/ilp/identity";
```

**Edit 3 — BTP at the root.** `location /` already sets `Upgrade`/`Connection` and
`proxy_read_timeout 1h`, so `wss://proxy.devnet.toonprotocol.dev/ilp/btp` works through it once
Edit 1 lands — no new block is needed for `/ilp/btp`. But `location /` does not set
`proxy_send_timeout`, while `location = /rust/ilp/btp` does; add it to `location /`:

```diff
         proxy_read_timeout 1h;
+        proxy_send_timeout 1h;
```

**Edit 4 — keep `/rust/ilp` alive as an alias.** Do **not** delete the `location /rust/ilp` and
`location = /rust/ilp/btp` blocks in this window. They are what the live kind:10032 announce
advertises (§5) and what shipped clients hard-code (§5a). Leave both exactly as they are; retire
them in a later window once discovery and installed clients have rolled over.

**Edit 5 — `/admin/metrics.json`.** Per §2.3 decision (1): delete the
`location = /admin/metrics.json` block. `location ^~ /admin { return 404; }` stays and now covers
the whole surface. If the owner picks (2) instead, skip this edit and block on #669.

**Edit 6 — remove the TS service, and its `depends_on` in the same commit.** In
`/root/connector/infra/linode-node/docker-compose.node.yml`, delete the `connector:` service **and**
the `nginx` service's `depends_on: connector: {condition: service_healthy}` block at :120-122.
**These two edits must land together** — leaving the `depends_on` behind means nginx will not come
up on the next `docker compose up`. Grep the file for `connector` once more after editing; the
`relay` and `faucet` services have their own healthchecks (`:43` relay `:3100/health`, `:97` faucet
`:3500/health`) which are unrelated and must stay.

**Do not touch:** `relay-ws.devnet` and `faucet.devnet` entries in either map — they point at
`relay:7100` / `relay:3100/health` and `faucet:3500` / `faucet:3500/health` and are independent of
the connector. The faucet declares no connector-related env.

## 4. Exact edits — store box (`root@45.79.173.113`)

This is the harder half, and where the real design decision sits: the store box needs a payment
front for `g.toon.ario` / `g.toon.store` → `http://store:3300`. Two shapes.

**Shape A — stand up the Rust overlay on the store box** (what #714 and #678 assume).
`infra/linode-store/docker-compose.store.rust.yml` + `connector-rust.toml` already exist, but this
shape wants a real apex↔store peer link, gated on:

- **#732** — peer claims are EVM-only while production peering settles on `solana:devnet`
  (`crates/connector-peer-btp/src/claim_json.rs:191` returns `UnsupportedChain("solana")`);
  explicitly blocks #714.
- **#620** — closed. A `peer_id` route now carries its own client-edge `price` and is
  greeted, claim-gated and journaled exactly as a terminating route is ([ADR
  0028](../adr/0028-a-forwarded-route-is-priced-at-the-client-edge.md)), so a forwarded
  `g.toon.store` is no longer a free-write lane and config load refuses one that omits the price.
  The far side's own gap — a terminating connector not charging its `price` for a peer-wire
  arrival — is closed by #752 / [ADR
  0029](../adr/0029-a-peer-wire-arrival-to-a-priced-termination-must-cover-its-price.md): the
  store box now refuses an apex-forwarded packet whose `amount` does not cover its own `price`,
  rather than depending on the apex's `price` alone to cover the whole path.
- **#678** — the bring-up itself, still open.

**Shape B — no peer link at all.** The apex's **live** `connector-rust.toml` has **no
`[[peers]]` section**. Its store routes are already plain priced terminating routes over public
HTTPS:

```toml
[[routes]]
prefix = "g.toon.ario"
handler_url = "https://proxy.store.devnet.toonprotocol.dev/store"
price = 1000
[[routes]]
prefix = "g.toon.store"
handler_url = "https://proxy.store.devnet.toonprotocol.dev/store"
price = 1000
```

`/store` on the store box's nginx goes straight to `store:3300`, bypassing the store connector
entirely. So under the Rust apex there is already no inter-node peering, and the store box's TS
connector is not on the `g.toon.ario` write path.

> **Superseded 2026-08-04/05.** The block above is what the apex ran when this was written; it is
> kept because the argument that follows depends on it. Since then Shape A was built: both store
> routes were repointed at `peer_id = "apex-store"` across a real BTP peering, `g.toon.store` was
> retired entirely (one name for one app), and the store box's edge was renamed
> `proxy.store.devnet` → `proxy.ario.devnet`. The live shape is
> `infra/linode-node/connector-rust.toml`, which is now the peering's source of truth rather than
> a copy of it.

If Shape B is accepted, **#732 / #620 / #678 are not on the critical path for retiring
TypeScript** — they are on the critical path for having a peer link, a different goal. What Shape B
costs, stated honestly:

- **Revenue split changes.** Today the apex takes a 0.1% hop fee and the store connector charges
  the 1000 termination. Under Shape B the apex collects the whole 1000 and the store box earns
  nothing.
- **#625 stays open and gets sharper.** `POST /store` is publicly reachable on the store box, so
  the paid route has a free bypass beside it — pre-existing, but Shape B makes it the only thing
  standing between the internet and free writes. Fix by restricting `location /store` to the
  apex's IP before or during this window.
- **The store's kind:10032 announce needs a new publisher.** Its `httpEndpoint`
  (`https://proxy.store.devnet.toonprotocol.dev/ilp`) stops existing. Proposal: run a second
  announcer instance on the apex box (the sidecar publishes to `http://relay:3100` locally = free)
  configured for the store's identity and addresses, rather than giving a store-side sidecar a
  payment path. Needs the store's announce key — a proposal, not a settled design.

**Recommendation: put Shape A vs Shape B to the owner before the window opens.** Shape B is the
only one that makes this ticket executable today; Shape A is correct if a real peer link is the
actual goal, in which case this ticket waits on #678/#732/#620.

Under Shape B, store-box edits are:

- `nginx/conf.d/node.conf`: drop `proxy.store.devnet.toonprotocol.dev "http://connector:3000"` from
  `map $host $backend` (leaving `dvm.devnet` → `store:3400`), and delete the
  `location = /admin/metrics.json` block per §2.3.
- Restrict `location /store` to the apex's IP (`allow 104.237.150.177; deny all;`) — closes #625.
- `docker-compose.store.yml`: delete the `connector:` service.

## 5. Client-facing URLs, and every hardcoded `/rust/ilp`

The client-facing shape changes: `/rust/ilp` → `/ilp` at the root. `/rust/ilp*` must keep working
through the window — it is what discovery currently advertises.

An org-wide sweep found 91 hits across 27 files. The ones that matter:

**(a) Shipped client defaults — why `/rust/ilp` must not be deleted in this window.**

| Location                                                  | Line                             | Value                                                                      |
| --------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `rig/packages/rig/src/cli/standalone-mode.ts:159-160`     | `OFFICIAL_PROXY_URL`             | `https://proxy.devnet.toonprotocol.dev/rust/ilp`                           |
| `toon-client/packages/rig/src/cli/standalone-mode.ts:160` | same constant, duplicated source | same                                                                       |
| `buzz/desktop/src/shared/api/toonTransportConfig.ts:124`  | `proxyUrl`                       | `https://proxy.devnet.toonprotocol.dev/rust/ilp`                           |
| `buzz/desktop/.../toonTransportConfig.ts:125`             | `connectorUrl`                   | **`https://proxy.devnet.toonprotocol.dev/rust`** — bare `/rust`, no `/ilp` |
| `buzz/desktop/.../toonTransportConfig.ts:130`             | `btpUrl`                         | `wss://proxy.devnet.toonprotocol.dev/rust/ilp/btp`                         |

`rig`'s `OFFICIAL_PROXY_URL` is the compiled-in default uplink for standalone mode in a **published
npm package**. Every already-installed rig points at `/rust/ilp`. It cannot be un-published, so the
alias has to outlive the cutover by however long old rigs stay in use — not a 600s discovery-expiry
question.

> **Trap:** buzz's `connectorUrl` is a bare `/rust`. A sweep that greps only `/rust/ilp` misses it.
> It is a live fallback (`toonTransportConfig.ts:257-258`) consumed by `toonPaidWriter.ts:164-170`.
> Any nginx change must keep `/rust` (not just `/rust/ilp`) resolving, or buzz's BTP-mode connector
> base URL points at a dead prefix. Grep for `/rust` when verifying.

**(b) What the network is told — change these, in this order, after the root path works.**

| Location                                                                                                                | Kind                                             | Action                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live apex announcer container env — `ANNOUNCER_HTTP_ENDPOINT=…/rust/ilp`, `ANNOUNCER_BTP_ENDPOINT=wss://…/rust/ilp/btp` | Live config — what kind:10032 actually publishes | Update in `docker-compose.node.announcer.yml`, recreate; refresh cadence 300s, expiry 600s                                                                 |
| `connector/packages/announcer/src/config.ts:71-72` — `DEFAULT_HTTP_ENDPOINT` / `DEFAULT_BTP_ENDPOINT`                   | Compiled-in fallback                             | Change to `/ilp` and `/ilp/btp`; rebuild the announcer image. If the env is ever unset on a redeploy, these re-broadcast the dead URL to the whole network |

**(c) Tests that hard-fail on the change:** `connector/packages/announcer/src/config.test.ts:23-24`
asserts the defaults verbatim; also `announce-builder.test.ts` (10, 11, 59, 60, 94, 95),
`service.test.ts` (101, 102, 129, 130), `event.test.ts` (12, 13).
`toon-client/packages/client/src/__integration__/rust-edge-devnet.integration.test.ts:39` runs
against the real devnet edge (override via `RUST_EDGE_E2E_EDGE`) — the closest thing to a canary,
though on-demand, not scheduled. Run it manually as part of §7.

**(d) Docs:** `connector/packages/announcer/README.md:49-50`, `announce-builder.ts:9,28,30`,
`docs/operators/btp-peer-transport-bringup.md:31`, `buzz/desktop/README.md:66`,
`buzz/.env.example:221`, three CHANGELOGs, and
`toon-meta/prototypes/peer-wire-audit/DEPLOYMENT-PLAN.md` (41 hits — the audit this runbook builds
on).

Zero hits in `relay`, `store`, `fractal`, `Forge`, `capability-market`, `swap`, `toon`, `hub`,
`town`, `hello-toon`.

Because a published announce lives 600s but a published npm package lives indefinitely, sequence
it as: **nginx serves `/ilp` at the root → verify → repoint the announcer → old `/rust/ilp`
announces expire → keep the `/rust/ilp` alias indefinitely** until `rig` and `buzz` have shipped
releases pointing at `/ilp` _and_ those releases are known to be in use. Removing the alias is its
own later ticket with its own gate, not a step in this one.

**Traffic observation that supports the change:** in 24h of apex nginx logs there were 16
`POST /ilp` and zero `/rust/ilp` requests. Real clients are using the root path (the TS connector);
the advertised `/rust/ilp` endpoint gets no traffic at all. The cutover makes the advertised
endpoint and the used endpoint the same thing.

## 6. Order of operations

The public edge is down only for the duration of an `nginx -s reload`.

**Pre-window (no downtime, do days ahead):**

1. Settle §2.3 (`/admin/metrics.json`) and §4 (Shape A vs B) with the owner.
2. Sweep for `/health` body consumers — **done, in §2.1**. The only consumer is
   `infra/devnet-manage.sh:417`, and it checks reachability, not body.
3. `cp node.conf node.conf.bak.$(date -u +%Y%m%dT%H%M%SZ)` on both boxes; same for both compose
   files. Record the exact TS image digest:
   `docker inspect --format '{{index .RepoDigests 0}}' linode-node-connector-1`.
4. Confirm the Rust apex is healthy and its state volume is intact — it restarted at 14:28 UTC on
   2026-08-04, so let it soak.

**Window:**

5. Apply Edits 1–3 and 5 to the apex `node.conf`. **Leave the TS container running.**
6. `docker exec linode-node-nginx-1 nginx -t` must pass. Then `nginx -s reload`.
7. Run the whole of §7. Any failure → §8 rollback is one `nginx -s reload` away, because the TS
   container is still up.
8. Soak 30 minutes with the TS container still running but no longer routed.
9. Store box (Shape B): apply §4 edits, `nginx -t`, reload, verify `g.toon.ario` writes still land.
10. `docker compose … stop connector` on the store box, then on the apex. **Stop, do not `rm`** — a
    stopped container restarts in seconds.
11. Soak 24h.
12. Only then: `docker compose … rm -f connector` on both, apply Edit 6 / the compose deletions,
    `docker image rm ghcr.io/toon-protocol/connector:3.36.3-solchan.0` on both.

**Post-window:**

13. Repoint the announcer (§5b), recreate it, confirm a fresh kind:10032 carries `/ilp`.
14. **Keep the `/rust/ilp` alias.** File follow-up tickets against `rig` and `buzz` to move
    `OFFICIAL_PROXY_URL` / `toonTransportConfig` to `/ilp` (including buzz's bare `/rust`
    `connectorUrl`). Removing the alias is gated on those shipping — its own later ticket.
15. Repo PR: box↔repo nginx reconciliation (#668), announcer defaults + tests, compose files, and
    `.github/workflows/publish-{relay,store}-connector-image.yml` (#714 steps 2 and 5). **Done.**
    The `deploy/node-quickstart` and `deploy/pay-edge` bundles named here were not repinned —
    they were DELETED (2026-08-05). Their `connector:3.44.0` base had itself been purged from
    GHCR and was not among the archived digests, so neither bundle could be brought up at all;
    see `deploy/README.md`. The `location = /rust/ilp/btp` block is gone too, on both boxes.

## 7. Verification checklist

Run from a workstation unless stated. `E=https://proxy.devnet.toonprotocol.dev`

**a. `POST /ilp` behaves as `/rust/ilp` does today** — send the same body to both and diff:

```bash
BODY='{"destination":"g.toon.relay","amount":"1"}'   # or a real ILP PREPARE envelope
for p in /ilp /rust/ilp; do
  echo "== $p"; curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$E$p" \
    -H 'content-type: application/json' --data "$BODY"
done
```

Expect identical status and body from both paths. Today an unpriced/no-condition prepare to
`g.toon` returns 200 with an ILP REJECT (`F01 prepare carries no execution condition`) — the
announcer logs that every 5 min as `edge_greeting_not_402`. Match whatever `/rust/ilp` returns, not
an absolute.

**b. `POST /ilp/claim-state` returns a claim-state body, not 404** — this endpoint only exists on
Rust (`rust-sha-54a967d` shipped it), so it is the sharpest proof the root is Rust:

```bash
curl -sS -i -X POST "$E/ilp/claim-state" -H 'content-type: application/json' -d '{}'
```

Expect a claim-state JSON or a 4xx from the handler (e.g. a validation error). A 404 means nginx is
still on the TypeScript connector — stop and roll back.

**c. `GET /ilp/btp` websocket upgrade → HTTP 101:**

```bash
curl -sS -i -N -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H "Sec-WebSocket-Key: $(head -c16 /dev/urandom | base64)" "$E/ilp/btp"
```

Expect 101. Cross-check `/rust/ilp/btp` returns 101 too (alias still alive).

**d. `/health`:**

```bash
curl -sS -i "$E/health"
```

Expect 200 with `{"keyId":"connector-signer","publicKey":"0x04…"}`. Confirm the key matches
`docker exec linode-node-nginx-1 wget -qO- http://connector-rust:4000/ilp/identity`. Also confirm
the other two hosts are untouched: `curl -s https://faucet.devnet.toonprotocol.dev/health` and
`curl -s https://relay-ws.devnet.toonprotocol.dev/health` still 200.

**e. Relay writes still work** — the real end-to-end. Publish a paid event through the TOON client
(`toon_publish`) against `g.toon.relay` and confirm it is readable back:

```bash
docker logs --since 5m linode-node-relay-1 | grep '\[write\] event='
```

Expect a `[write] event=<id> payer=- amount=- chain=-` line. The `-` placeholders are the expected
new normal (§2.4) — the event id must be present and the event must be queryable on
`wss://relay-ws.devnet.toonprotocol.dev`. Also `docker logs linode-node-connector-rust-1` should
show the packet accepted rather than `F02 no route`.

**f. Faucet still works:**

```bash
curl -sS -i -X POST https://faucet.devnet.toonprotocol.dev/api/base-sepolia/request \
  -H 'content-type: application/json' -d '{"address":"0x…"}'
curl -sS -o /dev/null -w '%{http_code}\n' https://faucet.devnet.toonprotocol.dev/
```

Expect unchanged behaviour — the faucet is a separate container with no connector env; this is a
regression check on the nginx reload, not on the cutover.

**g. Store writes still land** (after §4): publish to `g.toon.ario` and confirm
`docker logs linode-store-store-1` shows the job, and the Arweave tx id comes back.

`crates/connector-bin/tests/devnet_store_leg_probe.rs` does this end to end and checks the half a
log line cannot — that the bytes fetched back off a public Arweave gateway are the bytes that were
paid to store. Its free checks (identity, price arithmetic across the hop, unpaid refusal) cost
nothing; the paid round trip stays inert until a funded channel is supplied, and spends one
packet's price when it is. Read its module docs before hand-rolling a packet: the traps it
documents (seal to the TERMINATING node, the derived condition, the `Z`-suffixed claim timestamp,
the 1002/1000 subtraction) are each an afternoon.

**h. Dashboard:** `curl -sS -o /dev/null -w '%{http_code}\n' "$E/dash/"` → 200 (static, unaffected).
`curl -sS -o /dev/null -w '%{http_code}\n' "$E/admin/metrics.json"` → 404 is the expected new
result under §2.3 decision (1). The flow strip on `/dash` will be empty — that is the recorded
loss.

**i. The `/rust` aliases still resolve** (rig + buzz depend on them, §5a):

```bash
curl -sS -o /dev/null -w '/rust/ilp -> %{http_code}\n' -X POST "$E/rust/ilp" \
  -H 'content-type: application/json' -d "$BODY"
curl -sS -o /dev/null -w '/rust     -> %{http_code}\n' "$E/rust"
```

`/rust/ilp` must match check (a). A bare `/rust` currently falls through to `location /` — confirm
its behaviour is unchanged from before the reload, since buzz builds URLs from it.

**j. Run the devnet canary** —
`toon-client/packages/client/src/__integration__/rust-edge-devnet.integration.test.ts` against the
live edge, once with the default `/rust/ilp` and once with
`RUST_EDGE_E2E_EDGE=https://proxy.devnet.toonprotocol.dev/ilp`. Both must pass.

**k. `devnet-manage.sh status`** — `bash infra/devnet-manage.sh status`; the `proxy/connector`
probe must still report reachable.

**l. Nothing regressed for 24h:**
`docker logs --since 24h linode-node-connector-rust-1 | grep -c '"level":"ERROR"'` and confirm
`POST /ilp` volume in nginx logs is at least the pre-cutover 16/24h.

## 8. Rollback

Backups live at `/root/connector/infra/linode-node/nginx/conf.d/node.conf.bak.<UTC>` and
`/root/connector/infra/linode-store/nginx/conf.d/node.conf.bak.<UTC>` (the store box already has a
`.bak.*` convention in use).

**Stage 5–8 (TS container still running) — under 5 seconds:**

```bash
cp /root/connector/infra/linode-node/nginx/conf.d/node.conf.bak.<UTC> \
   /root/connector/infra/linode-node/nginx/conf.d/node.conf
docker exec linode-node-nginx-1 nginx -t && docker exec linode-node-nginx-1 nginx -s reload
```

Nothing else is required — the TS connector never stopped.

**Stage 10 (TS stopped, not removed) — under 30 seconds:** the above, plus
`docker start linode-node-connector-1` (and `linode-store-connector-1`). Restore compose files
from their `.bak.<UTC>` copies if they were edited.

**Stage 12 (TS removed):** restore the compose backups and
`docker compose -f docker-compose.node.yml -f docker-compose.node.rust.yml -f docker-compose.node.announcer.yml up -d connector`.
The image must still be pullable — step 3 records the digest before anything is deleted. The store
box's connector holds no durable state beyond its config; the apex's TS connector's channel state
is the one thing to check before stage 12 — **do not remove it while it holds unredeemed claims.**
Verify with the admin API before stage 12 removes the container.

**Announcer rollback:** revert the env in `docker-compose.node.announcer.yml` and recreate. Stale
announces self-expire in 600s.

## 9. Acceptance criteria

- [ ] Owner has decided §2.3 (`/admin/metrics.json`) and §4 (Shape A vs Shape B).
- [ ] `POST $E/ilp/claim-state` returns a handler response, not 404.
- [ ] `GET $E/ilp/btp` upgrades with 101; `/rust/ilp/btp` still does too.
- [ ] `$E/health` returns 200 and the body matches `connector-rust:4000/ilp/identity`.
- [ ] A paid write to `g.toon.relay` lands in the relay and is readable on the public WS.
- [ ] A paid write to `g.toon.ario` reaches the store and returns an Arweave tx id, and the tx
      serves back the bytes that were sent (`cargo test -p connector --test devnet_store_leg_probe`).
- [ ] Faucet endpoints unchanged.
- [ ] `GET $E/rust/ilp/*` and a bare `$E/rust` still resolve (rig's `OFFICIAL_PROXY_URL` and buzz's
      `connectorUrl` depend on them).
- [ ] `docker-compose.node.yml` has no `connector` service and no `depends_on: connector`;
      `docker compose up -d` from scratch brings nginx up.
- [ ] No `connector:3.36.3-solchan.0` container on either box; image removed from both.
- [ ] kind:10032 announces carry `/ilp` and `/ilp/btp`, and `/rust/ilp` is still served as an
      alias.
- [ ] Follow-up tickets filed against `rig` and `buzz` for their hardcoded `/rust` defaults.
- [ ] The box↔repo nginx drift (#668) is reconciled in a reviewed PR, not by overwriting the box.
- [ ] The loss of `X-TOON-*` attribution is recorded against #535 with this date.
- [ ] Follow-up ticket filed for a real `GET /ilp/health` on the Rust client edge.

## 10. Relationship to #714

This document does not change #714's decision to retire the TypeScript connectors — it turns that
decision into exact edits, exact verification and exact rollback for two specific boxes as they
stood on 2026-08-04. #714 remains the tracking ticket and stays open until this runbook has been
executed and its acceptance criteria hold; if the boxes' live configuration drifts further before
that happens, re-audit before executing rather than trusting this snapshot.

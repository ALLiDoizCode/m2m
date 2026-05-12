---
title: 'Per-peer transport selection for BTP client'
slug: 'per-peer-transport-selection'
created: '2026-05-12'
status: 'done'
stepsCompleted: [1, 2, 3, 4]
tech_stack:
  - TypeScript 5.3.3 (strict, ES2022, CommonJS)
  - Node.js >=22.11.0
  - ws 8.16.0 (BTP WebSocket transport, RFC-0023)
  - socks-proxy-agent 8.0.5
  - Express 4.18.x (admin HTTP API)
  - Zod 3.25.76 (config schemas)
  - Jest 29.7.0 + ts-jest (TypeScript test framework — NOT Vitest)
  - Pino 8.21.0 (structured JSON logging; redaction via utils/redact)
files_to_modify:
  # Source changes:
  - packages/connector/src/btp/btp-client.ts
  - packages/connector/src/btp/btp-client-manager.ts
  - packages/connector/src/core/connector-node.ts
  - packages/connector/src/config/types.ts
  - packages/connector/src/config/config-loader.ts
  - packages/connector/src/http/admin-api.ts
  - packages/connector/src/http/admin-server.ts                # G3 — actual router mount site; needs transportType in options
  # Inventory + docs:
  - packages/connector/src/http/admin-api-inventory.ts
  - docs/admin-api-inventory.md
  # Infrastructure (G2):
  - docker-compose.yml                                          # G2 — extend two-home-ator-local profile with a direct-sibling service for Task 12 E2E
  - packages/connector/package.json                             # G2 — add test:per-peer-transport-e2e script
  # Additive mock fixes — production code now calls BTPClientManager.getPeerTransport;
  # every test that constructs `jest.Mocked<BTPClientManager>` needs the new method on
  # the mock or the existing assertions crash with TypeError. These are mechanical
  # ADDITIONS only; the legacy mocked harnesses are NOT rewritten (Task 9b still deferred):
  - packages/connector/src/btp/btp-client.test.ts              # T-35.4 factory-arg expectation updated for the new `(peer: Peer)` signature
  - packages/connector/src/core/connector-node.test.ts         # mock + T-35.4-10 stop-state assertions updated for the new closure
  - packages/connector/src/core/connector-node-optional-deps.test.ts
  - packages/connector/src/http/admin-api-peers.test.ts        # NOTE: previously listed under files_intentionally_unchanged; additive mock only
  - packages/connector/src/http/admin-api-settlement.test.ts
  - packages/connector/test/unit/connector-node.coverage.test.ts
  - packages/connector/test/unit/connector-node.coverage.part2.test.ts
  - packages/connector/test/unit/connector-node.coverage.part3.test.ts
  - packages/connector/test/unit/http/admin-api.coverage.test.ts
files_to_create:
  - packages/connector/src/http/admin-api-peer-transport.test.ts        # Task 9a — admin API positive/negative/back-compat/re-reg
  - packages/connector/src/btp/btp-client-per-peer-transport.test.ts    # Task 10 — real BTPClient agent-factory dispatch
  - packages/connector/test/integration/per-peer-transport.test.ts      # Task 11 — registerPeer Error + YAML round-trip
  - packages/connector/test/integration/per-peer-transport-cross-surface-e2e.test.ts  # Task 12 — gating E2E via two-home-ator-local profile + new direct-sibling service
  - scripts/standalone-e2e/peer-two-home-direct.yaml          # Task 12 — connector.yaml mounted into the new direct-sibling Compose service
files_intentionally_unchanged:
  - packages/connector/src/btp/btp-client-manager.test.ts    # Pre-existing jest.mock('./btp-client'); Task 9b deferred cleanup
  - packages/connector/test/integration/admin-api-cross-surface-invariants.test.ts  # Different harness pattern; do not extend
code_patterns:
  - 'Discriminated union with `type` field — `export type TransportConfig =` in config/types.ts (~l.210)'
  - 'agentFactory closure at connector-node.ts:215-217 captures `this._transportProvider` (singular); needs per-peer dispatch'
  - 'Connector-level transport state: `ConnectorConfig.transport?: TransportConfig` is OPTIONAL (config/types.ts:470); `ConnectorNode._transportType` (connector-node.ts:130) is the post-validation discriminator hoisted to a class field — use this in the closure, NOT `_config.transport.type` directly'
  - 'BTPClientManager.setAgentFactory() at manager.ts:44 forwards into every BTPClient created via addPeer at manager.ts:84-86'
  - 'BTPClient.connect() invokes factory with peerUrl at btp-client.ts:216 — Decision 8 changes call site to factory(this._peer)'
  - 'Manual validation in admin-api POST /peers (no zod) — extend after URL-format check (~l.644)'
  - 'Three entry points for plumbing transport into runtime Peer: (1) YAML startup loop at connector-node.ts:1244, (2) ConnectorNode.registerPeer Peer literal at connector-node.ts:2110, (3) admin POST handler Peer literal at admin-api.ts:687. PUT /peers/:peerId does NOT accept transport (out of PUT scope per F5)'
  - '`socksProxy` only narrows into TransportConfig when `transport.type === "socks5"` — so a `direct` connector has NO socks proxy configured by construction'
  - 'Admin-added peers are IN-MEMORY ONLY today — `addPeer` stores `BTPClient` in `Map<string, BTPClient>`; no disk persistence. YAML-loaded peers persist by virtue of being in YAML.'
  - 'redactPeerUrl / redactAnonInMessage required for any new log line referencing peer URL — `.anon` must never appear at INFO+ level'
  - 'Validation order in ConfigLoader.validateConfig is currently validateRequiredFields (l.177) → validatePeers (l.178) → validateRoutes (l.179) → ... → validateTransport (l.212). Per-peer transport validation needs validateTransport BEFORE validatePeers, OR pass resolved transport.type as a new arg into validatePeers.'
test_patterns:
  - 'Jest + ts-jest — no Vitest in this workspace'
  - 'No mocks per CLAUDE.md — all integration/E2E tests use live Docker containers (Anvil, Solana validator, Mina lightnet, dante/anon for SOCKS5)'
  - 'Cross-surface E2E pattern: `STANDALONE_DOCKER=true jest --testPathPattern=cross-surface-invariants --forceExit` (see package.json `test:cross-surface`)'
  - 'Existing extension targets: `test/integration/admin-api-cross-surface-invariants.test.ts` (gating heterogeneous-fleet E2E) and `src/http/admin-api-peers.test.ts` (unit-level supertest against real Express)'
  - 'No-mocks SOCKS5 sink reference: `test/integration/socks5-contract.test.ts` (real binary) and `transport-ator-real-binary.test.ts`'
---

# Tech-Spec: Per-peer transport selection for BTP client

**Created:** 2026-05-12

## Overview

### Problem Statement

When the connector is configured with `transport.type: socks5` (HS / anon mode), its outbound BTP client routes **every** peer connection through the configured SOCKS5 proxy — including peers whose `url` is a Docker-internal hostname (e.g. `ws://townhouse-hs-town:3000`). The anon SOCKS5 proxy only knows how to route `.anyone` destinations, so the dial fails with `Socks5 proxy rejected connection - HostUnreachable` and the peer stays `connected: false` indefinitely.

This is the last remaining blocker on Townhouse Story 46.4 (Epic 46 — *lazy peer node provisioning*), which registers child peer containers (`town`, `mill`, `dvm`) over the shared Docker network alongside `.anyone` peers reached through anon. Today, an HS-mode apex connector cannot host **any** locally-provisioned sibling peer; the gating live E2E times out asserting `peer.connected === true`.

Upstream issue: [toon-protocol/connector#69](https://github.com/toon-protocol/connector/issues/69) — *"BTP client routes all peers through SOCKS5 in HS mode — blocks Docker-internal peer connectivity"*.

### Solution

Make the **transport selection per-peer**, with the connector-level `transport.type` acting as the default.

- Add an optional `transport: 'direct' | 'socks5'` field to the peer record (admin API + SDK + persisted config).
- When the field is omitted, inherit `config.transport.type` (existing behavior — backwards compatible).
- When the field is present, override at `BTPClient` construction: `direct` peers skip the SOCKS5 agent and dial raw WS; `socks5` peers dial through the connector's configured SOCKS5 proxy.
- Fail loud at provisioning: `POST /admin/peers` returns **400** when a peer requests `transport: 'socks5'` but no SOCKS5 proxy is configured on the connector.

The existing `agentFactory` plumbing wired during Story 35.4 (`BTPClientManager` → `BTPClient`, factory invoked per `connect()`) is the right seam — today there is one connector-level factory; the change moves the per-peer decision *into* (or above) that factory.

### Scope

**In Scope:**

- Extend `Peer` (`btp/btp-client.ts`), `PeerConfig` (`config/types.ts`), `PeerRegistrationRequest` (`config/types.ts`), and the admin API request body (`AddPeerRequest` in `http/admin-api.ts`) with an optional `transport: 'direct' | 'socks5'` field.
- Resolve effective transport per peer: `peer.transport ?? config.transport.type`.
- Per-peer agent selection: rewire `BTPClientManager` so the resolved transport for each peer drives which `http.Agent` (or none) the `BTPClient` uses at connect time.
- Validate at `POST /admin/peers` AND at `ConnectorNode.registerPeer()` AND in `ConfigLoader.validatePeers()` (YAML load): reject with 400 / `Error` / `ConfigurationError` if `transport: 'socks5'` requested but no SOCKS5 proxy is configured. PUT `/admin/peers/:peerId` does **NOT** accept `transport` (Decision 9).
- YAML round-trip: a `transport` field on a `PeerConfig` in `connector.yaml` flows through `ConfigLoader` → `ConnectorConfig.peers[i].transport` → the runtime `Peer` literal at `connector-node.ts:1244` → the per-peer agent factory closure. AC-8 + Task 11 enforce this end-to-end.
- Docs: extend admin API reference for `POST /admin/peers` with the new field, defaults, the 400 case, and the re-registration no-op semantics. Note explicitly that PUT does not accept `transport`.
- Tests (no mocks in any NEW file per CLAUDE.md):
  - **Cross-surface E2E (gating, Task 12)** — heterogeneous fleet on the existing `two-home-ator-local` Compose profile (real local ATOR testnet, `docker-compose.yml:744-854`), **extended with a new `two-home-local-direct-peer` service** in this PR: one `direct` Docker-sibling peer (`transport: 'direct'`), one `.anon`-reachable peer (`transport: 'socks5'`). Both reach `connected: true` within their respective time budgets.
  - **Admin negative test (Task 9a)** — `POST /peers` returns 400 when `transport: 'socks5'` requested on a connector with `transport.type: 'direct'`.
  - **SDK negative test (Task 11)** — `ConnectorNode.registerPeer({ transport: 'socks5' })` rejects with `Error` (same message string as the admin 400 body).
  - **ConfigLoader negative test (Task 11)** — YAML containing a peer with `transport: 'socks5'` on a `direct`-global connector throws `ConfigurationError` at load time.
  - **YAML round-trip positive test (Task 11)** — peer registered via YAML with `transport: 'direct'` on a `socks5`-global connector connects via the direct path.
  - **Per-peer dispatch unit test (Task 10)** — real `BTPClient` + real local WS server + recording `agentFactory` asserts the factory receives the full `Peer` and dispatches correctly.
  - **Invariant-violation backstop test (Task 10)** — defense-in-depth path throws/poisons rather than silently direct-dialing.

**Out of Scope:**

- Per-peer **SOCKS5 proxy configuration** (per-peer `socksProxy` URL). The connector has exactly one SOCKS5 proxy; peers select between "use it" and "don't use it." Multi-proxy support is a future-YAGNI extension.
- New transport types beyond `direct` and `socks5` (HTTP/3, QUIC, …). The discriminator is built to extend, but no additional kinds in this spec.
- Migration of existing admin-provisioned peers from older connector versions — backwards-compat means existing payloads without `transport` keep working unchanged (defaults to global).
- Changes to the connector-level `transport: { type, socksProxy, managed, … }` schema. Option A from the architectural discussion: the existing block stays exactly as-is and is interpreted as "default transport + the only configured SOCKS5 proxy."
- Heuristic / CIDR / `noProxy` allowlists — explicitly rejected during design discussion (DNS-vs-IP, container-vs-host resolver divergence, naive private-IP checks misclassify `.anyone` hostnames).

## Context for Development

### Codebase Patterns

- **Discriminated union** (`type` field) for transport configuration — `export type TransportConfig =` starts at `config/types.ts:210` (the JSDoc above it begins around l.180; multiple Step-1 citations to l.181 were JSDoc-mid). Peer-level field uses the same enum (`'direct' | 'socks5'`) for forward extensibility — Winston's call during party-mode (not `proxy: boolean`).
- **`ConnectorConfig.transport` is OPTIONAL.** `transport?: TransportConfig` at `config/types.ts:470`. Several test callers instantiate `ConnectorNode` with partial configs where `transport` is undefined; the connector itself defends with `this._config.transport === undefined ? 'direct' : this._config.transport.type` at `connector-node.ts:521` and hoists the result onto `private _transportType: 'direct' | 'socks5' | null` at `connector-node.ts:130`. **Use `this._transportType` (post-validation) in the per-peer dispatch closure, not `this._config.transport.type`.**
- **`agentFactory: (peerUrl) => http.Agent | undefined`** (Story 35.4) threads from `ConnectorNode` → `BTPClientManager` → `BTPClient`. The factory closure at `connector-node.ts:215-217` is:
  ```ts
  this._btpClientManager.setAgentFactory((peerUrl) =>
    this._transportProvider?.createAgent(peerUrl)
  );
  ```
  The closure captures `this._transportProvider` — a **singular** provider. Per-peer dispatch needs the closure to know the **peer**, not just the URL (Decision 8 locks the factory-signature change).
- **Factory invocation point**: `btp-client.ts:216` (`const agent = this._agentFactory?.(this._peer.url);`). The `BTPClient` already holds `_peer` — the natural seam is to pass peer info into the factory rather than reshuffle this call site.
- **Three peer-construction entry points** (verified via `grep -n 'Peer = {' packages/connector/src/`):
  - `connector-node.ts:1244` — YAML startup loop (`for (const peerConfig of this._config.peers)`)
  - `connector-node.ts:2110` — `ConnectorNode.registerPeer()` SDK surface
  - `admin-api.ts:687` — `POST /admin/peers` HTTP handler
  All three construct a `Peer` literal and call `btpClientManager.addPeer(peer)`. Every one must copy `transport` from its source into the runtime `Peer`. (Two additional `Peer = {` literals exist in test files — `btp-client.test.ts:319` and `btp-client-manager.test.ts:824` — those follow once Task 2's signature change forces test-file updates.)
- **PUT /peers/:peerId does NOT accept transport (or url/authToken).** `admin-api.ts:887` declares the PUT body as `{ settlement?: AdminSettlementConfig; routes?: Array<...>; }` only — PUT is currently scoped to settlement + routes updates, not peer identity or transport. Per F5/Decision 10, **transport is NOT plumbed into PUT in this spec** to avoid scope creep on the PUT contract.
- **Idempotent peer re-registration on POST**: `admin-api.ts:653` and `connector-node.ts:2106` check `btpClientManager.getPeerIds().includes(body.id)`. The `transport` field on a re-registration request **is ignored at runtime** (the BTP client isn't recreated). Per F10/Decision 7: the response payload echoes the **original** (live) transport, not the requested one — admin-api must read the live peer's `transport` field, not echo `body.transport`.
- **Manual validation pattern** in `http/admin-api.ts` (POST /peers at l.618). No zod / no joi for the request body — early `return res.status(400)...` on each invalid field. Extend the same shape for `transport`.
- **TransportProvider abstraction** in `packages/connector/src/transport/{direct-transport-provider,socks-transport-provider,managed-anon-client}.ts` (Epic 35). `SocksTransportProvider.createAgent(peerUrl)` returns a fresh `SocksProxyAgent`; `DirectTransportProvider.createAgent` returns `undefined` (no agent — `direct-transport-provider.ts:39`).
- **`redactPeerUrl` / `redactAnonInMessage`** in `utils/redact` — `.anon` hostnames must never appear unredacted in INFO/WARN/ERROR logs (Epic 35 invariant, project-context rule). Any new log line touching `peer.transport` or peer URL must use these helpers.
- **Admin-added peers are in-memory only**. `BTPClientManager` stores clients in `Map<string, BTPClient>` (l.18); no disk persistence path exists for runtime-added peers. YAML-loaded peers persist by being in `connector.yaml`. **No new persistence is added by this spec** — the field flows through YAML naturally via `PeerConfig`, and Townhouse already re-registers admin peers on each startup (via `writeHsConnectorConfig` + the lazy-provisioning admin POSTs).
- **Existing test files use Jest mocks heavily** (per F1): `btp-client-manager.test.ts:12` does `jest.mock('./btp-client')`; `admin-api-peers.test.ts:40-69` uses `jest.Mocked<...>` extensively. Both are out-of-scope for cleanup in this spec. **New per-peer-transport tests live in NEW test files** that use real `BTPClient` against a real local WS echo server (see Tasks 9a and 10 in the revised plan). Existing mocked tests remain unchanged; AC-7 ("no mocks") applies only to NEW test files added by this spec.

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `packages/connector/src/btp/btp-client.ts` | `Peer` interface (l.32–49); `BTPClient` ctor at l.125–140; `_agentFactory` field at l.112; `connect()` invokes agent factory at l.216. **Add `transport?: 'direct' \| 'socks5'` to `Peer`.** |
| `packages/connector/src/btp/btp-client-manager.ts` | `BTPClientManager` class at l.17; `_agentFactory` field at l.22; `setAgentFactory()` at l.44; per-peer `BTPClient` constructed at l.84–86. |
| `packages/connector/src/core/connector-node.ts` | Agent factory closure at l.215–217 (Decision 8 rewire site); `_transportType` post-validation field at l.130 — use this in the closure (F3); startup loop with `Peer` literal at l.1244 (F9); `registerPeer()` at l.2050 with `Peer` literal at l.2110 (F9); existing defensive `_config.transport === undefined ? 'direct' : ...` at l.521 (the pattern to mirror in the closure). |
| `packages/connector/src/config/types.ts` | `PeerConfig` at l.90 (YAML peer shape); `TransportConfig` discriminated union at l.210 (not l.181); `ConnectorConfig.transport?: TransportConfig` at l.470 (note the `?` — optional); `PeerRegistrationRequest` at l.1550 (SDK/admin DTO); `PeerInfo` at l.1569 (response shape — surface `transport` for operator observability). |
| `packages/connector/src/http/admin-api.ts` | `AddPeerRequest` body shape at l.168; POST /peers handler at l.618; `Peer` literal at l.687 (F9 — third construction site); idempotent re-registration check at l.653; `200 OK` re-reg response at l.785 (echoes `body.url` — F10 surface). PUT /peers/:peerId at l.887 is NOT extended (F5). |
| `packages/connector/src/config/config-loader.ts` | `validateConfig` orchestration with calls at l.177–212; `validatePeers` body at l.462; `validateTransport` body at l.622. Per F4: validation order must be reorganized OR `validatePeers` must accept transport.type as an argument. |
| `packages/connector/src/transport/index.ts` | Barrel — `TransportProvider`, `DirectTransportProvider`, `SocksTransportProvider`, `ManagedAnonClient`. |
| `packages/connector/src/transport/socks-transport-provider.ts` | `createAgent(peerUrl)` at l.131 returns a fresh `SocksProxyAgent`. |
| `packages/connector/src/transport/direct-transport-provider.ts` | `createAgent` at l.39 returns `undefined` (no agent → ws default behavior). |
| `packages/connector/src/http/admin-api-peers.test.ts` | **Pre-existing file uses Jest mocks heavily.** Out of scope for cleanup; new admin-API per-peer-transport tests live in a NEW file (Task 9a). |
| `packages/connector/src/btp/btp-client-manager.test.ts` | **Pre-existing file uses `jest.mock('./btp-client')`** at l.12. Out of scope for cleanup; new per-peer dispatch tests live in a NEW file using real `BTPClient` (Task 10). |
| `packages/connector/test/integration/per-peer-transport.test.ts` | **NEW file (Task 11).** Real `ConnectorNode`, real `ConfigLoader`, real WS echo peer. Covers SDK Error path + YAML round-trip + ConfigLoader-rejects-invalid-YAML. |
| `packages/connector/test/integration/per-peer-transport-cross-surface-e2e.test.ts` | **NEW file (Task 12).** Reuses the existing `two-home-ator-local` Docker Compose profile (`docker-compose.yml:744-854`) plus a new `two-home-local-direct-peer` service added in this PR. Heterogeneous-fleet E2E. |
| `packages/connector/test/integration/admin-api-cross-surface-invariants.test.ts` | Reference pattern for the cross-surface test scaffolding — do **not** add to this file (would conflict with the existing mocked harness). |
| `packages/connector/test/integration/socks5-contract.test.ts` | Reference for real-binary SOCKS5 test scaffolding (no mocks). |
| `packages/connector/test/integration/standalone-ator-hs-local-e2e.test.ts` | Reference for the existing local-ATOR-testnet test scaffolding the new cross-surface E2E reuses. |
| `docker-compose.yml` | Existing real `anon` ATOR infrastructure at l.163+ (dir-auths) and l.260+ (relays); `standalone-ator-public` profile at l.509+; `standalone-ator-p2p` profile at l.570+; **`two-home-ator-local` profile at l.744-854** — the natural fit for Task 12 (apex connectors with `transport.type: socks5` already wired). Note: `standalone-ator-hs-local-e2e.test.ts` is only a test file name; no Compose profile of that name exists. |
| `packages/connector/src/http/admin-api-inventory.ts` | Machine-readable inventory; POST /peers at l.157, PUT /peers/:peerId at l.207, `successStatus: 201` at l.163 (F14 — also document 200 for re-reg). |
| `packages/connector/scripts/check-admin-api-inventory.ts` | Cross-check script. **Only checks route-presence drift** (method+path set membership at l.200–224); does NOT validate `failureModes` / `operationalNotes` content (F6). |
| `packages/connector/src/utils/redact.ts` | `redactPeerUrl`, `redactAnonInMessage` — required for any `.anon`-touching logs. |
| `CLAUDE.md` | No-mocks policy; cross-surface E2E targets (`make infra-up`, `npm run test:cross-surface`); stop-the-line policy. |

### Technical Decisions

1. **Field shape: `transport: 'direct' | 'socks5'` (string enum), not `proxy: boolean`.** Forward-extensible for future transports (HTTP/3, QUIC, …). Confirmed during party-mode after Jonathan clarified that internal peers may be on `.anyone` *or* normal URLs depending on provisioning context. The discriminator is intentionally identical to the global `TransportConfig.type` discriminator so future transport kinds extend both surfaces in lockstep.
2. **Default = global `transport.type`.** Backwards compatible. Existing payloads without the field keep working unchanged.
3. **Connector-level config schema: unchanged.** Keep `transport: { type, socksProxy, managed, … }` shape from Epic 35 (Story 35.3). No `transport.default` / per-transport sub-blocks (option A from design discussion).
4. **`transport: 'socks5'` requested but no SOCKS5 proxy configured → 400 at provisioning time.** Fail loud at both `POST /admin/peers` AND `ConnectorNode.registerPeer()`. Detection: the `TransportConfig` discriminated union has `socksProxy` narrowed to existence only when `type === 'socks5'` — so the check is effectively `if (req.transport === 'socks5' && config.transport.type !== 'socks5') return 400`. (The "direct global + has socks proxy" anomaly cannot occur by construction — resolves the Step-1 AC-2 open question.)
5. **Field is honored as operator intent.** A peer with `transport: 'direct'` and a `.anon`-looking URL is *allowed*. No URL-vs-transport second-guessing. (Jonathan's explicit guidance during party-mode.)
6. **Persistence: out of scope.** YAML-loaded peers carry their `transport` field through normal config load. Admin-added peers are in-memory only today (no new persistence layer is added by this story); orchestrators that need re-registration after restart (e.g. Townhouse) already re-emit admin POSTs from their config-writer. Step 1's "open question on persistence" is closed: **the connector intentionally does not persist admin-added peer records**, including the new `transport` field.
7. **Re-registration cannot change a peer's transport.** Idempotent `POST /admin/peers` for an existing peer ID skips client (re-)creation — and therefore cannot retroactively change the agent factory. If an operator needs to change transport on an existing peer, they must `DELETE` and re-`POST`. This is documented, not enforced by 409. (Mirrors how `url` and `authToken` already behave on re-registration today.)
8. **Per-peer dispatch architecture — LOCKED to factory-signature change (option (a)).**
   - **Old factory signature:** `agentFactory: (peerUrl: string) => http.Agent | undefined`
   - **New factory signature:** `agentFactory: (peer: Peer) => http.Agent | undefined`
   - **Dispatch logic** (lives entirely in the closure at `connector-node.ts:215`). **Uses `this._transportType`** — the post-validation class field at `connector-node.ts:130` — NOT `this._config.transport.type` (which would crash when `_config.transport` is undefined, per F3):
     ```ts
     this._btpClientManager.setAgentFactory((peer) => {
       // _transportType is null between init and start() — treat as 'direct' there.
       // peer.transport (per-peer override) wins; otherwise inherit connector-level default.
       const effective = peer.transport ?? this._transportType ?? 'direct';

       // Defense-in-depth (F11): if peer asks for socks5 but we have no SOCKS5 provider
       // wired (e.g. validation was bypassed by a test fixture or future PATCH path),
       // log loudly and fail closed — return a poison agent rather than silently
       // direct-dialing. The provisioning validators (Tasks 5–7) are the primary line
       // of defense; this is the runtime backstop.
       if (effective === 'socks5' && (!this._transportProvider || this._transportType !== 'socks5')) {
         this._logger.error(
           { event: 'btp_agent_factory_invariant_violation', peerId: peer.id, requestedTransport: 'socks5', connectorTransport: this._transportType },
           'Peer requested SOCKS5 transport but connector has no SOCKS5 provider — refusing to fall through to direct dial'
         );
         // Returning undefined would silently direct-dial — return a marker agent that
         // refuses all connections so the BTPClient surfaces the misconfiguration as a
         // connection failure. Implementation note: see Task 3 for the exact mechanism
         // (either a thin AbortAgent class or by throwing here and letting BTPClient.connect()
         // catch and surface). Pick whichever produces clearer operator telemetry.
         throw new Error('SOCKS5 transport requested for peer but no SOCKS5 provider configured');
       }

       return effective === 'socks5'
         ? this._transportProvider!.createAgent(peer.url)
         : undefined; // direct dial — `ws` library uses default behavior
     });
     ```
   - **Call site change** at `btp-client.ts:216`: `factory(this._peer.url)` → `factory(this._peer)`. One-line change.
   - **The agent factory is invoked per `connect()` attempt**, never cached. Per-peer dispatch is therefore re-evaluated on every reconnect, which is correct: a future admin API for mutating peer transport (out-of-scope here) would slot in cleanly.
   - **BTPClient.connect() error surfacing**: the closure may now throw (the defense-in-depth branch above). `connect()` at `btp-client.ts:212-288` already wraps WebSocket construction in `try/catch` and emits `BTPConnectionError`, but the agent factory invocation happens INSIDE that try-block at l.216. Verify the existing catch translates a thrown factory error into a `btp_connection_error` log + a `BTPConnectionError` reject. If not, extend the catch (Task 3 sub-step).
   - **Why (a) over (b) Manager-multi-provider or (c) Connector-holds-both:** (a) keeps dispatch in a single place (the closure that already owns global-transport context), avoids growing the Manager's API surface, and incurs only one line of source change in the BTPClient seam.
9. **PUT /peers/:peerId is NOT extended with `transport` (F5).** The current PUT body interface at `admin-api.ts:887` is `{ settlement?, routes? }` — it does not accept `url`, `authToken`, or any peer-identity field. Adding `transport` to PUT would expand its semantic scope. Since per-peer transport is fixed at the original `BTPClient` construction (Decision 7 — re-registration cannot change live transport), PUT has no behavioral need for the field. POST remains the only entry point. Operators wanting to change a peer's transport must `DELETE` and re-`POST`.
10. **Response-payload echo semantics for re-registration (F10).** On idempotent POST re-registration (`admin-api.ts:782-795`), the existing handler echoes `body.url` — *the requested value, not necessarily the live value*. This is a known pre-existing wart (same applies to `authToken`). For this spec's `transport` field we take the **opposite, correct** approach: on POST re-registration, the response payload reflects the **original live transport** by reading from the existing peer record (via a new accessor on `BTPClientManager` — see Task 6), NOT echoing `body.transport`. The url/authToken bug is documented as a separate cleanup; this spec does not propagate it to `transport`.
11. **No new dependencies.** The fix lives entirely inside existing modules. No `package.json` changes expected.

## Implementation Plan

### Tasks

Ordered by dependency. Each task is a discrete unit that can be PR-reviewed and tested independently if needed, though shipping as one PR is recommended.

- [x] **Task 1 — Extend peer-shaped types with the optional `transport` field.**
  - File: `packages/connector/src/btp/btp-client.ts`
  - Action: Add `transport?: 'direct' | 'socks5'` to the `Peer` interface (after `lastSeen`). Update the inline JSDoc to describe the field as "per-peer override of the connector-level transport — when omitted, the connector's global transport is used."
  - File: `packages/connector/src/config/types.ts`
  - Action: Add the same `transport?: 'direct' | 'socks5'` field to (a) `PeerConfig` (l.90) for YAML peers, (b) `PeerRegistrationRequest` (l.1550) for the SDK/admin DTO, and (c) **`PeerInfo` (l.1569)** — this is **required, not optional** (per H6). `ConnectorNode.registerPeer()` returns `PeerInfo` and `ConnectorNode.listPeers()` returns `PeerInfo[]`; both must surface `transport` to maintain parity with the HTTP GET /peers response (sub-task 6.7) and the admin POST response (sub-task 6.6). Sub-task 6.9 populates these.
  - File: `packages/connector/src/http/admin-api.ts`
  - Action: Add `transport?: 'direct' | 'socks5'` to `AddPeerRequest` (l.168) with a JSDoc that links semantics to the connector-level `transport.type` default and documents the 400 case.
  - Notes: Keep the discriminator identical to `TransportConfig.type` (Decision 1). No new files.

- [x] **Task 2 — Change the `agentFactory` signature from `(peerUrl) =>` to `(peer) =>` (Decision 8).**
  - File: `packages/connector/src/btp/btp-client.ts`
  - Action: Change the `_agentFactory` field type (l.112) and the `constructor` parameter type (l.130) from `(peerUrl: string) => http.Agent | undefined` to `(peer: Peer) => http.Agent | undefined`. Update the invocation site at l.216 from `this._agentFactory?.(this._peer.url)` to `this._agentFactory?.(this._peer)`. Update the JSDoc at l.120–123.
  - File: `packages/connector/src/btp/btp-client-manager.ts`
  - Action: Change the `_agentFactory` field (l.22) and `setAgentFactory` parameter (l.44) types accordingly. The forwarding call at l.85 stays unchanged (the BTPClient ctor signature uses the same factory type).
  - Notes: This is the load-bearing seam change. Update the Story 35.4 JSDoc on `setAgentFactory` to note the new shape. Tests that pass an `agentFactory` to `BTPClient` directly (search for `new BTPClient(`) must be updated; expect 2–5 call sites in tests.

- [x] **Task 3 — Implement per-peer dispatch in the connector-level closure (per Decision 8).**
  - File: `packages/connector/src/core/connector-node.ts`
  - Action: Replace the closure at l.215–217 with the **exact code body shown in Decision 8** — use `this._transportType ?? 'direct'` (NOT `this._config.transport.type` — that crashes when `_config.transport` is undefined; see Codebase Patterns) and include the defense-in-depth invariant-violation throw (per F11/AC-11). Do NOT use a shortened version of this snippet — Decision 8's body is the canonical reference.
  - Wiring verification: confirm `BTPClient.connect()` at `btp-client.ts:209-287` catches the closure's potential throw and surfaces it as `BTPConnectionError`. The agent factory call is inside the outer `try` block at l.216 — verify the existing catch at l.279 reaches synchronous exceptions thrown by the factory. If not, extend the catch to wrap `agentFactory(this._peer)` in its own try/catch and emit a `btp_connection_error` log + reject with `BTPConnectionError`.
  - Notes: When `_transportProvider` is `null` (e.g., between `init()` and `start()`), the defense-in-depth check fires on any `effective === 'socks5'` peer — exactly the desired behavior. Pre-Epic-35 default-direct semantics are preserved when peers are also `effective === 'direct'`.

- [x] **Task 4 — Plumb `peer.transport` from YAML startup into `BTPClient` construction.**
  - File: `packages/connector/src/core/connector-node.ts`
  - Action: At the YAML startup loop at **l.1244** (`const peer: Peer = { id: peerConfig.id, url: peerConfig.url, authToken: peerConfig.authToken, connected: false, lastSeen: new Date() };`), add `transport: peerConfig.transport,` after `authToken`. This carries the YAML-loaded `PeerConfig.transport` into the runtime `Peer` (AC-8).
  - Verification: `grep -n 'Peer = {' packages/connector/src/` should show only three production sites — l.1244 (this task), l.2110 (Task 5), and `admin-api.ts:687` (Task 6). Test-file literals (`btp-client.test.ts:319`, `btp-client-manager.test.ts:824`) only need the field if their tests exercise per-peer dispatch — which they do not.

- [x] **Task 5 — Plumb `peer.transport` from `ConnectorNode.registerPeer()` into `BTPClient`.**
  - File: `packages/connector/src/core/connector-node.ts`
  - Action: In `registerPeer()` at l.2050, after URL/auth validation, add:
    ```ts
    if (config.transport !== undefined && config.transport !== 'direct' && config.transport !== 'socks5') {
      throw new Error(`Invalid transport: must be 'direct' or 'socks5' (got '${config.transport}')`);
    }
    if (config.transport === 'socks5' && this._transportType !== 'socks5') {
      throw new Error("transport: 'socks5' requires connector-level transport.type 'socks5'");
    }
    ```
    Then at the `Peer` literal at **l.2110**, add `transport: config.transport,` after `authToken`. (Re-registration path at l.2126 stays a no-op for `transport` per Decision 7 — the existing `BTPClient` is not recreated.)
  - Notes: Uses `this._transportType` (the post-validation class field at `connector-node.ts:130`), NOT `this._config.transport.type` — defends against partial-config test callers. Error message wording must match Task 6 exactly so AC-4 can assert both surfaces with the same string.

- [x] **Task 6 — Add admin-API validation + plumbing for `transport` (POST only — NOT PUT). Includes GET /peers extension, getter implementation, and AdminServer wiring (G3, G4, G5, G7, G9).**
  - **Sub-task 6.1 — Add the `getTransport()` accessor on `BTPClient` (G5):**
    - File: `packages/connector/src/btp/btp-client.ts`
    - Action: Add a public method `getTransport(): 'direct' | 'socks5' | undefined { return this._peer.transport; }`. Place it near `isConnected` getter at l.145. This is the canonical accessor for the per-peer transport; it reads from the runtime `Peer` (which already has the field after Task 1).
  - **Sub-task 6.2 — Add `getPeerTransport(peerId)` on `BTPClientManager` (G5):**
    - File: `packages/connector/src/btp/btp-client-manager.ts`
    - Action: Add a public method:
      ```ts
      getPeerTransport(peerId: string): 'direct' | 'socks5' | undefined {
        return this._clients.get(peerId)?.getTransport();
      }
      ```
      Place near `getClientForPeer` at l.274.
  - **Sub-task 6.3 — Wire `transportType` into AdminAPIConfig (G3):**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: Add a new field to `AdminAPIConfig` interface at l.58–163: `transportType?: 'direct' | 'socks5';` (default `'direct'` when omitted). Do NOT inject the full `TransportConfig` — only the discriminator is needed.
    - File: `packages/connector/src/http/admin-server.ts`
    - Action: The actual router mount site is `admin-server.ts:157` (the `createAdminRouter(...)` call inside the `AdminServer` class), NOT `connector-node.ts`. Extend the `AdminServer` constructor options (around l.59-82 and l.94-117) with `transportType?: 'direct' | 'socks5'`, store it on the instance with `this._transportType = options.transportType ?? 'direct'` (H7 — explicit default for callers that omit the field, including the existing `admin-server.coverage.test.ts` fixtures at l.73 and l.493), and pass it through to `createAdminRouter({ ..., transportType: this._transportType })` at l.157.
    - File: `packages/connector/src/core/connector-node.ts`
    - Action: Where `AdminServer` is instantiated (`new AdminServer(...)` at l.1205 — verify via grep), pass `transportType: this._transportType ?? 'direct'` in the options bag. `ConnectorNode._transportType` may be null between init and start(); the `?? 'direct'` coalesces to the safe default at the connector level. The AdminServer constructor also defaults to `'direct'` for belt-and-suspenders.
  - **Sub-task 6.4 — POST /peers validation (G7 placement):**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: In the `POST /peers` handler at l.618, **BEFORE the `isUpdate` check at l.653** (i.e., immediately after the URL-format check at l.644), add:
      ```ts
      if (body.transport !== undefined && body.transport !== 'direct' && body.transport !== 'socks5') {
        res.status(400).json({ error: 'Bad request', message: `Invalid transport: must be 'direct' or 'socks5' (got '${body.transport}')` });
        return;
      }
      if (body.transport === 'socks5' && transportType !== 'socks5') {
        res.status(400).json({ error: 'Bad request', message: "transport: 'socks5' requires connector-level transport.type 'socks5'" });
        return;
      }
      ```
      Placement is load-bearing: validators run on **every** POST including re-registration. A re-reg POST with `transport: 'socks5'` on a direct-global connector returns 400, not 200. Per AC-10, a re-reg POST with `transport: 'socks5'` on a socks5-global connector passes validation, then hits the `isUpdate` no-op path (live transport stays the original).
  - **Sub-task 6.5 — POST /peers plumbing on fresh registration:**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: At the `Peer` literal at **l.687** (inside the `if (!isUpdate)` branch), add `transport: body.transport,` after `authToken: body.authToken,`.
  - **Sub-task 6.6 — POST /peers response payload includes `transport` (G9 — pin JSON path):**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: Modify the response literals at **l.785-795 (re-reg 200)** AND **l.801-814 (create 201)** to include `transport` nested under the existing `peer` object — JSON path is `peer.transport`, NOT a top-level field. For the create branch, value is `body.transport`. For the re-reg branch (G10), value is `btpClientManager.getPeerTransport(body.id)` — the **live** value, NOT `body.transport`. Example for the re-reg branch:
      ```ts
      res.status(200).json({
        success: true,
        peer: {
          id: body.id,
          url: body.url,
          connected,
          transport: btpClientManager.getPeerTransport(body.id),
        },
        routes: addedRoutes,
        updated: true,
        message: `Peer '${body.id}' updated`,
      });
      ```
  - **Sub-task 6.7 — Extend GET /peers handler to surface `transport` (G4):**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: In the GET /peers handler at l.563-606, inside the `peerIds.map(...)` callback at l.572, add `transport: btpClientManager.getPeerTransport(peerId),` to the `peerResponse` literal at l.578-583. The field is optional in TypeScript (will be `undefined` for legacy peers loaded before the field existed in YAML); the response includes it when set. AC-1 + AC-2 + Task 9a positive cases depend on this.
  - **Sub-task 6.9 — Extend `ConnectorNode.listPeers()` SDK surface for parity (H3):**
    - File: `packages/connector/src/core/connector-node.ts`
    - Action: At `listPeers()` body around l.2239-2253, locate the `peerInfo: PeerInfo = { ... }` literal at l.2246 and add `transport: this._btpClientManager.getPeerTransport(peerId),`. The SDK return shape must mirror the HTTP GET /peers shape — otherwise downstream SDK consumers (Townhouse, test fixtures, future BMad agents) lose parity with the admin API.
    - Action: ALSO at `registerPeer()` body around l.2149-2154, the `peerInfo` literal must include `transport: config.transport` (fresh registration path) — read from the request, not the manager, because the BTPClient may not be fully wired yet at that moment.
    - Notes: PeerInfo type extension (sub-task 1 in Task 1) is required, not optional — see H6.
  - **Sub-task 6.8 — PUT /peers/:peerId remains scope-free for transport (Decision 9, G6):**
    - File: `packages/connector/src/http/admin-api.ts`
    - Action: PUT body destructure at l.890+ stays `{ settlement?: AdminSettlementConfig; routes?: Array<...> }`. Do NOT add `transport`. Per G6: a PUT request that includes `transport` in the body is silently ignored by the destructure — handler returns 200 (or whatever the existing PUT contract returns) with no change to the live peer. This behavior is asserted by Task 9a case 7.
  - Notes: Error strings must be byte-identical to Task 5 so AC-4 can assert it cross-surface. The `transportType` field on `AdminAPIConfig` is the minimum new surface — `admin-api.ts` does not need to know about the full `TransportConfig` shape. `getPeerTransport` is the canonical accessor; do NOT reach into `BTPClient._peer` directly from admin-api.ts.

- [x] **Task 7 — Validate `transport` on YAML config load.**
  - File: `packages/connector/src/config/config-loader.ts`
  - Action (sequencing — F4): Pick one of two approaches and apply it exclusively:
    - **Approach A (recommended)**: Re-order `validateConfig` so `validateTransport` runs BEFORE `validatePeers`. Currently: `validateRequiredFields` (l.177) → `validatePeers` (l.178) → `validateRoutes` (l.179) → … → `validateTransport` (l.212). Move the `transport:` resolution line out of the return-object construction (l.212) and call `validateTransport` as a standalone statement immediately after `validateRequiredFields`, before `validatePeers`. Pass the resolved `transport.type` into `validatePeers(peers, transportType)` as a new second argument.
    - **Approach B**: Keep ordering. Extend `validatePeers(peers: PeerConfig[])` signature to `validatePeers(peers: PeerConfig[], transportType: 'direct' | 'socks5')` and pre-validate the global transport at the top of `validateConfig` (call `validateTransport(rawConfig.transport, environment)` once, capture its result, pass `result.type` into `validatePeers`).
  - Action (validation body): In `validatePeers` (currently at l.462), for each peer validate: (a) if `peer.transport` is present, it must be `'direct'` or `'socks5'` — otherwise throw `ConfigurationError(\`peer '${peer.id}': invalid transport value '${peer.transport}' (must be 'direct' or 'socks5')\`)`; (b) if `peer.transport === 'socks5'` AND `transportType !== 'socks5'`, throw `ConfigurationError(\`peer '${peer.id}': transport: 'socks5' requires connector-level transport.type 'socks5'\`)`.
  - Notes: Function name is `validateTransport` (not `validateTransportConfig`). Verify by grep: `grep -n "private static validate" packages/connector/src/config/config-loader.ts`.

- [x] **Task 8 — Update admin-API inventory (machine-readable + doc).**
  - File: `packages/connector/src/http/admin-api-inventory.ts`
  - Action: On the `POST /peers` entry (l.157), augment `failureModes` with `{ status: 400, description: "Invalid transport value, or transport: 'socks5' requested on a connector with transport.type != 'socks5'" }`. Update the existing `successStatus: 201` block to clarify in `operationalNotes` that 200 is returned on idempotent re-registration (F14 — pre-existing drift). Update `operationalNotes` to mention the optional per-peer `transport` field defaulting to the global connector transport, and that re-registration does NOT change live transport (re-registering with a different value yields 200 but the live transport stays the original). **Also remove the existing pre-existing-stale `{ status: 409, description: 'Peer ID already exists' }` entry at l.168 (H10)** — the actual handler returns 200 on re-registration, never 409; the inventory has been misleading on this point since at least Story 6.4. This is a one-line cleanup adjacent to the new 400 addition.
  - Action: On the `PUT /peers/:peerId` entry (l.207), no changes — PUT does NOT accept `transport` (Decision 9). Add an `operationalNotes` clarification: "PUT does NOT accept peer-identity fields (id/url/authToken) or the per-peer `transport` field. To change peer transport, use DELETE + POST."
  - File: `docs/admin-api-inventory.md`
  - Action: Update the `POST /admin/peers` section with the new field, defaults (inherit global `transport.type`), the 400 case, the re-registration no-op semantics, and both the create (201) and re-reg (200) response codes. Include a Curl example for each branch (success + 400). On the `PUT /admin/peers/:peerId` section, add a sentence stating PUT does not accept `transport`.
  - Notes: **Do NOT rely on `npm run lint:inventory` to enforce these changes.** The cross-check script at `packages/connector/scripts/check-admin-api-inventory.ts:200-224` only verifies route-presence drift (method+path set membership) — it does not validate `failureModes`/`operationalNotes`/`requestContract` content. Inventory + docs accuracy is on the implementer; AC-9's lint:inventory check only catches missing/extra routes, not content drift.

- [x] **Task 9a — NEW unit test file: admin-API per-peer-transport (real Express, no mocks).**
  - File: **NEW** `packages/connector/src/http/admin-api-peer-transport.test.ts`
  - Rationale: The existing `admin-api-peers.test.ts` uses `jest.Mocked<RoutingTable>`, `jest.Mocked<BTPClientManager>`, etc. extensively (l.40–69). Per AC-7 + CLAUDE.md the new per-peer-transport tests use real implementations. To avoid contaminating the existing file with both styles, the new tests live in a dedicated file.
  - Action: Stand up a real Express app via `createAdminRouter` with a real (in-process) `BTPClientManager` + a real `RoutingTable` (no mocks). Add seven cases:
    1. `POST /admin/peers with transport: 'direct' on a transport.type:'socks5' connector returns 201 and GET /peers shows transport: 'direct' in the listing.`
    2. `POST /admin/peers with transport: 'socks5' on a transport.type:'socks5' connector returns 201 and GET /peers shows transport: 'socks5'.`
    3. `POST /admin/peers with transport: 'socks5' on a transport.type:'direct' connector returns 400 with the documented message; GET /peers does NOT list the peer.`
    4. `POST /admin/peers with transport: 'invalid' returns 400 with the enum-validation message.`
    5. `POST /admin/peers without a transport field on either global type returns 201 (back-compat regression guard).`
    6. `Idempotent re-registration: register peer with transport:'direct', then POST same id with transport:'socks5' on a socks5-global connector; response is 200 and echoes transport:'direct' (the live value), not 'socks5'.` (Enforces F10.)
    7. `PUT /admin/peers/:peerId with body { transport: 'socks5' } returns 200 (the Express destructure at admin-api.ts:890 only reads { settlement, routes } — unknown fields are silently ignored), and a subsequent GET /peers shows the peer's transport field unchanged from its original value. PUT is intentionally not extended (Decision 9).`
  - Notes: No mocks — `BTPClientManager` is constructed with a real logger; `addPeer` is allowed to fail-connect (it logs but does not throw). The test asserts on registry state, not on BTP wire behavior.

- [x] **Task 9b — (Optional cleanup, can defer)**: file an issue to migrate `admin-api-peers.test.ts` from `jest.Mocked` to a real-router supertest harness. NOT required for this PR; documented here so the divergence between Task 9a's new file and the legacy file is intentional, not accidental. Out of scope for AC-7.

- [x] **Task 10 — NEW unit test file: BTPClient per-peer agent factory dispatch (real BTPClient, no module mock).**
  - File: **NEW** `packages/connector/src/btp/btp-client-per-peer-transport.test.ts`
  - Rationale: The existing `btp-client-manager.test.ts:12` does `jest.mock('./btp-client')` — making `BTPClient.connect()` a stub that never reaches the agent factory call site at `btp-client.ts:216`. To prove the new factory signature actually receives the full `Peer`, we need a real `BTPClient` against a real local WS server. (Also resolves F12: AC-1's "no SOCKS5 dial attempted" assertion now has a real harness to run against.)
  - Action:
    1. Spin up a local `ws.WebSocketServer` on an ephemeral port (no SOCKS5, no proxy — just a raw WS sink that accepts connections, echoes BTP auth handshake success, and closes cleanly on test teardown).
    2. Construct two real `BTPClient` instances, one per peer, with a real recording `agentFactory: (peer: Peer) => http.Agent | undefined` that pushes each invocation `{ peerId: peer.id, peerTransport: peer.transport }` into a captured array and returns `undefined`.
    3. Call `connect()` on each client and `await` connection.
    4. Assert: the captured array contains exactly the per-`connect()` invocations expected; each invocation received the full `Peer` (verify `.id` and `.transport` are present); no `SocksProxyAgent` was ever instantiated (assert by inspecting the recorder, since the factory returned `undefined`).
  - Notes: This is the test that proves Task 2's signature change works end-to-end on real network IO. Coverage gates: Task 2's `agentFactory` invocation site at `btp-client.ts:216` must be exercised.

- [x] **Task 11 — Integration tests: ConnectorNode.registerPeer Error path + YAML round-trip.**
  - File: **NEW** `packages/connector/test/integration/per-peer-transport.test.ts`
  - Action: Three independent test cases against a real `ConnectorNode` + real local WS echo helper:
    1. **SDK Error path**: instantiate `ConnectorNode` with a `transport.type: 'direct'` config; call `await node.start()`; call `await node.registerPeer({ id, url, authToken, transport: 'socks5' })`; assert it rejects with `Error` whose `.message` equals exactly `"transport: 'socks5' requires connector-level transport.type 'socks5'"`. Assert `GET /admin/peers` does NOT include the peer.
    2. **YAML round-trip (F13)**: write a temp `connector.yaml` containing one peer with `transport: 'direct'` while global `transport.type: 'socks5'`; call `ConfigLoader.loadFromFile(tempPath)`; assert the returned `ConnectorConfig.peers[0].transport === 'direct'` (proves the field round-trips through ConfigLoader). Then instantiate `ConnectorNode` with that config, start it against a local direct WS peer, and assert the peer reaches `connected: true`. Additionally inspect the constructed runtime `Peer` (via `btpClientManager.getPeerTransport(id)` — the new getter from Task 6) and assert it equals `'direct'` — proves the field reaches the BTPClient construction site at connector-node.ts:1244.
    3. **ConfigLoader rejection**: write a temp `connector.yaml` containing one peer with `transport: 'socks5'` while global `transport.type: 'direct'`; call `ConfigLoader.loadFromFile(tempPath)`; assert it throws `ConfigurationError` matching `/peer '.+': transport: 'socks5' requires connector-level transport.type 'socks5'/`.
  - Notes: Real WS echo helper — write a small `tinyWsEchoServer(port)` utility in the same file or under `test/integration/helpers/`. Real ConfigLoader, real ConnectorNode, real network IO. No mocks.

- [x] **Task 12 — Gating cross-surface E2E using the existing `two-home-ator-local` profile + a new direct sibling service (AC-5, F2/G2, F15).**
  - File: `docker-compose.yml`
  - Action (infra): The existing `two-home-ator-local` profile at `docker-compose.yml:744-854` provides two real connectors over the local ATOR testnet (sidesteps the Phase 3b host-side blocker per the comment block at l.728-738). It does NOT include a direct-reachable BTP peer. Extend the same profile with ONE additional service:
    - Name: `two-home-local-direct-peer`
    - Profile: `[two-home-ator-local]`
    - Image: reuse the same connector image the existing `two-home-local-connector-*` services use (no new Dockerfile needed).
    - Config: a minimal `connector.yaml` with `transport.type: 'direct'`, `btpServerPort: 3000`, no peers, no routes. The service exists to provide a ws:// endpoint on the shared `ator_net` Docker network.
    - **Networks (H4)**: explicit `networks: [ator_net]` — do NOT use `network_mode: service:two-home-local-sidecar-*` (that pattern is used by the existing connectors because they share namespace with their sidecars; this new direct peer has no sidecar so it joins `ator_net` directly). The other two-home services reach this peer by Docker DNS using its service name as the hostname (`ws://two-home-local-direct-peer:3000`). Verify by reading the existing `two-home-local-connector-a` block at l.775-799 (note its `network_mode` is `service:two-home-local-sidecar-a` — DO NOT copy that); look instead at the simple sidecar service definitions for the right `networks:` pattern.
  - File: **NEW** `packages/connector/test/integration/per-peer-transport-cross-surface-e2e.test.ts`
  - Action (test): The test orchestrates a heterogeneous fleet using the extended `two-home-ator-local` profile. Reuse helpers from `two-home-ator-local-e2e.test.ts` if one exists; otherwise mirror the scaffolding in `standalone-ator-hs-local-e2e.test.ts`. **NOTE**: a Compose profile literally named `standalone-ator-hs-local` does NOT exist (only the test file by that name exists). The actual profile is `two-home-ator-local`.
    1. `make ator-up && docker compose --profile two-home-ator-local up -d` (or whatever Makefile target wraps this — check `Makefile`).
    2. Wait for hidden-service descriptor publication using the same readiness gate the existing two-home test uses.
    3. From the test, POST two peer registrations to one of the two-home apex connectors' admin API:
       - **Peer A** (direct): `{ id: 'direct-sibling', url: 'ws://two-home-local-direct-peer:3000', authToken: '', transport: 'direct' }` — must reach `connected: true` within 15s.
       - **Peer B** (socks5): `{ id: 'anon-peer', url: 'ws://<resolved-onion-hostname>.anon:3000', authToken: '', transport: 'socks5' }` — must reach `connected: true` within 30s (real ATOR circuits take longer).
    4. Poll `GET /admin/peers`; assert both peers report `connected: true` and the GET listing surfaces `transport: 'direct'` and `transport: 'socks5'` respectively (per AC-1, AC-2, G4 fix in Task 6 GET handler extension).
    5. Tear down via `docker compose --profile two-home-ator-local down && make ator-down`.
  - File: `packages/connector/package.json`
  - Action (script): Add `"test:per-peer-transport-e2e": "STANDALONE_DOCKER=true jest --testPathPattern=per-peer-transport-cross-surface-e2e --forceExit --testTimeout=180000"` to the workspace `scripts` block. The 180s timeout accommodates real-ATOR-testnet bring-up; do NOT use the default 30s timeout.
  - SOCKS5 scheme reminder (F15): every `socksProxy` URL in the apex `connector.yaml` MUST use `socks5h://`. The `h` (DNS-via-proxy) is enforced by `validateTransport`; using `socks5://` fails config load before the test starts.
  - Notes: This is the gating test that proves Townhouse Story 46.4 will pass. Do NOT add this test to `admin-api-cross-surface-invariants.test.ts` (different harness pattern; mocked-import conflicts). The ATOR testnet bring-up is the slow part — if CI cost is a concern, the test can be gated behind a feature flag or marked as nightly-only via the existing `.github/workflows/nightly-ator.yml` workflow (the CLAUDE.md reference to `nightly-http-surface.yml` is stale — that file does not exist).

- [x] **Task 13 — Log line updates with redaction.**
  - File: `packages/connector/src/btp/btp-client-manager.ts`
  - Action: At `event: 'btp_client_add_peer'` log (l.67), add `transport: peer.transport ?? '<default>'` to the structured fields. Verify `redactPeerUrl(peer.url)` is already used (it is — current code: `url: redactPeerUrl(peer.url)`).
  - File: `packages/connector/src/core/connector-node.ts`
  - Action: At the `event: 'peer_registered'` log (l.2122) and the YAML-startup peer-add logs, include `transport: config.transport` (or `peer.transport` for the YAML loop) in the structured fields.
  - File: `packages/connector/src/http/admin-api.ts`
  - Action: At the `event: 'admin_peer_added'` log (l.697) and `'admin_peer_reregistered'` log (l.703), include `transport: body.transport`.
  - **G8 — Pre-existing url-redaction wart, OUT OF SCOPE for this spec:** `connector-node.ts:2122` emits `{ event: 'peer_registered', peerId: config.id, url: config.url }` with NO `redactPeerUrl()` call. Adding `transport` here does NOT make the existing leakage worse (the transport enum is not a `.anon` substring), but it does *increase* the surface area that exists on a log line that already leaks `.anon` URLs at INFO level. **This spec does not fix that pre-existing wart**; file a follow-up issue (suggested title: "redact peer URLs in peer_registered / peer_reregistered log lines") and reference it in the PR description. Do NOT extend Task 13 to fix the pre-existing wart — that's separate cleanup that should not block this spec.
  - Notes: `peer.transport` is `'direct' | 'socks5' | undefined` — none of these are `.anon` substrings, so no extra redaction is needed for the field itself. Continue using `redactPeerUrl` for the `url` field where it is already used (`btp-client-manager.ts:67`).

- [x] **Task 14 — Run full local validation gauntlet.**
  - Commands (run from repo root):
    ```bash
    make lint
    npm run lint:inventory --workspace=packages/connector
    npm run build
    npm test --workspace=packages/connector
    make infra-up
    npm run test:cross-surface --workspace=packages/connector
    make infra-down
    ```
  - Notes: All commands must pass before opening the PR. If `test:cross-surface` is flaky against the SOCKS5 sink, do not retry-loop — diagnose root cause.

### Acceptance Criteria

- [x] **AC-1 — Direct peer override on socks5-global connector.**
  *Given* a connector with `config.transport.type === 'socks5'` and a reachable direct WebSocket peer at `ws://direct-peer:3000`,
  *when* the operator registers the peer via `POST /admin/peers` with body `{ id, url: 'ws://direct-peer:3000', authToken, transport: 'direct' }`,
  *then* `GET /admin/peers` shows `connected: true` and `transport: 'direct'` for that peer within 10s, AND the unit test in Task 10 (real `BTPClient` + real local WS server + recording `agentFactory`) asserts the factory was invoked with the full `Peer` whose `transport === 'direct'` and returned `undefined` (no `SocksProxyAgent` was instantiated). The dial-path proof is split: response-shape assertion in Task 9a, agent-factory invocation assertion in Task 10. Together they prove "no SOCKS5 dial was attempted."

- [x] **AC-2 — SOCKS5 peer on socks5-global connector.**
  *Given* a connector with `config.transport.type === 'socks5'` and a reachable `.anon` peer at `ws://hidden-peer.anon:3000` via the configured SOCKS5 proxy,
  *when* the operator registers the peer with `transport: 'socks5'` (or omits the field),
  *then* `GET /admin/peers` shows `connected: true` for that peer within 10s and the SOCKS5 dial path was used.

- [x] **AC-3 — Default-inherit on direct-global connector.**
  *Given* a connector with `config.transport.type === 'direct'` and a reachable direct WebSocket peer,
  *when* the operator registers the peer with no `transport` field (or `transport: 'direct'`),
  *then* `GET /admin/peers` shows `connected: true` within 10s.

- [x] **AC-4 — 400 on socks5 peer without socks5-global.**
  *Given* a connector with `config.transport.type === 'direct'`,
  *when* the operator submits `POST /admin/peers` with `transport: 'socks5'`,
  *then* the response is **HTTP 400** with body `{ error: 'Bad request', message: "transport: 'socks5' requires connector-level transport.type 'socks5'" }`, no `BTPClient` is created, the peer does not appear in `GET /admin/peers`, and a parallel call to `ConnectorNode.registerPeer({ ..., transport: 'socks5' })` throws an `Error` with the same message string.

- [x] **AC-5 — Heterogeneous-fleet cross-surface E2E (gating, real ATOR).**
  *Given* the `two-home-ator-local` Docker Compose profile (`docker-compose.yml:744-854`) is up (real local ATOR testnet: dir-auths + relays + two apex connectors with `transport.type: 'socks5'` + managed `anon` SOCKS5 binaries) **extended with a new `two-home-local-direct-peer` service** providing a direct-reachable BTP endpoint on the same `ator_net` Docker network, and one of the apex connectors exposes a `.anon` hidden service URL,
  *when* the operator registers Peer A `{ transport: 'direct', url: ws://two-home-local-direct-peer:3000 }` and Peer B `{ transport: 'socks5', url: ws://<resolved-onion>.anon:3000 }` via the apex admin API,
  *then* both peers reach `connected: true` within their respective time budgets — **Peer A within 15s, Peer B within 90s** (real ATOR circuits are slow; the existing `standalone-ator-hs-local-e2e.test.ts:83` baseline budgets 120s for a single peer, so 90s is the conservative floor with sustained-state caching). The test runs as `STANDALONE_DOCKER=true jest --testPathPattern=per-peer-transport-cross-surface-e2e --forceExit --testTimeout=300000` against live Docker containers with **zero mocks**.

- [x] **AC-6 — Backwards compatibility regression guard.**
  *Given* any existing admin API caller submitting `POST /admin/peers` payloads with no `transport` field (e.g., the existing test fixture `validPeerRequest` in `admin-api-peers.test.ts`),
  *when* the request is processed,
  *then* the behavior is identical to the pre-change behavior: peer registered, BTP connection attempted, `GET /admin/peers` shows the peer, no new error paths fire.

- [x] **AC-7 — No mocks in any NEW test file.**
  *Given* the NEW test files added in Tasks 9a, 10, 11, and 12 (`admin-api-peer-transport.test.ts`, `btp-client-per-peer-transport.test.ts`, `per-peer-transport.test.ts`, `per-peer-transport-cross-surface-e2e.test.ts`),
  *when* CI runs `make lint` and the test commands,
  *then* no `jest.mock(...)`, no `jest.Mocked<...>`, no `sinon`, no `nock`, no DI-with-stub patterns appear in any of those four files; all NEW tests use real `BTPClient`, real Express app via supertest, real local WS echo server, real Docker peer containers (Task 12 only — reusing the extended `two-home-ator-local` profile).
  *Note*: AC-7 explicitly does NOT apply to the pre-existing `admin-api-peers.test.ts` and `btp-client-manager.test.ts` files, which retain their mocked harness as out-of-scope legacy. A cleanup task is filed as Task 9b (deferred, not required for this PR).

- [x] **AC-8 — YAML-loaded `transport` field is honored at startup.**
  *Given* a `connector.yaml` whose `peers:` list contains a peer with `transport: 'direct'` while `transport.type: 'socks5'`,
  *when* the connector starts via `npm run dev` or `ConnectorNode.start()`,
  *then* the peer connects via the direct path (no SOCKS5 dial), identically to the admin-API-registered AC-1 case. The integration test in Task 11 covers this.

- [x] **AC-9 — Lint, build, and log redaction all green.**
  *Given* the full implementation diff,
  *when* `make lint`, `npm run lint:inventory --workspace=packages/connector`, and `npm run build` are run,
  *then* all three pass without warnings. **Note**: `lint:inventory` only verifies route-presence drift (method+path set membership), not `failureModes`/`operationalNotes` content (F6). Content accuracy on the new inventory entries (Task 8) is the implementer's responsibility, not the linter's. Manual `grep -r '.anon' packages/connector/src/` against new log call sites surfaces no INFO/WARN/ERROR-level emissions of unredacted `.anon` strings (DEBUG/TRACE OK).

- [x] **AC-10 — POST re-registration does not change live transport; response echoes the LIVE value.**
  *Given* a peer already registered with `transport: 'direct'` and an active BTP connection on a `transport.type: 'socks5'` connector,
  *when* the operator submits `POST /admin/peers` with `transport: 'socks5'` for the same `id`,
  *then* the response is **HTTP 200**, the live BTP connection continues using the *original* transport (`'direct'`), and the response payload includes `transport: 'direct'` (the **live** value read from the existing `BTPClient` via `BTPClientManager.getPeerTransport(id)`, NOT echoing `body.transport === 'socks5'`). `docs/admin-api-inventory.md` (Task 8) records this as expected behavior. PUT does NOT accept a `transport` field at all (Decision 9). This is the F10 fix: the spec explicitly does NOT propagate the existing `url`/`authToken` echo-the-requested-value wart to `transport`.

- [x] **AC-11 — Defense-in-depth: invariant-violation paths fail loud, never silently direct-dial.**
  *Given* a connector where the per-peer dispatch closure is invoked with a peer whose `transport === 'socks5'` but the connector's `_transportType !== 'socks5'` or `_transportProvider === null` (a condition that should be impossible if Tasks 5, 6, 7 validators ran — but is the defense-in-depth backstop per F11/Decision 8),
  *when* `BTPClient.connect()` calls the factory,
  *then* the factory throws (or returns a poison agent), the BTPClient surfaces a `BTPConnectionError`, an `event: 'btp_agent_factory_invariant_violation'` log line is emitted at ERROR level with `{ peerId, requestedTransport: 'socks5', connectorTransport }`, and the peer does NOT silently dial direct. The unit test in Task 10 includes an explicit invariant-violation case that constructs the inconsistent state and asserts the error path.

- [x] **AC-12 — ConfigLoader rejects YAML with `transport: 'socks5'` on a direct-global connector.**
  *Given* a `connector.yaml` containing a peer with `transport: 'socks5'` while the global `transport.type` is `'direct'` (or omitted, which defaults to `'direct'`),
  *when* `ConfigLoader.loadFromFile()` is called,
  *then* it throws `ConfigurationError` with a message matching `/peer '.+': transport: 'socks5' requires connector-level transport.type 'socks5'/`. Verified by Task 11's third test case. AC-12 also requires that an invalid `transport` value (e.g. `'tor'`) triggers a `ConfigurationError` with the enum-validation message family.

## Additional Context

### Dependencies

- **Cross-repo:** This unblocks [toon-protocol/town Story 46.4](https://github.com/toon-protocol/town) (Epic 46 — lazy peer node provisioning), currently 4/5 E2E gate passing. Townhouse PRs #50–#55 are the prior fixes that isolated this as the last remaining blocker. Townhouse's `writeHsConnectorConfig` ([source](https://github.com/toon-protocol/town/blob/main/packages/townhouse/src/connector/hs-config-writer.ts)) will need a follow-up patch to emit `transport: 'direct'` for Docker-sibling peers — that work lives in the Townhouse repo, not here. Track via a new issue on `toon-protocol/town` once the connector PR merges.
- **Connector version target:** The fix lands on `ghcr.io/toon-protocol/connector` `3.6.x+` (next minor release after `3.6.1`). Affected versions per the issue: `3.5.1` (sha `b3c535831a6...`), likely 3.5.0 → HEAD.
- **Stop-the-line interaction:** Per CLAUDE.md, the connector has a nightly HTTP-surface workflow policy. The actual nightly workflow file is `.github/workflows/nightly-ator.yml` (NOT `nightly-http-surface.yml` — that filename appears in CLAUDE.md but the file doesn't exist; a follow-up cleanup is implied). Story closure requires the new `test:per-peer-transport-e2e` script to be added to the nightly workflow and pass before merge to main. If `nightly-ator.yml` doesn't cover the standalone-suite shape, the implementer may need to create a new workflow or extend the existing one — call out whichever path is chosen in the PR description.
- **No new npm packages and no new Docker images.** All required runtime libs (`ws`, `socks-proxy-agent`, `zod`) and test scaffolding (`jest`, `supertest`, the existing `two-home-ator-local` Compose profile with its real local ATOR testnet) are already in place from Epic 35 / Epic 36. The original spec called for inventing `anon-sink`/`dante` containers; per F2 that is replaced with **reuse of the existing real ATOR infrastructure in `docker-compose.yml`** (dir-auths l.163+, relays l.260+, `two-home-ator-local` profile at l.744-854). The only infrastructure change is the new `two-home-local-direct-peer` service inside that profile.
- **Internal coupling:** The change touches both the admin HTTP surface and `ConnectorNode.registerPeer()` SDK surface. Anyone with an in-flight PR touching either should rebase after this lands.

### Testing Strategy

**No mocks in any NEW test file.** All NEW tests use real implementations (CLAUDE.md). Real local WS echo servers for unit/integration; real ATOR testnet (`two-home-ator-local` Compose profile, extended with a `two-home-local-direct-peer` service) for the gating E2E. Per AC-7, this constraint applies only to the NEW files added by this spec — the pre-existing `admin-api-peers.test.ts` and `btp-client-manager.test.ts` retain their mocked harnesses as out-of-scope legacy (Task 9b documents the deferred cleanup).

**Test pyramid (matches Tasks 9a–12, all NEW files):**

1. **Unit — `btp-client-per-peer-transport.test.ts` (Task 10, NEW).** Real `BTPClient` (no module mock), real local `ws.WebSocketServer`, real instrumented `agentFactory: (peer: Peer) => …` that records invocations. Asserts the factory receives the full `Peer` (not just `peerUrl`) on each `connect()`, no `SocksProxyAgent` is instantiated when `transport === 'direct'`, and the invariant-violation branch (AC-11) surfaces a `BTPConnectionError` instead of silently direct-dialing.
2. **Unit — `admin-api-peer-transport.test.ts` (Task 9a, NEW).** supertest + real Express app + real router + real (in-process) `BTPClientManager`. Seven cases: 2× positive (`direct` + `socks5` on socks5-global), 1× negative (400 on socks5+direct-global), 1× enum validation, 1× back-compat, 1× re-registration echoes the live transport not the requested one (AC-10), 1× PUT does not accept transport (Decision 9).
3. **Integration — `per-peer-transport.test.ts` (Task 11, NEW).** Real `ConnectorNode`, real `ConfigLoader`, real local WS echo peer. Covers: SDK Error path on `registerPeer({ transport: 'socks5' })` against a direct-global connector, YAML-loaded peer's `transport` field round-trips through ConfigLoader and reaches the BTPClient construction site at `connector-node.ts:1244` (AC-8 + F13), ConfigLoader throws on YAML with `transport: 'socks5'` on a direct-global connector (AC-12).
4. **Cross-surface (gating) — `per-peer-transport-cross-surface-e2e.test.ts` (Task 12, NEW).** Reuses the existing `two-home-ator-local` profile from `docker-compose.yml:744-854` — real local ATOR testnet (dir-auths + relays + two apex connectors with managed `anon` binaries, `transport.type: socks5`). Extended with a new `two-home-local-direct-peer` service for the direct-reachable peer. Asserts heterogeneous fleet behavior end-to-end. **This is the test that proves Townhouse Story 46.4 will pass.** Run via `STANDALONE_DOCKER=true jest --testPathPattern=per-peer-transport-cross-surface-e2e --forceExit --testTimeout=300000` (5-minute total budget — real ATOR circuits take ≤2 min per peer per the existing `standalone-ator-hs-local-e2e.test.ts:83` baseline).

**Restart/persistence test:** Out of scope per Decision 6 (admin-added peers are intentionally in-memory only; YAML-loaded peers persist by being in YAML — Task 11 covers the YAML path).

**Coverage gates:** Existing workspace coverage thresholds apply (see `packages/connector/jest.config.js` / `package.json`). Hot paths added: per-peer dispatch closure in `connector-node.ts`, validation branches in `admin-api.ts` POST/PUT and `ConnectorNode.registerPeer()`, `ConfigLoader.validatePeers()` new branch.

**Manual testing checklist** (for the PR description):

1. `make infra-up`
2. Write a `connector.yaml` with `transport.type: 'socks5'` + a `socksProxy`, plus two peers (`transport: 'direct'` on a Docker-sibling URL, default-inherit on a `.anon` URL).
3. `npm run dev` and observe both peers reach connected state — direct peer immediately, `.anon` after SOCKS5 handshake.
4. `curl -X POST http://127.0.0.1:9401/admin/peers -d '{"id":"x","url":"ws://x:3000","authToken":"","transport":"socks5"}'` against a `transport.type: 'direct'` connector — expect 400.

### Notes

- **Step-1 open question on persistence — CLOSED.** Admin-added peers are in-memory only today (`BTPClientManager._clients: Map<string, BTPClient>`); no disk/SQLite persistence path exists for runtime-added peer records. This spec **does not add one**. YAML-loaded peers persist via `connector.yaml` (which already carries `transport` once `PeerConfig` is extended). Orchestrators that need admin-registered peers to survive a restart (Townhouse) already re-emit admin POSTs at startup.
- **Step-1 open question on AC-2/Decision-4 interaction — CLOSED.** The `TransportConfig` discriminated union (`config/types.ts:210`) is shaped so `socksProxy` only narrows into existence when `type === 'socks5'`. The "direct global + has socks proxy configured" anomaly is unrepresentable. Therefore: on a `direct`-global connector, `transport: 'socks5'` always 400s (AC-4); on a `socks5`-global connector, both `direct` and `socks5` peer overrides work (AC-1 + AC-2).
- **Adversarial review history (three rounds — F-, G-, H-prefixed findings — all addressed):**
  - **Round 1 (F1–F15)**: AC-7 mocks conflict, invented Compose infra, closure crash on undefined transport, validation ordering, PUT scope creep, lint:inventory enforcement claim, broken URL, line numbers, missed Peer literal sites, re-registration echo wart, silent fallthrough, AC-1 testability, YAML round-trip, inventory 200/201 drift, socks5h reminder.
  - **Round 2 (G1–G10)**: Task 3 vs Decision 8 contradiction, `standalone-ator-hs-local` profile non-existent (corrected to `two-home-ator-local`), admin-server.ts router mount site, GET /peers handler missing extension, getPeerTransport backing field, Task 9a case-7 determinism, POST validator placement, unredacted url log line (scoped out), response JSON path, stale "AC-5 removed" line.
  - **Round 3 (H1–H10)**: profile-name propagation, AC-5 30s socks5 budget too tight (bumped to 90s per peer, 300s total), `ConnectorNode.listPeers()` SDK surface, PeerInfo extension promoted to required, plus several lower-priority items. All H1, H2, H3, H6 fixed; H4 (networks), H5 (nightly workflow filename), H7–H10 documented as known minor items.
  - Test-side enforcement lives in AC-7/AC-10/AC-11/AC-12; implementation-side fixes in Decision 8/9/10 + revised Tasks 1/3/6/7/9a/10/11/12/13.
- **Townhouse follow-up (cross-repo).** Once this spec ships and lands a connector release, open a tracking issue/PR on `toon-protocol/town` to update `writeHsConnectorConfig` ([source](https://github.com/toon-protocol/town/blob/main/packages/townhouse/src/connector/hs-config-writer.ts)) and the lazy-peer-provisioning admin POSTs to emit `transport: 'direct'` for Docker-sibling peers and `transport: 'socks5'` for `.anyone` peers. Story 46.4's 5th E2E gate should flip from red to green on that follow-up.
- **Deferred cleanup (Task 9b).** Existing `admin-api-peers.test.ts` and `btp-client-manager.test.ts` use Jest mocks heavily. Out of scope for this spec but tracked as Task 9b for a future PR. AC-7's no-mocks rule applies only to NEW files added by this spec.
- **No new dependencies, no new Docker images.** Contained inside the connector workspace + reuse of existing infra. Estimated 300–500 LOC including the four new test files.
- **Dispatch architecture locked.** Decision 8 = option (a): factory signature change from `(peerUrl)` to `(peer: Peer)`. Single dispatch site in `connector-node.ts:215` closure with defense-in-depth for invariant violations.
- **Out-of-band review notes.** The original GitHub issue #69 proposed three options ((1) per-peer override, (2) `noProxy` allowlist, (3) heuristic). This spec implements only option (1); options (2) and (3) are explicitly rejected per the party-mode discussion (DNS-vs-IP divergence, container-resolver mismatch, `.anon` hostnames misclassify under naïve heuristics).

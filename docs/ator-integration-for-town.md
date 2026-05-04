# Integrating ATOR with the Connector — Guide for Town

**Audience:** Town developers (and other downstream consumers of `@toon-protocol/connector`) who want to enable ATOR (Anyone Protocol — Tor 0.4.9.x fork with token-incentivized relays) for privacy-preserving peer-to-peer connector traffic.

**Pre-read:** [`docs/ator-transport.md`](ator-transport.md) — the canonical operator deployment guide. This document is a Town-specific overlay on top of it. Anything in `ator-transport.md` is authoritative; this file translates it into Town's consumption modes and points to where each piece plugs into the existing topology.

**TL;DR:** Town's existing `@toon-protocol/connector ^3.3.3` dependency already contains the ATOR transport (Epic 35 shipped before 3.3.3). To enable it, Town adds a `transport:` block to the connector YAML it already mounts/generates and ensures `@anyone-protocol/anyone-client` is installable. No connector code change required.

---

## What ATOR gives Town

| Layer                                    | What it hides                                                         | From whom                       |
| ---------------------------------------- | --------------------------------------------------------------------- | ------------------------------- |
| ATOR circuit (this guide)                | All bytes on the wire — 514-byte fixed encrypted cells, content-blind | Relays, ISPs, on-path observers |
| ILP routing                              | Destination + amount + expiry visible only to packet endpoints        | Intermediary relays             |
| NIP-59 gift wrap (`nip59.enabled: true`) | Settlement-claim sender identity, blockchain type, amounts, timing    | Intermediary connectors         |

The three layers compose. ATOR alone is **not** NIP-59. If Town's threat model needs claim-level privacy, also enable NIP-59 (Epic 34, see `docs/ator-transport.md` § Privacy Model).

ATOR also delivers a property Town cares about strategically: **operating a relay from a home network behind NAT, with no public IP, no port-forwarding, no domain name**. The hidden-service rendezvous IS the reverse proxy. This is the property your README contrasts Lightning against (line 164: _"Lightning has onion routing (transport privacy) but reveals channel capacities..."_).

---

## Two consumption modes — what changes for each

Town consumes the connector in two ways today:

### Mode A — Embedded via `@toon-protocol/connector` npm package

Used by `@toon-protocol/town`, `@toon-protocol/sdk`, `@toon-protocol/mill`, `@toon-protocol/core`. Town instantiates `ConnectorNode` directly and runs it in-process.

**To enable ATOR:**

1. Add `@anyone-protocol/anyone-client` as a dependency in whatever Town package owns the connector lifecycle (e.g., `packages/town`):

   ```bash
   pnpm --filter @toon-protocol/town add @anyone-protocol/anyone-client@^1.1.3
   ```

   It is `optionalDependencies` in `@toon-protocol/connector`. Town must declare it explicitly to guarantee install reproducibility.

2. Build the `ConnectorConfig` with a `transport` block (this is the only material code change):

   ```typescript
   const cfg: ConnectorConfig = {
     // ...existing Town fields (nodeId, peers, routes, chainProviders)...
     transport: {
       type: 'socks5',
       socksProxy: 'socks5h://127.0.0.1:9050', // socks5h:// MANDATORY (DNS leak prevention)
       externalUrl: 'auto', // resolves from hidden-service hostname file at start
       managed: true,
       managedOptions: {
         hiddenServiceDir: '/var/lib/town/hidden-service',
         hiddenServicePort: 443, // what peers will dial: wss://X.anon:443
         startupTimeoutMs: 90_000,
         stopTimeoutMs: 10_000,
       },
     },
   };
   const node = new ConnectorNode(cfg, logger);
   await node.start(); // managed anon boots here; throws on misconfig (fail-closed)
   ```

3. Ensure the `hiddenServiceDir` is a persistent path. The `.anon` hostname is rotated only if you delete it. Town should mount this onto a persistent volume per node.

4. Read `node.getExternalUrl()` after `start()` to get the published `wss://X.anon:443`. Use whatever Town's existing peer-exchange mechanism is to share it (your DOGFOOD.md mentions Townhouse orchestration for peer wiring).

That's it. The rest of `ConnectorNode`'s API surface is unchanged — chain providers, settlement, BTP routing, claim verification all work identically over ATOR.

### Mode B — Standalone via `ghcr.io/toon-protocol/connector:3.3.3` Docker image

Used by `docker-compose-townhouse.yml` (the relay-operator deployment). Town runs the published connector image as a separate container and reaches it over BTP/HTTP.

**To enable ATOR**, the connector container needs:

1. **The optional ATOR SDK installed in the image.** If Town's tests or production require ATOR, verify the published image contains `@anyone-protocol/anyone-client`. Two paths:
   - **Confirm + use as-is:** `docker run --rm ghcr.io/toon-protocol/connector:3.3.3 ls node_modules/@anyone-protocol` should list `anyone-client`. If yes, no rebuild needed.
   - **Rebuild a Town-owned image variant** if not present: extend the published image with `RUN npm install --no-save @anyone-protocol/anyone-client@^1.1.3 --workspace=packages/connector` and publish as `town-connector:3.3.3-ator` (or similar).

2. **An `anon` binary sidecar OR managed-anon bundled in the same container.** Two patterns:
   - **Sidecar pattern (recommended for compose deployments):** a separate container running `anon` that the connector container reaches via SOCKS5 over the compose network. This is the shape `docker/ator-public-sidecar/` provides in the connector repo — see `docker-compose.yml` under the `standalone-ator-p2p` (public ATOR) and `two-home-ator-local` (local testnet) profiles for working examples.
   - **Managed-anon-in-connector:** set `managed: true` in the YAML and let `ManagedAnonClient` boot the binary inside the connector container. Requires the `anon` binary to be present in the image (it is NOT in the default `ghcr.io/toon-protocol/connector:3.3.3` image — the SDK installs it lazily on first start). For Town's deployment, prefer the sidecar pattern.

3. **A YAML `transport:` block in the config Town generates.** The `townhouse` package that produces the connector config from env vars (`CONNECTOR_PEERS`, `TRANSPORT_MODE`, etc.) needs to grow a `TRANSPORT_MODE=socks5` branch that emits the same `transport: { type: 'socks5', ... }` block shown in Mode A. Today it always emits `direct` (per `docker-compose-townhouse.yml:39`).

4. **Compose network shape** mirroring the connector repo's `standalone-ator-p2p` profile. Each connector + sidecar pair shares a single Docker network namespace via `network_mode: service:<sidecar>` so the sidecar's HS forward target (`127.0.0.1:3000`) reaches the adjacent connector's BTP listener without DNS chicken-and-egg. See `docker-compose.yml` lines 565-675 in the connector repo for the verbatim shape.

---

## Configuration reference (for Town code that generates connector YAML)

This is the schema Town's config-generation code (`packages/townhouse/...`) needs to learn. Authoritative source: `packages/connector/src/config/types.ts` `TransportConfig` discriminated union.

```yaml
# Direct transport — current Town default. Backwards-compatible; existing
# deployments without a `transport:` key get this implicitly.
transport:
  type: direct

# SOCKS5 transport with EXTERNAL anon — Town's Townhouse compose runs anon
# itself in a sidecar container, points the connector at it.
transport:
  type: socks5
  socksProxy: socks5h://127.0.0.1:9050   # MUST be socks5h://, not socks5://
  externalUrl: wss://abcd1234.anon:443    # the .anon hostname Town's sidecar publishes
  managed: false

# SOCKS5 transport with MANAGED anon — connector boots its own anon binary.
# Recommended only when Town runs the connector as a single binary on a host
# (e.g., a Raspberry Pi relay), not as a Docker service.
transport:
  type: socks5
  socksProxy: socks5h://127.0.0.1:9050
  externalUrl: auto                       # resolves from hidden-service hostname at start
  managed: true
  managedOptions:
    hiddenServiceDir: /var/lib/town/hidden-service   # MUST be persistent
    hiddenServicePort: 443
    startupTimeoutMs: 90000
    stopTimeoutMs: 10000
```

**Validation rules** (enforced by `ConfigLoader.validateSocks5Transport()`):

- `socksProxy` MUST start with `socks5h://`. The `h` forces DNS resolution through the proxy. `socks5://` resolves locally and would leak `.anon` destinations. Triple-validated.
- `externalUrl` MUST be `wss?://...` OR the literal string `"auto"`.
- `"auto"` requires `managed: true` AND `managedOptions.hiddenServiceDir` set.
- `managedOptions` is permitted only when `managed: true`.
- Path-traversal segments (`..`) in `hiddenServiceDir` / `binaryPath` / `configFilePath` are rejected.

---

## Gotchas Town developers will hit

### 1. BTP `authToken` is empty-string by default — and BTP accepts it

Per `packages/connector/src/btp/btp-server.ts:519-538`, the BTP server is **permissionless by default** — it accepts an empty-string handshake unless `BTP_ALLOW_NOAUTH=false` is set in the connector's environment. This is intentional (RFC-0023 conformance for ILP-gated networks where access control happens at the ILP layer). Town's existing relay model already lives here.

If Town wants to opt into BTP-level auth for specific peer pairs:

- Each peer's `peers[].authToken` must be a 32+ byte shared secret agreed out-of-band
- The BTP server validates **inbound** secrets against `process.env.BTP_PEER_<peer-id-uppercase>_SECRET`, **not** against the YAML — YAML is only the outbound (client) token (`btp-server.ts:573-588`, `btp-client.ts:330`)
- So Town's deployment must export both: `peers[id].authToken: <token>` in YAML AND `BTP_PEER_<ID>_SECRET=<token>` in the connector container's env. `BTP_ALLOW_NOAUTH=false` if you want to reject empty-string handshakes from anyone else.

The `tools/two-home-ator-handshake/handshake.sh` script in this repo handles this asymmetric wiring automatically — useful as a reference.

### 2. The first HS publish takes 30-90s

The first time a managed-anon node starts, anon must build a circuit through the network and upload its hidden-service descriptor to a HSDir before the `.anon` hostname is reachable from peers. Town's startup probes / health checks should budget for this. After the descriptor is uploaded, the hostname is cached and re-publish on restart is faster.

### 3. ATOR latency: budget timeouts accordingly

| Metric                       | Direct TCP | Through ATOR              |
| ---------------------------- | ---------- | ------------------------- |
| BTP connection establishment | ~50ms      | ~600ms (6-hop rendezvous) |
| Single-hop ILP round-trip    | ~100ms     | ~400-700ms                |
| 3-hop ILP payment round-trip | ~300ms     | ~1.2-2.1s                 |

Town's STREAM senders, settlement timers, and SDK per-call timeouts should be tuned for the `ATOR` row when the destination is over a `.anon` peer. The connector forwards whatever `expiresAt` the sender set — it does NOT auto-extend.

### 4. `.anon` addresses are sensitive — DEBUG-only logging

The connector enforces this internally (transport logs at INFO use `{proxyHost, proxyPort}`, never `peerUrl`/`externalUrl`). Town's own logging — anything that handles peer config — should follow the same rule. **Never** log a `.anon` URL at INFO/WARN/ERROR. Use DEBUG, redact in error messages.

### 5. Optional dep gotcha

`@anyone-protocol/anyone-client` is in the connector's `optionalDependencies`. If your install pipeline runs `npm install --omit=optional` or `pnpm install --no-optional`, the SDK won't be present and managed mode will throw a canonical install-guidance error at first use (not at module import). For deterministic builds, **declare it explicitly** in the package.json that owns the connector lifecycle.

### 6. Hidden-service directory persistence

Delete `${hiddenServiceDir}/hostname` and the next start publishes a NEW `.anon` URL — and all peers that knew the old one cannot reach you anymore. Town's deployment automation should treat this directory as durable state (mount it on a named volume in compose, or to a persistent partition on bare-metal Pi deployments).

---

## What Town needs to build

Concrete checklist for the integration:

- [ ] Decide: in-process embedded mode or Docker sidecar mode (or both — they coexist)
- [ ] Add `@anyone-protocol/anyone-client` to `packages/town`'s dependencies (Mode A) or extend the connector image (Mode B)
- [ ] Extend the `townhouse` config generator to emit a `transport:` block when `TRANSPORT_MODE=socks5`
- [ ] If Mode B: extend `docker-compose-townhouse.yml` with an anon sidecar service (mirror `docker/ator-public-sidecar/` from the connector repo) and rewire the connector container to `network_mode: service:<sidecar>`
- [ ] Reserve a persistent volume for `hiddenServiceDir`
- [ ] Update timeouts (STREAM, SDK, settlement) for ATOR-paired peers
- [ ] Audit logging for `.anon` leaks (anything passing peer URLs to log lines)
- [ ] Write/extend a peer-exchange flow that knows about `.anon` addresses (your existing peer-discovery + a nullable transport hint field is probably enough)
- [ ] Document for relay operators: `make town-up-with-ator` (or equivalent) that brings up the full stack

## Verification — proven shapes you can copy

The connector repo has three verified end-to-end shapes you can study or borrow:

| Shape                                                             | What it proves                                                                                                                                                       | Where                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `make two-home-ator-local-up` + `make two-home-ator-local-verify` | Two connectors over LOCAL ATOR testnet exchange real ILP packets via real `.anon` rendezvous. Offline-runnable, ~3 min wall clock.                                   | `docker-compose.yml` profile `two-home-ator-local` + `tools/two-home-ator-handshake/docker-local-verify.sh`                                 |
| `make standalone-test-ator-p2p`                                   | Same as above but on the PUBLIC Anyone network. ~5-8 min, requires internet.                                                                                         | `docker-compose.yml` profile `standalone-ator-p2p` + `packages/connector/test/integration/standalone-ator-public-p2p-container-e2e.test.ts` |
| `tools/two-home-ator-handshake/handshake.sh`                      | Single-binary CLI to set up a connector + managed anon on a real laptop and produce a real `.anon` URL. Good for operator-facing testing of Town's relay deployment. | `tools/two-home-ator-handshake/`                                                                                                            |

All three pass green as of the PR that introduced this guide. The compose patterns in particular are directly liftable into Town's own compose files.

## When to publish what

| Question                                                                  | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Does Town need a new `@toon-protocol/connector` npm release to use ATOR?  | **No.** ATOR support shipped in Epic 35, included in the published 3.3.3 (and 3.3.x generally).                                                                                                                                                                                                                                                                                                                                                                                                        |
| Does Town need to update its `@toon-protocol/connector` peer-dep version? | No — `^3.3.3` is fine. ATOR is opt-in via the `transport:` config block; there's no breaking API change.                                                                                                                                                                                                                                                                                                                                                                                               |
| Does Town need a new `ghcr.io/toon-protocol/connector` Docker image?      | **Maybe.** If the published 3.3.3 image bakes `@anyone-protocol/anyone-client` (verify with `docker run --rm ghcr.io/toon-protocol/connector:3.3.3 ls node_modules/@anyone-protocol`), no rebuild needed. If not, either (a) Town builds and publishes a `town-connector:3.3.3-ator` variant, or (b) the connector maintainers publish a `connector:3.3.3-ator` tag. The cleanest fix upstream is to make `@anyone-protocol/anyone-client` a regular dep (not optional) in a future connector release. |
| Does Town need to publish a new sidecar image?                            | **Yes if going down Mode B (sidecar pattern).** Town's `docker/` repo can either: (a) bake the connector repo's `docker/ator-public-sidecar/` into Town's own build pipeline and publish under `ghcr.io/toon-protocol/town-ator-sidecar:v0.4.10.0-beta`, or (b) the connector maintainers publish that image to GHCR for shared consumption. Either way, the underlying anon binary version should be pinned the same way the existing testnet image pins it.                                          |

## Where to follow up

- **Operator deployment guide:** `docs/ator-transport.md` (this repo) — the canonical reference.
- **Two-home verification cookbook:** `tools/two-home-ator-handshake/README.md` (this repo) — three verified topologies including a single-laptop dry-run.
- **Settlement + ATOR composition:** `docs/ator-transport.md` § "Privacy Model" — the three-layer stack and what each layer hides.
- **NIP-59 enablement:** Epic 34 documentation in `_bmad-output/planning-artifacts/` and `packages/connector/src/settlement/privacy/nip59-claim-wrapper.ts`.
- **Roadmap context:** Epic 41 (Nostr-based peer discovery) will eventually let Town nodes find each other's `.anon` addresses without manual exchange. Until then, your existing peer-discovery mechanism (or out-of-band paste) is the integration point.

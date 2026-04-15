# ATOR Overlay Transport -- Deployment and Configuration Guide

> Epic 35 -- ATOR Overlay Transport for Privacy-Enabled Peering.
> Planning artifact: [\_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md](../_bmad-output/planning-artifacts/epic-35-ator-overlay-transport.md).
> Test design (T-ID authority): [\_bmad-output/planning-artifacts/test-design-epic-35.md](../_bmad-output/planning-artifacts/test-design-epic-35.md).

This guide covers running a TOON connector whose outbound BTP WebSocket traffic is tunneled through an ATOR (Anyone Protocol) overlay, and whose inbound peering is reachable via a `.anon` hidden service. ATOR is a fork of Tor 0.4.9.x with token-incentivized relays; at the protocol layer it is standard onion routing, so the integration also works with a system `tor` SOCKS proxy when `socks5h://` is used.

The guide targets two audiences:

- **Operators** setting up a privacy-enabled connector for the first time.
- **Security reviewers** checking that the claimed privacy guarantees match what Stories 35.1--35.6 actually ship.

Default transport remains direct TCP -- existing deployments that do not opt into `transport.type: "socks5"` are unaffected.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
  - [External anon, or system tor (Opt A)](#option-a-external-anon-or-system-tor)
  - [Managed anon via @anyone-protocol/anyone-client (Opt B)](#option-b-managed-anon-via-anyone-protocolanyone-client)
- [Connector Configuration](#connector-configuration)
  - [transport Block Reference](#transport-block-reference)
  - [Example A -- Direct Transport (Default)](#example-a----direct-transport-default)
  - [Example B -- SOCKS5 with External anon](#example-b----socks5-with-external-anon)
  - [Example C -- SOCKS5 with Managed anon and Hidden Service](#example-c----socks5-with-managed-anon-and-hidden-service)
- [Peer Discovery](#peer-discovery)
- [Privacy Model](#privacy-model)
- [Performance and Timeout Tuning](#performance-and-timeout-tuning)
- [Operational Monitoring](#operational-monitoring)
- [Troubleshooting](#troubleshooting)
- [Security Model](#security-model)

---

## Prerequisites

| Requirement  | Minimum                                 | Source                                                                     |
| ------------ | --------------------------------------- | -------------------------------------------------------------------------- |
| Node.js      | `>= 22.11.0`                            | root `package.json` `engines.node`                                         |
| npm          | `>= 10.0.0`                             | root `package.json` `engines.npm`                                          |
| anon / tor   | ATOR binary OR system `tor` with SOCKS5 | Story 35.2 SocksTransportProvider; R-005 in the Epic 35 planning doc       |
| Optional SDK | `@anyone-protocol/anyone-client ^1.1.3` | `packages/connector/package.json` `optionalDependencies` (Story 35.5 AC10) |

Privacy-enabled peering imposes no new hardware requirement beyond the default connector: a Raspberry Pi class device with a consumer internet connection is sufficient because ATOR traverses NAT without port forwarding.

---

## Installation

You have two paths. Pick one. Both run the same `SocksTransportProvider` on the connector side -- the difference is who starts and stops the `anon` binary.

### Option A: External anon (or system tor)

The operator runs the SOCKS5 proxy themselves. The connector only talks to it over `socks5h://127.0.0.1:<port>`.

**With ATOR's anon binary (Linux / macOS):**

```bash
# Option A.1: install anon via the official distribution.
# See https://docs.anyone.io for distro install packages (background reference).
# Expected outcome: `anon` process listening on SOCKS5 port (default 9050).

# Option A.2: install the Anyone Protocol SDK locally and run its bundled
# proxy binary directly. The package exposes TWO CLIs -- pick the one that
# matches what you want to do:
#
#   anyone-proxy   -- experimental SOCKS5 daemon wrapper (proxychains-backed).
#                     Start this when you want a running SOCKS5 endpoint on a
#                     specific port and nothing else.
#   anyone-client  -- process orchestrator around the bundled `anon` binary.
#                     Use this when you want richer control: OR port, control
#                     port, custom anonrc, and the `anon` binary lifecycle.
#
# The connector's managed-client code path (see below) does NOT shell out to
# either CLI -- it imports the SDK and calls the `Anon` constructor directly.
# These CLIs are for operators who want to run the proxy outside the connector.
npm install @anyone-protocol/anyone-client
```

**Flag surface (`anyone-proxy`, pinned SDK):**

| Flag           | Type / form         | Effect                                                           | Provenance      |
| -------------- | ------------------- | ---------------------------------------------------------------- | --------------- |
| `--socks-port` | `--socks-port 9050` | SOCKS5 bind port for the proxychains-wrapped `anon` process.     | [operator-only] |
| (forwarded...) | any other args      | Forwarded verbatim to proxychains / `anon`; unknown flags error. | [operator-only] |

**Flag surface (`anyone-client`, pinned SDK -- uses `node:util.parseArgs`):**

| Flag                     | Short | Type   | Effect                                                                      | Provenance      |
| ------------------------ | ----- | ------ | --------------------------------------------------------------------------- | --------------- |
| `--socksPort <n>`        | `-s`  | int    | SOCKS5 bind port (default `9050`). Maps to `Anon({ socksPort })`.           | [story 35.5]    |
| `--orPort <n>`           | `-o`  | int    | OR port (default `9001`). Connector sets this to `0` programmatically.      | [story 35.5]    |
| `--controlPort <n>`      | `-c`  | int    | Control port (default `9051`). Not invoked from connector code.             | [operator-only] |
| `--verbose`              | `-v`  | bool   | Enables `displayLog` on the spawned `Anon`. Maps to `Anon({ displayLog })`. | [story 35.5]    |
| `--config <path>`        | `-f`  | string | Path to anonrc. Maps to `Anon({ configFilePath })`.                         | [story 35.5]    |
| `--binaryPath <path>`    | `-b`  | string | Override for the `anon` executable. Maps to `Anon({ binaryPath })`.         | [story 35.5]    |
| `--agree`                | --    | bool   | Auto-accept upstream terms (non-interactive installs).                      | [operator-only] |
| `--termsFilePath <path>` | `-t`  | string | Path to an accepted-terms marker file (for `--agree` flows).                | [operator-only] |

Flags consumed by the managed-client code path -- `binaryPath`, `configFilePath`, `hiddenServiceDir`, `hiddenServicePort`, `socksPort` -- were introduced by [story 35.5]. The flag-surface audit itself was done by [story 36.2]. See `packages/connector/src/transport/managed-anon-client.ts` `_buildFactoryOptions()` for the exact SDK options the connector passes programmatically; note that `hiddenServiceDir` / `hiddenServicePort` are SDK-programmatic options only and are NOT exposed as CLI flags on `anyone-client` at the pinned version.

**Settings NOT exposed as CLI flags (anonrc-only at the pinned SDK version):** `data-dir` (the `anon` data directory) and `log-level` (verbosity beyond the boolean `--verbose` / `-v` toggle) are controlled via the anonrc file referenced by `--config` / `-f`, not as direct flags on `anyone-client`. Operators who need to override the data-dir or raise the log-level beyond `--verbose`'s notice-level default must edit their anonrc and pass it via `--config <path>`. This gap was confirmed during the [story 36.2] audit against `@anyone-protocol/anyone-client@1.1.3`; if a future SDK bump adds `--data-dir` / `--log-level` as first-class CLI flags, update this table and the committed `--help` snapshots in the same PR. [operator-only]

**Syntactic-validity note (`--help` is not honored by either CLI):**

- `anyone-proxy --help` is intercepted by proxychains before the SDK sees it; exit code `0` with a proxychains "can't load process '--help'" message. Not a usage screen.
- `anyone-client --help` throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` from `node:util.parseArgs` and exits `1`. Again, not a usage screen.

Byte-for-byte transcripts of both invocations at the pinned SDK version are committed at `docs/ator-transport/anyone-proxy-help.txt` and `docs/ator-transport/anyone-client-help.txt`; the snapshot-diff gate at `packages/connector/test/integration/story-36-2-anon-cli-snapshot.test.ts` fails CI if either output drifts silently on an SDK bump.

**Example commands:**

```bash
# Start the SOCKS5 proxy on the default port (9050)
npx anyone-proxy

# Start the SOCKS5 proxy on a custom port
npx anyone-proxy --socks-port 9150

# Start the full client with custom SOCKS + OR ports and verbose logging
npx anyone-client -s 9050 -o 9001 -v

# Validate flag syntax without starting the daemon (exits non-zero on typos)
npx anyone-client --bogus-flag   # exits 1: ERR_PARSE_ARGS_UNKNOWN_OPTION
```

> Flag surface verified against @anyone-protocol/anyone-client@1.1.3 on 2026-04-15.

See `docs/ator-transport/anyone-proxy-help.txt` and `docs/ator-transport/anyone-client-help.txt` for the full flag surface as of the audit.

**With system tor (fallback on platforms where the bundled anon binary is unavailable -- Epic 35 R-005):**

```bash
# Debian / Ubuntu
sudo apt-get install tor
sudo systemctl enable --now tor

# macOS
brew install tor
brew services start tor
```

The connector does not care whether the SOCKS5 endpoint is `anon` or `tor`: both accept `socks5h://` connections with remote DNS resolution. Set `transport.managed: false` (or omit `managed` entirely) and point `socksProxy` at the running proxy.

### Option B: Managed anon via @anyone-protocol/anyone-client

The connector process boots and tears down the `anon` binary itself, optionally configuring a hidden service for inbound peering.

The SDK is declared as an **optional dependency** -- running the connector with `transport.type: "direct"` does not require it. If you set `transport.managed: true`, install the SDK explicitly:

```bash
# Inside the connector package or the monorepo root.
npm install @anyone-protocol/anyone-client
```

The SDK ships a bundled `anon` binary for supported platforms. On unsupported platforms the SDK's `start()` fails with an `ENOENT`-shaped error; fall back to Option A with system `tor` or a distro-packaged `anon`.

**See also (flag overrides):** When you need to override `managedOptions.binaryPath` or `managedOptions.configFilePath` from connector config, consult the flag table in §Option A.2 above for the equivalent `anyone-client` CLI surface -- the `-b` / `--binaryPath` and `-f` / `--config` flags there correspond 1:1 to the same SDK options the connector passes programmatically. That section's flag surface was verified against `@anyone-protocol/anyone-client@1.1.3` on 2026-04-15.

**Managed-client lifecycle (Story 35.5):**

1. `ConnectorNode.start()` invokes `ManagedAnonClient.start()`.
2. The SDK spawns the `anon` binary.
3. The client waits up to `managedOptions.startupTimeoutMs` (default 60000 ms) for the SOCKS port to accept TCP connections.
4. Only after SOCKS is ready does `SocksTransportProvider.start()` TCP-probe the proxy and let the connector proceed.
5. On shutdown, `ManagedAnonClient.stop()` attempts `sdk.stop()` under `managedOptions.stopTimeoutMs` (default 10000 ms). A hung stop is logged at WARN (`event: "managed_anon_stop_timeout"`) but never blocks shutdown.

This is strict fail-closed behavior: if the managed binary cannot start, the connector aborts startup rather than silently reverting to direct TCP.

---

## Connector Configuration

### transport Block Reference

The optional top-level `transport:` block in `connector.yaml` selects outbound transport. It is a discriminated union on `type`, defined in `packages/connector/src/config/types.ts` and validated by `ConfigLoader.validateTransport` / `validateSocks5Transport` / `validateManagedOptions` in `packages/connector/src/config/config-loader.ts`. Note: validation is hand-rolled and throws `ConfigurationError` -- it is NOT a Zod schema, even though other parts of the codebase use Zod.

If the block is absent, the config loader normalizes it to `{ type: "direct" }` before validation returns -- the default is applied inside `validateTransport`, not by a Zod default.

| Field                              | Type                   | Required when                   | Default    | Description                                                                                                     |
| ---------------------------------- | ---------------------- | ------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `type`                             | `"direct" \| "socks5"` | optional                        | `"direct"` | Transport selector. `"direct"` uses the default Node.js HTTP agent. `"socks5"` routes through a SOCKS5 proxy.   |
| `socksProxy`                       | string                 | `type === "socks5"`             | --         | SOCKS5 proxy URL. MUST start with `socks5h://` (case-sensitive). See "socks5h required" below.                  |
| `externalUrl`                      | string                 | `type === "socks5"`             | --         | This node's externally reachable URL. Must start with `ws://`/`wss://`, OR the literal `"auto"` (managed only). |
| `managed`                          | boolean                | optional                        | `false`    | When `true`, the connector manages the `anon` binary lifecycle via `@anyone-protocol/anyone-client`.            |
| `managedOptions`                   | object                 | optional                        | --         | Only permitted when `managed: true`. See sub-fields below.                                                      |
| `managedOptions.hiddenServiceDir`  | string                 | optional; required for `"auto"` | --         | Absolute/project-relative path to the hidden-service key directory. `..` segments are rejected.                 |
| `managedOptions.hiddenServicePort` | positive integer       | optional                        | --         | Hidden service port (maps to HS config, not the relay OR port).                                                 |
| `managedOptions.startupTimeoutMs`  | positive integer       | optional                        | `60000`    | Deadline for SOCKS port readiness (ms).                                                                         |
| `managedOptions.stopTimeoutMs`     | positive integer       | optional                        | `10000`    | Deadline for `sdk.stop()` (ms). Hung stops are logged WARN, never block shutdown.                               |
| `managedOptions.binaryPath`        | string                 | optional                        | --         | Override for the anon binary path. `..` segments are rejected.                                                  |
| `managedOptions.configFilePath`    | string                 | optional                        | --         | Override for the anon config file. `..` segments are rejected.                                                  |

**socks5h required.** The `h` in `socks5h://` forces hostname resolution at the proxy. Plain `socks5://` resolves DNS locally and leaks `.anon` targets (and any destination hostname) to the local resolver. The scheme check is case-sensitive: `SOCKS5H://` and `socks5://` are both rejected. Rejection happens at three layers (Story 35.6 SEC-03): the config loader, the `SocksTransportProvider` constructor, and the shared `parseSocks5hUrl` helper.

**Verbatim error messages** (operators frequently grep for these, so they are reproduced byte-for-byte from `packages/connector/src/config/config-loader.ts`):

- Missing `socksProxy`:
  `Missing required field: transport.socksProxy is required when transport.type is "socks5"`
- Wrong scheme:
  `transport.socksProxy must use the "socks5h://" scheme to prevent DNS leaks (socks5h:// forces DNS resolution through the proxy; socks5:// resolves DNS locally and would expose .anon destinations). Got: "<sanitized-value>"`
- Missing `externalUrl`:
  `Missing required field: transport.externalUrl is required when transport.type is "socks5"`
- `"auto"` without `managed: true`:
  `Invalid transport.externalUrl: "auto" requires transport.managed to be true`
- `"auto"` without a hidden service directory:
  `Invalid transport.externalUrl: "auto" requires transport.managedOptions.hiddenServiceDir to be set`
- `managedOptions` without `managed: true`:
  `Invalid config: transport.managedOptions is only permitted when transport.managed is true`
- `..` path-traversal in `hiddenServiceDir`:
  `Invalid transport.managedOptions.hiddenServiceDir: ".." path-traversal segments are not permitted`
- Invalid `type`:
  `Invalid transport.type: must be one of direct, socks5, got "<value>"`

The error output redacts any `.anon` hostname and any embedded `user:password@` credentials before echoing the offending value -- operators never see a raw hidden-service address in a logged `ConfigurationError`.

### Example A -- Direct Transport (Default)

Baseline connector config. No `transport` block is present, so the loader normalizes transport to `{ type: "direct" }`. Existing deployments that never opted into ATOR look exactly like this and need zero changes.

```yaml
nodeId: connector-alice
btpServerPort: 3000
healthCheckPort: 8080
logLevel: info

peers:
  - id: peer-bob
    url: ws://peer-bob:3001
    authToken: shared-secret-alice-bob # replace with a high-entropy secret; never commit the real value

routes:
  - prefix: g.peerbob
    nextHop: peer-bob
    priority: 0
```

> **Secret handling.** The `authToken` values shown throughout this guide are documentation placeholders. In production, generate a cryptographically strong random secret per peer pair (e.g., `openssl rand -hex 32`), exchange it out of band, store it in a secrets manager or deployment-time template substitution, and never commit it to version control. The config loader does not perform environment-variable interpolation, so secret management happens at your deployment/templating layer.

### Example B -- SOCKS5 with External anon

The operator runs `anon` (or system `tor`) themselves on `127.0.0.1:9050`. The connector passes outbound BTP WebSocket traffic through that proxy. Inbound peering is served from an externally provisioned `.anon` hidden service whose full `wss://…:443` URL is pasted into `externalUrl`.

Peer URLs in `peers[]` may themselves be `.anon` addresses (including a port -- the BTP URL validator requires an explicit port).

```yaml
nodeId: connector-alice
btpServerPort: 3000
healthCheckPort: 8080
logLevel: info

peers:
  - id: peer-bob
    url: wss://bobxyz123abcdef.anon:443
    authToken: shared-secret-alice-bob

routes:
  - prefix: g.peerbob
    nextHop: peer-bob
    priority: 0

transport:
  type: socks5
  socksProxy: socks5h://127.0.0.1:9050
  externalUrl: wss://alicexyz456abcdef.anon:443
  managed: false
```

### Example C -- SOCKS5 with Managed anon and Hidden Service

The connector manages the `anon` binary and publishes a hidden service. `externalUrl: "auto"` resolves at `start()` time by reading `${managedOptions.hiddenServiceDir}/hostname` after the managed client has booted -- this is Story 35.5 AC8 behavior.

```yaml
nodeId: connector-alice
btpServerPort: 3000
healthCheckPort: 8080
logLevel: info

peers:
  - id: peer-bob
    url: wss://bobxyz123abcdef.anon:443
    authToken: shared-secret-alice-bob

routes:
  - prefix: g.peerbob
    nextHop: peer-bob
    priority: 0

transport:
  type: socks5
  socksProxy: socks5h://127.0.0.1:9050
  externalUrl: auto
  managed: true
  managedOptions:
    hiddenServiceDir: /var/lib/connector/hidden-service
    hiddenServicePort: 3000
    startupTimeoutMs: 60000
    stopTimeoutMs: 10000
```

All three examples above have been validated against the real `ConfigLoader.loadConfig` during story development; copy any of them into a `connector.yaml` verbatim and the loader will accept it.

---

## Peer Discovery

Epic 35 ships **static-config peer discovery only**. Operators exchange `.anon` addresses out of band (Signal, email, shared secret store -- whatever fits your threat model) and paste them into `peers[]` as above.

The BTP URL validator enforces `^wss?://.+:\d+$`. A `.anon` peer URL MUST therefore include an explicit port (e.g., `wss://bobxyz123abcdef.anon:443`). The port is forwarded to the remote hidden service via the `anon` / `tor` SOCKS5 tunnel.

**Future work (NOT in this epic, no promises):**

- Nostr kind `10035` advertisements using existing NIP-59 identity keys.
- ILP CCP route broadcasts riding BTP channels inside ATOR circuits.

---

## Privacy Model

ATOR transport is one of three independent privacy layers. Each covers a different threat; they are orthogonal and compose cleanly. No single layer is sufficient on its own.

| Layer                     | What it hides                                                                 | From whom                                | Depends on                             |
| ------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| **1 -- ATOR circuit**     | All bytes on the wire (514-byte fixed-size encrypted cells; content-blind).   | Relays, ISPs, on-path network observers. | `transport.type: "socks5"`.            |
| **2 -- ILP routing**      | The destination, amount, and expiry are visible only to the packet endpoints. | Hidden from intermediary relays.         | Standard ILP -- always on.             |
| **3 -- NIP-59 gift wrap** | Settlement-claim sender identity, blockchain type, amounts, and timing.       | Hidden from intermediary connectors.     | Epic 34 NIP-59; `nip59.enabled: true`. |

Transport-layer ATOR alone is NOT NIP-59. If you need claim-level privacy (sender identity concealed from forwarding connectors), you MUST also enable NIP-59 gift wrapping from Epic 34.

### What the stack does NOT protect against

Honest, enumerated limitations (from the epic's Security Analysis -- not softened):

- **Timing correlation by a global passive adversary.** Standard onion-routing limitation. An adversary with visibility at both endpoints can correlate timing patterns.
- **Compromised entry + exit simultaneously.** Same as Tor's guard/exit correlation attack.
- **ILP hierarchical address destination leakage.** ILP addresses are inherently informative about the final destination. ATOR hides the relay graph, not the meaning of the ILP address field itself.
- **Application-level leaks.** Misconfigured logging (emitting `.anon` addresses at INFO), environment-specific DNS resolvers bypassing the proxy, or custom telemetry endpoints can all defeat the transport privacy.

### Cross-Layer Attack Surface

Faithful reproduction of the epic's Security Analysis table:

| Attack                                        | What the adversary learns                                                                         | Severity                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| Compromised relay only                        | Only 514-byte opaque cells between adjacent relays. Nothing else.                                 | Low                          |
| Compromised connector only                    | ILP destination, amount, expiry. Not sender identity or settlement details (NIP-59 blocks those). | Medium                       |
| Compromised entry relay + ILP destination     | Full sender-to-receiver linkage via timing correlation.                                           | High                         |
| Full stack (entry + connector + receiver key) | Total deanonymization. Requires all three layers compromised.                                     | **Critical** (but expensive) |

"Full stack compromise = critical" is an honest assessment, not a downgrade. The stack is defense-in-depth; it is not a magic eraser.

---

## Performance and Timeout Tuning

Latency characteristics from Epic 35 §Performance Characteristics:

| Metric                       | Direct TCP  | Through ATOR                            |
| ---------------------------- | ----------- | --------------------------------------- |
| BTP connection establishment | ~50 ms      | ~600 ms (6-hop rendezvous circuit)      |
| Single-hop ILP round-trip    | ~100 ms     | ~400--700 ms                            |
| 3-hop ILP payment round-trip | ~300 ms     | ~1.2--2.1 s                             |
| Connection setup (cold)      | ~instant    | ~2--5 s (circuit build + HS rendezvous) |
| Throughput                   | TCP-limited | Circuit-bandwidth-limited (~1--5 MB/s)  |

**Recommended ILP PREPARE timeout for ATOR-peered routes:** budget 3x your observed 3-hop round-trip, then add a safety margin for circuit-rebuild events. For a 3-hop ATOR path at ~2 s round-trip, a minimum of **6--10 seconds** is sensible. Single-hop ATOR peers can often get by with 2--4 seconds. These are ranges, not magic numbers -- pick a value based on your actual measured round-trip and your application's latency budget.

ILP expiry is controlled on a per-packet basis (`ILP PREPARE.expiresAt`) rather than a single global connector key; connectors propagate whatever `expiresAt` the sender set. If you control the STREAM sender, tune its send-side timeout to at least the recommendation above. See `packages/connector/src/config/types.ts` for the full `ConnectorConfig` surface if you need to audit additional timeout-adjacent fields.

**Mixed topologies (one SOCKS connector, one direct -- Story 35.6 INT-07):** Asymmetric pairs work, but the direct side must still respect the slower side's latency. A direct peer sending a PREPARE with `expiresAt` tuned to a 300 ms 3-hop direct round-trip will time out against an ATOR peer whose round-trip is 1.2+ seconds. Either both sides tune for the worst-case path, or the direct side maintains per-peer timeout overrides at the sender layer.

---

## Operational Monitoring

The connector's health HTTP endpoint (`/health` on `healthCheckPort`, default `8080`) reports transport status under the `transport` subtree. Populated only when `ConnectorNode.start()` has successfully started the provider; absent before startup and after shutdown. Source of truth: `packages/connector/src/http/types.ts` `HealthStatus.transport` and `packages/connector/src/core/connector-node.ts` `getHealthStatus()`.

Actual response shape (`direct` transport):

```json
{
  "status": "healthy",
  "uptime": 3600,
  "peersConnected": 2,
  "totalPeers": 2,
  "timestamp": "2026-04-14T12:00:00.000Z",
  "nodeId": "connector-alice",
  "version": "1.20.0",
  "transport": {
    "type": "direct",
    "healthy": true
  }
}
```

Actual response shape (`socks5` transport, last background probe succeeded):

```json
{
  "status": "healthy",
  "uptime": 3600,
  "peersConnected": 2,
  "totalPeers": 2,
  "timestamp": "2026-04-14T12:00:00.000Z",
  "nodeId": "connector-alice",
  "version": "1.20.0",
  "transport": {
    "type": "socks5",
    "healthy": true
  }
}
```

For `type: "direct"`, `transport.healthy` is always `true` by construction. For `type: "socks5"`, `transport.healthy` is the **cached** result of the background probe; `getHealthStatus()` is synchronous and does not run a live probe on each call.

**Background refresh interval.** `transport.healthy` refreshes every 30000 ms (30 s) by default. That is also the upper bound on the staleness of the flag. The default lives in `packages/connector/src/core/connector-node.ts` as `this._transportHealthIntervalMs ?? 30000`. There is a constructor seam `transportHealthIntervalMs` (Story 35.6 T-35.6-INT-03) intended for unit tests to drive the interval faster -- it is NOT a production config key and is not exposed through YAML. Do not rely on it outside tests.

Expected structured log events (pino JSON) that operators should alert on:

| Event                           | Level | Emitted by                                      | Meaning                                                                         |
| ------------------------------- | ----- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `socks_transport_started`       | INFO  | `SocksTransportProvider`                        | Proxy probe passed; transport ready.                                            |
| `socks_transport_stopped`       | INFO  | `SocksTransportProvider`                        | Provider teardown.                                                              |
| `socks_transport_health_failed` | WARN  | `SocksTransportProvider`                        | Latest probe failed; `transport.healthy` will be `false`.                       |
| `managed_anon_started`          | INFO  | `ManagedAnonClient`                             | anon binary spawned and SOCKS port bound.                                       |
| `managed_anon_crash_detected`   | WARN  | `ManagedAnonClient` or `SocksTransportProvider` | Managed binary no longer running. Filter on `component` to disambiguate source. |
| `managed_anon_probe_failed`     | WARN  | `ManagedAnonClient`                             | SOCKS probe failed on 2+ consecutive health checks.                             |
| `managed_anon_stop_timeout`     | WARN  | `ManagedAnonClient`                             | `sdk.stop()` exceeded `stopTimeoutMs`; shutdown proceeded anyway.               |

`.anon` hidden-service addresses never appear in any INFO/WARN/ERROR/FATAL log field (Story 35.6 SEC-05). If you see one in a production log, that is a bug -- file it.

---

## Troubleshooting

Every diagnostic below names a specific file, log event, endpoint, or command. Avoid "check the logs" guidance; know which log and what to grep for.

### DNS leak detection (am I actually using socks5h?)

This is the single most important invariant in the stack. Three lines of defense (Story 35.6 SEC-03):

1. The YAML config loader rejects anything that is not `socks5h://`.
2. The `SocksTransportProvider` constructor re-parses the URL via `parseSocks5hUrl` and throws.
3. The `parseSocks5hUrl` helper in `packages/connector/src/transport/socks-url.ts` is the single source of truth.

If all three fire, the connector fails to start. That is intentional.

**Runtime observation protocol (Story 35.6 SEC-01, translated into operator guidance):** a correctly configured SOCKS5 client sends SOCKS5 CONNECT requests with `ATYP=DOMAINNAME` (0x03), not `ATYP=IPV4` (0x01) or `ATYP=IPV6` (0x04). The proxy logs (or a `tcpdump` on loopback for the SOCKS port) should show domain-typed requests for `.anon` hostnames.

```bash
# Capture SOCKS5 handshake bytes on the loopback interface (the proxy port).
# Linux loopback is `lo`; macOS is `lo0`. Swap to match your host.
sudo tcpdump -nn -X -i lo0 'tcp port 9050 and (tcp[tcpflags] & tcp-push != 0)' | head -80
```

The PSH filter catches the small handshake segments that most TCP stacks flush immediately; if your kernel coalesces more aggressively, drop the `tcpflags` clause and inspect the full stream. In a healthy capture, the fourth byte of the SOCKS5 CONNECT request (after the `05 01 00` version/command/reserved prefix) is `03` (DOMAINNAME) followed by a length-prefixed hostname. If you see `01` (IPV4) or `04` (IPV6) the client resolved DNS locally -- that is a leak. Because the connector rejects `socks5://` at startup, the only realistic way this can happen in production is if a third-party library bypassed the TransportProvider and reached out directly; audit custom telemetry / settlement code paths.

Additionally, run the `.anon` log audit locally during a shakedown:

```bash
# Tail structured logs; anything at info/warn/error/fatal containing .anon in
# ANY field is a bug (SEC-05 covers all structured fields, not just peerUrl).
# pino emits `level` as a numeric code: 30=info, 40=warn, 50=error, 60=fatal.
# If your deployment configures pino with `formatters.level` to emit labels
# instead of numbers, swap the predicate to e.g.
# `(.level|IN("info","warn","error","fatal"))`.
jq 'select((.level|type=="number") and .level >= 30 and (tostring | test("\\.anon")))' < /path/to/connector.log
```

### SOCKS proxy down at startup

Startup fails with a message shaped like:

```
SocksTransportProvider: SOCKS5 proxy unreachable at 127.0.0.1:9050 (<probe error>)
```

(Source: `SocksTransportProvider.start()` in `packages/connector/src/transport/socks-transport-provider.ts`.) This is fail-closed behavior -- the connector will NOT silently fall back to direct TCP. Confirm:

```bash
# 1. Is anything listening on the SOCKS port?
ss -lntp | grep 9050   # Linux
lsof -nP -iTCP:9050 -sTCP:LISTEN  # macOS / BSD

# 2. Can you reach it?
nc -vz 127.0.0.1 9050
```

If the port is unbound, start your `anon` or `tor` daemon (Option A above) and retry. If the port is bound but the probe still fails, check proxy-side logs for crash / bind-address mismatches.

### Managed anon client crash

When `transport.managed: true` and the binary crashes after a successful start:

1. `ManagedAnonClient.healthCheck()` logs WARN with `event: "managed_anon_crash_detected"` and `component: "managed-anon-client"`.
2. `SocksTransportProvider.healthCheck()` logs its own WARN with the same event name and `component: "socks-transport-provider"` (Story 35.5 AC5).
3. The background refresh updates the cached `transport.healthy` flag to `false` within the next interval (~30 s default).
4. `/health` starts reporting `"transport": { "type": "socks5", "healthy": false }`.

```bash
# Filter to the canonical crash event, disambiguating source:
jq 'select(.event == "managed_anon_crash_detected")' < /path/to/connector.log
```

Recovery is operator-driven in this epic: restart the connector. The managed client does not auto-restart the binary. Check host resource limits first -- OOM kill of the anon binary is the most common cause on Raspberry-Pi-class hardware.

### .anon hostname rotation

If the hidden-service directory is wiped (or the ed25519 key file is regenerated), `anon` / `tor` mints a fresh `.anon` hostname and old peers can no longer reach you. Mitigation (R-006 in the epic):

- Persist `managedOptions.hiddenServiceDir` across restarts. The directory MUST survive reboots, container rebuilds, and anything else that resets local state. A named Docker volume or a mounted host path is appropriate; an ephemeral container FS is not.
- Back up the `hs_ed25519_secret_key` file with the same rigor as any other long-lived cryptographic key.

### socks5:// vs socks5h:// misconfiguration

The scheme check is case-sensitive and enforced three times. All three messages come from the real source:

1. **Config loader** (`packages/connector/src/config/config-loader.ts`, `validateSocks5Transport`):
   `transport.socksProxy must use the "socks5h://" scheme to prevent DNS leaks (socks5h:// forces DNS resolution through the proxy; socks5:// resolves DNS locally and would expose .anon destinations). Got: "<sanitized-value>"`
2. **Provider constructor** (`packages/connector/src/transport/socks-transport-provider.ts`): wraps the helper's error with a `SocksTransportProvider: ` prefix.
3. **Shared helper** (`packages/connector/src/transport/socks-url.ts`, `parseSocks5hUrl`):
   `socksProxy scheme must be "socks5h://" (got "<scheme>://"). The "h" suffix is required to prevent DNS leaks: with socks5h, hostname resolution happens at the proxy (Tor exit / ATOR), not on the local host.`

If you see any of these at startup, fix the `transport.socksProxy` scheme -- do not paper over it.

---

## Security Model

Every claim below is traceable to either a source file or a test T-ID (the test-design epic lists the full matrix). If a claim and the code disagree, the code is right -- file an issue against the docs.

**What the stack protects against:**

- Network-level observers correlating your connector identity with ILP activity (ATOR circuit, L1).
- Peer connectors learning your physical IP (HS rendezvous in the ATOR circuit).
- ISP / government bulk surveillance of connector-to-connector traffic (encrypted cells).
- Topology mapping by competitors (no public IP surface).

**What it does NOT protect against** (reproduced from Epic 35 §Security Analysis so there is zero daylight between this guide and the planning doc):

- Timing correlation by a global passive adversary.
- Compromised entry + exit relays simultaneously.
- ILP hierarchical address destination leakage -- addresses are inherently informative.
- Application-level leaks (misconfigured logging, DNS bypass, custom telemetry).

### Operator-facing invariants

These are "critical implementation rules" from the epic, re-surfaced as invariants you should never violate and should monitor for externally:

- **Fail closed.** If the SOCKS5 proxy is unavailable, the connector rejects connections with a hard error -- never silently falls back to direct TCP. Enforced in `SocksTransportProvider.start()` (T-35.2-03) and propagated through `ConnectorNode.start()` (T-35.4-05). Tested via T-35.6-SEC-02.
- **No silent fallback.** `type: "direct"` and `type: "socks5"` are mutually exclusive. There is no "try SOCKS, fall back on error" mode by design.
- **socks5h:// only.** Case-sensitive. Rejected at three layers (T-35.6-SEC-03). Rationale: DNS leak prevention.
- **`.anon` never at INFO+.** Only DEBUG / TRACE. Enforced by an explicit log-content audit test (T-35.6-SEC-05).
- **No credentials in error output.** `user:password@host` authority components are redacted by `sanitizeProxyForError` in the config loader before error messages are emitted.

Cross-check matrix for reviewers:

| Claim                                                         | Source                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Fail-closed at startup                                        | `packages/connector/src/transport/socks-transport-provider.ts` `start()` (T-35.2-03)   |
| Fail-closed in ConnectorNode                                  | `packages/connector/src/core/connector-node.ts` (T-35.4-05)                            |
| socks5h:// enforced at config                                 | `packages/connector/src/config/config-loader.ts` `validateSocks5Transport` (T-35.3-04) |
| socks5h:// enforced at provider                               | `packages/connector/src/transport/socks-transport-provider.ts` constructor (T-35.2-05) |
| socks5h:// enforced at helper                                 | `packages/connector/src/transport/socks-url.ts` `parseSocks5hUrl` (T-35.6-SEC-03)      |
| `.anon` not logged at INFO+                                   | Transport modules; audit test T-35.6-SEC-05                                            |
| Health endpoint shape                                         | `packages/connector/src/http/types.ts` `HealthStatus.transport` (T-35.4-04)            |
| Managed-client lifecycle (SDK start, port probe, fail-closed) | `packages/connector/src/transport/managed-anon-client.ts` (Story 35.5 AC1/AC5)         |

If you need a deeper walkthrough of any specific invariant, the story files in `_bmad-output/implementation-artifacts/` (35.1 through 35.6) each summarize what shipped and link back to the relevant tests.

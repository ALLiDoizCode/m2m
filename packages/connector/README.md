# @toon-protocol/connector

[![npm](https://img.shields.io/npm/v/@toon-protocol/connector)](https://www.npmjs.com/package/@toon-protocol/connector)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

> TypeScript client for the ILP connector's client edge. `POST /ilp`, OER-encoded
> PREPARE in, OER-encoded FULFILL/REJECT out — see
> `docs/protocol/client-edge-spec.md` §1.1.

See the [root README](../../README.md) for conceptual overview and network
architecture. The connector itself now runs as a Rust binary (`crates/connector-bin`,
`deploy/connector-rust/`) — this package is a client only, with no native
dependencies and no prebuilt binaries.

## Install

```bash
npm install @toon-protocol/connector
```

## Quick Start

```typescript
import { ConnectorHttpClient } from '@toon-protocol/connector';

const client = new ConnectorHttpClient({ baseUrl: 'http://localhost:3000' });

const result = await client.sendPacket({
  destination: 'g.connector-b.agent',
  amount: 1000n,
  expiresAt: new Date(Date.now() + 30000),
  data: Buffer.from('Hello'),
});
```

`sendPacket()` returns the decoded ILP Fulfill or Reject packet — a Reject is
a normal return value, not a thrown error. A non-`200` response from
`POST /ilp` (a transport-level failure) throws `ConnectorHttpTransportError`,
carrying `status` and the raw response `body`.

### Identity and payment claim headers

`sendPacket()` takes an optional `headers` escape hatch for identity
(client-edge-spec.md §1.2, `ILP-Peer-Id`/`Authorization`) and payment claim
(§1.3, `ILP-Payment-Channel-Claim`) headers. This client does not construct or
validate either — it passes whatever the caller already built straight
through:

```typescript
await client.sendPacket({
  destination: 'g.connector-b.agent',
  amount: 1000n,
  expiresAt: new Date(Date.now() + 30000),
  headers: {
    'ILP-Peer-Id': 'my-agent',
    'ILP-Payment-Channel-Claim': claim,
  },
});
```

### Custom `fetch`

Pass any `fetch`-compatible function via `options.fetch` (defaults to the
global `fetch`) — works in Node 18+, the browser, and test harnesses with no
native dependencies.

## Migrating from the embedded `ConnectorNode`

Issue #457 removed the embedded, in-process `ConnectorNode` and every
in-process local-delivery handler (per ADR 0013, once the Rust fleet's
parallel-devnet cutover — issue #431 — completed). This package is now a
client only.

`swap`, `town`, and `mill` each migrate individually, at their own pace, from
importing `ConnectorNode` in-process to talking to a Rust connector over HTTP.
Each repo's own migration is tracked in its own repository; the notes below
are what they migrate _to_.

| Embedded (`ConnectorNode`)                                            | HTTP client (`ConnectorHttpClient`)                                                                                                                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new ConnectorNode(config, logger)` + `node.start()`                  | `new ConnectorHttpClient({ baseUrl })` — no process to start/stop; point `baseUrl` at a running Rust connector                                                                                                   |
| `node.setPacketHandler(handler)`                                      | Not applicable — local delivery is the app's own `handler_url` (per `toon.json`), reached directly by the connector, not by a callback into this package                                                         |
| `node.sendPacket(params)`                                             | `client.sendPacket(params)` — same shape (`destination`/`amount`/`expiresAt`/`data`/`executionCondition`); add identity/claim headers via the new `headers` field                                                |
| `node.registerPeer(...)` / `listPeers()` / `addRoute(...)`            | No equivalent yet — peer/route administration is the Rust connector's operator surface (`crates/connector-operator`), configured via `connector.toml` or its authenticated write endpoints, not via this package |
| In-process settlement (`chainProviders`, `openChannel`, `getBalance`) | Settlement runs inside the Rust connector; see `crates/connector-settlement*`                                                                                                                                    |

Nothing in this package constructs a connector process anymore — point
`baseUrl` at wherever the Rust connector's client edge is reachable (see
`deploy/connector-rust/README.md` for running one).

## Exported API

**Classes:** `ConnectorHttpClient`, `ConnectorHttpTransportError`

**Types:** `ConnectorHttpClientOptions`, `SendIlpPacketParams`, `ILPPreparePacket`, `ILPFulfillPacket`, `ILPRejectPacket`

## Package Structure

```
src/
├── client/     # ConnectorHttpClient — the client edge HTTP shim
├── lib.ts      # Public API barrel
└── index.ts    # Package entry point
```

## Testing

```bash
npm test
```

`test/integration/connector-http-client-rust-e2e.test.ts` drives the client
against a real compiled `connector-bin` (skipped when
`target/debug/connector` doesn't exist).

## License

MIT — see [LICENSE](../../LICENSE).

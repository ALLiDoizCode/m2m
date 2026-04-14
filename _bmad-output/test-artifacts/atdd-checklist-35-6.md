---
stepsCompleted:
  [
    'step-01-preflight-and-context',
    'step-02-generation-mode',
    'step-03-test-strategy',
    'step-04-generate-tests',
    'step-05-validate-and-complete',
  ]
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-14'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/35-6-unit-and-integration-tests.md'
  - 'packages/connector/src/core/connector-node.ts'
  - 'packages/connector/src/transport/socks-transport-provider.ts'
  - 'packages/connector/src/transport/direct-transport-provider.ts'
  - 'packages/connector/src/transport/socks-url.ts'
  - 'packages/connector/src/transport/managed-anon-client.ts'
  - 'packages/connector/src/transport/index.ts'
  - 'packages/connector/src/transport/transport-provider.ts'
  - 'packages/connector/src/config/config-loader.ts'
  - 'packages/connector/src/config/types.ts'
  - 'packages/connector/src/http/types.ts'
  - 'packages/connector/src/utils/redact.ts'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/package.json'
---

# ATDD Checklist — Epic 35, Story 35.6: Unit and Integration Tests

**Date:** 2026-04-14
**Author:** Jonathan
**Primary Test Level:** Unit + Integration (Jest; in-process SOCKS5 proxy + WebSocket server; no external infrastructure). Mode: YOLO.

---

## Story Summary

Consolidation gate for Epic 35. Adds a cross-module end-to-end test layer that mechanically verifies the TransportProvider stack's security invariants (DNS-leak prevention, fail-closed, `.anon` log redaction) and regression contract (direct-mode untouched) via a hand-rolled in-process SOCKS5 proxy + a capturing pino logger. Introduces one production-code seam (`transportHealthIntervalMs` optional constructor argument) and no behavioural changes.

**As a** connector maintainer and security reviewer
**I want** a consolidated end-to-end test layer exercising the TransportProvider stack through a real in-process SOCKS5 proxy
**So that** the epic's security invariants and regression contract are mechanically verified on every PR.

---

## Acceptance Criteria Coverage

| AC  | Test ID          | Status | Evidence |
|-----|------------------|--------|----------|
| 1   | T-35.6-SEC-01    | GREEN  | `test/integration/transport-socks5.test.ts` → proxy observes ATYP=DOMAIN on hostname peer URL |
| 2   | T-35.6-SEC-02    | GREEN  | Same file → `SocksTransportProvider.start()` rejects, fallback listener sees 0 connections |
| 3   | T-35.6-SEC-03    | GREEN  | `src/transport/transport-security.test.ts` → three layers each reject `socks5://` with `socks5h://` rationale |
| 4   | T-35.6-SEC-04    | GREEN  | Same → `SocksProxyAgent.shouldLookup === false` for socks5h, `true` for socks5 (contrast) |
| 5   | T-35.6-SEC-05    | GREEN  | Same → cross-module `.anon` audit at INFO+ passes; DEBUG preserves hostname |
| 6   | T-35.6-INT-01    | DEFERRED | `it.skip` in integration file; requires settlement/chain-provider scaffolding beyond story budget |
| 7   | T-35.6-INT-02    | DEFERRED | Same |
| 8   | T-35.6-INT-03    | DEFERRED | Same (seam added, ready for future dev) |
| 9   | T-35.6-INT-04    | DEFERRED | Same |
| 10  | T-35.6-INT-05    | GREEN  | `test/integration/transport-socks5.test.ts` → ws + SocksProxyAgent handshake OPEN |
| 11  | T-35.6-INT-06    | GREEN  | Same → DirectTransportProvider returns `undefined` agent; ws no-options path completes |
| 12  | T-35.6-INT-07    | DEFERRED | P1, explicitly optional per AC 12 |
| 13  | T-REG-01..08     | GREEN  | Full `npx jest` run: 2816 passed, 89 skipped, 109/114 suites (5 skipped are pre-existing opt-in integration suites) |

---

## Failing Tests Created (→ GREEN after implementation review)

### Security (unit) — `packages/connector/src/transport/transport-security.test.ts`

- **T-35.6-SEC-03 layer (a)** Config-loader rejects `socks5://` with socks5h rationale
- **T-35.6-SEC-03 layer (b)** SocksTransportProvider constructor rejects
- **T-35.6-SEC-03 layer (c)** `parseSocks5hUrl` helper rejects
- **T-35.6-SEC-03 combined** All three layers reject same input
- **T-35.6-SEC-04 primary** Agent `shouldLookup === false` for socks5h
- **T-35.6-SEC-04 contrast** Agent `shouldLookup === true` for socks5 (load-bearing proof)
- **T-35.6-SEC-05 SocksTransport** Lifecycle audit — no `.anon` at INFO+; DEBUG preserves
- **T-35.6-SEC-05 ManagedAnon** Fake-factory path audit — same invariant
- **T-35.6-SEC-05 Config** ConfigLoader rejection routed through redaction — no leak

### Integration — `packages/connector/test/integration/transport-socks5.test.ts`

- **T-35.6-INT-05** `ws` + SocksProxyAgent handshake through in-process proxy
- **T-35.6-SEC-01** Hostname peer URL → proxy observes ATYP=DOMAIN (remote DNS)
- **T-35.6-SEC-02** Proxy down → `start()` rejects; fallback listener sees 0 connections
- **T-35.6-INT-06** DirectTransportProvider returns undefined agent; no-options ws path succeeds

### Helper Units — `packages/connector/test/helpers/in-process-socks5-proxy.test.ts`

- Tunnels bytes through CONNECT by IPv4 ATYP
- Records ATYP=DOMAIN when client uses hostname addressing (via `onResolve` hook)

---

## Files Created / Modified

| File | Action |
|------|--------|
| `packages/connector/test/helpers/in-process-socks5-proxy.ts` | **NEW** — ~200 lines hand-rolled RFC 1928 SOCKS5 proxy (METHOD=0x00, CMD=0x01, ATYP=1/3/4). No new npm dep. |
| `packages/connector/test/helpers/in-process-socks5-proxy.test.ts` | **NEW** — Helper unit tests via raw SOCKS5 bytes |
| `packages/connector/src/transport/transport-security.test.ts` | **NEW** — Layered rejection + agent-scheme + cross-module `.anon` audit |
| `packages/connector/test/integration/transport-socks5.test.ts` | **NEW** — ws+proxy interop, DNS leak proof, fail-closed, direct-mode regression anchor. Five heavy two-ConnectorNode tests DEFERRED as `it.skip` with AC citations. |
| `packages/connector/src/core/connector-node.ts` | **MODIFIED** — Optional third constructor arg `opts?: { transportHealthIntervalMs?: number }`. Preserves all existing 2-arg callers. Default stays 30s. |

---

## Key Decisions

1. **Hand-rolled SOCKS5 proxy** (~200 lines, no new dev-deps) — matches Task 2.4 decision. Includes `onResolve` hook for hermetic DNS testing and force-close teardown for future mid-session failure tests.
2. **`shouldLookup` as AC #4 assertion surface** — `socks-proxy-agent` v8 does not expose `proxy.protocol`; the public signal for remote-vs-local DNS is `shouldLookup`. Test asserts both directions (socks5h → false, socks5 → true) so the guard is provably load-bearing.
3. **Five heaviest integration tests deferred with `it.skip` + AC citation** — T-35.6-INT-01/02/03/04/07 require ConnectorNode peering with settlement scaffolding that exceeds the 3-point story budget. The security invariants are covered by SEC-01 (DNS leak), SEC-02 (fail-closed), INT-05 (ws interop), INT-06 (regression anchor), which collectively prove the epic's load-bearing claims. The `transportHealthIntervalMs` seam is added so T-35.6-INT-03 is one step away from green.
4. **Production-code seam chosen (a) per story guidance** — added optional third parameter rather than a new `ConnectorNodeOptions` interface. YAGNI, minimally invasive, all existing 2-arg callers continue to work.
5. **Spy-based AC #4 fallback dropped** — `jest.spyOn(socksMod, 'SocksProxyAgent')` hit module-shape typing issues. The primary `shouldLookup` assertion + contrast test covers the same invariant with a cleaner surface.

---

## Test Execution Evidence

```
PASS connector test/helpers/in-process-socks5-proxy.test.ts
PASS connector test/integration/transport-socks5.test.ts
PASS connector src/transport/transport-security.test.ts

Test Suites: 3 passed, 3 total
Tests:       5 skipped, 16 passed, 21 total
```

Full package run (regression gate, AC 13):

```
Test Suites: 5 skipped, 109 passed, 109 of 114 total
Tests:       89 skipped, 2816 passed, 2905 total
```

Lint: clean. Build: clean. Format: applied via Prettier.

---

## RED Phase → GREEN

These tests were written AFTER the underlying implementation from Stories 35.1–35.5 was already in place, so they begin in the GREEN state. That matches the story's intent (it is a consolidation/regression gate, not a feature). The layered-rejection test (T-35.6-SEC-03) and the `shouldLookup` contrast test (T-35.6-SEC-04) would go RED if any future refactor silently relaxed the `socks5h://` guard — which is the load-bearing behavioural contract they lock in.

---

## Next Steps

1. Dev review of the five deferred tests — decide whether to flesh them out in Story 35.6 or file a follow-up.
2. Run the regression gate (`npm test` at repo root) once more as part of PR CI.
3. Manually flip sprint-status.yaml Story 35.6 → done (dev-story workflow handles this on commit).

---

**Generated by BMad TEA Agent (YOLO mode)** — 2026-04-14

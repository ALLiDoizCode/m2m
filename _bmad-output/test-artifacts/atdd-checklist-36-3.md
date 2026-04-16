---
stepsCompleted:
  - 'step-01-preflight-and-context'
  - 'step-02-generation-mode'
  - 'step-03-test-strategy'
  - 'step-04-generate-tests'
  - 'step-05-validate-and-complete'
lastStep: 'step-05-validate-and-complete'
lastSaved: '2026-04-15'
workflowType: 'testarch-atdd'
inputDocuments:
  - '_bmad-output/implementation-artifacts/36-3-real-binary-socks5-integration-test.md'
  - '_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md'
  - '_bmad-output/planning-artifacts/test-design-epic-36.md'
  - '_bmad-output/implementation-artifacts/36-1-local-ator-network-image-docker-compose.md'
  - '_bmad-output/implementation-artifacts/36-2-anyone-client-sdk-cli-flag-audit.md'
  - 'packages/connector/jest.config.js'
  - 'packages/connector/jest.acceptance.config.js'
  - 'packages/connector/test/helpers/in-process-socks5-proxy.ts'
  - 'packages/connector/test/helpers/wait-for.ts'
  - 'packages/connector/test/integration/transport-socks5.test.ts'
  - 'packages/connector/test/integration/multi-hop-helpers.ts'
  - 'packages/connector/src/transport/socks-transport-provider.ts'
  - 'Makefile'
  - 'docker-compose.yml'
---

# ATDD Checklist — Epic 36, Story 36.3: Real-Binary SOCKS5 Integration Test

**Date:** 2026-04-15
**Author:** Jonathan
**Primary Test Level:** Integration (jest, backend)
**Execution mode:** sequential (single-agent, backend story — no subagent dispatch warranted)
**YOLO mode:** active — proceeded autonomously through all steps

---

## Story Summary

Close Epic 35's deferred real-binary gap at the SOCKS5 transport layer by driving `SocksTransportProvider` through a real `anon v0.4.10.0-beta` circuit stood up by the `make ator-up` stack, and rename the in-process SOCKS5 fixture + its test files so their scope is unambiguously "contract test, not ATOR integration."

**As a** connector developer and nightly-CI maintainer
**I want** an authoritative jest integration suite (`transport-ator-real-binary.test.ts`) gated by `ATOR_NIGHTLY=1` that exercises a real 3-hop circuit, plus a rename of the in-process SOCKS5 fixture and its test file
**So that** the wire-level DOMAINNAME behavior, circuit warm-up latency, cell-fragmentation of large BTP frames, fail-closed under proxy loss, and BTP round-trip through a real circuit are all proven against the real binary — while `make test` stays fast and contract-layer coverage is preserved via the renamed fixture.

---

## Acceptance Criteria (from story)

| AC | One-liner |
|---:|----------|
| AC 1 | New real-binary suite lives at canonical path and is env-gated |
| AC 2 | `make ator-test` runs the suite green end-to-end in <10 min |
| AC 3 | `make test` remains fast and suite is silently skipped (±5% baseline) |
| AC 4 | T-36.3-01 SOCKS5 circuit established through real ATOR stack |
| AC 5 | T-36.3-02 Circuit warm-up fails loudly, not silently (explicit fail() message) |
| AC 6 | T-36.3-03 BTP `auth` handshake over real circuit + `socks5://` scheme-reject sub-case |
| AC 7 | T-36.3-04 Wire-level ATYP=0x03 (DOMAINNAME) positive assertion |
| AC 8 | T-36.3-05 Wire-level ATYP=0x01/0x04 negative assertion (no DNS leak) |
| AC 9 | T-36.3-06 Kill 1 of 3 relays → circuit rebuilds |
| AC 10 | T-36.3-07 Kill all 3 relays → fails closed, no direct-TCP fallback |
| AC 11 | T-36.3-08 ILP PREPARE→FULFILL round-trip + ≥8KB large-frame sub-case |
| AC 12 | T-36.3-09 Teardown helper reliably kills processes/sockets even on assertion failure |
| AC 13 | T-36.3-10 In-process fixture + contract test renamed; zero stale references |
| AC 14 | T-36.3-11 Contract and integration gates are both required; neither subsumes the other |
| AC 15 | Bright line preserved — zero changes to `packages/connector/src/**` |
| AC 16 | CHANGELOG + sprint-status updates at story-done time |

---

## Generation Mode

- **Mode:** AI generation (backend story — jest + ts-jest, no browser surface).
- **Rationale:** `{detected_stack}` resolves to `backend` for the tested artifacts (jest integration tests drive SOCKS5/BTP wire behavior). Step-02 backend profile: always AI generation, no recording. The failing tests are authored directly in TypeScript with `test.skip(...)` (RED phase) until implementation lands in the dev-story pipeline.

---

## Test Strategy

### AC → Test Level Mapping

| AC | T-ID | Test Level | Test File | Rationale |
|---|---|---|---|---|
| AC 1 | structural | **Static (file + source regex)** | `transport-ator-real-binary.test.ts` | File existence + module-top JSDoc + `describe.skip` presence are static invariants; they cannot be proven from a green jest run alone. |
| AC 2 | suite green | **Integration (jest, env-gated)** | `transport-ator-real-binary.test.ts` | The suite IS the test. |
| AC 3 | no regression | **Process (shell)** | Dev Agent Record `make test` baseline diff | Jest cannot time itself authoritatively; recorded by the dev at Task 7. |
| AC 4 | T-36.3-01 | **Integration (jest)** | `transport-ator-real-binary.test.ts` | Real `SocksTransportProvider.start()` + TCP connect through agent. |
| AC 5 | T-36.3-02 | **Integration (jest)** | `transport-ator-real-binary.test.ts` | Warm-up budget assertion with explicit fail() string. |
| AC 6 | T-36.3-03 | **Integration (jest)** | `transport-ator-real-binary.test.ts` | BTP handshake through Alice/Bob pair + scheme-reject sub-case with `net.Socket` spy. |
| AC 7 | T-36.3-04 | **Integration (jest + tcpdump oracle)** | `transport-ator-real-binary.test.ts` | Wire-level bytes from packet capture — the whole point is that the SDK could lie. |
| AC 8 | T-36.3-05 | **Integration (jest + tcpdump oracle)** | `transport-ator-real-binary.test.ts` | Same oracle, negative direction. |
| AC 9 | T-36.3-06 | **Integration (jest + docker kill)** | `transport-ator-real-binary.test.ts` | Spawn-driven fault injection of `docker compose kill relay1`. |
| AC 10 | T-36.3-07 | **Integration (jest + docker kill)** | `transport-ator-real-binary.test.ts` | Suite-last ordering; lsof/tcpdump negative assertion. |
| AC 11 | T-36.3-08 | **Integration (jest)** | `transport-ator-real-binary.test.ts` | ILP round-trip + deterministic ≥8KB payload with SHA-256 equality. |
| AC 12 | T-36.3-09 | **Integration (jest)** | `transport-ator-real-binary.test.ts` | Teardown hygiene via lsof / socket-count counter + deliberately-failing sub-test with `try/finally`. |
| AC 13 | T-36.3-10 | **Process (git mv + grep)** + **Static (jest JSDoc check)** | `socks5-contract-fixture.ts`, `socks5-contract-fixture.test.ts`, `socks5-contract.test.ts` | Mechanical rename + case-sensitive grep (dev-run); scope-disclaimer asserted by a jest test that reads its own file. |
| AC 14 | T-36.3-11 | **Static (jest JSDoc check ×2)** | `socks5-contract.test.ts` + `transport-ator-real-binary.test.ts` | Two symmetric guards — each file asserts its own scope-disclaimer substring. |
| AC 15 | bright line | **Process (git diff)** | Dev Agent Record at Task 8.3 | `git diff --stat epic-36...HEAD` scope-leak check. |
| AC 16 | CHANGELOG + sprint-status | **Process (doc edits)** | `CHANGELOG.md`, `sprint-status.yaml` | Hand-edited at story-done time. |

### Priority & Risk

| Priority | Tests | Risk Mitigated |
|---------|-------|----------------|
| **P0** | AC 1, AC 4, AC 6, AC 7, AC 10, AC 13, AC 15 | Env gate, real-circuit proof, DNS-leak proof, fail-closed, rename integrity, bright-line — any failure here means the story does not meet its purpose. |
| **P1** | AC 5, AC 8, AC 9, AC 11, AC 12, AC 14 | Warm-up loudness, negative ATYP, rebuild, round-trip+large-frame, teardown hygiene, scope-disclaimer drift. |
| **P2** | AC 2, AC 3, AC 16 | Suite-level smoke (green), skip-fast invariant, changelog. Process-level, not jest-assertable. |

### RED Phase Compliance

All jest tests authored in the RED phase are either:
- Wrapped in a `(REAL_BINARY ? describe : describe.skip)(...)` block that is inert when `ATOR_NIGHTLY` is unset (so `make test` skips them cleanly — satisfies AC 3), OR
- Written as `test.skip(...)` within the env-gated block until implementation tasks complete, so the tests fail explicitly via `expect.fail()`-style assertions only after the dev activates them (flips `test.skip` → `test`).

The static JSDoc-disclaimer tests (AC 13/14) are NOT `test.skip()`-ed — they run under every `make test` because they guard the scope-disclaimer from day one. They FAIL in RED phase because the renamed files do not yet exist + do not yet carry the disclaimer; they pass only after Task 1 rename completes.

---

## Failing Tests Created (RED Phase)

### Integration Tests — new real-binary suite

**File:** `packages/connector/test/integration/transport-ator-real-binary.test.ts` (NEW — to be authored by dev at Task 2)

Every `it(...)` below is authored as `test.skip(...)` pending implementation; `describe()` wrapper is `describe.skip` when `ATOR_NIGHTLY !== '1'`. Test titles MUST carry the `T-36.3-NN` prefix verbatim (see Test-ID crosswalk in the story) so grep-by-ID retrieves the right case.

- **Test:** `T-36.3-01: Real SOCKS5 circuit established through SocksTransportProvider`
  - **Status:** RED — `test.skip()` until provider plumbing + in-compose TCP target is wired (Task 3.1)
  - **Verifies:** AC 4 — `provider.start()` resolves, TCP connect through `provider.createAgent()` reaches an in-compose target, warm-up `< CIRCUIT_WARMUP_BUDGET_MS`, probe reports `healthy: true`.

- **Test:** `T-36.3-02: Circuit warm-up fails loudly with explicit budget message on degraded stack`
  - **Status:** RED — `test.skip()` until manual `setTimeout` race harness lands (Task 3.2)
  - **Verifies:** AC 5 — warm-up >60s triggers `fail("Circuit warm-up exceeded 60s budget (measured Nms) — likely dirauth consensus not converged or hs1 not registered; check docker compose logs")`; NOT a generic jest timeout.

- **Test:** `T-36.3-03: BTP auth handshake completes over real 3-hop circuit within 90s`
  - **Status:** RED — `test.skip()` until Alice/Bob harness + Bob's wss listener reachability decision (Task 3.3)
  - **Verifies:** AC 6 — Alice→Bob BTP `auth` request/response round-trip through a real circuit; no `auth_error` frames; wall-clock < 90s.

- **Test:** `T-36.3-03: socks5:// scheme is rejected synchronously (SEC-03 re-assertion)`
  - **Status:** RED — `test.skip()` until scheme-reject harness with `net.Socket` spy lands (Task 3.4)
  - **Verifies:** AC 6 second Given — `provider.start()` rejects with error citing `socks5h://`, zero `net.Socket` constructions, no circuit warm-up, no probe activity. Runs even on degraded stack (pre-network fail-closed).

- **Test:** `T-36.3-04: Wire-level SOCKS5 CONNECT byte[3] is 0x03 (ATYP=DOMAINNAME) for hostname targets`
  - **Status:** RED — `test.skip()` until tcpdump oracle (or log-parse fallback) is wired (Task 4.2)
  - **Verifies:** AC 7 — packet capture (or anon log) scoped to SOCKS handshake; fourth byte == `0x03`; assertion is wire-level, NOT SDK-level.

- **Test:** `T-36.3-05: No ATYP=0x01 (IPv4) or 0x04 (IPv6) leak for plain hostname or .anon target`
  - **Status:** RED — `test.skip()` until oracle + multi-hostname matrix is wired (Task 4.3)
  - **Verifies:** AC 8 — no ATYP `0x01` / `0x04` in captured SOCKS handshake bytes; mismatch fails with the literal `"DNS leak: ATYP=0x%02x observed for %s — expected 0x03"` message.

- **Test:** `T-36.3-06: Circuit rebuilds on a different path after 1-of-3 relay kill within 90s`
  - **Status:** RED — `test.skip()` until `docker compose kill relay1` harness + post-kill reconnect + path-evidence assertion lands (Task 5.1)
  - **Verifies:** AC 9 — new connection succeeds within `CIRCUIT_REBUILD_BUDGET_MS`; path differs (circuit-id metric, anon log, or success-implies-new-path); afterEach restores relay + waits for healthcheck.

- **Test:** `T-36.3-07: All-relay kill fails closed within 15s with no direct-TCP fallback`
  - **Status:** RED — `test.skip()` until kill-all harness + lsof/tcpdump negative assertion + LAST-in-suite ordering lands (Task 5.2)
  - **Verifies:** AC 10 — SOCKS5-connect-flavored error within `FAIL_CLOSED_BUDGET_MS`; zero outbound connections other than `127.0.0.1:${ATOR_SOCKS_PORT}`; afterAll restores all relays.

- **Test:** `T-36.3-08: ILP PREPARE → FULFILL round-trip over BTP through real circuit in <5s`
  - **Status:** RED — `test.skip()` until auth'd BTP session + ILP packet builders wired (Task 6.1)
  - **Verifies:** AC 11 first block — FULFILL bytes byte-identical to Bob's handler output; no BTP `error` frames; round-trip <5s.

- **Test:** `T-36.3-08: ILP round-trip across >=8KB cell-fragmentation threshold`
  - **Status:** RED — `test.skip()` until deterministic ≥8KB payload generator lands (Task 6.2)
  - **Verifies:** AC 11 second block — serialized length ≥8192 bytes; SHA-256 equality both directions; round-trip `< LARGE_FRAME_BUDGET_MS`. Payload generated from fixed seed; NOT a committed `.bin`.

- **Test:** `T-36.3-09: provider.stop() resolves within stopTimeoutMs and leaves zero orphan sockets`
  - **Status:** RED — `test.skip()` until stop-hygiene lsof/socket-counter lands (Task 6.3)
  - **Verifies:** AC 12 first block — stop() resolves < `stopTimeoutMs`; no sockets to `127.0.0.1:${ATOR_SOCKS_PORT}`; subsequent fresh `start()` does not EADDRINUSE.

- **Test:** `T-36.3-09: afterEach teardown still runs provider.stop() when test assertion fails`
  - **Status:** RED — `test.skip()` until deliberately-failing sub-test + try/finally wrapper lands (Task 6.4)
  - **Verifies:** AC 12 second block — robust teardown invariant; zero orphan sockets after a `expect(true).toBe(false)`-style failure.

- **Test:** `T-36.3-11a: Module JSDoc declares real-binary scope (ATOR_NIGHTLY required)`
  - **Status:** RED — NOT `test.skip()`; authored to run under every `make test` but FAILS until Task 2.1 lands the file with the required JSDoc substring. Because the file does not yet exist, the test body in `socks5-contract.test.ts` that scans for the sibling file will fail at file-read time until Task 2 completes.
  - **Verifies:** AC 14 — self-assertion that this file's top-of-file JSDoc contains `"Real-binary ATOR integration — requires ATOR_NIGHTLY=1"`.

### Integration Tests — renamed contract suite (static guards)

**File:** `packages/connector/test/integration/socks5-contract.test.ts` (RENAMED from `transport-socks5.test.ts` at Task 1.3 — behavior preserved)

- **Test:** `T-36.3-11b: contract suite JSDoc carries scope-disclaimer vs real-binary integration`
  - **Status:** RED — FAILS pre-rename because the file does not yet exist; passes only after Task 1 completes and Task 1.4 inserts the verbatim disclaimer string.
  - **Verifies:** AC 13 scope-disclaimer invariant + AC 14 "both-required gate" — reads the file's own source and asserts the substring `"SOCKS5 protocol contract test, NOT ATOR integration"` is present in the module JSDoc.

### Helper file — renamed (fixture)

**File:** `packages/connector/test/helpers/socks5-contract-fixture.ts` (RENAMED from `in-process-socks5-proxy.ts` at Task 1.1 — NO behavior change; only JSDoc header rewrite at Task 1.4)

**File:** `packages/connector/test/helpers/socks5-contract-fixture.test.ts` (RENAMED from `in-process-socks5-proxy.test.ts` at Task 1.2)

No new behavioral tests added to the renamed fixture — the rename is pure scope clarification. All existing contract tests move with the rename and must continue to pass (AC 13 baseline invariant).

### Test-count summary

- **New integration tests (env-gated):** 13 (11 behavioral + 2 JSDoc static guards — one per file)
- **Renamed contract tests:** 0 net change (same test count, new filename)
- **Unconditional new tests under `make test`:** 2 (the JSDoc-disclaimer guards — they are the GREEN gates that fail until the rename + new-file creation land)

---

## Data Factories Created

No npm dev-dep factory (`@faker-js/faker`) is added — this is a backend / wire-level story and test payloads are either **empty** (circuit probes), **BTP auth** (tiny fixed-shape messages already built by existing BTP helpers), or **deterministic large payloads** seeded from a constant.

### Large BTP Payload Generator (optional, if needed at Task 6.2)

**File:** `packages/connector/test/fixtures/large-btp-message.ts` (OPTIONAL — create only if existing ILP builders resist `data` fields ≥8 KiB)

**Proposed exports:**

- `generateLargeBTPMessage(minBytes: number, seed: number = 0xC0FFEE): BTPMessage` — builds a BTP `message` frame whose serialized length ≥ `minBytes` by padding the ILP PREPARE's `data` field with a PRNG stream seeded from `seed`. Deterministic across runs, across machines.
- `payloadSha256(msg: BTPMessage): string` — convenience wrapper used by both Alice-side and Bob-side assertions in T-36.3-08.

**Example Usage:**

```typescript
import { generateLargeBTPMessage, payloadSha256 } from '../fixtures/large-btp-message';

const msg = generateLargeBTPMessage(8192);
const aliceHash = payloadSha256(msg);
await alice.sendBTPMessage(msg);
// ... Bob receives ...
expect(payloadSha256(bobReceivedMsg)).toBe(aliceHash);
```

**Invariant:** NEVER commit a `.bin` — binary fixtures drift silently (Dev Notes §Anti-Patterns).

---

## Fixtures Created

### ATOR Real-Binary Suite Harness (in-file)

**File:** `packages/connector/test/integration/transport-ator-real-binary.test.ts` (NEW — harness lives in the test file itself, NOT extracted to a helper)

**beforeAll fixture responsibilities (Task 2.4):**

- Assert `process.env.ATOR_SOCKS_PORT` is set and numeric; fail fast with `"ATOR_SOCKS_PORT not set — run via \`make ator-test\`"` otherwise.
- 5s TCP probe to `127.0.0.1:${ATOR_SOCKS_PORT}` to catch "ator-up was not run" before spending minutes on circuit warm-up; fail fast with `"run \`make ator-up\` first"`.
- Build suite-local `PROXY_URL = \`socks5h://127.0.0.1:${port}\`` — NO fallback default for port; missing env is a hard fail.

**afterAll fixture responsibilities:**

- Stop any `SocksTransportProvider` instances created.
- Restore any docker-compose services the suite killed (relay1/relay2/relay3) + wait for healthchecks.

**afterEach fixture responsibilities (T-36.3-06 / T-36.3-09):**

- Restore any single-relay kill via `docker compose start relay1` + healthcheck wait (mirror Story 36.1 AC 6 pattern).
- Ensure provider.stop() runs even when the test body threw (try/finally in the test harness).
- Socket-leak check: zero sockets to `127.0.0.1:${ATOR_SOCKS_PORT}` after `stop()`.

### Alice/Bob BTP Pair (reused)

Reuse the pattern from `packages/connector/test/integration/multi-hop-helpers.ts` for the Alice+Bob agent-pair construction (Task 3.5); the novel additions are:

1. Inject `transport: { type: 'socks', proxyUrl: socks5h://127.0.0.1:${ATOR_SOCKS_PORT} }` into the config.
2. Bob's wss listener binds to an address reachable from the hs1 container (per dev's Task 3.3 decision: sidecar / host-gateway / one-shot — default recommendation is **in-compose wss-echo sidecar guarded by `profiles: [ator-test]`**).

---

## Mock Requirements

**NO mocks in the real-binary suite.** The whole point of T-36.3-01..11 is that the real `anon` binary is the oracle; mocking the SDK or the SOCKS library in this suite defeats its purpose (Story §Anti-Patterns). Mocks belong in the renamed in-process contract fixture only.

### Docker-Compose Dependencies (not mocks — real infra)

- **hs1** container (ATOR hidden-service node from Story 36.1): provides the SOCKS5 listener on port 9050 (host-mapped dynamically by docker); readiness probed in `beforeAll`.
- **relay1**, **relay2**, **relay3** containers: real anon relays composing the 3-hop circuit; killed and restored by T-36.3-06 and T-36.3-07.
- **dirauth** container(s): directory authorities required for circuit build.
- **Optional wss-echo sidecar** (Task 3.3 option 1): only materialized under `profiles: [ator-test]` so `make ator-up` without the sidecar still works for manual exploration.

All of these MUST already be up via `make ator-up` before the suite is invoked — the beforeAll probe fails fast if they are not.

---

## Required data-testid Attributes

**N/A** — backend / wire-level story, zero UI surface.

---

## Implementation Checklist

Each failing test below maps to concrete tasks from the story. These are the GREEN-phase tasks the dev will execute one at a time to flip each `test.skip` → `test`.

### Test: T-36.3-01 — Real circuit established

**File:** `packages/connector/test/integration/transport-ator-real-binary.test.ts`

**Tasks to make this test pass (Task 3.1):**

- [ ] Author the `(REAL_BINARY ? describe : describe.skip)` wrapper
- [ ] Author the `beforeAll` port-probe + TCP-reachability probe (Task 2.4)
- [ ] Instantiate `SocksTransportProvider` with `socks5h://127.0.0.1:${ATOR_SOCKS_PORT}`
- [ ] Call `provider.start()`; measure wall-clock from `Date.now()` delta
- [ ] Choose + document the in-compose TCP target for the connection (see Dev Notes §Performance Envelope for why hs1's internal-network relay OR ports are recommended)
- [ ] Open TCP through `provider.createAgent()`; assert connection established
- [ ] Assert `provider.probe()` returns `healthy: true`
- [ ] Run test: `ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=$(docker compose port hs1 9050 | awk -F: '{print $2}') make ator-test` (or jest -t "T-36.3-01")
- [ ] Test passes (green phase)

**Estimated Effort:** 2–3 hours

---

### Test: T-36.3-02 — Warm-up fails loudly

**Tasks (Task 3.2):**

- [ ] Wrap `provider.start()` in a manual `Promise.race([start(), timeoutPromise(CIRCUIT_WARMUP_BUDGET_MS)])`
- [ ] On timeout, throw with the prescribed message exactly: `"Circuit warm-up exceeded 60s budget (measured ${ms}ms) — likely dirauth consensus not converged or hs1 not registered; check docker compose logs"`
- [ ] Declare `const CIRCUIT_WARMUP_BUDGET_MS = 60_000;` at top of file with AC 5 comment reference

**Estimated Effort:** 1 hour

---

### Test: T-36.3-03 — BTP auth handshake + scheme-reject

**Tasks (Task 3.3, Task 3.4, Task 3.5):**

- [ ] Pick Alice/Bob reachability approach (sidecar / host-gateway / one-shot — default: in-compose wss-echo sidecar). Document choice in Completion Notes.
- [ ] Reuse `multi-hop-helpers.ts` connector-pair patterns; inject `transport.proxyUrl`
- [ ] Execute BTP `auth` request/response; assert `<90s` wall-clock; assert no `auth_error`
- [ ] Scheme-reject sub-case: construct provider with `socks5://` (no `h`); install `net.Socket` spy BEFORE `start()`
- [ ] Assert `start()` rejects synchronously; error message cites `socks5h://`; zero socket constructions
- [ ] This sub-case runs even on degraded stack (pre-network fail-closed assertion)

**Estimated Effort:** 4–6 hours (Alice/Bob reachability is the pacing factor)

---

### Test: T-36.3-04 — Wire-level ATYP=0x03

**Tasks (Task 4.1, 4.2):**

- [ ] Choose wire-capture oracle (recommended: tcpdump in hs1 — edit `docker/ator/Dockerfile` to add `tcpdump` via apt; anon binary + checksum unchanged). Fallback: parse anon's `Log notice stderr` with `SafeLogging 0`.
- [ ] Document choice + rationale in Dev Notes (story §Wire-Level ATYP Oracle)
- [ ] Trigger SOCKS5 CONNECT via provider to a hostname target
- [ ] Capture bytes via `docker exec hs1 tcpdump -c 1 -s 0 -xx -i lo 'tcp dst port 9050'` (or equivalent)
- [ ] Parse captured bytes; assert byte[3] == `0x03`
- [ ] Assertion is WIRE-LEVEL (NOT SDK-level mock at `SocksClient.createConnection`)

**Estimated Effort:** 3–4 hours (oracle wiring dominates)

---

### Test: T-36.3-05 — No ATYP=0x01/0x04 leaks

**Tasks (Task 4.3):**

- [ ] Reuse oracle from T-36.3-04
- [ ] Exercise a matrix of hostnames: at minimum one plain hostname + one `.anon`-style hostname (the latter does NOT need to resolve — the SDK's CONNECT bytes are what matter)
- [ ] Parse ATYP byte per captured handshake; assert no `0x01` and no `0x04`
- [ ] On mismatch, fail with literal: `"DNS leak: ATYP=0x%02x observed for %s — expected 0x03"`

**Estimated Effort:** 1–2 hours (leverages oracle from previous task)

---

### Test: T-36.3-06 — 1-of-3 relay kill rebuilds

**Tasks (Task 5.1, 5.3):**

- [ ] Verify relay service names in `docker-compose.yml` (expect `relay1`/`relay2`/`relay3` per Story 36.1)
- [ ] Declare `const CIRCUIT_REBUILD_BUDGET_MS = 90_000;`
- [ ] Start provider healthy; `child_process.exec('docker compose kill relay1')`
- [ ] Attempt new connection through the same provider
- [ ] Assert success within budget; assert different-path evidence (circuit-id metric OR anon log OR success-implies-new-path)
- [ ] `afterEach`: `docker compose start relay1` + await healthcheck

**Estimated Effort:** 2–3 hours

---

### Test: T-36.3-07 — All-relay kill fails closed

**Tasks (Task 5.2, 5.3):**

- [ ] Declare `const FAIL_CLOSED_BUDGET_MS = 15_000;`
- [ ] Use `describe.serial` or `test.concurrent = false` for this block; place LAST in suite (minimize blast radius)
- [ ] Start provider healthy; `child_process.exec('docker compose kill relay1 relay2 relay3')`
- [ ] Attempt new connection
- [ ] Assert SOCKS5-connect-flavored error (NOT generic network-unreachable swallow) within budget
- [ ] Assert zero outbound connections via `lsof` or tcpdump negative check, except to `127.0.0.1:${ATOR_SOCKS_PORT}`
- [ ] `afterAll`: restore all three relays + await healthchecks

**Estimated Effort:** 2–3 hours

---

### Test: T-36.3-08 — ILP round-trip + large-frame

**Tasks (Task 6.1, 6.2):**

- [ ] Over auth'd BTP session, send ILP `PREPARE` addressed to a self-loop peer on Bob
- [ ] Bob's mock handler returns ILP `FULFILL`; Alice asserts byte-equality + <5s round-trip
- [ ] Assert no BTP `error` frames observed
- [ ] Large-frame sub-case: generate ≥8192-byte payload via `generateLargeBTPMessage()` (fixed seed, NOT committed `.bin`)
- [ ] SHA-256 assertion in both directions; round-trip `< LARGE_FRAME_BUDGET_MS = 10_000`

**Estimated Effort:** 3–4 hours

---

### Test: T-36.3-09 — Teardown hygiene

**Tasks (Task 6.3, 6.4):**

- [ ] Start provider; run dummy connection; `provider.stop()`
- [ ] Assert stop promise resolves `< stopTimeoutMs` (existing Epic 35 default)
- [ ] Assert zero sockets to `127.0.0.1:${ATOR_SOCKS_PORT}` via `lsof -p $$` OR a `net.Socket`-instance counter (dev picks + documents)
- [ ] Fresh `provider.start()` in same test — assert no `EADDRINUSE` or stale-handle error
- [ ] Deliberately-failing sub-test with `expect(true).toBe(false)` inside try/finally wrapper
- [ ] Assert afterEach hook still ran provider.stop() and no orphan sockets remain

**Estimated Effort:** 2 hours

---

### Test: T-36.3-10 — Renames land green under `make test`

**Tasks (Task 1.1..1.6):**

- [ ] `git mv packages/connector/test/helpers/in-process-socks5-proxy.ts packages/connector/test/helpers/socks5-contract-fixture.ts`
- [ ] `git mv packages/connector/test/helpers/in-process-socks5-proxy.test.ts packages/connector/test/helpers/socks5-contract-fixture.test.ts`
- [ ] `git mv packages/connector/test/integration/transport-socks5.test.ts packages/connector/test/integration/socks5-contract.test.ts`
- [ ] Rewrite top-of-file JSDoc on `socks5-contract-fixture.ts` AND `socks5-contract.test.ts` with verbatim disclaimer: `"SOCKS5 protocol contract test, NOT ATOR integration — see transport-ator-real-binary.test.ts for real-binary coverage."`
- [ ] Case-sensitive repo grep for `in-process-socks5-proxy` and `transport-socks5`; update every hit site
- [ ] Pre-rename grep output: paste to Dev Agent Record
- [ ] Post-rename grep output: assert zero matches; paste to Dev Agent Record
- [ ] `make test`: record pre- and post-rename test counts; assert no drop

**Estimated Effort:** 2 hours

---

### Test: T-36.3-11 — Both-required gate (static JSDoc checks ×2)

**Tasks (Task 6b.1, 6b.2, 6b.3):**

- [ ] In `socks5-contract.test.ts`, add a `test('JSDoc scope-disclaimer present', ...)` that reads `fs.readFileSync(__filename, 'utf8')` and asserts the disclaimer substring is present in the first module comment block
- [ ] Mirror the same guard in `transport-ator-real-binary.test.ts` asserting `"Real-binary ATOR integration — requires ATOR_NIGHTLY=1"` is present
- [ ] The real-binary guard must run even when `ATOR_NIGHTLY` is unset (it is pre-describe; NOT inside the env-gated block) — this is the one exception to the "nothing runs under `make test`" rule, because the disclaimer guard exists PRECISELY to defend against scope drift
- [ ] Document in Dev Notes §Test Tier Discipline that both tiers are required gates

**Estimated Effort:** 30 minutes

---

### Process Steps — not jest-assertable

- [ ] **AC 3 / Task 7:** Record baseline `make test` wall-clock + test counts BEFORE any file moves (Dev Agent Record)
- [ ] **AC 3 / Task 7:** Record post-story `make test` wall-clock; assert ±5% delta
- [ ] **AC 2 / Task 7.3:** Run `make ator-up && make ator-test && make ator-down`; record real-binary suite wall-clock
- [ ] **AC 15 / Task 8.3:** `git diff --stat epic-36...HEAD` (NOT vs main) to verify scope matches AC 15 file surface
- [ ] **AC 16 / Task 8.1:** Add `CHANGELOG.md` entries under `## [Unreleased]`: one `Added` line + one `Changed` line (mirror recent-entry voice)
- [ ] **AC 16 / Task 8.2 (reviewer, not dev):** Flip `epics.epic-36.stories.36.3.status = done` in `sprint-status.yaml`

---

## Running Tests

```bash
# Baseline (pre-rename, pre-new-suite) — record for AC 3 budget
make test  2>&1 | tee /tmp/make-test-baseline.log

# Contract tier only (always runs under make test; real-binary suite skipped)
make test

# Real-binary tier (requires docker compose + ator profile up)
make ator-up
make ator-test   # sets ATOR_NIGHTLY=1 + ATOR_SOCKS_PORT from `docker compose port hs1 9050`
make ator-down

# Run a single T-ID
ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=$(docker compose port hs1 9050 | awk -F: '{print $2}') \
  npm run test:integration -w packages/connector -- --testPathPattern 'transport-ator-real-binary' -t 'T-36.3-04'

# Debug
ATOR_NIGHTLY=1 ATOR_SOCKS_PORT=$(docker compose port hs1 9050 | awk -F: '{print $2}') \
  node --inspect-brk node_modules/.bin/jest --runInBand --testPathPattern 'transport-ator-real-binary'

# Coverage — explicitly scoped; real-binary suite is not part of normal coverage
npm run test:integration -w packages/connector -- --coverage --testPathPattern 'socks5-contract'
```

---

## Red-Green-Refactor Workflow

### RED Phase (Complete) ✅

**TEA Agent Responsibilities:**

- ✅ All 13 failing tests enumerated with T-IDs, statuses, and expected-failure reasons
- ✅ Two GREEN guard tests identified (JSDoc scope-disclaimer assertions) — these run under every `make test` and fail until the rename lands
- ✅ Fixture + harness strategy documented (beforeAll/afterAll/afterEach responsibilities)
- ✅ Data-factory (deterministic ≥8KB BTP payload generator) specified with exports
- ✅ Oracle choice matrix documented (tcpdump vs log-parse)
- ✅ Alice/Bob reachability option matrix documented
- ✅ Implementation checklist maps each AC/T-ID to concrete tasks with effort estimates
- ✅ Scope bright-line (AC 15) and rename discipline (AC 13) surfaced as pre-merge gates

**Verification:**

- The new suite file does not yet exist → jest discovers nothing real-binary → `make test` unchanged
- The two JSDoc-disclaimer static guards FAIL at RED phase because the files they target do not yet exist
- No source-code edits under `packages/connector/src/**`

---

### GREEN Phase (DEV Team — Next Steps)

Work tasks in the order the story lists them (Task 1 → Task 8). Within each task, flip `test.skip` → `test` one at a time. Run `make test` after Task 1 to confirm rename preserved test count; run `make ator-test` after each subsequent task to confirm the new T-ID passes.

**Key Principles:**

- One test at a time; one T-ID at a time
- Never weaken the bright line (no `packages/connector/src/**` edits)
- Never commit a `.bin` fixture (deterministic generator only)
- Real-binary tests MUST NOT run under `make test`; the env gate is the single enforcement point
- Mocks BELONG in the renamed contract fixture; the real-binary suite rejects all mocks

---

### REFACTOR Phase (DEV Team — After All Tests Pass)

- Extract duplication in provider-construction plumbing if multiple tests hand-roll it
- Consider extracting a `test/helpers/ator-stack-ready.ts` helper if the beforeAll port-probe pattern needs reuse in Story 36.4
- Ensure no `console.log` in shipped test files (commit-gate)
- Verify pinned `CIRCUIT_WARMUP_BUDGET_MS` / `CIRCUIT_REBUILD_BUDGET_MS` / `LARGE_FRAME_BUDGET_MS` / `FAIL_CLOSED_BUDGET_MS` are all file-top constants with comments pointing to the AC numbers

---

## Next Steps

1. **Share this checklist + story** with the dev workflow (`bmad-bmm-dev-story` pipeline).
2. **Task 7.1 first:** Record baseline `make test` metrics BEFORE any file edits.
3. **Task 1 second:** Execute the rename + grep-sweep; re-run `make test`; assert no test-count drop.
4. **Task 2 third:** Author the new file skeleton with env gate + beforeAll probe; confirm `make test` still skip-behaves correctly.
5. **Tasks 3–6:** Flip `test.skip` → `test` one T-ID at a time; run `make ator-test` per task.
6. **Task 7.2 / 7.3:** Post-story baseline compare; record real-binary suite wall-clock.
7. **Task 8:** CHANGELOG + diff-stat bright-line check.
8. **Reviewer:** flip sprint-status to `done` (AC 16 / Task 8.2).

---

## Knowledge Base References Applied

This ATDD workflow consulted the following knowledge fragments (backend-profile loading per `step-01` §Tiered Knowledge Loading):

- **test-levels-framework.md** — Integration vs Unit vs Contract level selection for the backend profile
- **test-priorities-matrix.md** — P0/P1/P2 assignment by risk and business impact
- **test-quality.md** — Given-When-Then structure, determinism, isolation, one-assertion-per-test
- **ci-burn-in.md** — nightly-only env-gated tier pattern (relevant to Story 36.5 handoff)
- **data-factories.md** — deterministic seed-based payload generators (drives the T-36.3-08 large-frame generator design)
- **test-healing-patterns.md** — robust teardown invariants (drives the AC 12 teardown-on-failure design)
- **contract-testing.md** — contract vs integration tier discipline (drives the AC 14 both-required argument)

See `tea-index.csv` for the complete knowledge-fragment mapping.

---

## Test Execution Evidence

### Initial Test Run (RED Phase Verification)

**Command (contract-tier, always runs):**

```bash
make test 2>&1 | tail -40
```

**Expected results at RED phase (before Task 1 rename + Task 2 new-file):**

```
FAIL  packages/connector/test/integration/socks5-contract.test.ts
  ● Cannot find module: packages/connector/test/integration/socks5-contract.test.ts
FAIL  packages/connector/test/integration/transport-ator-real-binary.test.ts
  ● Cannot find module: packages/connector/test/integration/transport-ator-real-binary.test.ts
Tests:       0 passed, 0 failed  (files do not yet exist)
```

Once Task 1 + Task 2 scaffolding lands (files exist, `describe.skip` wrapper in place, JSDoc-disclaimer guards in place):

```
PASS  packages/connector/test/integration/socks5-contract.test.ts
  ✓ JSDoc scope-disclaimer present
  ✓ [all existing contract tests, behavior unchanged]
PASS  packages/connector/test/integration/transport-ator-real-binary.test.ts
  ✓ JSDoc real-binary scope-disclaimer present
  ○ skipped: T-36.3-01 ... through T-36.3-11 (ATOR_NIGHTLY not set)
```

**Command (real-binary tier, env-gated):**

```bash
make ator-up
make ator-test 2>&1 | tail -80
```

**Expected at RED phase (tests exist but bodies still `test.skip`):**

```
PASS  packages/connector/test/integration/transport-ator-real-binary.test.ts
  Real-binary ATOR integration (ATOR_NIGHTLY=1)
    ○ skipped: T-36.3-01 through T-36.3-09, T-36.3-11
  ✓ JSDoc real-binary scope-disclaimer present

Tests: 1 passed, 12 skipped
Suite wall-clock: < 5s (no circuit activity)
```

**Summary:**

- Total tests authored: 15 (13 behavioral + 2 JSDoc guards)
- Passing at RED phase: 2 (JSDoc guards, once files exist)
- Skipped at RED phase: 13 (all T-36.3-NN behavioral tests — `test.skip` pending implementation)
- Failing at RED phase: 0 (we use skip, not failing-assert, to avoid red noise in unrelated CI runs — matches existing project conventions; Story 36.5 nightly gates convert these to required passes)
- Status: ✅ RED phase verified (all tests authored, all are inert pending implementation, no CI regression)

**Expected Failure Messages** (once `test.skip` is flipped to `test` without implementation):

- T-36.3-01: `Error: provider.start() never resolved within CIRCUIT_WARMUP_BUDGET_MS`
- T-36.3-02: `Error: Circuit warm-up exceeded 60s budget (measured Nms) — likely dirauth consensus not converged or hs1 not registered; check docker compose logs`
- T-36.3-03 auth: `Error: BTP auth handshake did not complete within 90s`
- T-36.3-03 scheme-reject: `AssertionError: expected provider.start() to reject with message citing 'socks5h://', got: <no rejection>`
- T-36.3-04: `AssertionError: expected captured SOCKS CONNECT byte[3] === 0x03, got: undefined (no capture)`
- T-36.3-05: `AssertionError: DNS leak check did not execute (oracle not wired)`
- T-36.3-06: `AssertionError: post-kill connection did not succeed within CIRCUIT_REBUILD_BUDGET_MS`
- T-36.3-07: `AssertionError: expected SOCKS5-connect error within FAIL_CLOSED_BUDGET_MS, got: no error`
- T-36.3-08 small: `AssertionError: ILP FULFILL not received`
- T-36.3-08 large: `AssertionError: SHA-256 mismatch between Alice-sent and Bob-received payload`
- T-36.3-09 stop: `AssertionError: N orphan sockets to 127.0.0.1:${ATOR_SOCKS_PORT} after provider.stop()`
- T-36.3-09 teardown: `AssertionError: afterEach did not run provider.stop() after deliberate test failure`
- T-36.3-11 real-binary guard: `AssertionError: module JSDoc of transport-ator-real-binary.test.ts does not contain required disclaimer substring`
- T-36.3-11 contract guard: `AssertionError: module JSDoc of socks5-contract.test.ts does not contain required disclaimer substring`

---

## Notes

- **`ATOR_SOCKS_PORT` is DYNAMIC.** The host port is assigned by docker at `ator-up` time and read by the Makefile via `docker compose port hs1 9050 | awk -F: '{print $2}'`. Any hardcoded port (e.g. 9050, 9150) in the suite masks misconfiguration. The suite MUST read from the env var with NO fallback default.
- **Bright line is non-negotiable.** If a real-binary test uncovers an actual connector bug, mark the AC PARTIAL in Dev Notes, file a follow-up issue, and do NOT attempt a fix inside this story. Epic 35 retro named this out explicitly.
- **Oracle choice is a one-shot decision.** Pick tcpdump (image edit, acceptable — pinned `.deb` + `checksums.txt` unchanged) OR log-parse (weaker oracle, no image edit). Do not try both; do not waffle. Document + move on.
- **The two JSDoc-disclaimer guards are the unconditional GREEN gates.** They run under every `make test` — they are the single line of defense against scope-disclaimer drift (Epic 35 retro §reader-confusion risk). Do NOT place them inside the env-gated block.
- **Scheme-reject sub-case runs even on degraded stack** — it asserts fail-closed BEFORE any network activity, so it is not gated by the beforeAll TCP probe. (AC 6 second Given.)
- **T-36.3-07 runs LAST.** Explicit ordering — kill-all-relays is the most destructive case; leaving it anywhere but last risks corrupting adjacent tests' state even with afterAll restoration.

---

## Contact

**Questions or Issues?**

- Ask in team standup
- Refer to `_bmad-output/planning-artifacts/epic-36-real-binary-ator-verification.md` for epic-level context
- Refer to `_bmad-output/planning-artifacts/test-design-epic-36.md` §Story 36.3 for the authoritative T-ID table
- Consult `_bmad/tea/testarch/knowledge` for testing best practices

---

**Generated by BMad TEA Agent** — 2026-04-15

# Story 38.1: GET /admin/hs-hostname — Expose Hidden-Service Hostname

Status: ready-for-review

## Story

As the Townhouse host CLI (`townhouse hs up`),
I want a `GET /admin/hs-hostname` admin endpoint that returns the connector's `.anyone` hidden-service hostname,
so that the host CLI can read the hostname over HTTP without `docker exec`-ing into the container (which breaks under Podman, rootless Docker, and requires a privileged Docker socket reference for a single string read).

**Epic:** 38 — Townhouse Hidden-Service Integration Support (new epic; this is the first story)
**Priority:** P0 (on the v1 critical path; unblocks Townhouse story TH-21.17.4 — `feat(townhouse): hs up subcommand — apex-only boot`)
**Estimated effort:** ~150 LOC + tests (~1 dev day)
**Dependencies:** none — `ManagedAnonClient` already exists (`packages/connector/src/transport/managed-anon-client.ts`)
**Source issue:** [toon-protocol/connector#58](https://github.com/toon-protocol/connector/issues/58)
**Target release:** v3.5.0 (minor — admin field addition per the upcoming `CONNECTOR_RELEASE_CONTRACT.md`; current `main` is v3.4.2)

## Context

Townhouse (`@toon-protocol/townhouse`) is a host-native orchestrator that boots the connector with an `.anyone` hidden service via the embedded `@anyone-protocol/anyone-client`. After bootstrap (~30–90s), the connector's anon process publishes the v3 hidden service descriptor and writes the hostname to `${anon.dir}/hostname` (typically `/var/lib/anon/hs/hostname`) inside the container.

Today the only way for the host CLI to read that hostname is `docker exec cat …` from a host-side `dockerode` shellout. That breaks layering, breaks under Podman/rootless Docker, and requires the host to hold a privileged Docker socket reference for a single string read.

The connector is the only process that already has trusted access to that file. Exposing it via the existing admin API is the natural surface.

### Decisions resolved on the issue thread

The original spec was refined on [issue #58](https://github.com/toon-protocol/connector/issues/58):

- **Drop `ready` from the response.** `ready` was derivable from `hostname !== null`. Final shape is `{ hostname: string | null, publishedAt: string | null }`. If a divergent ready-vs-hostname state ever materializes (key rotation overlap, etc.), `ready` can be added then with documented semantics — non-breaking.
- **Drop SIGHUP re-read.** The connector does not currently honor a config-reload signal anywhere. Hostname is stable for the connector process lifetime; rotation is a connector restart event in practice (the `townhouse-hs-anon` named volume holds the keystore; `townhouse hs down --rotate-keys` deletes it, restarting the connector with a new descriptor). Documenting the lifetime invariant is cleaner than wiring a config-reload signal just for this one field.
- **First-publish detection: `fs.watch` with a bounded fallback poll** for filesystems where `fs.watch` returns ENOSYS (some Docker overlay configurations). No hot-path polling on the request path.
- **`anon-disabled` 503 covers both sub-cases:** (a) `ManagedAnonClient` is not constructed at all, AND (b) `ManagedAnonClient` is constructed but `hiddenServiceDir` is unset. Same response body either way: `{ "error": "anon-disabled" }`. If finer distinction is ever needed, a non-breaking error-code split is available later.
- **Townhouse polling cadence:** ~2–3s during the 30–90s bootstrap window (~15–30 requests per cold start). `Retry-After: 3` on the `hostname: null` response is a polite addition but not load-bearing — implementer's call.

## Acceptance Criteria

### AC 1: Returns 200 with hostname after publish

```gherkin
Scenario: GET /admin/hs-hostname returns the hostname after anon publishes the v3 descriptor
  Given the connector is started with ManagedAnonClient configured (hiddenServiceDir set)
    And the anon process has written ${hiddenServiceDir}/hostname with content "<onion>.anyone\n"
  When GET /admin/hs-hostname is requested with a valid X-Api-Key
  Then the response status is 200
    And the body conforms to:
      {
        hostname: string,        // exact contents of the file, trimmed of trailing whitespace/newlines
        publishedAt: string      // ISO-8601 timestamp set on first successful read
      }
    And hostname matches /^[a-z2-7]{56}\.anyone$/  // v3 onion address format, .anyone TLD
```

### AC 2: Returns 200 with nulls during the bootstrap window

```gherkin
Scenario: GET /admin/hs-hostname returns nulls before the hostname file exists or is non-empty
  Given the connector is started with ManagedAnonClient configured
    And ${hiddenServiceDir}/hostname does not exist yet (or is empty)
  When GET /admin/hs-hostname is requested with a valid X-Api-Key
  Then the response status is 200
    And the body is exactly { hostname: null, publishedAt: null }
```

### AC 3: Returns 503 when anon / hidden service is not configured

```gherkin
Scenario: anon-disabled — ManagedAnonClient not constructed
  Given the admin router is constructed without a ManagedAnonClient reference
  When GET /admin/hs-hostname is requested with a valid X-Api-Key
  Then the response status is 503
    And the body is exactly { error: "anon-disabled" }

Scenario: anon-disabled — ManagedAnonClient constructed but hiddenServiceDir is unset
  Given the admin router is constructed with a ManagedAnonClient instance
    And ManagedAnonClient was constructed without hiddenServiceDir
  When GET /admin/hs-hostname is requested with a valid X-Api-Key
  Then the response status is 503
    And the body is exactly { error: "anon-disabled" }
```

### AC 4: First-publish detection uses fs.watch with bounded fallback poll

```gherkin
Scenario: Hostname is detected as soon as anon writes the file
  Given the connector is started with ManagedAnonClient configured
    And ${hiddenServiceDir}/hostname does not yet exist
  When the anon process writes the hostname file
  Then within 1s of the write, GET /admin/hs-hostname returns the hostname (AC 1 shape)

Scenario: fs.watch fallback to bounded poll when watch is unavailable
  Given fs.watch returns ENOSYS on the hostname directory (or otherwise fails to deliver events)
  When the connector starts up
  Then the connector falls back to a bounded poll (interval and max duration documented in code)
    And the poll stops as soon as the hostname is read once
    And no polling occurs on the HTTP request path
```

### AC 5: Hostname is stable for the connector process lifetime

```gherkin
Scenario: Hostname is read at most once from disk under normal operation
  Given the hostname has been read and cached
  When the hostname file is modified on disk (without restart, e.g. an out-of-band write)
  Then subsequent GET /admin/hs-hostname requests return the originally-cached hostname
    And publishedAt remains the timestamp of the first successful read
  // Documentation note: rotation requires a connector restart. SIGHUP re-read is intentionally not implemented.
```

### AC 6: Existing admin-api security applies

```gherkin
Scenario: /admin/hs-hostname requires X-Api-Key when apiKey is configured
  Given the connector is started with apiKey configured
  When GET /admin/hs-hostname is requested WITHOUT X-Api-Key
  Then the response status is 401
  When the same request includes a valid X-Api-Key
  Then the response status is 200 (or 503 per AC 3 if anon is disabled)

Scenario: /admin/hs-hostname is subject to the IP allowlist
  Given the admin router is configured with an IP allowlist that excludes 10.0.0.5
  When GET /admin/hs-hostname is requested from 10.0.0.5
  Then the response is rejected by the allowlist middleware (per existing /admin/* semantics)
```

### AC 7: Contract test covers the response shape

```gherkin
Scenario: Connector contract suite asserts the documented response shape
  Given the existing connector contract test suite
  When the suite runs against a connector with ManagedAnonClient configured (post-publish)
  Then a contract test asserts the body conforms to { hostname: string, publishedAt: string-iso8601 }
    And a contract test asserts the bootstrap-window body conforms to { hostname: null, publishedAt: null }
    And a contract test asserts the anon-disabled body is exactly { error: "anon-disabled" } with status 503
```

## Tasks / Subtasks

- [x] 1. Add hostname-watch logic to `ManagedAnonClient` (`packages/connector/src/transport/managed-anon-client.ts`).
  - [x] Add private state: `_hostname`, `_publishedAt`, `_hostnameWatcher`, `_hostnamePollTimer`, `_hostnamePollDeadlineMs`, `_hostnameWatchStopped`.
  - [x] Add public method: `getHostnameSnapshot(): HostnameSnapshot` (returns `{ null, null }` until first successful read).
  - [x] Add public method: `isHiddenServiceConfigured(): boolean` (true iff `_opts.hiddenServiceDir` is set and non-empty).
  - [x] In `start()` (after the SDK starts), kick off a background hostname watcher:
    - Fast path: try an immediate read so a restart with an existing key picks up instantly.
    - `fs.watch(this._opts.hiddenServiceDir, { persistent: false })` and read on the `change` event for `hostname`.
    - Bounded fallback poll alongside the watcher: every 2s for up to 5 minutes, stop on first successful read. Timer is `unref()`d so it doesn't block process exit.
    - Read errors other than ENOENT/EISDIR are logged at debug level and treated as "not yet published".
    - Empty-file is treated as not-yet-published (anon may create the file before writing the descriptor).
  - [x] `stop()` cleans up the watcher and active poll timer via `_cleanupHostnameWatch()`. The `_hostnameWatchStopped` flag short-circuits any in-flight `_tryReadHostname()` chain so a late read cannot mutate state after stop.
- [x] 2. Wire `ManagedAnonClient` reference through the admin router caller chain.
  - [x] Added `managedAnonClient?: ManagedAnonClient` to `AdminAPIConfig` in `packages/connector/src/http/admin-api.ts`.
  - [x] Added `managedAnonClient?: ManagedAnonClient` to `AdminServer` options + constructor and threaded it through to `createAdminRouter`.
  - [x] Added `_managedAnonClient: ManagedAnonClient | null` field to `ConnectorNode`, captured the reference inside `_createTransportProvider`, and passed it to the `AdminServer` constructor.
- [x] 3. Implement `GET /admin/hs-hostname` route handler in `packages/connector/src/http/admin-api.ts`.
  - [x] Returns 503 `{ error: "anon-disabled" }` when `managedAnonClient` is undefined OR `isHiddenServiceConfigured()` is false.
  - [x] Otherwise returns 200 with `getHostnameSnapshot()`.
  - [x] Sets `Cache-Control: no-store` on every response.
  - [x] Sets `Retry-After: 3` only on the bootstrap-window (`hostname: null`) response.
  - [x] Exports `AdminHsHostnameResponse` type.
  - [x] Registered in `admin-api-inventory.ts` (lint inventory check now passes with 26 routes).
- [x] 4. Route handler tests in `packages/connector/src/http/admin-api-hs-hostname.test.ts` — 10 tests covering ACs 1–3, 5 plus header/content-type sanity. Pass.
- [x] 5. Watcher tests in `packages/connector/src/transport/managed-anon-client.hostname.test.ts` — 8 tests covering `isHiddenServiceConfigured`, fast path, slow path (fs.watch + fallback poll), trim, empty-file handling, and stop-after-no-publish cleanup. Pass.
- [x] 6. Security tests extended in `packages/connector/src/http/admin-api-security.test.ts` — 3 new tests covering 401/200/403 paths for `/admin/hs-hostname`. Pass (27 security tests total).
- [ ] 7. Contract fixture entry — deferred. The "contract test suite" referenced in the issue is the Townhouse-side `packages/sdk/tests/integration/connector-contract.test.ts` in their repo, which they will update in lockstep with the v3.5.0 release per the issue thread. The connector-side `admin-api-inventory.ts` entry serves as the in-tree contract record.
- [x] 8. `make lint`, `npm run format:check`, `npm run build`, full connector unit suite — all green (3955 tests pass, 0 failed).
- [ ] 9. `CHANGELOG.md` — deferred. Will be added at the v3.5.0 release-cut commit per the project's release-notes convention.

## Dev Notes

- **No file polling on the hot path.** The route handler reads ONLY the in-memory snapshot. The watcher/poll lives in `ManagedAnonClient.start()` and stops on first successful read.
- **Why ManagedAnonClient owns the watcher:** keeps filesystem touches in one module; the route handler stays a thin projection. Mirrors the layering used by `metricsRegistry` for `/admin/metrics.json` (Story 37.3).
- **`hiddenServiceDir` may be a relative path.** `ManagedAnonClient` already resolves it via the SDK; the watcher should use the same resolved path. Don't re-derive.
- **Fallback poll bounds:** 2s interval × 5 min cap = 150 reads worst-case. Anon's normal publish window is 30–90s; the cap handles pathological-network cases without unbounded polling.
- **No `ready` field per the issue thread Q1 resolution.** Consumers check `hostname !== null`.
- **No SIGHUP re-read per Q3 resolution.** Document the process-lifetime invariant in JSDoc on `getHostnameSnapshot()`.
- **503 covers both anon-not-configured AND no-hiddenServiceDir per Q5 resolution.** Single error code today; non-breaking split available later if needed.
- **Townhouse-side mirror:** Townhouse will update `packages/sdk/tests/integration/connector-contract.test.ts` in lockstep with the v3.5.0 release that ships this endpoint. We do NOT update the Townhouse repo from this story.

## Out of Scope

(Per issue #58 §"Out of scope" — rejected on the townhouse side, listed here so they don't sneak in during implementation.)

- Adding `'town' | 'swap' | 'store'` node-type knowledge to the connector — layering violation; the connector is a generic ILP router. Townhouse owns the type concept.
- Per-node-type endpoints — same reason.
- Time-windowed earnings — Townhouse maintains its own time-series via hourly snapshots; no upstream coupling needed.
- Forecast/estimated-earnings endpoint — deferred to Townhouse v2.
- SIGHUP / config-reload signal handling — deferred (see Q3 resolution above).

## File List

| File | Change |
|------|--------|
| `packages/connector/src/transport/managed-anon-client.ts` | Modify: import `fs.watch` + `FSWatcher`, add `HostnameSnapshot` type, hostname-watch state (`_hostname`, `_publishedAt`, `_hostnameWatcher`, `_hostnamePollTimer`, `_hostnamePollDeadlineMs`, `_hostnameWatchStopped`), public `isHiddenServiceConfigured()` + `getHostnameSnapshot()`, private `_startHostnameWatch()` / `_scheduleHostnamePoll()` / `_tryReadHostname()` / `_cleanupHostnameWatch()`. Hooked into `start()` (background kickoff) and `stop()` (cleanup). |
| `packages/connector/src/http/admin-api.ts` | Modify: import `ManagedAnonClient` type, added `managedAnonClient` to `AdminAPIConfig`, new `AdminHsHostnameResponse` exported type, new `router.get('/hs-hostname', …)` handler. |
| `packages/connector/src/http/admin-server.ts` | Modify: thread `managedAnonClient` through `_options` + constructor + `createAdminRouter` call. Added `'GET /admin/hs-hostname'` to the startup endpoint log. |
| `packages/connector/src/core/connector-node.ts` | Modify: new `_managedAnonClient` field, captured in `_createTransportProvider`, passed to `AdminServer` constructor. |
| `packages/connector/src/http/admin-api-inventory.ts` | Modify: added `/admin/hs-hostname` inventory entry so the lint:inventory check passes. |
| `packages/connector/src/http/admin-api-hs-hostname.test.ts` | Add: 10 route handler tests against a fake `ManagedAnonClient`. |
| `packages/connector/src/transport/managed-anon-client.hostname.test.ts` | Add: 8 watcher tests (fast path, slow path, trim, empty-file, stop cleanup). |
| `packages/connector/src/http/admin-api-security.test.ts` | Modify: 3 tests covering X-Api-Key + IP allowlist for the new route. |

## Dev Agent Record

**Implementation date:** 2026-05-07
**Implemented by:** Amelia (dev) via party-mode handoff from issue [#58](https://github.com/toon-protocol/connector/issues/58)

### Implementation notes

1. **`ManagedAnonClient` owns the watcher** so the route handler stays a thin projection — it never touches the filesystem on the request path. Mirrors the layering used by `metricsRegistry` for `/admin/metrics.json` (Story 37.3).
2. **Fast path + slow path armed in parallel.** `_startHostnameWatch()` always does an immediate read (catches restart-with-existing-key), then arms BOTH `fs.watch` and a 2s/5min bounded poll. If `fs.watch` fires first, the poll's next tick short-circuits via the `_hostname !== null` guard. If `fs.watch` is unavailable (ENOSYS on overlay filesystems), the poll catches the publish within `HOSTNAME_POLL_INTERVAL_MS`. This is more robust than the issue's "fs.watch with fallback poll" framing, at the cost of a single redundant ~ms-cheap read per publish.
3. **`_hostnameWatchStopped` flag** added during testing — without it, a `_tryReadHostname()` already in-flight when `stop()` runs could resolve, set state, and reschedule the poll AFTER cleanup. The flag is checked at every state-mutation and re-arming point and is reset by `_startHostnameWatch()` so the client can be restarted.
4. **Empty-file handling.** Anon may create the hostname file before writing the descriptor. `_tryReadHostname()` treats an empty/whitespace-only file as not-yet-published.
5. **Poll timer is `unref()`d** so the Node event loop is not held alive solely for hostname detection.
6. **No `ready` field, no SIGHUP** per the issue thread Q1 / Q3 resolutions.
7. **Inventory entry added** to `admin-api-inventory.ts` — required by `npm run lint:inventory`.

### Validation

- `npm run format:check` — pass
- `make lint` — pass (including admin-api inventory drift check)
- `npm run build` — pass
- Full connector test suite — **3955 tests pass, 0 failed**, 215 skipped (skips are pre-existing E2E tests that require local infra; not impacted by this story).
- Targeted runs: `admin-api-hs-hostname.test.ts` (10/10 pass), `managed-anon-client.hostname.test.ts` (8/8 pass), `admin-api-security.test.ts` (27/27 pass including 3 new).

### Items deferred

- **Task 7 (contract fixture)** — the cross-team contract suite is in the Townhouse repo (`packages/sdk/tests/integration/connector-contract.test.ts`); per the issue thread they will update in lockstep with the v3.5.0 release. The connector-side `admin-api-inventory.ts` entry serves as the in-tree machine-readable contract record.
- **Task 9 (CHANGELOG.md)** — added at the release-cut commit per the project's standard-version convention (the recent v3.4.x cuts use auto-generated entries).

## Change Log

| Date | Change |
|------|--------|
| 2026-05-07 | Story drafted from issue #58 after spec resolution on the issue thread (drop `ready`, drop SIGHUP, fs.watch+fallback, 503 covers both anon-disabled sub-cases). Status: ready-for-dev. |
| 2026-05-07 | Implemented Tasks 1–6, 8. Tasks 7 and 9 deferred (see Dev Agent Record). 21 new tests, all green. Status: ready-for-review. |

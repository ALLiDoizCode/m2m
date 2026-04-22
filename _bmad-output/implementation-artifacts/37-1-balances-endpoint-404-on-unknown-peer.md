# Story 37.1: Balances Endpoint — 404 on Unknown Peer

Status: done

## Story

As the Townhouse dashboard,
I want `GET /admin/balances/:peerId` to return `404` when the peerId is not registered with the connector,
so that the dashboard can distinguish "unknown peer" (operator typo / misconfiguration) from "known but idle peer" (valid, zero balances).

**Epic:** 37 — Admin API Observability for Townhouse Dashboard
**Priority:** P1
**Estimated effort:** 1 point (~half day)
**Dependencies:** None

## Context

Verified defect (response doc §3.2): `admin-api.ts:1392-1425` delegates to `accountManager.getAccountBalance(peerId, tokenId)`, which in `account-manager.ts:441-490` deterministically derives TigerBeetle account IDs from `(peerId, tokenId)` and defaults missing balances to `0n`. An unknown peer and a known-but-idle peer therefore return identical `200` bodies.

The DELETE/PUT `/admin/peers/:peerId` endpoints already use `btpClientManager.getPeerIds().includes(peerId)` for the same unknown-peer guard (`admin-api.ts:686, 748`). Story 37.1 brings the balances endpoint in line with that pattern.

## Acceptance Criteria

### AC 1: Unknown peer → 404

```gherkin
Scenario: GET /admin/balances/:peerId returns 404 for an unregistered peer
  Given btpClientManager.getPeerIds() returns ['peer-b', 'peer-c']
  When GET /admin/balances/unknown-peer is requested
  Then the response status is 404
  And the response body is { error: 'Not found', peerId: 'unknown-peer', message: <string> }
  And accountManager.getAccountBalance is NOT called
```

### AC 2: Known peer with no ledger activity → 200 with zeros

```gherkin
Scenario: GET /admin/balances/:peerId returns 200 with zero balances for an idle registered peer
  Given btpClientManager.getPeerIds() returns ['peer-b']
  And accountManager.getAccountBalance('peer-b', 'M2M') resolves to { debitBalance: 0n, creditBalance: 0n, netBalance: 0n }
  When GET /admin/balances/peer-b is requested
  Then the response status is 200
  And body.balances[0] is { tokenId: 'M2M', debitBalance: '0', creditBalance: '0', netBalance: '0' }
```

### AC 3: Known peer with activity → 200 unchanged

```gherkin
Scenario: Existing happy path is unchanged
  Given btpClientManager.getPeerIds() returns ['peer-b']
  And accountManager.getAccountBalance('peer-b', 'M2M') resolves to { debitBalance: 5000n, creditBalance: 3000n, netBalance: -2000n }
  When GET /admin/balances/peer-b is requested
  Then the response status is 200
  And body.balances[0].debitBalance is '5000'
```

### AC 4: 503 branch preserved

```gherkin
Scenario: accountManager not wired up still returns 503
  Given the admin router is constructed without accountManager
  When GET /admin/balances/peer-b is requested
  Then the response status is 503
  And the peer-registry check is skipped (no dependency on btpClientManager for this branch)
```

### AC 5: 500 branch preserved

```gherkin
Scenario: accountManager throws
  Given btpClientManager.getPeerIds() returns ['peer-b']
  And accountManager.getAccountBalance rejects with an Error
  When GET /admin/balances/peer-b is requested
  Then the response status is 500
```

## Tasks / Subtasks

1. Edit `packages/connector/src/http/admin-api.ts`:
   - In the `router.get('/balances/:peerId', …)` handler (~line 1392), insert an unknown-peer guard after the `!accountManager` check and before the `getAccountBalance` call.
   - Use `btpClientManager.getPeerIds().includes(peerId)`; return `404` with `{ error: 'Not found', peerId, message: 'Peer '<id>' not found' }` on miss.
2. Update `packages/connector/src/http/admin-api-channels.test.ts`:
   - In the balances `describe` block setup (~line 1236), change `getPeerIds: jest.fn().mockReturnValue([])` to `.mockReturnValue(['peer-b', 'peer-big'])` so existing happy-path assertions still pass the new gate.
   - Replace the single "should return 200 with zero balances for unknown peer (TigerBeetle semantics)" test (~line 1348) with two tests:
     - "should return 404 for an unregistered peer" (AC 1)
     - "should return 200 with zero balances for a known idle peer" (AC 2) — configure `getPeerIds` to include `peer-b`, have `getAccountBalance` resolve to zeros.
3. Run `npm test -- admin-api-channels` to confirm green.
4. Run `make lint` to confirm no lint regressions.
5. Append `## 12. Connector update` to the cross-team response doc with the story link and PR reference.

## Dev Notes

- **Why `btpClientManager.getPeerIds()` and not a dedicated peer-registry?** The BTPClientManager is the authoritative live-peers registry in the current architecture; `admin-api.ts` already uses it as such for DELETE/PUT `/admin/peers`. Adding a parallel registry for balances would introduce drift risk. If a "configured but disconnected" peer should 200 rather than 404, we'd need a richer registry — but Town's §5.2 requirements explicitly want 404 for "peer does not exist" and don't distinguish disconnected-vs-unknown at this endpoint.
- **Error body shape** matches the DELETE handler's convention at `admin-api.ts:687-690`: `{ error, message }` with an explicit `peerId` field added for the dashboard's degraded-state UX (Town requirements §5.2).

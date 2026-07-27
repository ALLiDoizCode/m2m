# Retiring the TypeScript prefix

**Status:** Operational checklist, consistent with
[ADR 0013](../adr/0013-cut-over-through-a-parallel-address-space.md) — it does not restate that
decision, it answers the question ADR 0013 leaves open: when has the moment to delete the old
prefix actually arrived. Written for whoever executes the cutover (issue #431 and its
children), not for the general reader of the ADR.

ADR 0013 puts two networks live at once and says the old (TypeScript) prefix "is disposable by
design ... it exists to be deleted." It does not say how anyone knows that day has come. This
document is that answer, as a checklist against observable state rather than a feeling that
enough time has passed. All three conditions below must hold before the old fleet is torn down.
None of them is a proxy for the others.

## Condition 1 — no traffic is reaching the old prefix

**What to look at:** on the TypeScript fleet's `HealthServer` (port 8080, unauthenticated,
`GET /metrics`, see [`docs/admin-api-inventory.md`](../admin-api-inventory.md)):

- `toon_last_packet_timestamp_seconds{peer_id=...}` has not advanced, for every configured
  `peer_id`, for the whole observation window below.
- `toon_packets_forwarded_total` and `toon_packets_rejected_total` are flat (no counter
  increments) over the same window.

**Why traffic, not a client list:** the client edge accepts anonymous senders with no prior
registration with the operator (`docs/protocol/client-edge-spec.md` §1.2 — an unaffiliated payer
identified only by its claim's signer, `http:anon` if even that is absent). There is no
enumerable roster of "everyone who might send to this prefix." Condition 2 checks the clients
this repository knows about; this condition is what covers everyone it doesn't.

**Window:** long enough to distinguish "migrated" from "quiet." A single idle hour or overnight
gap proves nothing — pick a window that spans the longest realistic gap between two legitimate
payments on this deployment (an operator judgement call this document cannot make for a
deployment it has never seen), and record what window was used and why alongside the decision to
delete. Re-check at the end of the window rather than trusting the snapshot that started it.

## Condition 2 — every known client has repointed

**What to look at:** the deployment configuration or destination address of every client this
repository knows targeted the old fleet's apex. As of this writing that is `swap`
(`@toon-protocol/connector`'s only caret consumer per the 4.0.0 release notes); `town` is archived
and `mill` does not exist as a repository, per #431's own scoping decision, so neither is a client
to track here. If a new client is onboarded before the old prefix is deleted, add it to this list.

**What "repointed" means:** its destination address resolves to the new (Rust) apex, and — per
ADR 0013 — it has opened and funded a payment channel with that apex, since a channel is
bilateral and does not follow an address change. Confirm this against the client's own deployment,
not against anything this repository can observe.

**Why this is necessary but not sufficient:** this condition only covers clients this repository
can name. Condition 1 is what catches everything it can't — a client repointed here can still be
missed if it kept a second, forgotten integration pointed at the old prefix, and only sustained
zero traffic would show that.

## Condition 3 — every channel opened against the old apex is resolved

**What to look at:**

- On the TypeScript fleet's `AdminServer` (port 8081, `X-Api-Key`):
  - `GET /admin/channels` — every returned `AdminChannelStatus` is closed.
  - `GET /admin/settlement/states` — no peer reports a nonzero `pendingClaims`.
- On the TypeScript fleet's settlement API, mounted on `HealthServer` (port 8080,
  unauthenticated):
  - `GET /settlement/status/:peerId` — no peer reports a nonzero `pendingAmount`.

A channel with a nonzero pending claim or a status other than closed is not resolved: redeem it
or cooperatively close it (`POST /admin/channels/:channelId/close`, or the settlement API) while
the old fleet — and whatever signer material and claim history it holds — still exists to do so.

**If an operator chooses to tear down the fleet with a channel still open anyway:** that is a
decision this document can flag but not forbid. Record it explicitly rather than letting it
happen by omission — see "what is lost" below.

## What is irreversible, and what is lost if a condition is wrong

- **A client that has not migrated cannot be rolled forward once its prefix is gone.** Deleting
  the old prefix removes the only address that client's un-migrated integration can reach; unlike
  the migration direction (a destination change per ADR 0013), there is no equivalent one-line
  fix once the far end no longer exists. If Condition 1 or 2 was wrong — traffic was actually
  still arriving, or a client thought to be repointed was not — that client is cut off, not
  merely degraded, until someone notices and either restores the old fleet or manually migrates
  it out of band.
- **A channel does not follow an address change and does not follow the fleet either.** Closing
  or redeeming a channel is an action the old fleet's own process takes (its signer, its claim
  history, its admin API). Once that process is gone, so is the software path to invoke it. Any
  underlying on-chain contract may still expose its own unilateral withdrawal or challenge
  mechanism independent of the connector (`packages/contracts/src/TokenNetwork.sol`,
  `packages/solana-program`), but that path is separate from, and untested by, this migration —
  it is not a safety net to rely on in place of Condition 3.
- **These conditions are read at a point in time, not guaranteed to stay true.** A condition met
  today can stop being true tomorrow if a new client is onboarded against the old prefix before
  it is deleted. Re-verify immediately before deletion, not only when the observation window
  above first closes.

## Relationship to ADR 0013

This checklist does not change ADR 0013's decision — the parallel address space, the
disposability of the old prefix, the bilateral-channel consequence — it operationalizes the one
question that decision leaves open. If any condition above conflicts with a future revision of
ADR 0013, ADR 0013 governs and this document should be updated to match, not the reverse.

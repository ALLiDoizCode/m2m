# ADR-vs-tree contradiction sweep

**Ticket:** [#1053](https://github.com/toon-protocol/connector/issues/1053) — child of the wayfinder map [#1049](https://github.com/toon-protocol/connector/issues/1049).
**Swept:** 2026-08-19, against the working tree on branch `research/adr-tree-contradiction-sweep`.
**Scope:** all 44 records in `docs/adr/`, checked against `crates/`, `docs/protocol/` and `CONTEXT.md`.

> **This is a list, not a set of rulings.** Each finding names the record, the exact claim, the tree
> fact with `file:line`, and the ruling it _probably_ wants under the map's scope-based default
> (protocol law → record wins; connector architecture → code wins; fleet and operations → case by
> case). Nothing here is adjudicated. Each finding graduates into its own ticket.

**Excluded by the ticket:** ADR 0042 and ADR 0044. Both are correctly labelled target records; their
unbuilt state is declared debt, not a contradiction. Where they appear below it is as the _successor_
a stale citation should be re-pointed at, or as an _inverse_ claim (something the index says is unbuilt
that is in fact built) — never as a failure of their own.

**Already ticketed, not re-derived:** ADR 0003's client-edge half vs bare `/ilp` (#1054);
`x402.rs:206` vs `connector announce` (#1055); `money-model.md`'s credit-window sections (#1056);
`apex`/`children` (#1057); the `unresolvable_lookup_budget_*` knobs. Siblings of each are reported and
marked.

---

## Counts

**88 findings** (numbered F-01…F-89; F-81 is a cross-reference to F-48, not a separate finding).

| Probable ruling                                                                                                                                                        | Count |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **Fix the code** — including a `docs/protocol/` spec, a repo doc, a shipped string or a code comment, where the record and the code agree and the _doc_ is the outlier | 44    |
| **Amend the record**                                                                                                                                                   | 32    |
| **Open a record** (a live mechanism no record covers)                                                                                                                  | 6     |
| **Either/case-by-case** (the finding names two viable dispositions)                                                                                                    | 6     |
| **Retire the record**                                                                                                                                                  | **0** |

| Category                                                            | Count |
| ------------------------------------------------------------------- | ----- |
| (a) an Accepted record describes a mechanism the tree does not have | 21    |
| (b) a mechanism in the tree that no record covers                   | 19    |
| (c) a `**Status:**` line (or an index row) that is itself wrong     | 21    |
| (d) a `docs/protocol/` spec contradicts a record                    | 27    |
| (e) `CONTEXT.md` contradicts a record                               | 9     |

_(Categories sum to more than 88: several findings sit in two at once.)_

**Zero retirements.** Nothing found here says a record should die — the folder's triage was honest
about which records are dead. What it was not honest about is how many _live_ records describe a tree
that has moved.

**Records that check out clean:** 0006, 0012, 0013, 0024, 0031, 0032, 0034, 0036, 0037, 0038, 0039,
0041 — plus the _core_ of 0011, 0020, 0023, 0027, 0028, 0033, 0035, 0040 (each carries a peripheral
finding but its decision holds).

---

## The five that matter most

1. **F-45 — the cross-repo vector contract has no client-edge section at all.** ADR 0021 exists to
   serve ADR 0003's economics: the client edge is the surface whose far end this repo cannot flag-day.
   `vectors/wire-vectors.json` fully vectors the _peer_ carriage (both ends operator-controlled) and
   vectors the client edge **not at all**. The contract covers the surface that needed it least.
2. **F-46 / F-49 — the client edge's front door is covered by no record.** `[[client_identities]]`,
   `ILP-Peer-Id`, `Authorization: Bearer`, the anonymous fallback, its `401`, and the NIP-59
   privacy-wrapped claim header have **zero occurrences across all 44 records** and zero vectors. This
   is the whole of the map's territory 7 admission path.
3. **F-72 / F-75 / F-80 — ADR 0031's rule is stated as present-tense fact in shipped user-visible
   text.** A `/metrics` HELP string, two config load errors, the deployed `connector.toml` template,
   two operator runbooks and `CONTEXT.md` all say every peer PREPARE carries its covering claim. ADR
   0042 says the forwarded half is not built. An operator reading the error message is being told
   something false at 3am.
4. **F-16 — "the packet path never locks" locks on every paid packet.** `recognize_channel` takes an
   unconditional `RwLock::write()` per admitted request on both client-edge carriages, on a set that
   is written once per _channel_ — the exact read-mostly shape ADR 0015 reserves `ArcSwap` for.
5. **F-28 — a peer arrival refused by F03 keeps the claim it was refused for.** ADR 0029 says "the
   sending peer is not charged for a delivery that never happened"; the covering claim is journalled
   and the watermark advanced _before_ the F03 gate runs, with no peer-side counterpart to the
   `roll_back` that #1012 built for the client edge.

---

# A. Connector architecture

## F-01 — ADR 0001: "handlers contain no decision logic"

- **Record:** 0001 (Accepted; connector architecture)
- **Claim:** "**Handlers contain no decision logic.** `connector-api` and `connector-admin`
  deserialize, call exactly one method on `Connector`, and serialize. **Any `if` in a handler that is
  not input validation is a bug.** … there is one brain, and HTTP is a transport reaching it."
- **Tree fact:** `crates/connector-client-edge/src/lib.rs:1030` — `handle_ilp` is a ~280-line policy
  engine. `:1113` computes the price from a matched route; `:1122` refuses on transport policy; `:1135`
  issues the x402 greeting on `if !has_claim_header && (price > 0 || !condition_present)`; `:1150`
  raises an over-carry reject before the claim is ingested. None is input validation.
  `connector-client-edge` is 20,817 lines across 10 modules against `connector-runtime`'s 14,926 — the
  brain is split, not single. ADR 0028 explicitly ratifies pricing at the edge; 0001 was never updated.
- **Category:** (a) · **Probable ruling:** amend the record · **Confidence:** high

## F-02 — ADR 0001: `@toon-protocol/connector` "becomes a thin HTTP client"

- **Record:** 0001 (Accepted; connector architecture)
- **Claim:** "The embedded node is deleted; `@toon-protocol/connector` becomes a thin HTTP client."
- **Tree fact:** the package was deleted outright, not converted. `package.json` workspaces are
  `packages/announcer`, `packages/faucet`, `packages/mina-usdc-faucet-web`, `packages/mina-zkapp`,
  `tools/fund-peers`. `docs/adr/0017-…md:3` records this; 0001's Status line cross-references only
  #457's `ConnectorNode` deletion, not 0017.
- **Category:** (a) · **Probable ruling:** amend the record · **Confidence:** high

## F-03 — ADR 0001: the workspace shape

- **Record:** 0001 (Accepted; connector architecture)
- **Claim:** the "The shape" crate list — 11 crates.
- **Tree fact:** `Cargo.toml:12-29` lists 16 members. `connector-settlement` — which holds the
  `SettlementBackend` port, `InMemorySettlementBackend` and the port's shared contract suite
  (`crates/connector-settlement/src/lib.rs:19,23`) — appears in no record's workspace-shape decision;
  0001 implies the trait lives with the per-chain crates. `connector-peer-http` is named by crate name
  in no ADR.
- **Category:** (b) · **Probable ruling:** amend the record · **Confidence:** low

## F-04 — ADR 0002: the Node pin the record says it retired

- **Record:** 0002 (Accepted; connector architecture)
- **Claim:** "Dropping Mina also retires … the **Node ≥ 22.12 pin that exists solely so `require()` of
  an ES module works on the Mina claim path**."
- **Tree fact:** `package.json:46` still reads `"node": ">=22.12.0"`. `packages/mina-zkapp` remains a
  workspace member and `Makefile:125,128,131,163,166,169` keep `mina-up`/`mina-down`/`mina-logs`/
  `mina-build`/`mina-test`/`mina-deploy-devnet`. The Status line's carve-out covers only the deployed
  zkApp, not the pin. (`dist-esm/` **is** gone.) Adjacent: `CLAUDE.md` says "Node.js >= 22.11.0",
  which does not match `package.json`.
- **Category:** (c) · **Probable ruling:** amend the record (or drop the pin) · **Confidence:** medium

## F-05 — ADR 0005: "fulfilments not yet covered by a claim" are persisted

- **Record:** 0005 (Accepted, amended by 0033; connector architecture)
- **Claim:** Decision, first paragraph — _not_ covered by the Status carve-out, which retires only the
  Consequences' arithmetic: "The connector durably persists only what is signed or otherwise
  irreversible — claims sent, claims received with their watermarks, and **fulfilments not yet covered
  by a claim**."
- **Tree fact:** `crates/connector-domain/src/projection.rs:48-56` — `InboundFulfillmentRecorded` is
  "Historical entry kind, no longer produced (ADR 0031, ADR 0033, issue #882) … `Projection::apply`
  folds it into nothing", pinned by `a_historical_fulfillment_recorded_entry_replays_as_a_no_op` at
  `projection.rs:257`.
- **Category:** (a) · **Probable ruling:** amend the record (extend the Status carve-out to the
  Decision paragraph) · **Confidence:** medium-high

## F-06 — ADR 0005's Status line vs `money-model.md`

- **Record:** 0005 (Accepted; connector architecture)
- **Claim:** Status — "The exposure and ceiling arithmetic … is retired — **nothing projects exposure
  any more**."
- **Tree fact:** `docs/protocol/money-model.md:239-249` has a live section "## Exposure and the
  ceiling" presenting `pub fn exposure(&self, channel_id: &str) -> u64` reading `self.inbound_fulfilled`
  and `self.inbound_claimed`. Neither `fn exposure` nor `inbound_fulfilled` exists in `crates/`;
  `Projection`'s only accessors are `outbound_owed` (`projection.rs:178`) and `latest_inbound_claim`
  (`:189`).
- **Category:** (d) · **Probable ruling:** fix the doc — record and code agree.
  _Same document as #1056, different sentence: this one falsifies 0005's Status annotation, a separate
  artifact from the credit-window sections already ticketed._ · **Confidence:** high

## F-07 — ADR 0007: the `PeerTransport` contract suite is unreachable from both carriages

- **Record:** 0007 (Accepted; connector architecture)
- **Claim:** "contract tests defined once per port and run against every implementation of it";
  "**Every port owes a contract suite before it owes a second implementation.** … an implementation
  that has not passed it is not an implementation."
- **Tree fact:** the suite is at `crates/connector-runtime/src/peer_transport.rs:571`, nested inside
  `#[cfg(test)] mod tests` (`:312`). The only implementation held to it is `InProcessPeerTransport`
  (`:660`). The two production carriages — `BtpPeerTransport`
  (`crates/connector-peer-btp/src/dial.rs:463`) and `HttpPeerTransport`
  (`crates/connector-peer-http/src/dial.rs:258`) — are in separate crates and cannot reach a
  `#[cfg(test)]` module. The tree diagnoses itself at
  `crates/connector-settlement/src/contract.rs:6-14`: "unlike `connector-runtime`'s `PeerTransport`
  contract suite, this port's implementations live in separate crates … a suite hidden behind
  `#[cfg(test)]` is invisible outside this crate's own test build, so those crates could never hold
  their implementation to it." Also stale: `peer_transport.rs:15-19` still says "Until a carriage
  lands, `InProcessPeerTransport` is the only implementation."
- **Category:** (a) · **Probable ruling:** **fix the code** — move the suite behind a `test-util`
  feature exactly as `connector-settlement` already does. (Scope defaults to amend-the-record, but the
  record states a _doctrine_ the tree has not applied to one port, and the settlement crate proves the
  pattern is available.) · **Confidence:** high

## F-08 — ADR 0007: the `Journal` port has two implementations and no contract suite

- **Record:** 0007 (Accepted; connector architecture)
- **Claim:** "Every port owes a contract suite before it owes a second implementation."
- **Tree fact:** `crates/connector-runtime/src/journal.rs:30` — the `Journal` port has
  `InMemoryJournal` (`:75`) and `FileJournal` (`:222`) and no suite. Tests are hand-duplicated:
  `an_in_memory_journal_reads_back_everything_appended_in_order` (`:291`) and
  `a_file_journal_reads_back_everything_appended_in_order` (`:301`), with the `append_batch` durability
  contract asserted only against `FileJournal`.
- **Category:** (a) · **Probable ruling:** fix the code · **Confidence:** medium

## F-09 — `peer-semantics-spec.md` asserts contract-testing that does not happen

- **Record:** 0007 (via the spec)
- **Claim:** `docs/protocol/peer-semantics-spec.md:7-8` — "**Consumers:** the Rust
  `connector-runtime` peer transport port and every implementation of it (**contract-tested per
  [ADR 0007]**)".
- **Tree fact:** same root cause as F-07; no carriage implementation is contract-tested.
- **Category:** (d) · **Probable ruling:** fix the code (spec and record agree; the tree is the
  outlier). Same fix as F-07. · **Confidence:** high

## F-10 — ADR 0009: secrets are "never written inline"

- **Record:** 0009 (Accepted; connector architecture)
- **Claim:** "Secrets are referenced by location — a file path or a key management identifier — and
  **never written inline**."
- **Tree fact:** `crates/connector-config/src/operator.rs:50` declares `bearer_token: Option<String>`
  — the inline literal — and `operator.rs:43-45` states the retention is deliberate: "the file forms
  are ADDED beside the literals and **the literals stay accepted**." Same for the peering credential:
  `crates/connector-config/src/peer.rs:296` `secret: Option<String>`, documented at `peer.rs:285` as
  "`secret` — the literal. Still supported." The shipped deployment template writes one inline:
  `deploy/connector-rust/connector.toml:87`. (`[signer] key_file` and `[settlement.*.key]` _do_ follow
  the record — `crates/connector-config/src/secret.rs:20,41`.)
- **Category:** (a) · **Probable ruling:** amend the record · **Confidence:** high

## F-11 — ADR 0008: the operator write path has two mechanisms no record names

- **Record:** 0008 (Accepted; connector architecture)
- **Claim:** the Decision names RFC 9421 + RFC 9530 and no further write-path mechanism.
- **Tree fact:** `crates/connector-operator/src/write_auth.rs:42` carries
  `seen_signatures: Mutex<HashMap<Vec<u8>, u64>>`, a replay cache that "rejects a signature it has
  already accepted once" (`:6-8`), and `:43` an unbounded in-memory `audit_log: Mutex<Vec<AuditRecord>>`
  served at `GET /audit-log` (`crates/connector-operator/src/lib.rs:125,215-216`). Both are
  process-lifetime only — a signature replayed after a restart is accepted, and the audit trail is lost.
  Grepping `docs/adr/` for "replay" yields only claim-nonce replay (0027, 0030, 0035), never the
  operator write surface; ADR 0014 decides the observability surface without mentioning `/audit-log`.
- **Category:** (b) · **Probable ruling:** amend the record (add both, and state whether their
  volatility is intended) · **Confidence:** medium

## F-12 — ADR 0008: RFC 9421 is not, and no longer is, used on the client edge

- **Record:** 0008 (Accepted; connector architecture)
- **Claim:** `docs/adr/0008-…md:30-31` — "The mechanism already exists in the repository.
  `auth/rfc9421` implements signing, verification and Content-Digest, and **is used on the client edge
  to bind a claim to the request it pays for.** This points it at a second surface rather than
  introducing anything."
- **Tree fact:** **zero** RFC 9421 / Content-Digest usage in `crates/connector-client-edge/`. The only
  implementation is `crates/connector-operator/src/rfc9421.rs` + `write_auth.rs`.
  `docs/protocol/client-edge-spec.md:582-586` states the same: "No `requireRequestBinding` config
  field, `RouteTermination` type or RFC 9421 verification of a client's request exists anywhere in
  `crates/` … the RFC 9421 verification `connector-operator` does carry is the operator surface's write
  authentication (ADR 0008), **a different mechanism on a different surface**." The operator surface is
  the _only_ surface, not the _second_ — the record's "introduces nothing new" reasoning no longer holds.
- **Category:** (a) · **Probable ruling:** amend the record · **Confidence:** high

## F-13 — ADR 0014: "four of the five metrics stand" — three do

- **Record:** 0014 (Accepted, amended by 0033; connector architecture)
- **Claim:** Status — "**Four of the five metrics stand.** `toon_exposure` … is **permanently zero
  with no producer**."
- **Tree fact:** only **three** have producers. `Metrics` holds fields for `packets_total`,
  `packets_rejected_total`, `fees_earned_total` only
  (`crates/connector-runtime/src/metrics.rs:21-26`); `exposure` **and** `settlement_total` are
  registered as bare locals with no field retained and no setter (`:73-82`). The crate's own test is
  named `exposure_and_settlement_gauges_have_no_producer_and_report_zero` (`:153-158`).
- **Category:** (c) · **Probable ruling:** amend the record ("three of the five") · **Confidence:** high

## F-14 — ADR 0014: `toon_settlement_total` never went non-zero, though its feature shipped

- **Record:** 0014 (Accepted; connector architecture)
- **Claim:** "`toon_exposure` and `toon_settlement_total` were declared at their decided names and
  reported zero until … channel lifecycle (#422) existed to populate them … A dashboard or alert built
  against these names did not need to change when those tickets landed; **it started reporting
  non-zero**."
- **Tree fact:** channel lifecycle and claim redemption landed in full —
  `crates/connector-runtime/src/connector.rs:2447,2486,2501,2524`, exposed as `POST /channels`,
  `/channels/:id/fund`, `/redeem`, `/redeem-latest`, `/close`, `/cooperative-close`
  (`crates/connector-operator/src/lib.rs:139-144`) — and `toon_settlement_total` is still never
  incremented. Its own help text still says "Always 0 until channel lifecycle and claim redemption land
  (issue #422)" (`metrics.rs:60`).
- **Category:** (a) · **Probable ruling:** **fix the code** — wire `record_settlement()` into the four
  settlement paths. (The scope default says amend, but the record decided a name for a feature that has
  since shipped; the cheaper honest fix is the counter.) · **Confidence:** high

## F-15 — ADR 0014: `Connector::forward_to_peer` does not exist

- **Record:** 0014 (Accepted; connector architecture)
- **Claim:** "forwarding only ever changes `amount` (see `Connector::forward_to_peer`)"
- **Tree fact:** the function is `Connector::forward_via_peer_route`
  (`crates/connector-runtime/src/connector.rs:1633`).
- **Category:** (c) · **Probable ruling:** amend the record · **Confidence:** high

## F-16 — ADR 0015: "the packet path never locks" takes a write lock per paid packet

- **Record:** 0015 (Accepted; connector architecture)
- **Claim:** the title — "**the packet path never locks**"; and "That state is held as an immutable
  snapshot … so the packet path reads it with no lock and no per-read copy."
- **Tree fact:** `recognized_channels: RwLock<HashSet<String>>`
  (`crates/connector-runtime/src/connector.rs:442`) is **write**-locked on every admitted paid packet.
  `Connector::recognize_channel` takes `.write()` unconditionally and only then tests membership
  (`:1318-1326`), and it is called once per admitted request on both client-edge carriages —
  `crates/connector-client-edge/src/lib.rs:1196` (`POST /ilp`) and
  `crates/connector-client-edge/src/btp.rs:279`. The set is written once per _channel_ and read
  thereafter — exactly the read-mostly shape the record reserves `ArcSwap` for — yet it takes an
  exclusive global lock per _packet_, serializing concurrent paid requests. Not covered by the record's
  stated exceptions: it is neither cold/administrative nor "written at least as often as it is read"
  the way `probe_rate_limiter` genuinely is.
- **Category:** (a) · **Probable ruling:** **fix the code.** 0015 states a _rule_, not a description of
  existing code, so the "code wins" default does not fit; this is the #452 bug at smaller scale.
  · **Confidence:** medium-high (the fact is high; whether it clears the record's own exception is
  medium)

## F-17 — ADR 0015: `known_channels` type drift

- **Record:** 0015 (Accepted; connector architecture)
- **Claim:** "`known_channels` (`RwLock<Vec<ChannelId>>`) is read and written by settlement operations"
- **Tree fact:** the field is `known_channels: RwLock<Vec<(SettlementChain, ChannelId)>>`
  (`crates/connector-runtime/src/connector.rs:403`).
- **Category:** (c) · **Probable ruling:** amend the record (reasoning unaffected) · **Confidence:** high

## F-18 — ADR 0043: one removed key _is_ silently dropped

- **Record:** 0043 (Accepted; connector architecture)
- **Claim:** Status — "**Removed config keys are parsed-and-rejected traps rather than silent drops**";
  and 0038 removed "in full: the lease, its match-time demotion and its off-hot-path reaping."
- **Tree fact:** the `[peer_sale]` trap is real and complete (`crates/connector-config/src/config.rs:114-123,362`;
  message at `crates/connector-config/src/error.rs:855-858`; tests at `config.rs:2059,2092`). But the
  lease's `expires_at` survives in the on-disk snapshot reader as `StoredPeerCompat::Full { expires_at, .. }`,
  `#[allow(dead_code)]`, "Parsed so an older snapshot still opens, **then discarded**"
  (`crates/connector-runtime/src/peer_route_store.rs:59-70`). The code gives a good reason (a state file
  has no version field, so refusing is a crash loop with no migration path), and strictly the Status says
  "config keys" while this is a state-file key — but the blanket "rather than silent drops" reads as
  covering it.
- **Category:** (c) · **Probable ruling:** amend the record (one clause noting the snapshot-compat
  exception and why). Otherwise 0043 is total and verified. · **Confidence:** low-medium

## F-19 — ADR 0016's Status line asserts the opposite of the tree

- **Record:** 0016 (Partly superseded by 0017; protocol law)
- **Claim:** "the Rust connector **implements neither client edge v1 nor a compatibility path to it**"
- **Tree fact:** `docs/protocol/client-edge-spec.md:3-4` — "ADR 0021 makes the Rust implementation
  (`crates/connector-client-edge`) **the definition of this wire**."
  `crates/connector-client-edge/src/lib.rs:425-430` registers all of §1.1 `POST /ilp`, §1.9 `/ilp/btp`,
  §1.6 `/ilp/probe`, §1.7 `/ilp/identity`, `/ilp/routes/price`, §1.10 `/ilp/claim-state`. §1.3's claim
  gate is `claim_gate.rs`; §1.4's greeting is live (`lib.rs:13`).
- **Category:** (c) · **Probable ruling:** amend the record. (The line is trying to say "not the
  _prototype's_ v1 as a conformance target"; as written it is false — the Rust connector **is** v1.)
  · **Confidence:** high

## F-20 — ADR 0016: "the x402 greeting was removed and §1.4 is stale"

- **Record:** 0016 (live first half; protocol law)
- **Claim:** "Not the x402 greeting — ADR 0011 removed it and does not reinstate it, and
  `client-edge-spec.md` §1.4 is stale in still describing it"
- **Tree fact:** ADR 0022 reinstated it _as answering_. `docs/protocol/client-edge-spec.md:454-479`
  (§1.4, implemented per #526 / ADR 0022); `crates/connector-client-edge/src/lib.rs:542-546`
  (`x402_terms_body`, `X402SettlementTerms`).
- **Category:** (c) · **Probable ruling:** amend the record · **Confidence:** high

## F-21 — ADR 0016: "its client edge must not be exposed"

- **Record:** 0016 (protocol law)
- **Claim:** "identity, claims and request binding are all unimplemented (#498) … Until that lands,
  **its client edge must not be exposed**"
- **Tree fact:** identity `crates/connector-client-edge/src/lib.rs:428`; claims `claim_gate.rs`;
  request binding **decided against** — `docs/protocol/client-edge-spec.md:581-583` "Not implemented,
  and not going to be" (ADR 0035).
- **Category:** (c) + (d) · **Probable ruling:** amend the record. **Wider point worth its own line:**
  0016's stated _motive_ for reading the envelope (§1.5 request-request binding — "binding over
  anything less than the request re-opens exactly the replay it exists to close") was retired by ADR
  0035; the surviving justification is now ADR 0018's seal, not §1.5. · **Confidence:** high

---

# B. Fleet and operations

## F-22 — ADR 0030 under-describes the subcommand it decides

- **Record:** 0030 (Accepted, amended in place by #807; fleet and operations)
- **Claim:** "An **operator** may, by running `connector announce <relay-discovery-url>` on the node
  being announced"; and, in the claim-parts table, "**Only one of them is configured, and that is the
  point**".
- **Tree fact:** the subcommand additionally requires a destination ILP address not derivable from the
  through-URL, supplied as `--to` or `[announce] publish_to`, refusing by name when absent —
  `AnnounceError::NoDestination` at `crates/connector-cli/src/announce.rs:180`, message at `:261-269`.
  The real usage is `connector announce --config <config-file> <relay-discovery-url> [--to <ilp-address>]
[--btp-url <wss-url>] [--target <path>] [--via-own-routing] [--dry-run]`
  (`crates/connector-cli/src/lib.rs:108-112`). The record names neither the second required input nor
  `--config`. **Direct name collision:** the record's Considered Options _rejects_ "A `[announce]
publish_to` block", while `[announce] publish_to` is a live, load-bearing key with an entirely
  different meaning (`crates/connector-config/src/announce.rs:93,224`).
- **Category:** (b) · **Probable ruling:** amend the record · **Confidence:** high

## F-23 — the fleet runs the timer shape ADR 0030 rejected, unrecorded

- **Record:** 0030 (Accepted; fleet and operations)
- **Claim:** "A serving connector announces nothing. **There is no timer**, no `selfAnnounce` config
  block, and no startup broadcast." And, rejecting an option: "A `[announce] publish_to` block the
  serving process acts on, **on a timer** … Rejected here because it is exactly the daemon-decides
  shape ADR 0022 refuses … It remains the obvious next step … and it would be **a change to this ADR,
  made on purpose, rather than a drift**."
- **Tree fact:** the fleet now runs that shape, moved one process outward and never recorded.
  `infra/linode-store/docker-compose.store.announce.yml` defines a `restart: unless-stopped` service
  (`:254`) on the same `ghcr.io/toon-protocol/connector:rust-release` image (`:192`) running
  `connector announce` in a `/bin/sh` loop every `STORE_ANNOUNCE_REFRESH_SECS: '240'` (`:204-247`),
  self-described as "mirroring the announcer sidecar's own `ANNOUNCER_REFRESH_INTERVAL_SECS` shape"
  (`:33`). The relay box has the same (`infra/linode-relay/docker-compose.relay.announce.yml`), plus a
  third for the swap maker (`docker-compose.relay.swap-announce.yml`); `fleet-ops.yml:254-262` wires
  all three into the deploy. `docs/operators/announcing-a-node.md:7-8` still asserts "It is a one-shot
  operator action. A serving connector announces nothing on its own — see ADR 0030" and then documents
  "the loop retries on the next tick" (`:261,:303`) and "Stop the loop before you edit the config"
  (`:361`). ADR 0030 mentions no loop anywhere.
- **Category:** (a), and (b) for the loop overlay itself · **Probable ruling:** **case by case** (fleet
  and operations). The rule about the _serving process_ is technically intact — the loop is a separate
  container, i.e. a controller under `CONTEXT.md`'s definition — but the record predicted this exact
  move and asked for it to be recorded as a deliberate change. Amending 0030, or a new record, is what
  the record itself requires. · **Confidence:** high

## F-24 — ADR 0017 restates the versioned seam as if it existed

- **Record:** 0017 (Accepted; fleet and operations)
- **Claim:** "Nothing is versioned. ADR 0003's `POST /ilp/v{N}` **remains a seam with zero adapters** —
  this fleet serves exactly one wire."
- **Tree fact:** there is no versioned seam at all, not a seam with zero adapters. The client edge
  routes bare paths only (`crates/connector-client-edge/src/lib.rs:425-430`).
- **Category:** (c) · **Probable ruling:** amend the record — sibling of #1054, settle together
  · **Confidence:** high

---

# C. Protocol law — the money model

## F-25 — ADR 0004: `lockedAmount`/`locksRoot` were not removed

- **Record:** 0004 (Partly superseded by 0042; protocol law). Its Status calls this half "**Accepted
  and still binding**".
- **Claim:** "`lockedAmount` and `locksRoot` stay dead and are **removed from the balance proof and
  the on-chain contract**."
- **Tree fact:** both are live fields of the signed struct —
  `crates/connector-signer/src/claim_signature.rs:66-72` (`EvmBalanceProof::locked_amount`,
  `locks_root`), hashed at `:130-132`; and in the deployed contract at
  `packages/contracts/src/TokenNetwork.sol:41-42` and `:58-59`.
- **Category:** (a) · **Probable ruling:** amend the record. ADR 0024 already narrowed this
  deliberately ("**`lockedAmount`/`locksRoot` are still hashed as zeros** … omitting them would compute
  a digest the signer's wallet never actually signed"), and `peer-semantics-spec.md:152-157` carries the
  correction. 0004's Status never picked it up. · **Confidence:** high

## F-26 — ADR 0010: a client-originated packet cannot declare a minimum delivery

- **Record:** 0010 (Accepted, amended by 0042; protocol law)
- **Claim:** "**Every packet declares the amount that must reach its destination**, and a hop that
  cannot meet that figure after taking its fee rejects the packet rather than forwarding a smaller one."
- **Tree fact:** `crates/connector-client-edge/src/session_route.rs:91` and `:116` both call
  `handle_prepare_with_client_channel(prepare, 0, …)` — minimum delivery hardcoded to `0`;
  `crates/connector-client-edge/src/lib.rs:1216-1219` states it outright ("a client-originated packet
  declares no guarantee yet, so this hop enforces none"). The field is a peer-role grant that clients
  MUST have **ignored**: `crates/connector-peer-btp/src/fields.rs:34-38`,
  `crates/connector-peer-http/src/headers.rs:448-457`, per `docs/protocol/peer-carriage-spec.md:385-386`
  and `:659`.
- **Category:** (a) · **Probable ruling:** protocol law → record wins → **fix the code**. But the
  counter-argument is written down in two specs and one crate, so this may instead be a deliberate
  narrowing 0010 never recorded. · **Confidence:** medium-high

## F-27 — the "a client role ignores `minimumDelivery`" rule is covered by no record

- **Record:** none — that is the finding
- **Tree fact:** as F-26. Two carriages implement a MUST-ignore rule
  (`crates/connector-peer-btp/src/fields.rs:34-38`,
  `crates/connector-peer-http/src/headers.rs:448-457`) whose only source is
  `docs/protocol/peer-carriage-spec.md:385-386,659` — non-normative prose (ADR 0021).
- **Category:** (b) · **Probable ruling:** open a record, or a clause on 0010 · **Confidence:** high

## F-28 — ADR 0029: an F03-refused peer arrival keeps the claim it was refused for

- **Record:** 0029 (Accepted in part — "the per-packet `F03` price-coverage check **stands and is
  live**"; protocol law)
- **Claim:** "A rejected arrival never opens the wrap, never reaches the app, and records no exposure …
  **and the sending peer is not charged for a delivery that never happened.**"
- **Tree fact:** the covering claim is accepted **before** the F03 gate.
  `crates/connector-runtime/src/connector.rs:1276-1278` calls `handle_peer_claim(claim)` →
  `ClaimBook::accept_inbound`, which advances the inbound watermark and durably journals
  `InboundClaimAccepted` (`crates/connector-runtime/src/claim.rs:1220-1236`) — and only then, at
  `connector.rs:1280-1297`, does the F03 refusal run. There is no peer-side counterpart to ADR 0028's
  #1012 `ClientClaimGate::roll_back`; `claim.rs:1572`'s `roll_back` is the journal-batch-failure unwind,
  not a semantic one.
- **Category:** (a) · **Probable ruling:** protocol law → record wins → **fix the code** (a peer-side
  rollback mirroring #1012) — **or** amend 0029 to say the peer's watermark is not rolled back because
  a peer claim is cumulative rather than per-packet. The asymmetry is exactly the defect #1012 closed on
  one surface. · **Confidence:** medium

## F-29 — ADR 0033's body: "nothing emits `T04` any more"

- **Record:** 0033 (Accepted; protocol law). _Its Status line is otherwise verified true in every
  particular._
- **Claim:** "The same reasoning keeps `RejectCode::t04_insufficient_liquidity` … in `connector-domain`
  for wire interop, **even though nothing in this codebase emits it any more**."
- **Tree fact:** `crates/connector-runtime/src/connector.rs:1673-1683` emits
  `RejectCode::t04_insufficient_liquidity()` for the per-peer packet cap (`packet_cap_for`, `:644`) —
  and it is **pinned as a committed vector** at `crates/connector-vectors/src/lib.rs:1037`, so under
  ADR 0021 it is normative. `CONTEXT.md:255-262` ("Cap … refused with `T04`") is ahead of both the
  record and the spec here.
- **Category:** (c) · **Probable ruling:** amend the record — the emitter is 0042's cap, which shipped
  after 0033 was written. Also **amend ADR 0029's Status line**, which reads as though `T04` is dead.
  · **Confidence:** high

## F-30 — the `T04` constructor's own doc comment says nothing emits it

- **Record:** 0029 / 0033 (via a code comment)
- **Claim** _(offending side = code)_: `crates/connector-domain/src/packet.rs:218-224` — "Used until
  issue #424 … for this connector's own exposure ceiling; that machinery is retired (**ADR 0031**, ADR
  0033, issue #882) and **nothing in this codebase emits `T04` any more.** Kept for wire interop."
- **Tree fact:** `connector.rs:1675` emits it, per F-29. The comment also cites the dead ADR 0031.
- **Category:** (c) · **Probable ruling:** fix the code comment · **Confidence:** high

## F-31 — `peer-semantics-spec.md` §5.1–§5.3 say the same, and omit the cap refusal entirely

- **Record:** 0033 (protocol law)
- **Claim** _(spec)_: `docs/protocol/peer-semantics-spec.md:249-251` — "`connector_domain::RejectCode::
t04_insufficient_liquidity` still exists for wire interop (RFC-0027), **but nothing in this codebase
  emits it any more.**" §5.3's banner repeats it.
- **Tree fact:** same emitter (`connector.rs:1675`). Worse: **§5.1's code table has no row for the cap
  refusal at all**, and §5.2's `accumulatedCost = 0` enumeration does not list it either (the code sets
  `0`, `connector.rs:1682`).
- **Category:** (d) · **Probable ruling:** fix the spec · **Confidence:** high

## F-32 — `client-edge-spec.md` §1.3 gates value binding on route kind; ADR 0028 forbids that

- **Record:** 0028 (Accepted; protocol law), and 0035 which cites it
- **Claim** _(spec)_: `docs/protocol/client-edge-spec.md:164` — "3. **Value binding** (**for a
  locally-terminated, priced route**) — the claim's cumulative amount MUST advance by at least the
  route's configured flat price". ADR 0028 says the opposite: "The client edge treats the two kinds
  identically … **Any divergence between 'priced because terminated' and 'priced because forwarded' is
  a defect, not a design.**" ADR 0035's disposition table says "the claim gate itself deliberately does
  not tell the two kinds of route apart ([ADR 0028])".
- **Tree fact:** the price fed to the gate comes from `client_route` regardless of kind —
  `crates/connector-client-edge/src/lib.rs:1112-1113` (`let price = client_route.map_or(0, |route| route.price)`),
  passed to `extract_and_validate_claim` at `:1188`. `ClientRouteKind::Forwarded` carries a required
  price (`crates/connector-config/src/route.rs:411`, `ConfigError::PeerRouteMissingPrice`).
- **Category:** (d) · **Probable ruling:** fix the spec — delete the parenthetical; code and two
  records already agree against it · **Confidence:** high

## F-33 — the Solana Ed25519 balance proof is protocol law with no record behind it

- **Record:** none — 0024 is EVM-only by its title and Decision ("the EIP-712 balance-proof digest")
- **Tree fact:** the Solana claim's 48-byte Ed25519 balance-proof layout
  (`crates/connector-signer/src/claim_signature.rs:194-204`) is live on **both** the client edge and the
  peer carriage, is **vectored** (`crates/connector-vectors/src/lib.rs:764`, `claim_solana`) and is
  therefore normative under ADR 0021 — and its only written source is a recovered TypeScript function
  (`solana-payment-channel-sdk.ts::_buildBalanceProofMessage`, per the module doc at
  `claim_signature.rs:42-52`). No ADR states what a Solana claim signs over or why.
- **Category:** (b) · **Probable ruling:** open a record, or a Solana clause on 0024 · **Confidence:** medium

## F-34 — `peer-semantics-spec.md` §3.5 says there is no Ed25519 claim path

- **Record:** 0024 (Accepted; protocol law); term retired by 0027
- **Claim** _(spec)_: "The Solana row remains **aspirational**: **the peer wire has no Ed25519 claim
  path yet.**" — `docs/protocol/peer-semantics-spec.md:167-168`
- **Tree fact:** `ClaimBook` signs Solana claims at `crates/connector-runtime/src/claim.rs:833-842`
  and `:972-978`, verifies out of `solana_channels` (`:477`, `:670-680`, `:1072-1082`), holds
  `solana_signer: Option<Arc<dyn Ed25519Signer>>` (`:451`), `set_solana_signer` (`:569`),
  `verify_solana_balance_proof` (`:26`), `SOLANA_SIGNATURE_LEN` (`:52`).
  `peer-carriage-spec.md:1140-1144` records #998 wiring it from `[[peer_channels]]`. The claim is
  vectored (F-33). "Peer wire" is a retired term (`CONTEXT.md:205-213`).
- **Category:** (d) · **Probable ruling:** fix the doc — the §3.5 `solana` row is now as live as its
  `evm` row · **Confidence:** high

## F-35 — `sweep_flush` / `due_for_flush` survived ADR 0033 with no caller and no mention

- **Record:** 0033 (Accepted; protocol law)
- **Claim:** 0033's Considered Options justifies removing `flush_interval_ms` because
  "`warn_if_claim_ack_outlives_flush`, the one function that read it, **had zero callers anywhere in
  the codebase** … there was never a scheduled flush task reading this value."
- **Tree fact:** `Connector::sweep_flush` (`crates/connector-runtime/src/connector.rs:1451`) and
  `ClaimBook::due_for_flush` (`crates/connector-runtime/src/claim.rs:1075`) survive with **no
  production caller** — the only call sites are tests (`connector.rs:4522`, `:4537`).
  `sweep_flush`'s own doc comment still calls it "the mechanism that bounds trailing exposure", the
  exact quantity 0033 retired. 0033 never names either function.
- **Category:** (b) shading into (c) · **Probable ruling:** connector-architecture-shaped — either
  delete with the rest of the flush machinery, or record why the FLUSH frame's sender half stays
  reachable-but-uncalled. Same "undocumented, unjustified machinery" shape 0033 was written to close.
  · **Confidence:** medium

## F-36 — the index says `ClaimEnforcement::Observe` is not built; it is

- **Record:** the index (`docs/adr/README.md`)
- **Claim:** `docs/adr/README.md:200` — "| 0042 | a covering claim on forwarded arrivals;
  `ClaimEnforcement::Observe` | **Not built.** …"
- **Tree fact:** `ClaimEnforcement::Observe` is built and live —
  `crates/connector-config/src/peer.rs:217-224` (parsed from `"observe"` at `:249`) and read on the
  packet path at `crates/connector-peer-btp/src/price_gate.rs:159`, exercised at
  `crates/connector-peer-http/tests/peer_carriage_http.rs:1296-1298`.
- **Category:** (c) · **Probable ruling:** fix the index row. **This is the _inverse_ of 0042's declared
  debt** — something the index calls unbuilt that is built — so it falls outside the ticket's exclusion.
  · **Confidence:** high

## F-37 — `T05` and `F99` are reject codes no record covers

- **Record:** none — that is the finding
- **Tree fact:** `crates/connector-domain/src/packet.rs:228-236` — `T05: Rate Limited`, with a
  documented semantic distinction from `T00` ("`T00` says this connector tried and could not, `T05`
  says it declined to try") and a stated retry contract. `:177-182` — `F99: Application Error`. Neither
  string appears in any of the 44 records; `grep -o 'T0[0-9]' docs/adr/*.md` yields only `T00`, `T01`,
  `T04`.
- **Category:** (b) · **Probable ruling:** open a record — folds into the map's already-noted
  reject-code-table gap · **Confidence:** high

## F-38 — `F03`'s doc comment forward-references a mechanism ADR 0035 killed

- **Record:** 0035 (Accepted; protocol law)
- **Claim** _(offending side = code)_: `crates/connector-domain/src/packet.rs:158-163` — "F03: Invalid
  Amount … a locally-terminated route's configured price … **or, later, a request-request-bound route's
  price (§1.5)**."
- **Tree fact:** `docs/protocol/client-edge-spec.md:581` — "### 1.5 Request-request binding — **decided
  against.** **Not implemented, and not going to be.**" "later" is a promise the project withdrew.
- **Category:** (a) · **Probable ruling:** fix the code comment · **Confidence:** high

## F-39 — `money-model.md`'s "Decided, and now built (#868)" section

- **Record:** 0042 (Accepted)
- **Claim** _(doc)_: heading "## Decided, and now **built** (#868)"
  (`docs/protocol/money-model.md:374`) and "Every item this section lists as a future change **has since
  landed**: #880/#881 (ADR 0031) shipped the covering-claim requirement **on both the receive and send
  sides**" (`:379-380`).
- **Tree fact:** the same file's banner at `:8-11` — "**Corrected 2026-08-17:** … Neither was true.
  **Issue #881's send-side covering was never wired to config**, and the price gate requires a covering
  claim only at a _priced termination_." The 2026-08-17 correction was applied to the banner and never
  to this section. The document contradicts itself about the same fact.
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

## F-40 — and that banner is now _itself_ stale

- **Record:** 0004 / 0010 (money-model.md is their joining document)
- **Claim** _(doc)_: `docs/protocol/money-model.md:8-11` — "**Corrected 2026-08-17** … **Issue #881's
  send-side covering was never wired to config** … so for **forwarding**, the trailing-claim model
  described below is still what the binary does."
- **Tree fact:** `[[pay_channels]]` is now wired — `crates/connector-config/src/pay_channel.rs:1-13`,
  `resolve_pay_channels` at `:161` — landed in HEAD commit `1a5695a2` ("Wire issue #881:
  `[[pay_channels]]` populates outbound_client_hops"). _Reported as fact only; the underlying rule is
  0042's, which is excluded._
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** medium

## F-41 — `money-model.md`'s closing claim

- **Record:** 0042 (Accepted)
- **Claim** _(doc)_: "The model in the sections above described the code before #868; **it is not the
  model in the code today**." — `docs/protocol/money-model.md:420-421`
- **Tree fact:** ADR 0042:3 — "Until those land, **forwarding runs [0004]'s model end to end**"; the
  file's own banner (`:11-13`) says "for **forwarding**, the trailing-claim model described below is
  still what the binary does."
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

---

# D. Protocol law — the wire, its carriage, and the vector contract

## F-42 — ADR 0021: vectors are not generated from property tests

- **Record:** 0021 (Accepted; "the tiebreaker for every protocol record"; protocol law)
- **Claim:** "Vectors are **generated from property tests over the invariants**, not captured from
  whatever the implementation happened to emit. **The properties are the specification**; the vectors
  are its evidence."
- **Tree fact:** `crates/connector-vectors/src/lib.rs:1-3` — "Generates the committed cross-repo
  wire-vector set … **from fixed literal fixtures** run through the real implementations"; `:12-15`
  "Fixtures … are **literal**, non-secret bytes chosen only so this crate compiles to the same output
  every time it runs". `crates/connector-vectors/Cargo.toml:7-20` has **no `proptest` dependency at
  all** (four other crates do).
- **Category:** (a) · **Probable ruling:** amend the record — the shipped mechanism (fixtures
  self-verified against the same validators, `lib.rs:6-11`) is arguably _better_, but it is not what
  the ADR says. Protocol-law scope defaults to fix-the-code; the code here is deliberate and documented,
  so this is the case for amending _against_ the default. · **Confidence:** high

## F-43 — and the tree currently holds both readings at once

- **Record:** 0021
- **Tree fact:** `docs/protocol/client-edge-spec.md:5-8` sides with the **code** ("fixed literal
  fixtures … **not values literally emitted by a property-test run**"); `CONTEXT.md:198-202` sides with
  the **record** ("Vectors are generated from the properties, never captured…"). Whichever way F-42
  lands, these three must stop disagreeing.
- **Category:** (d) + (e) · **Probable ruling:** follows F-42 · **Confidence:** high

## F-44 — two `docs/protocol/` specs declare themselves Normative, against ADR 0021

- **Record:** 0021 (Accepted; protocol law)
- **Claim** _(offending side = the specs)_: `docs/protocol/peer-carriage-spec.md:3` — "**Status:**
  Normative for the carriage mapping"; `docs/protocol/peer-semantics-spec.md:3` — "**Status:** Normative
  for §3–§6", reinforced at `:33` and `:161`. Both declare RFC-2119 key words
  (`peer-carriage-spec.md:18-19`, `peer-semantics-spec.md:10-11`).
- **Tree fact:** ADR 0021 — "`crates/connector-vectors` is the contract; **`docs/protocol/` is not**";
  "Prose describing the wire continues to exist, and **says on its face that it is not normative**"
  (`:37`). `docs/adr/README.md:233` states it flatly for all five files. The two well-behaved siblings
  do say so: `wire-vectors.md:3` and `client-edge-spec.md:3` both read "**Status:** Non-normative."
  Each offending spec carries a _narrower_ local reconciliation (`peer-carriage-spec.md:6-9` — "where
  this prose and `vectors/wire-vectors.json` disagree about an encoding, the vectors are right") that
  the ADR index has never absorbed.
- **Category:** (d) · **Probable ruling:** fix the specs (record wins — protocol law), or amend 0021 to
  bless the narrower form · **Confidence:** high

## F-45 — the cross-repo vector contract has **no client-edge section**

- **Record:** 0021 (Accepted; protocol law), whose Context is written entirely about the client edge
- **Claim:** "A committed set of vectors … is the **cross-repo contract**. Every client SDK replays
  them as its own suite."
- **Tree fact:** `vectors/wire-vectors.json` has six sections — `envelope`, `giftwrap`, `fulfilment`,
  `claim`, `peer_carriage`, `channel_control_declaration`. There is **no client-edge carriage section**:
  zero occurrences of `wrapped` or `peer-id`, no client BTP frame, no client-edge HTTP header. The
  client BTP dialect "vectors" ADR 0026 points at are in-crate Rust unit tests only
  (`crates/connector-btp/src/frame.rs:414`, `:431-591`), which `toon-client` cannot replay. The peer
  carriage — operator-to-operator, both ends ours — is fully vectored and **dual-encoded** (20 cases,
  each carrying both `btp_*_hex` and `http_headers`/`http_body_hex`). The surface whose far end this
  repo cannot flag-day has nothing.
- **Category:** (b) · **Probable ruling:** **fix the code** — this is the exact inversion of ADR 0003's
  economics, which ADR 0021 was adopted to serve · **Confidence:** high

## F-46 — the client edge's identity and privacy mechanisms: no record, no vector

- **Record:** none — that is the finding
- **Tree fact:** two complete, live client-edge wire mechanisms with **zero occurrences across all 44
  records** and zero vectors:
  1. **Sender authentication.** `[[client_identities]]` (`id` + `secret`) at
     `crates/connector-config/src/config.rs:136-144` and `crates/connector-config/src/identity.rs:37-52`;
     the `ILP-Peer-Id` + `Authorization: Bearer <secret>` resolution and its `401` in
     `crates/connector-client-edge/src/lib.rs` and `claim_gate.rs`; wiring at
     `crates/connector-cli/src/runtime.rs:1656-1658,1986`; the anonymous fallback deriving an ephemeral
     peer id from the plaintext claim header's signer, or `http:anon`. Specified only at
     `docs/protocol/client-edge-spec.md:79-101` (non-normative).
  2. **The NIP-59 privacy-wrapped claim header** `ILP-Payment-Channel-Claim-Wrapped` —
     `crates/connector-signer/src/nip59.rs:62`, `client-edge-spec.md:114`.
- **Category:** (b) · **Probable ruling:** **open a record** (at minimum, vector both). This is the
  front door of the map's territory 7; the likeliest second implementer is a client SDK and it has
  nothing normative to build against. · **Confidence:** high

## F-47 — ADR 0026 calls `client-edge-spec.md` §1.9 "normative"

- **Record:** 0026 (Partly superseded by 0027; live architecture half; protocol law)
- **Claim:** "That dialect … is what **§1.9 specifies normatively**" (`:66`) and "See
  `docs/protocol/client-edge-spec.md` §1.9 for the current, **normative** frame grammar" (`:81-82`)
- **Tree fact:** `docs/protocol/client-edge-spec.md:3` — "**Status:** Non-normative."
- **Category:** (d) · **Probable ruling:** amend 0026 — 0021 is the declared tiebreaker and says prose
  is not normative; 0026's two references predate 0021 landing on that file · **Confidence:** high

## F-48 — ADR 0027's role rule vs `CONTEXT.md`'s: the glossary describes a _stronger_ test

- **Record:** 0027 (Accepted; protocol law)
- **Claim** _(record)_: "A session or request is a **peer** interaction if, and only if, it presented a
  credential configured in `[[peers]]` _and_ has a `[[peer_channels]]` entry binding it to a channel
  identity."
- **Tree fact:** the code implements the **record**, not the glossary: P2 is `if !entry.channel_bound`
  — a pure configuration fact — at `crates/connector-peer-auth/src/decision.rs:213`, inside
  `decide_role` (`:186`), which never verifies a claim signature. `CONTEXT.md:185-190` instead defines
  **Peer role** as "an interaction is a `peer` only if it is bound to a configured peer id **and carries
  a claim on one of that peer's channels that verifies against the counterparty key** that peering
  configures." `docs/protocol/peer-carriage-spec.md:137-140` concedes the same gap.
- **Category:** (e) · **Probable ruling:** **fix the glossary** — `docs/adr/README.md:236-237` is
  explicit ("fix the glossary, never the record"). This matters beyond wording: `CONTEXT.md` describes
  an admission test the tree does not perform. Contrast the well-handled "Covering claim" entry
  (`CONTEXT.md:232-233`), which _does_ mark its gap. · **Confidence:** high

## F-49 — ADR 0027's TLS claim vs `peer_allow_plaintext_endpoints`

- **Record:** 0027 (Accepted; protocol law)
- **Claim:** "The peer transport is now public-capable, **TLS-encrypted** and authenticated"; Decision
  — "`wss://` → BTP, `https://` → HTTP".
- **Tree fact:** `crates/connector-config/src/config.rs:87` — `peer_allow_plaintext_endpoints`, a
  node-wide switch under which `ws://` and `http://` resolve onto the two carriages
  (`crates/connector-config/src/peer.rs:107-116`), with a startup `WARN` naming every plaintext peering
  (`crates/connector-cli/src/runtime.rs:796-801`). No ADR mentions it; its only specification is
  `docs/protocol/peer-carriage-spec.md:1224-1235` (§12 item 8).
- **Category:** (b) · **Probable ruling:** amend the record — the switch is default-false,
  loopback/test-scoped, forbidden per-peer, and lives in the §12 amendment channel 0027 itself
  authorizes. A one-line note closes it; today the TLS claim reads as absolute. · **Confidence:** medium

## F-50 — ADR 0022's Decision leans on a premise ADR 0027 recorded as expired

- **Record:** 0022 (Accepted; protocol law)
- **Claim:** Decision, `:63-65` — "For peering the same endpoint serves: **both ends of a peer wire are
  operator-controlled by definition**, so two operators who have decided to peer exchange endpoints out
  of band and verify over a direct connection."
- **Tree fact:** verbatim the premise ADR 0027 records as expired —
  `docs/adr/0027-…md:79-84` ("**3. ADR 0003's load-bearing premise has expired** … The moment a third
  party runs a connector, 'both ends are ours' is false"). The tree agrees:
  `crates/connector-peer-auth/src/decision.rs:186` exists precisely because a counterparty is no longer
  trusted by virtue of being on the wire. ADR 0022's Status line flags **only** the "private, plaintext
  and unauthenticated" _consequence_ as superseded, not this Decision clause.
- **Category:** (c) · **Probable ruling:** amend the record — 0022's Status under-reports what 0027 took
  from it. The decision itself ("a connector answers, it does not announce") survives untouched; one
  sentence of its peering rationale does not. · **Confidence:** medium

## F-51 — `GET /ilp/versions` is specified in the present tense and does not exist

- **Record:** 0003 (client-edge half Accepted; protocol law) — the spec-side sibling of #1054
- **Claim** _(doc)_: "`GET /ilp/versions` **is** unauthenticated … and **returns**:
  `{ "supported": [1, 2], "default": 1 }`" — `docs/protocol/client-edge-spec.md:1126-1132`
- **Tree fact:** the router mounts six routes and `/ilp/versions` is not among them
  (`crates/connector-client-edge/src/lib.rs:425-430`). So a client cannot even _ask_ what versions
  exist, let alone address one.
- **Category:** (a)/(d) · **Probable ruling:** fold into **#1054** rather than filing separately
  · **Confidence:** high

## F-52 — the versioning gap is two carriages wide, not one endpoint wide

- **Record:** 0003 / 0026 — second sibling of #1054
- **Claim:** 0026 `:66-67` — TRANSFER etc. are added "to a transport **ADR 0003 already versions**
  behind the client edge's own discipline"
- **Tree fact:** `GET /ilp/btp` (`crates/connector-client-edge/src/lib.rs:426`) is unversioned exactly
  as `POST /ilp` is, and the BTP dialect carries no version field or negotiation —
  `crates/connector-btp/src/frame.rs` has no version byte, and `AUTH_PROTOCOL` handling in
  `crates/connector-client-edge/src/btp.rs` negotiates nothing.
- **Category:** (a) · **Probable ruling:** state on **#1054** — the gap is wider than the ticket
  currently reads · **Confidence:** high

## F-53 — ADR 0023's "the argument is historical" flag, and a second in-repo OER encoder

- **Record:** 0023 (Accepted; protocol law). _Its canonicality rule is fully honoured — `decode_var_uint`
  re-encodes and compares before accepting (`crates/connector-domain/src/oer.rs:56-58`), with three
  matching invalid-envelope vectors committed._
- **Claim:** Status — "its 'safe for the wire' argument reasons from
  `packages/shared/src/encoding/oer.ts` … **that package is no longer in this repository** … **The
  argument is historical**; the canonicality rule is not."
- **Tree fact:** the named file is indeed gone (`git ls-files packages/shared` → empty; only
  `packages/shared/dist/` survives untracked) — that half is accurate. But a **new tracked TypeScript
  OER encoder** has since landed: `packages/announcer/src/oer.ts:23` `encodeVarUint`, self-described at
  `:15-18` as a "byte-for-byte port of the three primitives connector-domain's `oer.rs` documents". It
  emits canonical form and is exercised by `packages/announcer/src/oer.test.ts`, but is **pinned by
  nothing in `vectors/wire-vectors.json`**.
- **Category:** (c) for the Status flag, (b) for the unpinned second producer · **Probable ruling:**
  amend the Status flag; separately the announcer encoder is a live cross-language consumer of the
  canonicality rule and belongs in the vector set under 0021 · **Confidence:** medium

---

# E. `docs/protocol/` prose vs the records

## F-54 — `peer-semantics-spec.md` §3.4 teaches exposure and the ceiling as live, unbannered

- **Record:** 0033 (Accepted; protocol law)
- **Claim** _(spec)_: "It does mean the payee now holds **unclaimed exposure** to the payer it cannot
  account for; a connector SHOULD stop forwarding… (this is the same mechanism as **the ceiling in
  §5.3**, applied to a payer that has become unable to pay)" —
  `docs/protocol/peer-semantics-spec.md:134-139`
- **Tree fact:** §3.2, §3.3 and §5.3 each carry a supersession banner; **§3.4 has none** (`:124-139` is
  unmarked prose). `docs/protocol/peer-carriage-spec.md:29` _declares_ §3.2–§3.4 superseded — so the two
  specs disagree about whether §3.4 is live. `crates/connector-domain/src/projection.rs:48,152` keep
  `InboundFulfillmentRecorded` as a historical, no-longer-produced kind.
- **Category:** (d) · **Probable ruling:** fix the doc — banner §3.4 the way its siblings are
  · **Confidence:** high

## F-55 — `peer-semantics-spec.md` §6 claims retired vocabulary as its own

- **Record:** 0033 (Accepted; protocol law)
- **Claim** _(spec)_: "This specification uses exactly the vocabulary of `CONTEXT.md` (… **exposure,
  ceiling, flush** …) and implements [ADR 0003] …" — `docs/protocol/peer-semantics-spec.md:350-353`
- **Tree fact:** `CONTEXT.md:242,249,264` marks all three **retired terms**. The sibling
  `peer-carriage-spec.md:1244-1248` handles this correctly ("of which _exposure_, _ceiling_ and _flush_
  are retired terms per ADR 0033 and appear above only in clauses marked retired"). §6 also claims to
  implement ADR 0003, whose peer-wire half is dead.
- **Category:** (d) · **Probable ruling:** fix the doc (copy the carriage spec's §13 hedge)
  · **Confidence:** high

## F-56 — `peer-semantics-spec.md` §5.4 teaches ADR 0031's greeting gate as universal

- **Record:** 0031 (superseded) / 0042
- **Claim** _(spec)_: "since issue #880 (ADR 0031) a peer-role PREPARE with no covering claim, or with
  one that does not cover this route's price, is greeted one layer up" —
  `docs/protocol/peer-semantics-spec.md:337-339`; and the note at `:341-346` — "**a claimless one now
  is**." Also the §5.3 banner's justification at `:311-313`.
- **Tree fact:** the gate fires **only at a priced `Terminated` route**
  (`crates/connector-peer-http/src/accept.rs`, `connector-peer-btp/src/price_gate::payment_required`),
  which `peer-carriage-spec.md:141-149` itself states. A claimless _forwarded_ peer PREPARE is admitted.
- **Category:** (d) · **Probable ruling:** fix the doc (narrow to "at a priced termination"), per 0042
  · **Confidence:** high

## F-57 — deleting §1–§2 of `peer-semantics-spec.md` orphaned two live code citations

- **Record:** 0027 (Accepted; protocol law) — which deleted §1–§2
- **Claim** _(offending side = code)_: two live doc comments cite a section that no longer exists:
  `crates/connector-signer/src/signer.rs:89` — "a peer's claim-verification key, per
  `docs/protocol/peer-semantics-spec.md` **§1.1**"; and
  `crates/connector-runtime/src/connector.rs:789` — "issue #423, peer-semantics-spec.md **§1.1**'s 'a
  configured peer id and verification key'".
- **Tree fact:** `docs/protocol/peer-semantics-spec.md:24` — "**§1 Framing and §2 Packet structure are
  therefore gone.**" The spec's own justification for not renumbering (`:35-37`) enumerates only §3+
  citations and missed these two, which now resolve to nothing.
- **Category:** (a) · **Probable ruling:** fix the code comments · **Confidence:** high

## F-58 — `peer-carriage-spec.md` §6.3 states a normative rule over a retired key, and §11 says so

- **Record:** 0033 (Accepted; protocol law)
- **Claim** _(spec)_: "`claimAckTimeoutMs` **SHOULD** be less than or equal to `flushIntervalMs` … a
  configuration where it is greater **MUST** at least be a load-time warning." —
  `docs/protocol/peer-carriage-spec.md:766-768`
- **Tree fact:** `flush_interval_ms` is a rejection trap only
  (`crates/connector-config/src/error.rs:544-549`, `ConfigError::PeerFlushIntervalRemoved`); no such
  warning exists. The same document contradicts itself at `:1164-1165`: "`AcceptOnlyPeerWithoutCeiling`
  and the `claim_ack_timeout_ms > flush_interval_ms` load-time warning (§6.3) are retired."
- **Category:** (d) · **Probable ruling:** fix the doc (strike the clause) · **Confidence:** high

## F-59 — `peer-carriage-spec.md` §5.3 / §6.4 cite ADR 0031 as the bound that replaced the ceiling

- **Record:** 0031 (superseded) / 0042
- **Claim** _(spec)_: "an accept-only peering now loads with no ceiling-shaped config at all, **bounded
  only by the covering-claim requirement every peering already carries (ADR 0031)**" —
  `docs/protocol/peer-carriage-spec.md:683-684`; repeated at `:812-814`.
- **Tree fact:** as F-56 — the requirement holds only at a priced termination. The real bound on an
  accept-only peering today is `max_packet_amount` (0042's cap), documented in the same file at
  `:1118-1124`.
- **Category:** (d) · **Probable ruling:** fix the doc (re-point at the cap) · **Confidence:** high

## F-60 — `peer-carriage-spec.md` §1.10 and I7 still hang the role rule on P1

- **Record:** 0027 (Accepted; protocol law), as amended
- **Claim** _(spec)_: "role is **still** decided by **P1 and P2** on that listener" —
  `docs/protocol/peer-carriage-spec.md:430`; and "**I7 — One role decision.** §1: the same **P1/P2
  rule**…" — `:983`.
- **Tree fact:** §1.2 at `:126-135` retires P1 as a role requirement and replaces it with P2+P3; §1.3 at
  `:269` says "Role is decided by P2 and a verified claim, or it is `client`." Two sections were amended,
  two were not.
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

## F-61 — `peer-carriage-spec.md` §1.2 states as "if and only if" a rule §10's own vector contradicts

- **Record:** 0021 (vectors are normative, prose is not); 0031→0042
- **Claim** _(spec)_: "An interaction has role `peer` **if and only if both** … **P3 — a verified
  claim**" (`:88-95`) and "Under #868 a peer PREPARE carrying no covering claim **is not admitted at
  all**" (`:100-101`) — while §10.2 item 6 requires a vector "`peer_prepare_no_claim` _(pair)_ … so
  **'claimless is legal' is pinned** rather than assumed" (`:1043-1044`).
- **Tree fact:** the spec concedes the code at `:137-140` ("`connector_peer_auth::decide_role` still
  implements the P1/P2 branch table… role itself is not yet decided from a verified claim"), confirmed
  at `crates/connector-peer-auth/src/decision.rs`. Under ADR 0021 the vector is the contract and §1.2 is
  the bug.
- **Category:** (d) · **Probable ruling:** fix the doc — state the rule as _target_, the way ADR 0042
  does, rather than as "if and only if" · **Confidence:** high

## F-62 — `wire-vectors.md`'s Scope section is stale on three counts

- **Record:** 0021 (Accepted; protocol law) and 0003 (peer-wire half dead)
- **Claim** _(doc)_: "**Nothing else about the peer semantics is in scope here**: it is
  operator-to-operator on both ends (**ADR 0003**), **already normative prose** for a different reason,
  and the rest of it is out of this issue's scope." — `docs/protocol/wire-vectors.md:19-21`
- **Tree fact:** (1) `vectors/wire-vectors.json` **does** now carry a `peer_carriage` section, required
  by `peer-carriage-spec.md:1001-1007` — the scope sentence is false of the file it describes. (2) It
  cites ADR 0003, whose peer-wire half is superseded by 0027. (3) "already normative prose" is exactly
  what ADR 0021 forbids, and this document's own Status line says the opposite (`:3`).
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

## F-63 — `channel_control_declaration` is a committed vector section nothing describes

- **Record:** 0021 (Accepted; protocol law)
- **Tree fact:** generated and self-verified at `crates/connector-vectors/src/lib.rs:1578-1799` (three
  cases: `_valid`, `_wrong_key`, `_expired`), present in `vectors/wire-vectors.json`, referenced only in
  passing at `docs/protocol/client-edge-spec.md:857`. `docs/protocol/wire-vectors.md`'s "Scope"
  (`:12-21`) and "Invariants" (`:23-95`) never mention it, and no ADR does. Under ADR 0021 this is
  **normative contract with no prose at all**.
- **Category:** (b) · **Probable ruling:** fix the doc (`wire-vectors.md`); consider a record
  · **Confidence:** high

## F-64 — two specs point at `money-model.md` without saying it is superseded

- **Record:** 0033 / 0042
- **Claim** _(spec)_: "**How the claim exchange below fits into value moving end to end…:**
  [`money-model.md`](money-model.md)." — `docs/protocol/peer-semantics-spec.md:12-13`, and the same
  unqualified pointer at `docs/protocol/peer-carriage-spec.md:10-11`.
- **Tree fact:** `docs/protocol/money-model.md:3` — "**Superseded 2026-08-07 through 2026-08-10…**".
- **Category:** (d) · **Probable ruling:** fix the docs (one clause) · **Confidence:** medium

## F-65 — `client-edge-spec.md` cites ADR 0013 (spent) as live authority, twice

- **Record:** 0013 (Partly superseded by 0017, otherwise **spent** — the fleet was switched off, #872)
- **Claim** _(doc)_: "per [ADR 0013], the old fleet stays up until nothing addresses its prefix" —
  `docs/protocol/client-edge-spec.md:1109`; and §3.4 "…mirroring [ADR 0013]'s treatment of the peer-role
  cutover" — `:1157`.
- **Tree fact:** `docs/adr/README.md` — "**Spent.** The migration completed (#872): the TypeScript
  prefix and fleet are gone." The spec's client-edge-version retirement policy is anchored on a record
  whose subject no longer exists. Same shape as F-72: a live doc leaning on a dead record.
- **Category:** (d) · **Probable ruling:** fix the doc — the retirement policy needs its own anchor
  · **Confidence:** high

## F-66 — `client-edge-spec.md` §1.4 says no settlement address is configured; the greeting publishes several

- **Record:** — (a spec and a code comment both falsified by the tree)
- **Claim** _(doc)_: "There is no per-chain `exact` scheme entry naming a settlement `asset`/`payTo`
  address, for EVM, Solana or any other chain, **because no settlement address is configured anywhere in
  this connector yet**" — `docs/protocol/client-edge-spec.md:534`. The same sentence is in the code:
  `crates/connector-domain/src/x402.rs:34-36`.
- **Tree fact:** settlement addresses are configured per chain and are published on every greeting.
  `crates/connector-cli/src/runtime.rs:1247-1259` builds
  `X402SettlementTerms { chain, settlement_address: format!("{:#x}", backend.own_address()),
token_network_registry, token_network, token_address, decimals }` into `extra.settlement` /
  `extra.settlements`; `crates/connector-domain/src/x402.rs:220-221` declares
  `#[serde(rename = "settlementAddress")] pub settlement_address: String`. The `[settlement]` section is
  1,035 lines (`crates/connector-config/src/settlement.rs`). §1.4 contradicts itself: the same paragraph
  that denies settlement addresses then lists `settlement`/`settlements` among the `extra` fields a node
  publishes.
- **Category:** (d) + (b) · **Probable ruling:** fix the doc and the code comment. **Direct sibling of
  #1055** — same file, same shape: a stale "this fleet does not do X" sentence in `x402.rs` the tree has
  since falsified. · **Confidence:** high

---

# F. Payload, envelope and termination

## F-67 — ADR 0018: a reject raised _at_ the termination is not always sealed

- **Record:** 0018 (Accepted; protocol law)
- **Claim:** "**On a FULFILL, and on a REJECT raised at the termination**, the terminating connector
  seals its answer back with that same shared secret." / "A sealed reject is **authenticated** … a
  sender can finally distinguish _'the destination said no'_ from _'someone on the path said no.'_"
- **Tree fact:** `crates/connector-runtime/src/connector.rs:46-54` (`unsealed_termination_reject` →
  `F01`, `data: Vec::new()`, unsealed), reached from `:2014-2022` (`open_termination_request`: no
  identity key configured, or a wrap that fails to open). Both are rejects raised _at_ the termination
  and both are plaintext.
- **Category:** (e) — **`CONTEXT.md` is correct and the record is not**: `CONTEXT.md:131-140` already
  carries the carve-out ("an **unsealed** reject proves nothing about who refused, because a termination
  that never recovered the secret … also answers in plaintext. Sealed identifies the destination;
  unsealed identifies nobody.")
- **Probable ruling:** amend the record — the code is the safe behaviour, the glossary already states
  the correct law, and 0018's own implementation comment at `connector.rs:1971` spells out the
  carve-out. **Confidence:** high

## F-68 — ADR 0018: the sealing key is not reported at `GET /identity`

- **Record:** 0018 (Accepted; protocol law)
- **Claim:** "the sender seals to the terminating connector's identity key … (`connector-signer`,
  uncompressed secp256k1, **reported at `GET /identity`**)"
- **Tree fact:** the sealing key is answered at `GET /ilp/identity`
  (`crates/connector-client-edge/src/lib.rs:428`). `GET /identity` is the operator surface's
  **bearer-gated** endpoint for a different audience (`crates/connector-operator/src/lib.rs:124`).
  `docs/protocol/client-edge-spec.md:687-691` states the distinction explicitly. A sender following 0018
  literally hits a bearer-gated operator endpoint.
- **Category:** (d) · **Probable ruling:** amend the record · **Confidence:** high

## F-69 — ADR 0018: stale line citation

- **Record:** 0018 (Accepted; protocol law)
- **Claim:** "`packet.rs:388` asserts the running total does not ride the OER encoding but beside it"
- **Tree fact:** `crates/connector-domain/src/packet.rs:381-389` is now
  `prepare_decode_rejects_wrong_type_byte`. The invariant lives at `:464`
  (`accumulated_cost_does_not_ride_the_oer_wire_encoding`) and is stated at `:267` and `:280`.
- **Category:** (c) · **Probable ruling:** amend the record (cite the test by name, not by line)
  · **Confidence:** high

## F-70 — ADR 0019's Status claim about `TOON-Fulfillment`

- **Record:** 0019 (Accepted; protocol law)
- **Claim:** Status — "The `TOON-Fulfillment` header it retires is **gone from `crates/`**."
- **Tree fact:** `crates/connector-runtime/src/app_client.rs:887,896,910` — a live test
  `an_ordinary_response_header_is_relayed_verbatim` deliberately sends `toon-fulfillment` and asserts it
  is relayed as an ordinary header. Behaviourally the record is right (no code reads it; `AppOutcome`
  has no `Delivered` variant and `decode_fulfillment_header` does not exist anywhere in the repo — both
  verified absent). The grep-shaped claim is what is wrong, and a future audit will re-derive this.
- **Category:** (c) · **Probable ruling:** amend the record ("no code reads it" rather than "gone from
  `crates/`") · **Confidence:** medium

## F-71 — `README.md` contradicts ADR 0040 outright

- **Record:** 0040 (Accepted; protocol law) and 0019
- **Claim** _(offending side = `README.md`)_: `README.md:48-49` — "The app supplies no preimage and is
  told nothing about the payment — no `TOON-Fulfillment`, no `X-TOON-Payer`, **no headers of any kind
  that this connector adds**."
- **Tree fact:** `crates/connector-runtime/src/attribution.rs:43-51,108-119` states
  `X-TOON-Payer`/`X-TOON-Amount`/`X-TOON-Chain` on a verified delivery. ADR 0040's own Consequences list
  the docs it reconciles; `README.md` was missed. `docs/protocol/client-edge-spec.md:729-753` **is**
  reconciled.
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

## F-72 — `docs/operators/parallel-fleet-comparison.md` contradicts ADR 0040 and ADR 0025

- **Record:** 0040, 0025
- **Claim** _(the doc, in a block headed "What the Rust connector does now")_: "No
  `X-TOON-Payer`/`-Amount`/`-Chain` … the app is told nothing about the payment at all"
  (`:88-89`) and "The request path is `handler_url` **joined with** the envelope's `target`" (`:86`).
- **Tree fact:** `crates/connector-runtime/src/attribution.rs:108-119` (headers are stated) and
  `crates/connector-runtime/src/app_client.rs:73` (`resolve_target_under_handler`, explicitly _not_
  `Url::join`). _(The document's historical banner covers the fleet comparison, not the "what it does
  now" block.)_
- **Category:** (d) · **Probable ruling:** fix the doc · **Confidence:** high

## F-73 — ADR 0025: an invalid envelope method is reported as `Unreachable`/`T01`

- **Record:** 0025 (Accepted; protocol law)
- **Claim:** "`AppOutcome` gains a third variant, `Refused`, distinct from `Answered` … and
  `Unreachable` (**the app could not be reached over the network**)"
- **Tree fact:** `crates/connector-runtime/src/app_client.rs:217-223` — an envelope whose `method` is
  not a valid HTTP method returns `AppOutcome::Unreachable`, which `connector.rs:2079-2085` maps to
  `T01` (peer unreachable), a **temporary** code. It is an envelope-shape defect, permanently bad, and
  the sender will retry forever. `envelope_target_would_be_refused` does not cover it either, so the
  covering claim is still spent.
- **Category:** (a) · **Probable ruling:** protocol law → record wins → **fix the code** (`F00`, like
  every other envelope-shape refusal 0025 introduced) · **Confidence:** medium

## F-74 — ADR 0025 does not cover the pre-admission refusal seam it owns

- **Record:** 0025 (Accepted; protocol law)
- **Claim:** "Refusal happens before any HTTP request is attempted — the app is never reached, so a
  refused target costs the payer nothing (see Pricing below)" — Pricing then only sets
  `accumulated_cost: 0`.
- **Tree fact:** `crates/connector-runtime/src/connector.rs:2250` `envelope_target_would_be_refused`
  (issue #869) opens the wrap and decodes the envelope _before_ the covering claim is admitted, at
  `crates/connector-client-edge/src/lib.rs:1188` and `crates/connector-client-edge/src/btp.rs:792`, so
  the claim is never ingested. This is referenced by ADR 0028 (`:91`) and ADR 0039 (`:86`) as "the
  pre-admission seam issues #869/#944 built for envelope-target refusals", but is nowhere in 0025 — the
  record that created the refusal.
- **Category:** (b) · **Probable ruling:** amend the record ("costs the payer nothing" now means
  something stronger than `accumulated_cost: 0`) · **Confidence:** medium

## F-75 — ADR 0032: the session registry _is_ touched before the overlap check

- **Record:** 0032 (Accepted; protocol law)
- **Claim:** Consequences — "a destination is checked against `Connector::client_route`'s `Terminated`
  kind _before_ `handle_prepare` **or the session registry** is touched at all"
- **Tree fact:** `crates/connector-client-edge/src/session_route.rs:85` calls
  `state.session_registry.resolve(...)` first; the overlap check is at `:101-108`. The `T00` therefore
  fires only while a session is actually bound — which matches the record's _Decision_ ("resolves to
  **both** … and a live client session") but not its Consequences sentence.
- **Category:** (c) · **Probable ruling:** amend the record (wording only; the behaviour is the safe one)
  · **Confidence:** high

## F-76 — ADR 0040: a fourth, partial-emit case the record's table does not describe

- **Record:** 0040 (Accepted; protocol law)
- **Claim:** the table stating all three headers, plus "**Nothing is stated where nothing was
  verified** … all three headers are absent."
- **Tree fact:** `crates/connector-runtime/src/attribution.rs:74-79,115-119` — if a channel key carries
  no `namespace:` prefix, `X-TOON-Payer` and `X-TOON-Amount` are stated but `X-TOON-Chain` is omitted.
  Unreachable in practice given the key format, but it is a documented-in-code case (`chain_of`'s doc
  comment) with no counterpart in the record.
- **Category:** (b) · **Probable ruling:** amend the record, or delete the defensive branch — trivial
  either way · **Confidence:** low

---

# G. The dead records, and who still leans on them

The four dead records — 0031 (superseded by 0042), 0037/0038/0039 (retired by 0043) — were verified
symbol by symbol. **The mechanisms are genuinely gone from `crates/`.** `[peer_sale]` is a rejection
trap only; `deliver_peer_sale`, the peer-sale route kind, the purchase lease and its reaper,
`max_purchased_rows`/`max_routes_per_payer`/`max_prefix_length`, and `require_claim` all return **zero**
live occurrences. Routes have no `kind` field at all — shape is derived from `handler_url` vs `peer_id`.
A repo-wide grep of `deploy/`, `infra/`, `scripts/`, `README.md` and `docs/` for purchasable-peering
vocabulary returns zero hits. **ADR 0037/0038/0039's Status lines are accurate** (modulo F-18).

What is _not_ clean is who still cites ADR 0031 as live law.

## F-77 — `CONTEXT.md` cites ADR 0031 as the reason exposure no longer arises

- **Record:** 0031 (Superseded by 0042)
- **Claim** _(offending side = `CONTEXT.md`)_: "With a covering claim mandatory on every peer PREPARE
  **(ADR 0031)**, this state no longer arises in normal operation and nothing tracks it." —
  `CONTEXT.md:245-246`
- **Tree fact:** ADR 0042's Status — "Not built: requiring a covering claim on **forwarded** arrivals …
  Until those land, forwarding runs [0004]'s model end to end." The covering-claim gate exists only at a
  priced termination (`crates/connector-peer-http/src/accept.rs:154`,
  `connector-peer-btp/src/price_gate`), and `Connector::handle_peer_prepare` still takes
  `claim: Option<WireClaim>`. Both halves are wrong: the citation names a dead record, **and** the state
  does still arise for forwarding — only the _tracking_ is gone.
- **Category:** (e) · **Probable ruling:** fix the doc (cite 0033 for "nothing tracks it", 0042 for the
  rule; drop the 0031 causal claim) · **Confidence:** high

## F-78 — an _Accepted_ record leans on 0031 as binding law

- **Record:** 0035 (Accepted; protocol law) citing 0031
- **Claim** _(offending side = 0035)_: "[ADR 0031] **requires** every peer PREPARE to arrive with its
  own covering claim, signed fresh on the channel between that one pair of connectors" —
  `docs/adr/0035-…md:98-100`
- **Tree fact:** 0031 is superseded entirely; its Decision "was false of the shipped binary"
  (`docs/adr/0031-…md:3,7-14`). 0035 also says "peer-wire claim" — a retired term.
- **Category:** (c) · **Probable ruling:** amend the record (0035's own argument survives; re-point at 0042) · **Confidence:** high

## F-79 — shipped user-visible text states 0031's rule as present-tense fact

- **Record:** 0031 / 0042
- **Claims** _(offending side = the doc or the shipped string)_:
  - `crates/connector-config/src/error.rs:534-536` — user-visible **load error**: "removed once **every
    peer PREPARE carries its own covering claim** (ADR 0031, ADR 0033, issue #882)". Same at `:545-548`.
  - `crates/connector-runtime/src/metrics.rs:55` — **`/metrics` HELP text**: "**every peer PREPARE now
    carries its own covering claim**, so there is no trailing exposure to report."
  - `deploy/connector-rust/connector.toml:165-167` — in the **shipped config template**.
  - `docs/operators/btp-peer-transport-bringup.md:12-13`; `docs/operators/claim-policy-rollout.md:17`.
  - `docs/embedded-connector-peer-relation-contract.md:210-211` — "[ADR 0031] makes coverage
    **universal on the peer path and explicitly not configurable**" — contradicted twice over: 0042 says
    it is not universal, and `ClaimEnforcement::Observe` _is_ the configurability this sentence denies.
- **Tree fact:** as F-77.
- **Category:** (a) — a record's mechanism the tree lacks, restated as fact in shipped text
- **Probable ruling:** **fix the docs and the strings.** The metrics HELP string and the config load
  errors are **shipped user-visible text**, not comments. · **Confidence:** high

---

# H. `CONTEXT.md` vs the records

> The index's own rule: "When they disagree, the record is the older document and the glossary is what
> the project settled on; **fix the glossary, never the record**." Every finding here is therefore a doc
> fix by default — but three of them assert mechanisms the tree does not have, which is a different
> failure from vocabulary drift.

## F-80 — the "Cap" entry says a peering can be bought, and that a cap is earned

- **Record:** 0043 (Accepted) and 0042 (Accepted)
- **Claim** _(`CONTEXT.md:257-259`)_: "The cap is how far a connector trusts a peer… **a peering that
  has just been bought** starts at the floor, **and a path that keeps fulfilling earns a larger one**."
- **Tree fact:** (1) ADR 0043:7 — "**A peering cannot be bought.**" ADR 0042 corrected this exact
  sentence ("ADR 0043 removed that premise outright") and now reads "**a new peering starts at the
  floor**" (`docs/adr/0042-…md:62-73`); `CONTEXT.md:163-164`'s own "Peering" entry agrees ("It cannot be
  bought, learned, earned or announced into existence"). The glossary contradicts itself. (2) The cap is
  **static configuration read once** — `crates/connector-runtime/src/connector.rs:644-649`
  (`peer_packet_caps.get(peer_id).copied().unwrap_or(DEFAULT_MAX_PACKET_AMOUNT)`), written only from
  config at `crates/connector-cli/src/runtime.rs:1203` off `max_packet_amount`
  (`crates/connector-config/src/peer.rs:600`). **Nothing raises it on fulfilments.**
- **Category:** (e) · **Probable ruling:** fix the doc — drop the "bought" clause (0042's correction
  never propagated) and the earned-cap sentence · **Confidence:** high

## F-81 — the "Peer role" entry states a stronger admission test than the tree performs

_(See F-48 for the full evidence — filed there because it is also the ADR 0027 finding.)_

## F-82 — the "Journal" entry: the journal is not the only money state the connector persists

- **Record:** 0005 (Accepted; connector architecture)
- **Claim** _(`CONTEXT.md:278`)_: "It is **the only money state the connector persists**, which is why
  recovery is replay rather than reconciliation between two stores that can disagree." ADR 0005 says the
  same in its Decision and at `:32-33`.
- **Tree fact:** `state_dir` holds **five** durable stores
  (`crates/connector-cli/src/runtime.rs:731-741`): `peer-claims.log`, `client-edge-claims.log` (the two
  journals, covered by 0005), the runtime peer/route table (covered by 0034), **`evm-channel-index.json`**
  (F-83), and the **outbound client ledger** — a per-next-hop durable **nonce floor** opened at
  `runtime.rs:1017-1020`, whose module header (`crates/connector-runtime/src/outbound_client.rs:1-60`)
  states "**Two ledgers, and why they must never merge**", "the watermark authority is the receiver", and
  "this ledger persists, per next hop, the highest nonce it has ever **issued**". That is money state, in
  a second store, that recovery _does_ reconcile against the receiver.
- **Category:** (e) + (a) · **Probable ruling:** fix the doc, **and amend ADR 0005** — the "only money
  state" claim is now false in both artifacts · **Confidence:** high

## F-83 — the EVM channel index: a durable chain-scanning subsystem no live record covers

- **Record:** none — that is the finding
- **Tree fact:** `EvmChannelIndex` / `EvmChannelIndexSyncer` / `IndexedEvmChannelSource` — a durable
  on-disk index (`evm-channel-index.json`, `crates/connector-cli/src/runtime.rs:741,776-785`) built by a
  backfill-then-poll background task over the settlement contract's own logs, spawned for the life of
  the process at `runtime.rs:1272-1287`, with its own config knobs (`channel_index_confirmations`,
  `channel_index_from_block`) and a fail-closed load error (`RuntimeError::EvmChannelIndexUnusable`).
  Its **only** live documentation is `docs/protocol/client-edge-spec.md:397-398`, a non-normative spec.
  Its only ADR mentions are inside two **retired** records — `docs/adr/0038-…md:96` and
  `docs/adr/0039-…md:117`.
- **Category:** (b) · **Probable ruling:** **open a record.** Same shape as the already-known
  `unresolvable_lookup_budget_*` fog: a load-bearing subsystem whose only description is non-normative.
  · **Confidence:** high

## F-84 — the outbound client ledger's design rules exist only as a Rust module header

- **Record:** none covers the design; ADR 0042's Status covers only that the send half is built
- **Tree fact:** `crates/connector-runtime/src/outbound_client.rs:1-60` states four rules that read as
  protocol law and appear in no record and no glossary term: the two-ledger separation ("they must not
  become one"), the receiver as sole watermark authority ("**never** taken from anything this node
  remembers"), the nonce floor as "exactly one number" the payer remembers, and the keying decision
  ("by next-hop **peer id** rather than by channel on purpose: one hop reached over several routes is
  still one nonce line"). `CONTEXT.md`'s "Watermark" entry (`:274`) defines the watermark per
  **channel**, with no term for a payer-side, per-**peer** nonce floor.
- **Category:** (b) + (e) · **Probable ruling:** **open a record** (and add a glossary term). Not a
  re-litigation of 0042's unbuilt half — this is the _built_ half's design, undocumented outside one
  module. · **Confidence:** high

## F-85 — the "Probe" entry vs a distinct probe ingress

- **Record:** 0011 (Accepted; protocol law)
- **Claim:** ADR 0011:10 — "**Probes are not a distinct packet type**, and fee accumulation is not a
  special mode"; `:16` — "It is an ordinary packet, routed by the ordinary routing table."
  `CONTEXT.md:318` — "Not a distinct kind of packet — only a way of using one."
- **Tree fact:** `POST /ilp/probe` is a distinct route with its own handler and its own authorization
  outcome (`crates/connector-client-edge/src/lib.rs:427`, `handle_probe` at `:1309`), returning `403` on
  three separate denials (no usable claim, no open channel, rate limited) that `POST /ilp` cannot
  produce, and validating the claim "against a price of `0`" (`:1305-1308`). The _packet_ is ordinary;
  the _ingress_ is not. ADR 0011's two conditions are correctly implemented — this is a vocabulary gap,
  not a behavioural one.
- **Category:** (e) · **Probable ruling:** fix the doc — "not a distinct kind of packet, though it has
  its own ingress and its own authorization" · **Confidence:** medium

## F-86 — `STORE_PEER_WIRE_BIND` is described as a live tombstone; it is not one

- **Record:** 0027 (Accepted; protocol law) — via `CONTEXT.md`'s retired-term entry
- **Claim** _(`CONTEXT.md:210-213`)_: the term still appears in "three places: … and
  **`STORE_PEER_WIRE_BIND` in `infra/`, the same tombstone convention. Deleting either identifier would
  let a stale config load with the key silently ignored.**"
- **Tree fact:** it is **gone**, not tombstoned. `infra/linode-store/.env.example:29` — "STORE_PEER_WIRE_BIND
  is **GONE** (ADR 0027, issue #679)"; `infra/linode-store/docker-compose.store.rust.yml:53` records its
  retirement. Unlike `peer_wire_addr`, which `connector-config` genuinely parses to reject, a
  docker-compose env var that no longer exists **is** silently ignored — the exact failure the sentence
  claims it prevents. (The "three places" count itself is fine.)
- **Category:** (e) · **Probable ruling:** fix the doc · **Confidence:** medium-high

---

# I. Index and vocabulary hygiene

## F-87 — ADR 0041 carries a fourth `**Scope:**` value the map's ruling default has no entry for

- **Record:** 0041 (Accepted)
- **Claim:** `**Scope:** deployment law for this fleet — not protocol.`
- **Tree fact:** the map's standing decision 2 keys the ruling default off three scope strings —
  _protocol law_, _connector architecture_, _fleet and operations_. Every other record uses one of the
  three verbatim; `docs/adr/README.md` files 0041 under "Fleet and operations". A fourth string means
  the scope-based default silently has no rule for one record. _(0041 itself is otherwise verified
  clean end to end.)_
- **Category:** (c) · **Probable ruling:** amend the record (one line) · **Confidence:** medium

## F-88 — `docs/adr/README.md`'s status-vocabulary table says five values and lists six

- **Record:** the index itself
- **Tree fact:** "## The status vocabulary / **Five values**, and they mean different things. **Three of
  them** still describe a live record." The table below has **six** rows (Accepted; Accepted, amended by
  N; Accepted in part; Partly superseded by N; Superseded by N; Retired by N), of which **four** describe
  a live-or-live-in-part record.
- **Category:** (c) · **Probable ruling:** fix the doc · **Confidence:** high

## F-89 — `CLAUDE.md` protects a set of names that no longer exist

- **Record:** — (terminology carve-out, adjacent to 0035)
- **Claim:** `CLAUDE.md`'s terminology note asserts the route-**termination** feature's types
  "`RouteTermination`/`RouteTerminationRegistry`/`RouteTerminationSink`, functions
  `resolveTermination`/`toRouteTermination`, the `termination` config fields, and `checkRequestBinding`
  … **are unchanged**."
- **Tree fact:** a repo-wide grep for all of those returns **zero hits** in `.ts` or `.rs`.
  `docs/protocol/client-edge-spec.md:583-584` says the same from the other side ("No
  `requireRequestBinding` config field, `RouteTermination` type … exists anywhere in `crates/`"). The
  carve-out is protecting names that no longer exist.
- **Category:** (b) · **Probable ruling:** fix `CLAUDE.md` · **Confidence:** high

---

# What checked out clean

Verified positively so nobody re-derives it:

- **ADR 0006** — discovery is absent from `crates/`; operator CRUD is live
  (`crates/connector-operator/src/lib.rs:117-146`); leased routes with TTL exist
  (`crates/connector-runtime/src/route.rs:117-123`) alongside 0034's durable runtime table; the lapsed
  `#867` sold-peering bullet is correctly declared dead. `connector announce` is sanctioned by ADR 0030.
- **ADR 0012** — `Signer`/`LocalSigner`/`KmsSigner` live; nothing named `Treasury` remains (the sole hit
  is a doc comment at `crates/connector-signer/src/lib.rs:22` recording the removal); no mnemonic or
  seed machinery in any connector crate.
- **ADR 0013** — no `packages/connector`; no `infra/` config carries the `/rust/` prefix (only
  `return 410;` tombstones at `infra/linode-relay/nginx/conf.d/node.conf:126` and
  `infra/linode-store/nginx/conf.d/node.conf:252`); all three cited operator docs exist.
- **ADR 0023's rule** — `decode_var_uint` re-encodes and compares before accepting
  (`crates/connector-domain/src/oer.rs:56-58`), overflow guard at `:43-45`; three matching _invalid_
  envelope vectors are committed. Fully honoured.
- **ADR 0024** — clean field for field. `connector_domain::claim_digest` is genuinely gone.
  `struct_hash` (`crates/connector-signer/src/claim_signature.rs:127-135`) hashes exactly the typehash at
  `packages/contracts/src/TokenNetwork.sol:41-42`; `ClaimBook` signs through it (`claim.rs:822,970`);
  `set_channel_domain` is the only domain entry point (`claim.rs:634`).
- **ADR 0025's confinement itself** — specifically hunted for a prefix-check defeat and none found.
  `resolve_target_under_handler` (`crates/connector-runtime/src/app_client.rs:73-107`) is concatenation,
  not a string-prefix comparison. `path_attempts_to_escape` (`:132-140`) checks the once-percent-decoded
  form; every spelling WHATWG treats as a double-dot segment (`..`, `%2e%2e` and case variants, `%2e.`,
  `.%2e`) decodes to `..` and is caught. Double-encoding survives the decode check but is handed **raw**
  to `set_path`, which does not decode, so it does not normalize out either. The #621 literal-restatement
  exception compares against the **raw** target, so `%2Fstore` correctly falls through to refusal.
- **ADR 0027's core** — both carriages exist and share **one** pipeline, not two:
  `crates/connector-peer-http/src/accept.rs:75` imports `connector_peer_btp::price_gate`, and both call
  the same `price_gate::payment_required` (`peer-btp/src/accept.rs:596`, `peer-http/src/accept.rs:316`),
  the same `claim_ack_to_emit`, the same `decide_role`, the same `AcceptedClaims`. Header/protocolData
  names are a single pairing table (`crates/connector-btp/src/frame.rs:129`). The raw-TCP wire is
  genuinely deleted; `peer_wire_addr` is a reject-only tombstone (`config.rs:56,365`,
  `error.rs:563`); `peer_wire.rs`/`network_peer_transport.rs` do not exist;
  `AcceptOnlyPeerWithoutCeiling` has **zero** occurrences.
- **ADR 0028** including the #1012 amendment — `over_carried_reject`
  (`crates/connector-client-edge/src/lib.rs:966-1004`) and `ClientClaimGate::roll_back` +
  `JournalEntry::InboundClaimRolledBack` (`claim_gate.rs:917-955`, `projection.rs:95`) both exist and
  are wired (`lib.rs:1226`).
- **ADR 0032's overlap refusal** — `session_route.rs:101-108` → `:319-334`, `T00` + `tracing::error!`,
  before `handle_prepare` or `deliver`. `Connector::client_route` (`connector.rs:2193`) does exclude
  leases, so the forwarding carve-out is automatic as the record claims.
- **ADR 0033's Status line** — verified true in every particular. `record_inbound_delivery`,
  `is_over_ceiling`, `ExposureView`, `GET /exposure`, `ProjectionDivergence`,
  `warn_if_claim_ack_outlives*`, `AcceptOnlyPeerWithoutCeiling`, `set_peer_channel` all absent from
  `crates/`; `ceiling`/`flush_interval_ms` survive only as traps (`peer.rs:636-639`);
  `InboundFulfillmentRecorded` folds to nothing (`projection.rs:155`); `toon_exposure` is a permanent
  zero. (Its _body_ carries F-29 and F-35.)
- **ADR 0034** — every named symbol exists and behaves as stated: `PeerRouteStore`
  (`peer_route_store.rs:215-219`, temp+`sync_all`+`rename`), `OwnedByConfig`/`UnknownPeerId`/`PeerInUse`,
  the exact `Leased(0) < RuntimePeer(1) < Peer(2) < App(3)` ordering (`connector.rs:253-259`),
  `source: Config|Runtime` tagging (`operator_view.rs:63,78`), all eight routes
  (`connector-operator/src/lib.rs:118-138`).
- **ADR 0035** — ships nothing, and nothing is there: no `RouteTermination`, `requireRequestBinding` or
  `checkRequestBinding` anywhere in `crates/`. (Its 0031 citation is F-78.)
- **ADR 0036** — `handle_prepare_with_client_channel` (`connector.rs:1226`), the span field
  (`:1236-1239`), both named tests (`:3082`, `:3107`), `ClientChannelRegistry`, `claim_gate.rs`,
  `client-edge-claims.log` all present.
- **ADR 0040's negative case** — verified, not assumed: `connector.rs:2866`
  (`a_delivery_no_claim_admitted_states_no_attribution`), `:2879`, `:2929`
  (`a_spoofed_payer_does_not_survive_an_unattributed_delivery`), plus the unconditional strip at
  `attribution.rs:93-97`, which genuinely runs before injection and on every delivery.
- **ADR 0041** — all four named workflows exist and do what the record says. `rust-release` is
  deliberately absent from `publish-connector-rust-image.yml`; `promote-to-fleet.yml:247` boots the
  candidate against **both** boxes' `connector-rust.toml` and classifies only
  `unknown field|missing field|is not valid TOML` as a refusal (`:290-296`); `fleet-health.yml` is cron
  `*/15` (`:136`) and opens a `needs:human`+`bug` issue (`:674-676`). `RawConfig` is genuinely
  `deny_unknown_fields` (`config.rs:28`).
- **ADR 0014's log half** — `correlation_id` = hex execution condition (`connector.rs:282,1234`); a
  single `info_span!("packet")` (`:1232`); JSON formatter + `RUST_LOG` filter
  (`crates/connector-bin/src/main.rs:11-18`); `Connector::finish` is the sole choke point
  (`:1553-1570`); label cardinality bounded, no per-peer/per-destination label anywhere.
- **ADR 0011's mechanism** — fee accumulation live (`connector.rs:1785`
  `reject.accumulated_cost += peer_route.fee()`), sum-only by construction (`accumulated_cost: u64`, no
  breakdown field anywhere), probe gated on a recognized channel + per-identity rate limit
  (`connector.rs:1404-1409`).
- **ADR 0020** — `insert_consistent_handler_price` / `ConfigError::ConflictingHandlerPrice`
  (`crates/connector-config/src/route.rs:378-396`, applied at `:463` and `:514`) genuinely enforces
  one-handler-one-price.
- **ADR 0022's decision** — nothing in the connector **process** pushes facts outward. `announce` is a
  CLI verb only (`crates/connector-cli/src/lib.rs:106,288`); no timer, no startup broadcast, nothing on
  the packet path. _(The fleet's compose-level loop is F-23, and it is a separate process.)_
- **ADR 0026's client half** — one router, one gate: `lib.rs:425-430` mounts `/ilp` and `/ilp/btp` on
  one `Router` over one `ClientEdgeState`; `claim_rejection_reject` (`:989`) and `x402_terms_body`
  (`:681`) are shared by both carriages (`btp.rs:58,604,691`). All five of its `## Update` blocks check
  out.

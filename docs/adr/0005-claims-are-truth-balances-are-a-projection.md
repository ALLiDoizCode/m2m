# Claims are the source of truth; balances are a projection

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

The connector durably persists only what is signed or otherwise irreversible — claims sent,
claims received with their watermarks, and fulfilments not yet covered by a claim. Per-peer
balances and credit-limit positions are an in-memory projection rebuilt from that journal on
start. There is no ledger abstraction and no TigerBeetle.

## Why

Under ADR 0004 the claim is the thing of value: signed, cumulative, superseding. A balance is
just an arithmetic consequence of the claims exchanged and the fulfilments since the last one.
Storing it as independent authoritative state creates a second thing that can disagree with
the first, and the reconciliation between them is work with no upside.

TigerBeetle is being dropped because it was never real. It appears nowhere in
`docker-compose*.yml`, `deploy/`, `infra/`, `config/connector.prod.yaml` or the `Makefile` —
only in `src/` and tests. Every deployed node has always fallen back to
`InMemoryLedgerClient`. What we actually carried was a `LedgerClient` port, two
implementations, a batch writer, an error-mapping layer, a dual-mode `AccountManager` and an
optional peer dependency, all to keep alive an option nobody exercised.

An official Rust client exists on the 0.16 line, so this is reversible if throughput ever
demands it. Re-adding a backend to a system with one concrete implementation is a bounded
task; carrying a port for a hypothetical second one is a permanent tax.

## Consequences

Recovery is replay, not reconciliation. On start the connector reads its journal and
recomputes balances. Correctness therefore depends on the journal being written before value
is considered moved, which is a much easier property to test than agreement between two
stores.

The projection must be reconstructible by pure code. That puts it in `connector-core` — no
async, no I/O — so the arithmetic that decides whether a peer is over its ceiling is
property-testable without a database, a chain, or a network.

Losing double-entry means losing its built-in `sum(debits) == sum(credits)` check. The
replacement invariant is that every peer's projected balance equals the delta between the
cumulative in its latest sent claim and its latest received claim, plus uncovered
fulfilments. That is checkable on every projection rebuild, and should be.

## Update (issue #709): the client edge's watermark is served on write, synced on a bound

**Narrowing, argued in the open, exactly as the issue asked.** "Correctness ... depends on the
journal being written before value is considered moved" (above) has always been read, in code
and in every doc comment that cited it, as "written _and `fsync`'d_" — `crates/connector-client-edge/src/claim_gate.rs`'s
own module doc said so verbatim until this update: "no service is rendered against an unfsync'd
watermark." That reading is now **false on purpose, on the client edge only**. A claim is served
once its journal entry is _written_; the `fsync` that makes it survive a crash follows
separately, batched, on the lesser of a configured number of watermark advances
(`journal_sync_max_advances`, default 100) or a configured delay
(`journal_sync_max_delay_ms`, default 10 ms). Measured motivation (`toon-meta/prototypes/mesh-shard-over-ilp/RESULTS.md`,
quoted in full in issue #709): one `fdatasync` is 72% of a paid packet's p50, 88% of its mean and
99% of its p99 on a real filesystem — 1,550× a bare `write()` — while the entire payment
cryptography layer (ECDSA recover, EIP-712, ECDH) costs a quarter of a millisecond. Verifying a
claim is cheap; making its watermark durable, synchronously, on the hot path, is not, and those
were always two separable decisions.

**Reproduced on this repo's own harness, before and after, on the same disk**
(`crates/connector-client-edge/tests/claim_gate_throughput.rs`, issue #686's own before/after
tool, `cargo test -p connector-client-edge --test claim_gate_throughput --release -- --ignored
--nocapture`). The sequential case (`sessions=1`) is exactly the shape the issue names as never
benefiting from group commit's batching, and it is the one that moves the most:

|                                      | sessions=1 claims/s | sessions=16 | sessions=64 | paced p50/p95/p99/max ms (10 sessions @ 50/s) |
| ------------------------------------ | ------------------- | ----------- | ----------- | --------------------------------------------- |
| before (write+fsync together)        | 1,358               | 5,189       | 5,926       | 1.0 / 2.1 / 2.2 / 3.2                         |
| after (write now, sync on the bound) | 2,225               | 5,825       | 6,112       | 0.7 / 1.6 / 1.8 / 2.1                         |

+64% sequential throughput, and every latency percentile down, on a disk far less fsync-punishing
than the prototype's own (this box's before/after gap is real but nowhere near the prototype's
1,550× write-vs-fsync step — consistent with the prototype's own caveat that the effect scales
with how expensive the underlying disk's fsync actually is). The concurrent cases (`sessions=16`,
`64`) move less, exactly as expected: issue #686's group commit already amortized their fsync
across a batch that formed from real concurrency; this change gives that amortization to the
`sessions=1` case group commit could never help.

**Scope: the client edge (`ClientClaimGate`), not the peer wire (`ClaimBook`).** The peer wire's
own group-committed journal (`crates/connector-runtime/src/claim.rs`) still writes and syncs
together via `Journal::append_batch`, unchanged by this update — issue #879 named that as a
distinct cost (a forwarded packet pays up to three synchronous `fdatasync`s) and filed it
separately as issue #710. This update, and the code it describes, touches only the packet a
_buyer_ pays this connector directly, which is what issue #709's own measurement is of.

**The risk moves onto this connector, and the bound is a liability ceiling, not a tuning knob.**
Under the pre-#709 design, a crash lost nothing an operator hadn't already made durable before
answering. Under this one, up to `journal_sync_max_advances` of the most recently accepted
watermark advances on a channel may not have reached disk when a crash happens — on restart the
watermark is _stale by exactly that many advances, never more_, so a claim already served against
one of them can be replayed and served again: delivered twice, redeemable once. Worst case,
per channel: `unsynced_depth × route price`. Two things keep this from being a silent, unbounded
tax:

- **The bound is enforced structurally, not statistically.** `GroupCommitter`'s write step never
  carries a channel's unsynced count past `journal_sync_max_advances` before forcing a sync — if a
  sync itself fails (a full or wedged disk), new admissions block behind a bounded retry rather
  than being served past the promised ceiling. The bound is exact for this reason: not a rolling
  average that happens to usually stay small, a number a reader can multiply by a route's price
  and get this connector's actual worst case.
- **The depth is operator-visible, per channel, before it ever needs debugging.** `POST
/ilp/claim-state` (`client-edge-spec.md` §1.10) now reports `unsyncedDepth` per channel
  alongside `available`/`cumulativeClaimed` — the same read surface an operator already polls,
  not a new one to learn. A channel sitting at a persistently high reading is either under
  sustained load or behind a sync that keeps failing (logged at `error`, naming the channel and
  the underlying I/O error, every time).

**The in-memory watermark itself never rolls back within a process lifetime for this reason.**
Before this update, a failed batch (which meant a failed _write+fsync_ together) rolled the
watermark back and refused every claim in it as `NotDurable`, because nothing had been served
yet. That still holds for a **write** failure. It does _not_ hold for a **sync** failure: by the
time a sync could fail, every claim it covers has already had its ticket resolved and its packet
served, so there is nothing left to refuse or unwind — only to log and retry. The only way a
live gate's watermark is ever behind what it once held is a restart, replaying only what the
journal actually has durable, and even then bounded by `journal_sync_max_advances`.

**Clean shutdown still flushes to zero**, restoring the pre-#709 guarantee at exactly the moment
it matters most: `ClientClaimGate::flush` forces every channel's outstanding sync, and the gate's
own `Drop` calls it automatically, so an orderly process exit (`connector-bin`'s new
`SIGINT`/`SIGTERM` graceful shutdown) always leaves the journal fully synced before the process
is gone — a crash is the only way to ever observe the bounded window this update opens.

**What is unchanged.** Every packet still arrives with its covering claim, verified in full
before anything is served (ADR 0031 stands verbatim); `crates/connector-client-edge/src/btp.rs`'s
claimless-packet rejection is untouched, and issue #709 explicitly withdrew the credit-window /
claimless-serving proposal an earlier draft of that issue carried (see connector#868, ADR 0031).
Nothing here reintroduces credit, surplus-banking, or a packet served without a claim covering
it — the only thing that moved is _when the claim's watermark advance reaches disk_, not whether
a claim was required to advance it at all.

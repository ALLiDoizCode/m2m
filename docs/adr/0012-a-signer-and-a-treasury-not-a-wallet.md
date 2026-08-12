# The connector holds a signer and a treasury, not a wallet

**Scope:** connector architecture — internal to this codebase. See the [ADR index](README.md).

Key handling collapses to one crate exposing a `Signer` — a local key or a key management
service backend, with rotation — and a treasury account that funds payment channels and pays
gas. Mnemonic recovery, seed management, human wallet authentication, the wallet database and
the fraud-detection rule engine are removed.

## Why

The existing `wallet/` and `security/` directories are two parallel stacks over the same four
concerns, each with its own key manager, audit logger, rate limiter and fraud detector. That
duplication is a symptom: nobody owned the concern, so it grew twice. Collapsing it required
first deciding what the connector actually needs, and the answer is much smaller than what is
there.

A connector needs to sign claims and settlement transactions, and needs an on-chain account to
collateralise channels and pay gas. It does not need mnemonic recovery flows, human
authentication, or 831 lines of seed management — those belong to an end-user wallet, and
`toon-client` is where end users are served.

The fraud rules are removed because they guess at invariants the protocol now enforces.
Double-spend detection is subsumed by the nonce watermark, which rejects any claim that does
not advance. Balance manipulation is subsumed by verifying the signature over the balance
proof. What remains — rapid channel closure, unusual settlement amounts, traffic spikes — are
observations about counterparties rather than defences, and belong to whatever watches the
network rather than to the thing forwarding packets.

## Consequences

Audit stops being a bespoke subsystem. Under ADR 0008 every operator write carries an RFC 9421
signature, and retaining that signature is a stronger audit record than a log line asserting
that something happened — it is non-repudiable and names a key.

Rate limiting moves to the edge, where the identity being limited is known, rather than living
as two implementations in two directories.

Custody remains a real blast radius: a compromised connector can sign claims up to existing
channel collateral, and can spend from the treasury. Keeping the treasury in-process was
chosen over an external funder because a connector that cannot open a channel cannot peer
without human intervention, which defeats the point of leased routes and an automated
controller.

> **The treasury component this ADR names never shipped, and is now removed.** Issue #556
> (2026-08) deleted `connector-signer::treasury` (`Treasury`, `ChainClient`,
> `TreasuryError` and the rest) outright: outside its own `#[cfg(test)]` module, it had
> exactly two references in the entire workspace — a `pub use` and a doc comment — and no
> caller on any running node in the Rust connector's life. The collateral job this section
> describes is done, and has been since #559/#542, by `connector-settlement`'s
> `SettlementBackend` (`fund`/`redeem`/`channel_state`), constructed in
> `connector-cli::runtime` and integration-tested against a real chain. Keeping an unwired
> second implementation of the same concern is exactly the "undocumented, unjustified
> machinery" [ADR 0033](0033-the-exposure-machinery-is-retired-not-restated.md) was written
> to stop accumulating, and that ADR's precedent — remove a component whose job is already
> done elsewhere, rather than restate it — is the one applied here. The **signer** half of
> this ADR's title is unaffected: `connector-signer::Signer`/`LocalSigner`/`KmsSigner` are
> unchanged.

# USDC on Mina: in-proof-enforcing token owner (design)

> Status: design + feasibility spike. Supersedes the SDK-enforced custody from
> #191/#192 (merged) once proven viable.

## Why

The merged Mina design (#191 + #192) makes the `PaymentChannel` zkApp
**accounting-only** and has the **SDK** build the `token.transfer(...)` updates,
because Mina's stock `mina-fungible-token` lets only the token owner move its
token (`Token_owner_not_caller`). Consequence: **the proof does not bind the
token payout to the channel's committed balances** — a wrong/malicious SDK or a
compromised channel key could brick or mispay a channel (it can't steal more than
escrowed, but accounting↔escrow can desync). EVM (`TokenNetwork`) and Solana (the
program) both bind payouts in-contract; Mina is the outlier.

**Decision:** move enforcement into a **custom token-owner zkApp** so the *proof*
(not the SDK) binds payouts to the channel commitment — matching EVM/Solana
trustlessness.

## The enforcement seam (verified in mina-fungible-token@1.1.0 + o1js 2.14.0)

- `FungibleToken.transfer(from,to,amount)` → `this.internal.send({from,to,amount})`.
- `approveBase(forest)` is the owner's gate over **every** token movement (enforces
  Σ balanceChange == 0, permissions unchanged).
- `TokenContract` exposes `this.internal.send(...)` — **the owner can author token
  movements**, and a subclass can add `@method`s that move tokens *while enforcing
  arbitrary constraints in the same proof*. Because the owner is the only actor
  that can move the token, gating the only escrow-moving path behind channel-rule
  checks makes desync impossible.

## Architecture

- **`PaymentChannel`** — unchanged state machine: `channelHash` (native,
  `Poseidon(A.x,B.x,nonce)`), `balanceCommitment`, `nonceField`, `channelState`,
  `depositTotal`, `closedAtSlot`, `settlementTimeout`. **No token logic.** The
  bare-deploy invariant (`E2E_MINA_ZKAPP_INDEX`, `Poseidon(apex,client,0)`) is
  preserved.
- **`UsdcChannelToken extends FungibleToken`** — the enforcer + mover:
  - `depositToChannel(channelAddr, amount, depositor)` — precondition
    `channel.channelState == OPEN`; `internal.send(depositor → channelEscrow,
    amount)`; runs in the same tx as `channel.deposit(amount, depositor)` and binds
    the moved amount to the accounted amount. Depositor signs.
  - `settleFromChannel(channelAddr, balanceA, balanceB, salt, A, B, nonce)` —
    preconditions binding to the channel's on-chain state:
    `balanceCommitment == Poseidon(balanceA,balanceB,salt)`,
    `depositTotal == balanceA+balanceB`, `channelState == CLOSING`,
    `channelHash == Poseidon(A.x,B.x,nonce)`, `currentSlot ≥ closedAtSlot+timeout`;
    then `internal.send(escrow → B, balanceB)` and `internal.send(escrow → A,
    balanceA)` (skip zero), and drive `channel → SETTLED`. **Payouts are forced ==
    committed balances inside the proof.**
- **Escrow** = the channel zkApp address's token account under the USDC `tokenId`.
  Its permissions are set (at first deposit) so the **owner's proof** can author
  sends from it — no per-settle holder/channel signature.

## Feasibility questions the spike MUST answer (before the full build)

1. Can a `FungibleToken` subclass `@method` author `internal.send({from: escrow,
   …})` authorized by the **owner's proof alone** (no escrow-holder signature),
   given escrow permissions set so only the owner can move it?
2. Can that `@method` **read another zkApp's (`PaymentChannel`) @state via account
   precondition** to bind `balanceA/balanceB/depositTotal/channelState/channelHash`?
3. Does coordinating the channel `→ SETTLED` transition + the token payout in one
   tx work (cross-account update or two method calls bound by precondition)?
4. Proving cost / constraint budget within reason (Mina nightly, not per-PR).

The spike proves these with a **minimal passing o1js test** (proofsEnabled:false):
a custom `FungibleToken` subclass moves escrowed tokens from a holder account to a
recipient *only* when an in-proof constraint holds, and **rejects** a tampered
amount. If a question hits an o1js wall (permissions, cross-account reads,
recursive-proof need), report it — that gates the rewrite.

## Supersedes / migration

Replaces #191's accounting-only-then-SDK-moves and #192's SDK-built transfers with
owner-enforced moves. #192's SDK reworks to call `depositToChannel` /
`settleFromChannel` (the channel key signature for settle likely goes away — the
owner's proof authorizes escrow movement). #194's adversarial tests carry over
(now the *contract* enforces what they assert). The nightly lightnet job validates
the new path on-chain.

## Risks

Proving cost (cross-account + token in one circuit); o1js custodial-escrow
permission model; preserving `channelHash` native + bare-deploy; migrating merged
code without regressing the EVM/Solana paths.

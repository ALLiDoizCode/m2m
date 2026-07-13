# RollingSwapChannel — post-#320 security decisions memo

Status: **maintainer decision required** — architectural findings from the security
review of PR [#320](https://github.com/toon-protocol/connector/pull/320)
(`packages/contracts/src/RollingSwapChannel.sol`).

This memo covers the four findings that need a **maintainer decision or cross-repo
coordination**, plus one trivial doc-fix flag. None of these are proposals to
change wire format or contract logic inside this memo — they are decisions to be
recorded, and (where a fix is chosen) coordinated migrations to be scheduled
across `connector` + `toon` (core/sdk) + `swap` + `toon-client`.

Scope note: the raw-keccak claim digest, the `updateBalance` selector/arity, and
the `SettlementSucceeded` event are **ABI-locked** — byte-for-byte what the
shipped sdk `buildEvmSettlementTx` and client `submitEvmSettlement` already
produce/expect (proven e2e by swap#59). Any fix that touches the signed digest is
therefore a coordinated multi-repo wire migration, not a local contract edit.

Evidence lines below reference the PR #320 branch of
`packages/contracts/src/RollingSwapChannel.sol` and the current `main` of
`toon-protocol/swap` and `toon-protocol/toon`.

---

## Finding #1 — Claim digest lacks chainId / contract-address domain separation → cross-chain & cross-deployment replay

**Severity: High. Blocking for mainnet (must be fixed or consciously accepted with an enforced invariant before real funds).**

### Problem

The redeemed balance-proof digest binds only `(channelId, cumulativeAmount, nonce,
recipient)`. It does **not** bind the chain id or the settling contract address.
The design leans entirely on one mitigation — "the maker won't sign the same
channelId twice across deployments, so channelId uniqueness prevents replay." That
mitigation is undermined by three facts in the shipped stack, so the digest is
replayable across chains and across deployments on the same chain.

### Evidence

- Contract digest, no chain/address binding —
  `RollingSwapChannel.sol:229` (`updateBalance`):
  `keccak256(abi.encodePacked(channelId, cumulativeAmount, nonce, recipient))`,
  and identically at `:284` (the claim leg of `cooperativeClose`) and the
  `claimDigest` view at `:372`.
- SDK hash, no chainId —
  `toon/packages/core/src/settlement/hashes.ts:85` `balanceProofHashEvm(...)`
  hashes exactly `channelId || cumulativeAmount(32BE) || nonce(32BE) || recipient`.
  Marked `@stable`.
- Swap signer, no chainId —
  `swap/packages/swap/src/payment-channel-signer.ts:28` (`PaymentChannelSignParams`
  carries only `channelId, cumulativeAmount, nonce, recipient`) and `:73`
  (`EvmPaymentChannelSigner.signBalanceProof` calls `balanceProofHashEvm` with no
  chain input).
- **One EVM key signs for every EVM chain** —
  `swap/packages/swap/src/swap-node.ts:937,949` `sharedEvmSigner ??= new
  EvmPaymentChannelSigner(...)` is instantiated once and reused for every `evm:*`
  target chain (`signers[chain] = sharedEvmSigner`). Same key ⇒ a signature valid
  on chain A is a valid signature on chain B for the same tuple.
- **False code comment** —
  `swap/packages/swap/src/swap-node.ts:931-932` asserts "the chain-id is baked
  into `BalanceProofParams` at signing time." It is **not** — verified against
  `PaymentChannelSignParams` and `balanceProofHashEvm` above; there is no chain id
  anywhere in the signed preimage. This comment actively misleads a future reader
  into believing replay is already prevented.
- **Off-chain state normalizes channelId reuse per chain** —
  `swap/packages/swap/src/channel-state.ts:4,132` keys channels by
  `${assetCode}:${chain}:${channelId}`. The same `channelId` on two chains is two
  distinct entries with independent watermarks — i.e. the off-chain layer treats
  channelId reuse across chains as normal, directly contradicting the "globally
  unique channelId" assumption the on-chain replay mitigation depends on.

### Exploit / impact

Deploy `RollingSwapChannel` on chain A and chain B (both settling, say, USDC).
The swap node opens a channel with the same `channelId` on both (its own state
keys by chain, so nothing stops it). A recipient holding a signer-signed claim for
`(channelId, cumulative=1000, nonce=7, recipient)` redeemed on chain A can submit
the **identical signature** to the chain-B contract's `updateBalance` and be paid
again — the signature recovers to the same shared signer, the digest matches, and
chain B has no knowledge of chain A's watermark. Same attack across two
deployments (e.g. a redeploy/migration) on a single chain. The maker's deposit on
the second contract is drained for value that was only ever earned once.

### Options

1. **Fix now: domain-separate the digest (recommended).** Fold `block.chainid`
   and `address(this)` into the signed preimage, ideally as a proper EIP-712 typed
   digest with domain `{name:"RollingSwapChannel", version, chainId,
   verifyingContract}` (matching the pattern TokenNetwork already uses —
   `TokenNetwork.sol:15` `EIP712`, `:287-299` `_hashTypedDataV4`). Pro: closes the
   class of bug permanently, aligns the two contracts. Con: **ABI-breaking wire
   migration across four repos** (see rollout below).
2. **Accept for now, enforce the invariant operationally.** Keep the raw digest;
   commit to the exact operational invariant that makes the mitigation real (see
   recommendation). Pro: zero code change, preserves the swap#59-proven path. Con:
   the invariant is easy to violate silently (nothing in code enforces it today,
   and the off-chain keying actively encourages per-chain channelId reuse), and it
   does **not** protect against cross-*deployment* replay on the same chain.
3. **Hybrid: accept for launch, schedule the v2 digest.** Ship raw for the first
   controlled single-deployment-per-chain rollout, but land the domain-separated
   v2 as a versioned migration before multi-deployment / multi-chain EVM
   settlement goes live.

### Full migration to fix (for options 1 / 3)

The digest is signed in one place and verified in four; all must move together,
gated by a version tag so old and new claims can never be confused.

- **(a) Contract** — digest folds in `block.chainid` + `address(this)`, ideally
  EIP-712 (`RollingSwapChannel.sol:229/:284/:372` + the `claimDigest` view).
- **(b) SDK** — `balanceProofHashEvm`
  (`toon/packages/core/src/settlement/hashes.ts:85`) gains `chainId` +
  `verifyingContract` params; `buildEvmSettlementTx` in
  `toon/packages/sdk/src/settlement/evm.ts` threads them through.
- **(c) Swap signer** — `EvmPaymentChannelSigner.signBalanceProof` +
  `PaymentChannelSignParams` (`swap/packages/swap/src/payment-channel-signer.ts:28/:73`)
  take chainId + contract address; the shared-signer construction in
  `swap-node.ts:949` must pass per-chain/per-contract context (the "shared key,
  per-chain domain" model — the key is still shared, but the *domain* is not).
- **(d) Client verification** — `submitEvmSettlement` / any client-side digest
  recompute in `toon-client` updated to the new preimage.
- **(e) Versioning / rollout** — introduce a **version byte or EIP-712 version
  string** in the digest so a v1 (raw) signature can never be accepted by a v2
  verifier and vice-versa. This makes the cutover fail-closed rather than
  ambiguous.

**Coordinated release order** (each consumer must accept the new format before any
producer emits it, and the contract must be redeployed, not upgraded — it's
immutable):

1. `toon` (core+sdk) — publish new `balanceProofHashEvm`/builder behind the
   version tag (verify both formats during transition if needed).
2. `swap` — swap signer emits v2 digests (and fix the false comment, #below).
3. `toon-client` — verifier accepts v2.
4. `connector` — **deploy** the v2 contract at fresh addresses; retire v1 channels
   via cooperative/unilateral close before pointing traffic at v2.

### Recommendation

**Fix it (option 1), scheduled as the v2 wire migration (option 3 sequencing) —
do not treat "channelId uniqueness" as a durable mitigation.** It is contradicted
by the shared signer key and by the off-chain keying that *normalizes* per-chain
channelId reuse. Domain separation is the standard, cheap-to-reason-about fix and
brings this contract to parity with TokenNetwork's EIP-712 posture.

**If accept-for-now is chosen for an initial launch, the exact invariant that MUST
hold and be enforced:** *every channelId is globally unique across all chains and
all deployments for the lifetime of the signer key* — concretely, the channelId
must itself encode the chain and deployment (e.g. derive it as
`keccak256(chainId, verifyingContract, entropy)`), and the swap provisioning layer
must guarantee this and refuse to reuse a channelId on a second chain. Enforce it
at the single choke point where channels are provisioned (swap operator
provisioning / `channel-state.ts` registration), **and** correct the false comment
so nobody re-derives false comfort from it. Note this still does not defend against
same-chain redeploys unless the deployment address is folded into the channelId.

---

## Finding #2 — channelId squat / DoS (and a fund-theft trap when combined with permissionless deposit)

**Severity: Medium. Blocking for mainnet as currently written (the deposit funder-guard, at minimum, should land first).**

### Problem

`channelId` is caller-chosen at `openChannel`, and `deposit()` is permissionless.
An attacker can pre-open (or front-run the opening of) any channelId, becoming its
`funder` with an attacker-controlled `signer`. On its own that is a griefing/DoS.
Combined with the "anyone may deposit" rule it becomes a fund-theft trap.

### Evidence

- Caller-chosen id, first-writer-wins — `RollingSwapChannel.sol:161-179`
  (`openChannel`), guarded only by `:162`
  `if (channels[channelId].state != NonExistent) revert ChannelExists();`. The
  opener sets `signer` (`:169`) and becomes `funder` (`:170`).
- Permissionless deposit — `RollingSwapChannel.sol:183-192` (`deposit`): any
  `msg.sender` may add funds to any Open channel; the doc comment even says "Anyone
  may add funds, but the remainder is always returned to the original funder."
- Remainder always routes to the stored funder — `withdrawRemainder`
  `:344-347` and `cooperativeClose` `:308`.

### Exploit / impact

- **DoS/squat:** attacker front-runs the swap node's `openChannel` for the
  provisioned channelId. The legitimate open reverts `ChannelExists`; the maker
  cannot use its provisioned id.
- **Fund-theft trap:** attacker opens `channelId` with `signer =
  attacker_signer`, `funder = attacker`. A victim (or an automated provisioning
  flow) that mistakes this for the intended channel and calls `deposit()` into it
  hands the attacker the funds: the attacker's signer signs a claim to an
  attacker recipient and drains via `updateBalance`, or the attacker (as funder)
  runs `initiateClose` → `withdrawRemainder` and takes the remainder.

### Options

1. **Derive channelId from participants** (TokenNetwork-style
   `keccak256(p1, p2, counter)`, `TokenNetwork.sol:199`). Removes caller choice
   entirely. **Conflicts with the ABI-locked `updateBalance(bytes32,...)`** and the
   signed digest: the channelId the swap node provisions and *signs over* is
   chosen off-chain; deriving a different id on-chain breaks the balance-proof
   match. Rejected unless the whole wire format moves (i.e. fold into the #1 v2
   migration).
2. **Namespace the storage mapping by opener** (`channels[opener][channelId]`).
   Makes squatting harmless (each opener has its own namespace). But the ABI-locked
   `updateBalance(channelId, ...)` takes no opener argument, so redeem-time lookup
   becomes ambiguous — also an ABI change. Rejected standalone.
3. **High-entropy channelIds opened via a private mempool.** Provision channelIds
   with full 256-bit entropy (already `bytes32`) and submit `openChannel` via a
   private/flashbots relay so it cannot be front-run. Squatting a *specific*
   unknown id is then infeasible. Cheap, fits the ABI-locked design.
4. **Add a `deposit()` funder-guard** (`require(msg.sender == ch.funder)`) — the
   fix being done in the hardening PR — plus document the caller-chosen-id
   contract. This closes the fund-theft trap (no third party can fund a
   squatted/foreign channel) and leaves only pure DoS, which #3 handles.

### Recommendation

**Do (4) + (3), and document.** Land the `deposit()` funder-guard (removes the
fund-theft trap outright), provision channelIds with full entropy and open them via
a private mempool (removes the practical squat/DoS), and document that channelId is
caller-chosen and must be treated as a capability. Reject (1)/(2) as standalone —
they require breaking the ABI; if the #1 v2 wire migration happens anyway,
folding participant-derived ids into it becomes attractive and should be
reconsidered there.

---

## Finding #4 — cooperativeClose accepts a stale recipient ack (latent; the off-chain co-sign path is not built yet)

**Severity: Medium (latent). Not blocking the current contract, but the terminal-ack semantics MUST be pinned before the off-chain co-sign signer is built.**

### Problem

`cooperativeClose` closes the channel at the `(cumulativeAmount, nonce)` carried by
a recipient close-ack, refunding the remainder to the funder. The on-chain guards
reject only values **below the on-chain-settled watermark** (`ch.cumulativePaid` /
`ch.nonce`), not below the recipient's **true off-chain watermark** — the highest
claim the recipient actually holds but may not have redeemed on-chain yet. So a
close-ack the recipient signed at an *earlier, lower* watermark remains valid
forever, even after the channel has advanced far beyond it off-chain.

### Evidence

- The only monotonicity guards — `RollingSwapChannel.sol:280-281`:
  `if (cumulativeAmount < ch.cumulativePaid) revert StaleCumulativeAmount();`
  `if (nonce < ch.nonce) revert StaleNonce();` — note `<`, not `<=`, and both
  compared against the **on-chain** watermark only.
- The ack digest binds no "final/terminal" or single-shot marker —
  `:289` `keccak256(COOP_CLOSE_TAG, channelId, cumulativeAmount, nonce)` (and the
  `cooperativeCloseDigest` view `:377`). It commits only to a value, not to "this
  is the last state."
- `cooperativeClose` is callable by anyone holding both sigs (no `msg.sender`
  restriction, `:269-276`); the funder and the swap signer can be the **same
  entity** (the maker funds and signs — `openChannel:170` sets funder=msg.sender,
  and the signer is maker-controlled).
- The off-chain producer of `recipientCloseSig` **does not exist yet** — grep of
  `swap/packages/swap/src` finds no `cooperativeClose` / `closeAck` / `COOP_CLOSE`
  signer. This finding is about pinning semantics *before* it is written.

### Exploit / impact

Recipient earlier signs a close-ack for a low watermark (e.g. `cumulative=100,
nonce=5`) during some negotiation. The channel then advances off-chain to
`cumulative=1000, nonce=50` (recipient holds a signer claim for 1000 but has not
yet called `updateBalance`, so on-chain `ch.cumulativePaid` is still low). A
colliding funder+signer replays the **old** ack (100/5) alongside a matching signer
claim for 100. `100 >= ch.cumulativePaid` passes `:280`, the channel closes at 100,
the recipient is paid only 100, and the ~900 of earned-but-unsettled value is
refunded to the funder. Because the channel is now `Closed`, the recipient can
never redeem their 1000 claim. The recipient's already-earned funds are stranded.

### Terminal-ack semantics to pin now (before building the signer)

Since the contract cannot know the recipient's off-chain watermark, the guarantee
must live in the ack semantics and the off-chain signer:

1. **The close-ack commits to the FINAL state and is single-shot.** The recipient
   must sign a close-ack for **exactly one** watermark — its current highest held
   cumulative — and treat signing as terminal: after signing, it stops accepting or
   relaying any further off-chain claims on that channel. It must **never** sign a
   close-ack for a value below a claim it already holds, and never sign two
   different acks for the same channel.
2. **Ack ⇒ recipient-side finality.** The future off-chain signer
   (`swap` / receive-side co-sign path) must produce the ack only in response to a
   close request, bind it to the recipient's own highest cumulative at that instant,
   and persist a "closed/terminal" flag so a restart cannot re-sign a stale value.
3. **Document the trust assumption:** a recipient that co-signs a coop-close is
   trusting that the value it signs equals everything it is owed; the protocol must
   make that the recipient's own highest watermark by construction.

### Contract-side assertions that would help (optional hardening)

- **Restrict the trigger to the recipient** (`require(msg.sender == recipient)` in
  `cooperativeClose`). Prevents a colliding funder+signer from unilaterally
  replaying a captured ack — the recipient must be the one to submit, at a moment
  of its choosing, with its current highest claim. (Small ABI/semantics change on a
  function no shipped client calls today, so low blast radius.)
- **Tighten the monotonic guards to `>` where a strict advance is intended** and
  consider requiring the coop-close to carry the recipient's own highest signer
  claim (i.e. the recipient effectively redeems-and-closes in one shot), so the
  close value cannot be below what the recipient could otherwise redeem.

### Recommendation

**Pin the terminal, single-shot ack semantics now and write them into the
receive-side co-sign design doc before the signer is built; adopt the
`msg.sender == recipient` trigger restriction on `cooperativeClose` as cheap
defence-in-depth.** The contract cannot enforce the off-chain watermark, so the
single-shot/terminal rule is the load-bearing guarantee and must be a stated
requirement on the future `swap` co-sign signer (and the Mina analog), not an
afterthought.

---

## Finding #6 — Ownerless, no rescue path

**Severity: Medium/Low. Not blocking; needs an explicit, recorded decision.**

### Problem

The contract is deliberately ownerless and non-pausable. There is no admin rescue.
Loss (or unavailability) of the funder key can permanently lock the **unspent
remainder** of a channel. Recipient funds are never at risk — a recipient can
always redeem its signed claims via `updateBalance` while the channel is Open or
Closing.

### Evidence

- No admin surface — `RollingSwapChannel.sol:48` `contract RollingSwapChannel is
  ReentrancyGuard` (no `Ownable`, no `Pausable`, no `emergencyWithdraw`). Contrast
  `TokenNetwork.sol:15` `is ReentrancyGuard, EIP712, Pausable, Ownable`, with
  `emergencyWithdraw` (`:430`, owner-only, paused-only) and `pause`/`unpause`
  (`:446`/`:452`).
- Only the funder can start the unilateral reclaim — `initiateClose:321-324`
  (`if (msg.sender != ch.funder) revert NotFunder();`), which is the precondition
  for `withdrawRemainder:335-350`.
- Recipient can always still redeem — `updateBalance` is allowed in both `Open`
  and `Closing` states (`:222`).

### Impact / nuance

If the funder key is lost, the remainder can only be recovered via the cooperative
path (`cooperativeClose`, which routes the remainder to the stored funder address
and needs the *signer* + *recipient* signatures, not the funder key —
`:308`). If that path is also unavailable (recipient gone, or signer won't co-sign
a teardown), the remainder is stuck forever with no recourse. This is a deliberate
trade: the alternative (an admin key able to move custodied funds) is exactly the
rug/censor vector the ownerless design avoids — an admin able to seize a
recipient's already-signed, already-earned balance.

### Options / tradeoff

- **Accept ownerless as-is.** Max trust-minimization; matches the stated design
  intent. Cost: permanently lockable remainder on funder-key loss, no emergency
  pause if a bug is found post-deploy.
- **Add TokenNetwork-style `Ownable`+`Pausable`+`emergencyWithdraw`.** Rescue and
  freeze capability. Cost: reintroduces the admin rug/censor vector over recipient
  funds — contradicts the whole point of this contract.
- **Add a narrow, time-locked sweep** of a long-abandoned channel: after a long
  fixed period of inactivity, allow the **recipient or anyone** to sweep the
  remainder **to the stored funder address** (never to an admin). Recovers stuck
  remainder without introducing any privileged seizure of funds.

### Recommendation

**Accept the ownerless posture and record it explicitly** — an admin key over
custodied recipient funds is the larger risk and is rightly rejected. Recommend
*considering* (as a follow-up, not a blocker) the time-locked
recipient-or-anyone-sweep-to-funder as a bounded rescue that keeps zero admin
authority. At minimum, this decision must be an explicitly recorded maintainer
acceptance rather than an implicit one.

---

## Cross-cutting flag (not one of the four; fix regardless)

**The false comment in `swap/packages/swap/src/swap-node.ts:931-932`** — "the
chain-id is baked into `BalanceProofParams` at signing time" — is **wrong** (see
Finding #1 evidence) and dangerously so: it tells a future reader that cross-chain
replay is already prevented when it is not. **Recommend a tiny follow-up PR in
`swap` to correct it** to state plainly that the EVM digest binds no chain id and
that cross-chain replay is currently mitigated only by channelId uniqueness. This
should happen **regardless of the Finding #1 decision.** (Not changed here — flagged
only.)

---

## Decision summary

| # | Severity | Blocking for mainnet | Recommendation |
|---|----------|----------------------|----------------|
| 1 | High | **Yes** | Fix: domain-separate the digest (chainId+address, ideally EIP-712) as a versioned v2 wire migration across connector+toon+swap+toon-client. If accepting for an initial launch, enforce globally-unique-channelId-encoding-chain-and-deployment at the swap provisioning choke point, and correct the false comment. |
| 2 | Medium | **Yes** (deposit funder-guard at minimum) | Add the `deposit()` funder-guard + high-entropy channelIds via private mempool + document. Reject participant-derived ids standalone (ABI-breaking); revisit only inside the #1 v2 migration. |
| 4 | Medium (latent) | No (but pin before building the co-sign signer) | Pin terminal, single-shot close-ack semantics in the receive-side co-sign design now; adopt `msg.sender == recipient` on `cooperativeClose` as cheap defence-in-depth. |
| 6 | Medium/Low | No | Accept ownerless and record it explicitly; consider a time-locked recipient-or-anyone sweep-to-funder as a bounded, admin-free rescue follow-up. |

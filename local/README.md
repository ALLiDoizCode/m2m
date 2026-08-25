# `local/` — the shipped image, run against real chains

One connector image, real containerised chains, a real packet. That is the
whole scope.

```sh
make local-up        # build the image, start the chains, provision keys and
                     #   channels, run it
make local-rehearse  # send real packets; non-zero unless they fulfil AND, on a
                     #   peered topology, the payee's journal says it was paid
make local-down      # and remove the state volumes with it — see below for why
```

All of them work in one compose project, `connector`, named in
`docker-compose.yml` rather than taken from the directory. So there is one
stack per machine and `make local-down` reaches it from any checkout of this
repository; `make local-preflight` says whether it is free.

Or `make local-verify` for all three, which is what CI runs
(`.github/workflows/local-topologies.yml`).

`LOCAL_TOPOLOGY` picks which one; `solo` is the default.

```sh
make local-verify LOCAL_TOPOLOGY=mixed-chain
```

## What this is for, and what it is not

`cargo test` covers the connector's behaviour far better than a container can.
It spawns its own `anvil` and `solana-test-validator` **per test**, deploys into
them and throws them away (ADR 0007) — nothing under `crates/` dials
`localhost:8545` or `localhost:8899`, and `make anvil-up` before `cargo test`
changes nothing.

What `cargo test` structurally cannot check is the thing every deploy depends
on: that **the image**, running as uid 10001, with a mounted `connector.toml`,
mounted key files and a real volume at `/app/state`, boots and moves a packet.
That is this, and only this.

`promote-to-fleet.yml` checks half of it — the candidate image against the
fleet's own committed configs — and can only _warn_ on the other half, because
a GitHub runner has no chain to reach and ADR 0009 makes an unreachable
settlement RPC a refuse-to-start. Here there is a chain, so it is an assertion.
The two are complementary: promotion proves image-matches-fleet-config, this
proves image-serves-and-settles. Neither replaces the other, and this one
deliberately does **not** use the fleet's configs — its own name local
container URLs, which is exactly the substitution ADR 0041's gate exists to
avoid making.

## Connector layer only

No relay, no store, no faucet. Composition of a connector with a real app lives
in that app's repository; this repo builds only the connector image. The thing
behind the route here is `stub-app`, the image's second binary: it answers
`POST /`, holds no secret and does no cryptography, so it contributes nothing
to a packet's fulfilment — the connector derives that itself (ADR 0019).

A `deploy/connector-rust/local-stack/` bundle used to do a bigger version of
this with the published relay image. It is deleted: it was app-layer by
construction, it pinned a relay sha that would rot, and its chain ran on the
_host_ behind a hand-run Python TCP forwarder because `anvil` binds loopback.
Here the chains are the same compose services `make anvil-up` starts, merged
into one project, so the connector reaches them by service name and there is
nothing left to forward.

## Topologies

| Topology                       | Nodes | What it proves                                                                                                                                                                               |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`solo/`](solo/)               | 1     | The image boots on a mounted config with **both** settlement backends live at once, and a real packet reaches the app behind its one route.                                                  |
| [`two-hop/`](two-hop/)         | 2     | Two images peered over ILP-over-HTTP. B **prices** the route it terminates; A covers each crossing before sending it, with a real EIP-712 claim on a real funded channel on the local anvil. |
| [`mixed-chain/`](mixed-chain/) | 3     | A↔B settles on EVM, B↔C on Solana, and B holds **both** backends. A packet originated at A reaches C's app, crossing a chain boundary in the middle.                                         |

`two_ledgers_never_merge.rs` is named for the both-chains concern and proves it
in-process; `solo` is the only place a node is actually stood up with an EVM and
a Solana backend attached simultaneously.

`two-hop` is the containerised counterpart of
`crates/connector-bin/tests/two_connectors_peer.rs`, which proves the same
peering in-process against an `anvil` it spawns per test — and therefore says
nothing about the image, the mounted config, or two nodes finding each other
over a network. Its own header is the reference for what a peering has to
assert; this is that path with the containers left in.

They diverge in exactly one place, and it is deliberate. `two_connectors_peer.rs`
terminates at `price = 0`; `two-hop`'s payee charges for the route it terminates,
which is only payable because its payer holds a `[[pay_channels]]` row the
in-process fixture does not (#1107). So the fixture is still the reference for
what a peering must assert, and this is the only place a **priced** peer
termination is stood up and paid at all.

`mixed-chain` is the shape with **no coverage anywhere else in the repository**.
It is not a conversion: the connector has no exchange rate (ADR 0010 replaced
the spread with a flat per-packet fee, and value conversion is the `swap`
repo's job). It is one node settling with different peers on different chains,
and every amount on the path is the same integer end to end.

## Keys and money

Both are the same rule: nothing is committed, and nothing is assumed.

`local/keys.sh <topology>` generates every key into
`local/.keys/<topology>/<node>/`, which is gitignored, and then **funds** it.
Nothing it writes is committed, and every `key_file` in a committed
`connector.toml` here is a path (ADR 0009, ADR 0012). One directory per node,
named after that node's compose service; the node's config is
`local/<topology>/<node>.toml`.

Per node it writes `signer.key`, `settlement.key`, `settlement-solana.key`,
`settlement-solana-cli.json`, `operator-bearer-token`, `operator-write-keys`,
`operator-send.key` and — for each peering the node is in — a shared
`peer-<id>-secret`. The operator two are a pair: the allowlist holds the
**public** half (derived by the same binary that will sign, so the two cannot
disagree), and `connector send` holds the private half. Ask for the allowlist
value directly with:

```sh
connector send --operator-key <file> --print-keyid
```

### Random and derived, and why the split exists

`signer.key`, `operator-send.key`, `operator-bearer-token` and the peering
secrets are **random**. None of them appears in a committed file, so nothing
depends on their value.

The two settlement keys are **derived**, per node, from anvil's own published
test mnemonic at a fixed index. They have to be: a `[[peer_channels]]` row
names the `counterparty_key` whose signature this node accepts, and a committed
config cannot say "whatever address the other container happened to generate".
The mnemonic is public knowledge — anvil prints it on every start, and account
0's private key was already in `keys.sh` as the local chain's deployer — so
deriving from it introduces no secret that did not already exist, and the
alternative (a fixed throwaway key checked in under `local/`) would introduce
one. EVM and Solana take disjoint index ranges, so no 32 bytes is ever used on
both curves.

Every address a committed config names is then **checked against the chain**:
`keys.sh` derives each settlement address, resolves the deployed
`TokenNetwork`, opens the EVM peering's channel and reads back its id, and
computes the Solana channel PDA — and refuses to provision, naming the value it
computed, if a committed file disagrees. Its `solana-channels` stage then opens
and funds the Solana channel once the nodes are serving and reads _that_
account back too. Those checks are what make committed-not-generated safe here.

Funding involves **no faucet on either chain** — the faucet is an app-layer
service and is not part of the connector:

- **EVM.** anvil's genesis funds account 0 with 10,000 ETH; it is the deployer
  `DeployLocal.s.sol` runs as, so it owns the settlement topology. ETH is a
  plain transfer from it and USDC is a `mint` — `MockERC20` is mintable, so
  nobody's balance runs down.
- **Solana.** `solana airdrop` from the validator's genesis, and then mock USDC
  on top of it — SOL pays fees, it is not the asset a channel settles in. The
  mint is seeded by `make solana-mint-usdc`, which **fails** rather than warns
  when it cannot: a validator without that mint cannot satisfy the committed
  `token_address`, and the node will refuse to start. Unlike anvil's mintable
  `MockERC20`, an SPL mint has one authority, so each node's tokens are a
  `spl-token transfer` out of the treasury that script seeds — with
  `--fund-recipient`, because this runs before any node boots and the
  associated token account it lands in does not exist yet.

Devnet funds completely differently — the faucet box and its treasuries, on
public chains. Do not carry an assumption from here to there.

## Sending a packet

`connector send` is the binary's third verb. It forms the packet the operator
surface cannot form for itself: an OER `Prepare` whose payload is gift-wrapped
to the terminating connector's identity (ADR 0018) under a condition minted
from the fulfilment that wrap derives (ADR 0019), inside an RFC 9421-signed
`POST /packets` (ADR 0008).

```sh
connector send \
  --operator  http://127.0.0.1:3001 \   # whose /packets originates it (two-hop's A)
  --operator-key local/.keys/two-hop/connector-a/operator-send.key \
  --to        g.local.two-hop.b.app \   # the ILP destination
  --seal-to   http://127.0.0.1:3002 \   # the connector that TERMINATES it (B)
  --amount    1000 \
  --body      payload.json \
  --expect-fulfill
```

`--seal-to` is separate from `--operator` because a payload is sealed to the
node that terminates it, which in a multi-hop topology is not the node the
packet is handed to. There is no way to discover that node's identity from the
destination address today; when ADR 0050 ships (`GET` on a connector's URL
returns its self-description) this flag becomes optional.

`--expect-fulfill` is what makes the rehearsal a gate. Without it a REJECT is
reported and the process exits 0 — right for an operator probing what a route
does, wrong for CI, where a run that prints `REJECT F02` and goes green is the
same nothing-asserted success ADR 0007 bans elsewhere.

## What `--expect-fulfill` cannot see

A peering's money is not on the packet's answer. A peer claim's verdict rides
back in the `Toon-Claim-Ack` header and never gates the packet
(`handle_peer_prepare` returns the answer and the ack side by side), so a
peering whose every claim was refused still FULFILLs every packet. A rehearsal
that only checked the exit status would go green over a peering carrying
traffic for free — the same nothing-asserted success ADR 0007 bans elsewhere.

So `two-hop` and `mixed-chain` cross **twice** and then read the payee's own
claim journal. They cross twice for two different reasons, and the difference
is the whole of what a `[[pay_channels]]` row changes.

`mixed-chain` owes after the fact. Value moves on fulfilment (ADR 0004), so its
payer owes nothing until the first crossing has fulfilled: the claim covering
crossing _n_ is signed after it and rides crossing _n + 1_. One packet proves
delivery and can say nothing about payment, which is why there is a second one.
`two_connectors_peer.rs` crosses twice for exactly that reason.

`two-hop` does not owe after the fact. A holds a `[[pay_channels]]` row (ADR
0042 item 2), so `cover_forward` mints the claim **before** the packet is sent
and crossing 1 arrives already paid for — which is precisely what lets B price
the route it terminates, since a priced peer termination refuses an uncovered
arrival. Its second crossing is a different assertion: a covering payer asks the
payee where its claims stand on every packet, and a payee answering out of the
wrong book reports nonce 0 forever, so crossing 2 re-signs crossing 1's
cumulative amount at a fresh nonce and advances nothing. That is issue #1102,
and one crossing cannot see it. Two can, and did.

**What reading the journal proves, and what it does not.** `two-hop`'s sender
walks B's journal line by line and fails unless there are at least as many
accepted claims on the peering's channel as crossings sent, each advances the
cumulative amount by at least the price, and the final watermark is at least
crossings × price. That advance is the exact quantity `price_gate::payment_required`
charges against, which is what makes it a measurement rather than a restatement.
It is silent on four things. It does not prove the price is **enforced**: the
gate returns early when a route's `price` is `0`, before any comparison runs, so
a price quietly dropped to zero satisfies every one of those checks — holding
B's committed `price`, the sender's `--amount` and `PRICE` to one figure is
`local_topologies_load.rs`'s job, and no container can do it. It does not say
which claim paid for which packet, only that the totals line up. It says nothing
about whether any of it could be **redeemed on chain**, for the reason the next
section gives: nothing on the peer path reads a chain. And it says nothing about
the BTP carriage, which no topology here runs.

`mixed-chain`'s money check is the weaker one, and deliberately so: it greps
each payee's journal for an accepted claim on its own channel and stops there.
That is enough for the question that topology asks — did a packet cross a chain
boundary and did each leg get paid at all — and it could not ask more, because
its terminations are unpriced and there is no price for an advance to be
measured against.

This is also why `make local-down` removes the state volumes. Both local chains
wipe their own state on every start, so keeping a claim journal across a
down/up pairs a live watermark with a chain that no longer has the history
behind it — and, concretely, a journal left by the last run satisfies this
run's money check without this run having paid anything.

For a while it did not actually manage that, and the reason is worth knowing
because it is invisible from inside one checkout. The compose project name used
to follow the directory, so a stack started from a git worktree was a
_different_ project from the same repository's main checkout: `make local-down`
in one could not see the other's containers, network or state volumes, and a
`connector_solo-state` outlived every teardown on one machine for two days
(issue #1122). `docker-compose.yml` now names the project `connector` outright,
so the teardown reaches whatever the bring-up created, from wherever either is
run — and it removes the project's state volumes **by label**, so a
`two-hop-b-state` left behind by another topology goes with it rather than
waiting for someone to run the matching `LOCAL_TOPOLOGY`.

One name means one stack per machine. That is not a capability being taken
away: every topology publishes 8545, 8899 and its connectors' client edges, so
a second stack was never going to run anyway — it would half-start, fail on a
port bind, and leave residue the other checkout could not reach. What changed
is that the collision is now **reported**. `make local-up` and `make
local-verify` run `local/stack-guard.sh` first (`make local-preflight` asks the
same question by hand), which refuses and names the directory and topology
already holding the stack, rather than letting this run adopt the other's
containers — an `anvil` with another checkout's `packages/contracts` mounted
into it, say. It also refuses a start over state volumes left by a run that was
killed rather than torn down, for the reason in the paragraph above: those
volumes are the journals the money assertion reads.

Two consequences worth knowing before editing a config here:

- **A postpay peer termination cannot be priced, and the way out is on the
  payer.** A route a node both terminates and prices refuses a peer PREPARE that
  arrives without a covering claim (`F06`, issue #880) — and a postpay peering's
  first crossing carries none, so it is refused, never fulfils, leaves nothing
  owed, and the second carries none either. The peering deadlocks rather than
  charging. ADR 0042's `[[pay_channels]]` breaks that circle by covering the
  PREPARE before it is sent instead of owing for it after it fulfils.
  **`two-hop` configures one**, which is why its payee can price the route it
  terminates; `mixed-chain` does not, so its termination stays `price = 0` and
  what a hop there is actually paid is the forwarded amount. Pricing a
  termination is therefore a property of the pair, not of the payee: adding a
  price without the payer's row is the deadlock above.
  `local/two-hop/connector-a.toml` and `connector-b.toml` carry the two halves
  of the long version, including the defect the row found the first time it was
  tried here (issue #1102, fixed by #1103, and the reason the rehearsal counts
  what each claim **advanced** rather than that a claim exists).
- **No hop charges a fee yet.** Every forwarded route here is `fee = 0`. That
  used to be forced: `POST /packets` declared `minimum_delivery = amount`, so
  `amount_after_fee` refused any hop that would retain anything, and a non-zero
  fee turned the rehearsal into `R01`. The lockout is retired (ADR 0057, issue
  #1143) -- no packet declares a floor and `R01` is gone from the reject
  vocabulary -- so the fees can be raised. Issue #1144 does that, raising each
  node's `price` to match; until then the rehearsal still exercises the flat
  per-packet fee nowhere.

## What a peer claim does and does not check

`ClaimBook` verifies a peer claim's signature against the `counterparty_key`
its operator configured, and nothing else (CF-23). It reads no chain. So the
channels `keys.sh` opens and funds on anvil are not what makes a crossing
verify — a topology would rehearse green against a channel with a zero deposit,
which was tried. They are opened and funded anyway, for the reason
`two_connectors_peer.rs`'s fixture does the same: a claim naming a channel
nobody could redeem is not a payment, and the difference does not show up until
somebody tries.

The Solana peering's channel is opened **and funded** too, and by a different
route on both counts, because nothing in this repository can submit either
instruction from a shell. `InitializeChannel` is a positional account list
under an 8-byte discriminator, `spl-token` knows only SPL Token, and the Solana
CLI cannot build an arbitrary program instruction. `Deposit` is worse than
inconvenient to build by hand — it credits strictly **by signer**, with no
participant parameter, so only the depositing node can submit its own
collateral at all. The submitter for both is therefore a **running node's
operator surface** — `POST /channels` and `POST /channels/:id/fund`, ADR 0008's
writes — reaching `SolanaSettlementBackend::open` and `::fund` under that
node's own `[settlement.solana]` key. That is the right party as well as the
only available one: the channel's on-chain participant _is_ that settlement
identity, and it is the identity that will sign every claim on the channel.

Which is why `keys.sh` runs twice. `local/keys.sh <topology>` is everything
that has to exist before a node starts — including the mock USDC in each node's
own settlement account, which is what it later has to collateralise _with_;
`local/keys.sh <topology> solana-channels` runs after `--wait`, and `make
local-up` calls both with the containers started in between. The second stage
delegates to `local/open-solana-channel.py`, which makes both signed writes and
then reads the account back off the validator, refusing to report success
unless the deployed program's own layout agrees with the committed config — the
discriminator, both participants, the mint, `Opened` status, and the payer's
own deposit.

It is idempotent on both writes, and the two are idempotent differently. A
channel already at the expected address is left alone and still asserted. The
deposit is a **top-up**: `POST /channels/:id/fund` takes an increment, unlike
the EVM leg's absolute `setTotalDeposit`, so the script reads the payer's own
on-chain deposit first and deposits only the shortfall — nothing at all on a
second `make local-up`. That asymmetry is the one thing about this stage worth
remembering: the same figure reached by an absolute write on one chain and a
relative one on the other.

Neither journal can corroborate any of that, which is why the rehearsal asks the
chain rather than the payee. An accepted claim is a signature check against a
configured key and nothing more, so a journal stays exactly as green against an
address nobody ever created — which is what this topology used to settle
against. `mixed-chain`'s sender therefore reads the channel account off the
validator itself: that the payment-channel program owns it, and that it still
holds the payer's collateral. That runs before anything is sent, so a failure
names the missing channel or the missing deposit rather than a puzzling claim
further down.

**Opened is not funded, and both chains now do both.** They arrive there by
different routes, and the difference is worth keeping straight because it is
about who may submit, not about what the channel ends up holding. The EVM
`TokenNetwork`'s `setTotalDeposit` names the participant being credited
separately from the caller whose tokens are pulled, so `cast` can deposit for
the payer before any node exists — which is what the first stage does. The
Solana program's `Deposit` credits by signer, so only the payer's own node can,
and only after it is serving. Issue #1118 settled which of the two the port
means: `SettlementBackend::fund` is a **self-deposit** on both chains, backing
the claims that node _signs_ (`own_deposited`), never the counterparty's side
(`counterparty_deposited`, which is what bounds a claim this node could
_redeem_). So the honest summary is now: a peering's channel is real on both
chains, its collateral is real on both chains, and on Solana the deposit is
read back out of the program's own account twice — once by the script that
makes it and once by the rehearsal, before it sends.

What is still true is the sentence at the top of this section: none of it is
what makes a crossing verify. A claim is a signature check against a configured
key. The collateral is what makes the claim worth something to whoever holds
it, and `packages/solana-program`'s `ClaimFromChannel` bounds a claim by the
claimer's own deposit — which is precisely why the payer's side is the one
funded here.

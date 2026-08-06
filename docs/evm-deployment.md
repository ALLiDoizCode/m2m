# EVM devnet deployment: the ERC-2771 `TokenNetwork` cutover

The committed runbook for issue #695 -- deploying the meta-tx-aware `TokenNetwork` (#694) to Base
Sepolia devnet and repointing every place this repo advertises a settlement contract address. Read
this before touching any of the files it names; `docs/devnet-pricing.md` exists for the same reason
on the pricing side (connector#785) -- a hand-edit on one box or one file, unreconciled with the
rest, is exactly the failure mode both documents exist to prevent.

## Status: cutover NOT yet broadcast

Everything on the **code** side is done and proven against a real Base-Sepolia fork (this repo's
CI, `testnet-cutover-fork-test` job -- no broadcast, no secrets). The **broadcast** itself, and the
box repoint that follows it, are human-only steps that need a funded Base-Sepolia deployer key and
SSH/deploy access to the two devnet boxes -- neither of which this repo's automation holds (same
posture as the mainnet runbook in `packages/contracts/README.md`). This document is the runbook an
operator with that access follows; nothing below has been run for real yet.

## Why a fresh deployment at all

`TokenNetwork` is **not upgradeable** -- there is no proxy pattern anywhere in
`packages/contracts/src` -- so ERC-2771 support (#694) can only ship as a new deployment.
`TokenNetworkRegistry.createTokenNetwork(token)` also reverts `TokenNetworkAlreadyExists` for a
token it has already registered, and the live registry already has a `TokenNetwork` registered for
devnet's mock USDC. So the cutover deploys a **new** `TokenNetworkRegistry` too (wired to a new
`ERC2771Forwarder`), and creates the new `TokenNetwork` through it for the **same** USDC token --
never a new token, so no existing balance or faucet distribution is disturbed. Channels on the old
registry/`TokenNetwork` are a separate contract and are not migrated; they keep settling and closing
exactly where they always did (AC4).

## Current live deployment (pre-cutover)

From `packages/contracts/deployments/base-sepolia.md`, deployed 2026-07-18:

| Contract               | Address                                      |
| ---------------------- | -------------------------------------------- |
| TokenNetworkRegistry   | `0xcC9079adE929b168B54145f6d25262b64FAB9D5b` |
| Mock USDC (6 decimals) | `0x49beE1Bca5d15Fb0963117923403F9498119a9Ce` |
| TokenNetwork (USDC)    | `0x1E95493fEF46707E034b4a1945f25a8C76A1823D` |

This deployment has **no** trusted forwarder (`address(0)`) -- it predates #694 and cannot be
upgraded to add one.

## The cutover deploy

`packages/contracts/script/DeployTestnetCutover.s.sol`, broadcast per
`packages/contracts/README.md`'s "Devnet ERC-2771 cutover runbook" section:

```shell
cd packages/contracts
PRIVATE_KEY=<funded-deployer-key-no-0x-prefix> \
  forge script script/DeployTestnetCutover.s.sol --rpc-url base_sepolia --broadcast
```

Deploys, in order: an `ERC2771Forwarder("TokenNetworkForwarder")`, a fresh
`TokenNetworkRegistry`, `registry.setTrustedForwarder(forwarder)`, then
`registry.createTokenNetwork(0x49beE1…)` -- the same mock USDC as above, now behind a
forwarder-aware `TokenNetwork`. The script logs `BASE_FORWARDER_ADDRESS`,
`BASE_REGISTRY_ADDRESS`, and `BASE_TOKEN_NETWORK_ADDRESS`; record them (this document's
"After a real broadcast" section below) before doing anything else.

## After a real broadcast: what to repoint, and what NOT to

The connector announces whatever `TokenNetwork` its `[settlement.evm]` config resolves through the
registry at boot (`crates/connector-config/src/announce.rs`, `crates/connector-settlement-evm/src/
lib.rs::connect`) -- there is no separate config field naming a `TokenNetwork` address directly, and
**no Rust config carries the forwarder address at all**: it is baked immutably into the deployed
`TokenNetwork`'s bytecode (`ERC2771Context`), and the connector itself never acts as a relayer, so
nothing needs to be told about it. Repointing the announce is therefore exactly one config value,
in exactly two files:

1. **`infra/linode-node/connector-rust.toml`** -- `[settlement.evm] contract_address` ->
   `BASE_REGISTRY_ADDRESS` from the broadcast.
2. **`infra/linode-store/connector-rust.toml`** -- same field, same new value. Both boxes MUST agree
   -- a claim one box accepts against a channel opened on the new contract is unresolvable by a box
   still pointed at the old registry.

Then redeploy/restart both boxes and re-run `connector announce` (issue #784) so the live kind:10032
event advertises the new `TokenNetwork` address -- the next announce picks it up automatically, with
no announce-side config change needed.

### What this does NOT touch: the apex↔store peer channel

Both `.toml` files also have a `[[peer_channels]] token_network` literal
(`0x1E95493fEF46707E034b4a1945f25a8C76A1823D` today) -- the EIP-712 signing domain for the existing
apex↔store peer channel. That channel was opened **before** cutover, so per AC4 it keeps settling
against the **old** deployment; this field is deliberately left unchanged by the cutover. Migrating
that specific peering to the new contract (closing it and opening a fresh one) is a separate
operational decision -- new channel funding and coordination between both box operators -- not part
of this repoint.

### Bookkeeping that must be updated alongside the repoint

- **`crates/connector-bin/tests/devnet_configs_load.rs`** -- `APEX_LIVE_REGISTRY` asserts the live
  registry address as a literal against both `.toml` files; update it to the new registry or this
  test fails the moment the boxes are repointed.
- **`packages/contracts/deployments.json`** and **`packages/contracts/deployments/base-sepolia.md`**
  -- add the new forwarder/registry/TokenNetwork addresses, transaction hashes, and deploy date,
  the same way the pre-cutover deployment is recorded there today.
- **`crates/connector-settlement-evm/contracts/BYTECODE-PROVENANCE.md`** -- its own text says "If
  either contract is ever redeployed, this file must be redone against the new address." Redo it
  against the new registry/`TokenNetwork` addresses once they exist on chain.

## Rollback: one step

Because the old deployment is never touched (not destroyed, not paused, nothing migrated out of
it), rollback is exactly what AC5 asks for: revert `[settlement.evm] contract_address` back to
`0xcC9079adE929b168B54145f6d25262b64FAB9D5b` in both `.toml` files and redeploy/restart. The next
`connector announce` reverts the advertised address automatically -- there is no on-chain action to
undo, since the new registry/`TokenNetwork`/forwarder simply stop being referenced.

## Acceptance criteria, mapped to this document

- Meta-tx-aware `TokenNetwork` + forwarder deployed, addresses recorded -- the broadcast + "After a
  real broadcast" bookkeeping above.
- The live kind:10032 announce advertises the new address -- "After a real broadcast" step 1-2
  above; nothing else to configure.
- A channel opened after cutover settles through the forwarder from an EOA holding zero native gas
  -- proven against real forked chain state (with real forked USDC, funded by impersonating the
  live distributor, not minted) by
  `test/DeployTestnetCutover.fork.t.sol::testFork_Cutover_GaslessChannelLifecycleOnRealForkedUsdc`,
  and against local chain state by `test/TokenNetworkERC2771.t.sol` (#694).
- Channels opened before cutover still settle and close against the old deployment -- the old
  registry/`TokenNetwork` are never touched, proven by
  `testFork_Cutover_DoesNotDisturbTheOldLiveDeployment`; the apex↔store peer channel is a live
  example that is deliberately left pointed at the old contract (see above).
- Rollback is one documented step -- "Rollback: one step" above.

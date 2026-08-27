# CLAUDE.md

A multi-chain ILP connector: one Rust binary that forwards packets for payment and
settles on EVM and Solana. `docs/architecture/source-tree.md` is the map of the
repository and `CONTEXT.md` is the vocabulary; `README.md` is the operator's guide
and is written for someone deploying a node, not changing one. This file covers what
an agent working here needs that none of those says — how to run things, where keys
and money come from, and the rules that are easy to get wrong.

Where this file and an ADR disagree, **the ADR wins**. Where an ADR and a spec
disagree, the ADR wins too (`docs/adr/`).

## What is and is not the connector

The connector is the Rust workspace under `crates/`, built as the `connector`
binary. Nothing else in this repository is the connector:

- `packages/contracts` — the Solidity `TokenNetwork` / `TokenNetworkRegistry` the
  EVM backend binds to.
- `packages/solana-program` — the payment-channel program the Solana backend drives.
  A Cargo workspace member, excluded from the workspace test gate; it has its own
  `cargo test-sbf` job.
- `packages/faucet`, `packages/announcer` — devnet tooling and a standalone
  announcer sidecar. These are the only reason npm and `package.json` still exist
  here. `npm test` runs them; it does not test the connector.

Mina is **gone from this repository** (ADR 0065). ADR 0002 had already dropped it as a
settlement chain — o1js proof generation is JavaScript-only and a Node sidecar was
refused — and 0065 deleted what that record left standing: the zkApp, the browser
faucet dApp, the Mina tooling and the faucet's Mina leg. What survives is the
connector's refusal of a `mina` claim **by name**, which is wire behaviour owed to
`toon-client`, not Mina support. Do not reintroduce an o1js dependency.

The **app** (or **handler**, for the HTTP endpoint specifically) is the payment-oblivious
service behind a route's `handler_url`. Composition of a connector with an app lives
in the _app's_ repository, not here — this repo builds only the connector image.
Do not use "terminator", "BLS", or "agent runtime"; all three are retired names.

## Commands

```bash
make rust-build     # cargo build --workspace
make rust-test      # cargo test --workspace --exclude payment-channel  (the gate)
make solana-test    # cargo test-sbf, the on-chain program
make test           # npm: the faucet and the announcer — NOT the connector
make lint           # ESLint only. CI also runs cargo fmt --check and clippy -D warnings.

make local-verify   # the shipped IMAGE against real chains: up, send a packet, down
```

CI's Rust gate is `cargo fmt --all -- --check`, `cargo build --workspace`,
`cargo test --workspace --exclude payment-channel`, an assertion that no integration
harness executed zero tests, and `cargo clippy --workspace --exclude payment-channel
--all-targets -- -D warnings`. `packages/contracts` has a separate Foundry job
(`forge test`) that no make target currently runs.

## Testing

**No mocks.** A fake that upholds a port's contract suite is a legitimate test
subject; a stub that asserts a sequence of calls is not (ADR 0007). The three tiers:

1. **Property tests over `connector-domain`** — no I/O, no clock. Route selection,
   claim validation, nonce and watermark rules, fee arithmetic, expiry.
2. **Contract suites**, defined once per port and run against every implementation
   of it. `connector-settlement`'s `assert_upholds_the_contract` is the model.
3. **Integration tests against a real chain**, only where chain behaviour is the
   subject: gas estimation, nonce conflicts, confirmation semantics.

### Tier 3 does not use the Docker containers

This is the thing most often gotten wrong here. `cargo test` **spawns its own
disposable chain per test** and tears it down on drop:

- `connector_settlement_evm::test_support::Anvil::spawn` forks `anvil` on its own port.
- `connector_settlement_solana::test_support::SolanaValidator::spawn` forks
  `solana-test-validator` and loads `payment_channel.so` into genesis at a fixed
  program id, rebuilding the `.so` first unless it is byte-for-byte the one the
  harness itself last built from these sources — `target/deploy` is a drop box
  `make solana-test` and a hand-run `cargo build-sbf` write to as well.

Nothing under `crates/` dials `localhost:8545` or `localhost:8899`. Starting
`make anvil-up` before `cargo test` changes nothing. The containers exist for
running a node by hand, not for the test gate.

A missing chain binary **fails CI and skips locally**. `require_anvil()` /
`require_solana_test_validator()` panic when `CI` is set, because a guard that
returns early and reports `passed` in `0.00s` is worse than a missing test.
Never add a skip-when-unavailable branch that can go green in CI.

Install Foundry (`anvil`, `forge`, `cast`) and the Solana CLI to run the full gate
locally. `forge` is needed for `abi_provenance`, which rebuilds the contracts and
diffs the committed ABI.

### What the containers ARE for

`local/` — the shipped image, run against real containerised chains. It exists for
the one thing `cargo test` structurally cannot check: that the **image**, as uid
10001, with a mounted `connector.toml`, mounted key files and a real volume at
`/app/state`, boots and moves a packet. `make local-verify` brings it up, sends a
real packet, asserts the outcome and tears it down;
`.github/workflows/local-topologies.yml` runs it on every push to `main` and on
PRs touching the crates, the Dockerfile, the compose files, the contracts or
`local/` itself — the path filter is there because a docs-only change elsewhere
cannot break it and the image build is the expensive part.

There are three topologies, chosen with `LOCAL_TOPOLOGY` (default `solo`), and CI
runs all three: `solo` (one node, both settlement backends live at once),
`two-hop` (two nodes peered over ILP-over-HTTP on anvil) and `mixed-chain` (three
nodes, EVM on one leg and Solana on the other, with the middle node holding both
backends). The peered two do not stop at delivery — they cross the peering more
than once and then read the payee's own claim journal, because a peer claim's
verdict rides back in `Toon-Claim-Ack` and never gates the packet, so
`--expect-fulfill` alone would go green over a peering carrying traffic for free.
`local/README.md` is the long version, and is worth reading before editing
anything under `local/`.

It is complementary to `promote-to-fleet.yml`, not a duplicate. That gate checks a
candidate image against the _fleet's_ committed configs and can only warn when the
node fails to serve, because a GitHub runner has no chain to reach. `local/` has
chains, so serving is an assertion — but its configs necessarily name local
container URLs, so it can never be the fleet check. Promotion proves
image-matches-fleet-config; `local/` proves image-serves-and-settles.

`connector send` is the binary's second verb (serving is the other; `announce` was removed by
ADR 0046 / #1074 and is now refused by name). It forms
a real packet — an OER `Prepare` gift-wrapped to the terminating connector (ADR
0018), under a condition derived from that wrap (ADR 0019), inside an RFC
9421-signed `POST /packets` (ADR 0008) — and is what drives the topologies. It is an
operator tool, not a client SDK: it holds no channel and signs no claim.
`--expect-fulfill` makes a non-fulfilled packet a non-zero exit, which is what makes
the rehearsal a gate rather than a report. `--print-keyid` answers "what value goes
in this node's `[operator] write_keys`" from the binary that will do the signing.

## Keys

Key material is referenced **by location, never by value** (ADR 0009, ADR 0012).
Every key is a file path in the config; no key is ever inline, and there is no
environment-variable layer to smuggle one through.

The connector holds a **signer**, not a wallet. ADR 0012's treasury half was deleted
(#556) — collateral is `SettlementBackend`'s job. There is no mnemonic recovery, no
seed management and no wallet database, and none should be reintroduced; end-user
key handling belongs to `toon-client`.

A node reads these:

| Config                             | File                    | What it signs                                           |
| ---------------------------------- | ----------------------- | ------------------------------------------------------- |
| `[signer] key_file`                | `signer.key`            | claims and gift-wrap; 32 raw bytes or 64 hex, secp256k1 |
| `[settlement.evm.key] key_file`    | `settlement.key`        | EVM settlement transactions                             |
| `[settlement.solana.key] key_file` | `settlement-solana.key` | Solana settlement transactions                          |

`[announce]` is gone (ADR 0046 / #1074): the section is now `[node]`, holding only `addresses`,
`http_endpoint` and `btp_endpoint` — the facts a node cannot introspect about itself — and no key of
any kind. Its `identity_key_file`, which carried the retired announcer sidecar's Nostr identity, is
refused by name at boot along with every other announce-only key.

`[operator] write_keys` is different: it holds the **public** halves (64 hex each) of
the keys allowed to make an authenticated write. The private half lives with whoever
is calling, never on the node. `[operator] bearer_token` gates reads only — no shared
secret is ever sufficient to move value (ADR 0008).

Generate one with `openssl rand -hex 32 > signer.key`, or let `local/keys.sh
<topology>` do the whole set for a local topology — it also funds them, which is a
separate failure ("the connector refused to start" and "its settlement account has
no ETH" look identical otherwise). Everything it writes lands in `local/.keys/`,
which is gitignored.

It has a second stage, `local/keys.sh <topology> solana-channels`, and `make
local-up` calls it after the containers are serving. That ordering is forced: a
Solana channel is created by an `InitializeChannel`, no chain CLI here can build
one, and the only submitter is a running node's `POST /channels`. Opening it is
therefore an operator write after boot, not something the config does at boot.
Funding it is too, and for a stronger reason — the program's `Deposit` credits
strictly by signer, so only the payer's own node can put the payer's collateral
behind the payer's claims (`POST /channels/:id/fund`, a self-deposit on both
chains since #1118). That endpoint takes an **increment**, unlike the EVM leg's
absolute `setTotalDeposit`, so the stage reads the deposit back off the chain
first and tops up the shortfall rather than depositing again.

In a container, `state_dir` must be a mounted volume: the image runs as uid 10001
and creates `/app/state` owned by that uid precisely so a fresh named volume
inherits it.

**Never commit key material.** `tools/ci/check-tracked-secrets.sh` fails the build on
a tracked file matching `*-keypair.json`, `*.key`, `*.secret`, `deployer-wallet.json`
or `testnet-wallets.json`, inspecting `git ls-files` rather than the working tree —
a `.gitignore` rule does nothing for a file already in the index. It **also** checks
content: a Solana keypair is a bare JSON array of 64 bytes and can be called
anything, so name matching alone would miss it (and did — `infra/solana/usdc-authority.json`
is a real, spendable key matching no pattern). Deliberate exceptions are allowlisted
there by path, each with a reason.

## Where money comes from

Local and devnet fund completely differently. Do not carry an assumption from one
to the other.

**Local EVM (anvil).** Genesis funds 10 accounts with 10,000 ETH each; account 0
(`0xf39F…2266`) is the deployer everything uses. `DeployLocal.s.sol` deploys a
mintable `MockERC20` USDC at 6 decimals, plus `TokenNetworkRegistry`, `TokenNetwork`
and `RollingSwapChannel`. USDC is **minted on demand** (`deploy_mock_token`,
`MockERC20.mint`), never dripped. No faucet is involved.

**Local Solana.** The validator entrypoint airdrops to the genesis-funded validator
identity and uses it as the deploy fee payer, so no keypair is committed for it.
`infra/solana/create-usdc-mint.sh` creates a deterministic mock USDC mint and seeds
a treasury from `infra/solana/usdc-authority.json`. That script refuses any RPC URL
containing "mainnet" — it mints unlimited supply of a mock token from a committed
keypair and has no mainnet-shaped mode. In tests, funding is
`test_support::fund()`, a plain `request_airdrop`.

**Devnet** settles on _public_ chains — Base Sepolia and Solana devnet — and is
funded by the faucet box (`infra/linode-faucet/`), not by any of the above. The
faucet **mints** on both legs rather than paying out of a balance: Base Sepolia's
mock USDC has an ungated `mint()`, and on Solana the faucet's own keypair is the
mint authority of a mint that box created for itself
(`infra/linode-faucet/create-devnet-usdc-mint.sh`). So neither leg can run dry, and
there is no separate deployer key to lose — which is what happened to the mint used
before 2026-08, killing that leg with no repair path. The faucet is a separate
service and is not part of the connector.

**Mainnet.** Nothing here funds it and no mainnet deployment exists. The Solana
mint script and the local topology are devnet-and-below only.

## Environments

| Tier           | What it is                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **local**      | `docker-compose.yml` chain profiles, and the connector image run against them — that is `local/`. Disposable, funded from genesis, no shared state.                                                                  |
| **devnet**     | Two Linode boxes (`infra/linode-relay/`, `infra/linode-store/`). Containers follow the `rust-release` tag via a label-scoped Watchtower and bind-mount a committed `connector-rust.toml`.                            |
| **production** | **Named and empty** (ADR 0056). No machines, no mainnet contracts, no keys, no deploy. Its one artefact is `deploy/connector-rust/connector.production.toml`, a skeleton in which every value is invalid on purpose. |

Production is blocked on two deployments, not on configuration: `packages/contracts`
has never been deployed to an EVM mainnet, so there is no `TokenNetworkRegistry` to
name, and the Solana payment-channel program is devnet-only — and ADR 0053 binds the
settlement program into a claim's signed message, so a mainnet node naming the devnet
program takes money for claims it can never redeem. Do not fill the skeleton in, and
do not put it under `infra/`: those are gate-checked box configs.
`crates/connector-bin/tests/production_skeleton_is_inert.rs` fails the build on either.

`:rust-release` is a **promotion tag**, not a build output. It moves only by an
explicit `promote-to-fleet.yml` dispatch, which first checks the candidate image
still boots both boxes' committed configs. A green merge does not reach the boxes,
and that is deliberate (ADR 0041): the connector is the client edge on both machines,
so one bad digest takes the whole devnet's paid-write path dark at once. Do not wire
`:rust-release` to move on green `main` — that shipped once (#990) and was reverted.

A **release** is one human dispatch of `release-connector.yml` (ADR 0055), after which
build → handle → GitHub Release → the config-boot gate → the tag move → `fleet-health.yml`
all happen without further input. It is `workflow_dispatch` only, and must stay that way —
adding any automatic trigger reverses ADR 0041 Decision 3. Releases are named by a
monotonic handle (`2026.08.21.1`, UTC date plus that day's ordinal), never semver: every
crate is `0.1.0` with no release process, so a version series would claim a stability
contract the binary has not earned. Deploy ordering rides as a `config-change-required:
true|false` field on the release, which the promotion reads and refuses on. That question
has no default — the dispatch input's preselected option is a sentinel the workflow rejects,
because fail-open on deploy ordering is the shape of the swap#134 outage. When the answer is
yes, the named `fleet-ops config-apply` run is **verified** (right workflow, green, real
apply not a dry run, right box, and after the config's commit), not taken on trust.
(`package.json`'s `"version": "3.3.0"` is TypeScript-era residue; leave it alone.)

Configuration is **one typed TOML file**, validated once at boot, immutable for the
process lifetime, with `deny_unknown_fields` (ADR 0009). There is no environment-
variable override layer; `CONFIG_FILE`, `TOON_MNEMONIC` and friends do nothing. A
removed config key is parsed in order to be _rejected by name_, never silently ignored.
Because the binary and the box's bind-mounted TOML are a matched pair in both
directions, adding a required config key is a **breaking deploy**: land the config
first, then move the tag.

## Pointers

- `docs/architecture/source-tree.md` — the repository map: every crate, and what is
  deliberately not the connector.
- `README.md` — the operator's guide: run a node, put an app behind it, get paid, peer.
  A journey, not a reference; do not add reference material back to it.
- `CONTRIBUTING.md` — the workspace gate, the chain binaries the tests need, the doctrine.
- `CONTEXT.md` — the vocabulary. Read before writing docs or naming anything.
- `docs/adr/` — numbered decisions; the tiebreaker for everything above.
- `vectors/wire-vectors.json` — the normative cross-repo wire contract for
  `toon-client`, `rig` and `swap` (ADR 0021). Prose is not normative. Regenerate with
  `cargo run -p connector-vectors --bin generate-vectors` after any change to the
  envelope, gift wrap, fulfilment derivation or claim signing.
- `docs/operators/` — runbooks for the devnet fleet: box bring-up, key rotation, release
  and health, peering bring-up.
- `docs/agents/` — issue tracker, triage labels, domain docs conventions.
- `docs/rfcs/` — the ten Interledger RFCs this connector implements, vendored verbatim
  and pinned, each under a **TOON profile** recording where this connector departs and
  which record governs the departure (ADR 0062). CC BY-SA 4.0, not MIT — see its README.

When asked about Interledger protocol semantics, activate the relevant `rfc-*` skill
rather than answering from memory. Those skills read `docs/rfcs/`, so the answer comes
from the pinned text and its profile rather than from recall or the network. Never edit
an RFC body to match what this connector does: the alignment goes in the profile above
the marker, and `vendored_rfcs_are_unmodified.rs` fails the build on a body edit. When
the question is "what does Interledger specify" and "what does this connector do" have
different answers — and for ILPv4 packet bytes they currently do (#1174) — give both.

# Production is a named, empty tier

**Status:** Proposed. Not accepted, not live. The skeleton it describes exists
(`deploy/connector-rust/connector.production.toml`) and is held inert by
`crates/connector-bin/tests/production_skeleton_is_inert.rs`. Nothing is deployed, and this record
becomes false the moment something is — at which point it is superseded, not amended.

**Scope:** deployment law for this fleet — not protocol. See the [ADR index](README.md).

This project has three environment tiers — **local**, **devnet**, **production** — and production
is **named and empty**. It has no machine, no mainnet contract, no key, no DNS name and no deploy,
and it consists of exactly one artefact: a configuration skeleton at
`deploy/connector-rust/connector.production.toml` in which every value is invalid on purpose. The
skeleton is not under `infra/`, and it does not carry a real address, because there are none it
could carry.

Naming an empty tier is the decision. A tier that has no name has no place to write down what
standing it up would require, so the requirements get discovered one at a time by whoever
eventually does it.

## Context

### Two tiers, and a third that gets assumed

`CLAUDE.md` describes the tiers this project actually has:

- **local** — `docker-compose.yml` chain profiles and `local/` (connector#1099): the shipped image
  run against real containerised chains. Disposable, funded from genesis, no shared state.
- **devnet** — two Linode boxes, public testnets (Base Sepolia, Solana devnet), faucet-funded,
  `:rust-release` moved by a human dispatch ([0041](0041-a-moving-tag-carries-the-fleets-committed-config-or-it-does-not-move.md),
  [0055](0055-a-release-is-one-dispatch-and-the-ordering-rides-as-data.md)).

There is no third. What there is instead is a steady supply of language that assumes one. The
promotion tag is called `:rust-release`; `promote-to-fleet.yml` quotes a design note about
"validated before it hits production"; `CONNECTOR_RELEASE_CONTRACT.md` describes a supply-chain
contract in the present tense for an image that is no longer published. None of that is wrong
exactly, and all of it invites a reader to believe a production tier is somewhere nearby.

The cost of leaving it unnamed is not confusion for its own sake. It is that every question
production raises — key custody, journal durability, who may reach the client edge, what a mainnet
claim settles against — has nowhere to be written down where the person who eventually asks it will
look. They get rediscovered, individually, under time pressure, by whoever is standing the thing up.

### Two things are deployed-blocked, not merely unconfigured

The skeleton cannot be filled in even in principle, and the reasons are worth stating because they
are prerequisites rather than omissions:

- **There is no mainnet `TokenNetworkRegistry`.** `packages/contracts` has never been deployed to an
  EVM mainnet. `[settlement.evm] contract_address` — the registry every channel resolves through —
  has no correct value in existence. This is not a blank waiting for a paste: a connector pointed at
  the wrong registry resolves `getTokenNetwork()` to the wrong channel contract and accepts claims
  that settle nowhere. The devnet has already proved the failure mode's shape, in a smaller key:
  a `[settlement]` section naming the zero address made both committed box configs exit 1 on
  startup (#542, #576), because there is no contract there to resolve through.
- **The Solana payment-channel program is devnet-only.** `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip`
  is deployed on Solana devnet and nowhere else. [ADR 0053](0053-a-solana-claim-binds-its-domain-the-way-an-evm-claim-does.md)
  binds the settlement program into a Solana claim's signed message, so the program id is not a
  deployment detail a node can be vague about — it is part of what the counterparty signed. A
  mainnet-pointed node naming the devnet program advertises a domain no counterparty can settle
  against, after taking the money.

Both are deployments that have not happened. Neither is a configuration problem, and writing a
plausible-looking value into either would convert a visible blocker into an invisible one.

### Why the skeleton is under `deploy/` and not `infra/`

This is the part most likely to be got wrong by someone tidying up, so it is recorded rather than
left to the file's own header.

`infra/linode-relay/connector-rust.toml` and `infra/linode-store/connector-rust.toml` are **real,
gate-checked box configs**, and ADR 0041 made them load-bearing on purpose:

- `promote-to-fleet.yml` boots the candidate image against both of them, and refuses to move
  `:rust-release` on a config-schema error.
- `fleet-health.yml`'s `config-compat` job re-runs that on any PR touching them.
- `crates/connector-bin/tests/devnet_configs_load.rs` asserts over their contents through the real
  `Config::load`.

A placeholder file in that directory has two futures and no third. Either it breaks a gate — because
something globs the directory, or because a human adds it to a list that already has two entries —
or somebody "fixes" it into something real, which is the same slide by a slower route. ADR 0041's
own Consequences already named the obligation those files now carry: "committed box config becomes
load-bearing, and drifting it is now a build failure." A file that is deliberately not bootable does
not belong among files whose bootability is checked.

`deploy/` is where this repository keeps **recipes** rather than deployments —
`deploy/README.md` says so, and `deploy/connector-rust/connector.toml` is already a heavily
commented template whose placeholders are invalid on purpose (ADR 0009: the connector either runs
with a valid configuration or refuses to start and says why). The production skeleton is the same
pattern with a different subject, so it sits beside it.

### Why the skeleton must stay unrunnable, and why that needs a test

The risk with a named empty tier is not that it stays empty. It is that it fills in one value at a
time, by people each making a locally reasonable edit, until it loads — and a file that loads is a
file somebody can `docker run`. The worst single edit is the most tempting one: pasting the devnet
registry or the devnet Solana program id in "to have something valid there", which produces a node
that boots, looks healthy, and cannot redeem a claim.

So `production_skeleton_is_inert.rs` asserts three things: the file is refused by `Config::load`;
it is **still** refused once real key files are substituted at its three `key_file` paths (otherwise
the guarantee rests on nothing but a missing file, and the next person to mount a key discovers the
rest of the file is one address from booting); and it contains no 40-hex EVM address and never sets
the devnet Solana program id as a value. The program id may appear in prose — the header cites it
precisely to say it is devnet-only, which is the file's whole job.

## Decision

1. **There are three tiers and production is one of them**, named in `CLAUDE.md`, in this record,
   and in the skeleton's own header.
2. **Production is empty.** No machine, no mainnet contract, no key, no DNS name, no deploy, and
   no promotion target. `:rust-release` fronts the devnet and nothing else.
3. **The skeleton lives at `deploy/connector-rust/connector.production.toml`**, following the
   documented-template pattern of the `connector.toml` beside it: heavily commented, every value
   invalid on purpose, explaining _why_ each open question is open rather than leaving a blank.
4. **It is not under `infra/`.** That directory holds gate-checked box configs, and a deliberately
   unbootable file there either breaks a gate or gets repaired into a real one.
5. **It carries no real address.** No mainnet registry exists to name, and the devnet Solana
   program may be cited in prose but never set as a value.
6. **It stays unrunnable**, asserted by `crates/connector-bin/tests/production_skeleton_is_inert.rs`
   — including with key files present, so the guarantee does not rest on a missing file.

## Consequences

**The open questions have somewhere to live.** The skeleton names them inline, at the setting each
one belongs to: signer custody and rotation at `[signer]`; journal durability, backup and restore
rehearsal at `state_dir`; client-edge exposure at `client_edge_addr`; who holds the write key at
`[operator]`. They are not a checklist in a ticket that closes; they are comments on the lines that
cannot be filled in without answering them.

**"Production" stops being available as a loose word.** It now names something specific and empty.
A document that uses it to mean the devnet is wrong, and can be corrected against this record rather
than argued about. The devnet is the devnet: faucet-funded, testnet-settled, and explicitly accepted
by toon-meta#403 as a tier where a bad-but-green merge can reach a live box.

**Standing production up supersedes this record, it does not amend it.** The moment a machine
exists, a mainnet registry is deployed, or a key is provisioned, every sentence here is false. That
is the intended shape: this record describes an absence, and an absence cannot be edited into a
presence. The successor will need to answer, at minimum, what ADR 0041's rule 1 means when a tag
move can lose real money, and whether a supervised promotion dispatch is still a sufficient gate at
that stake.

**A cost, stated plainly:** this adds a file and three tests for a tier that does not exist, and
somebody will reasonably ask why. The answer is that the alternative is not "no file" — it is the
same content discovered under time pressure by whoever first tries, minus the two hard blockers
being visible before they start.

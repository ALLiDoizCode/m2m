# Bringing the rolling-swap maker up on the relay box

> **Its `fleet-ops` steps are historical as of
> [ADR 0068](../adr/0068-a-node-repository-pins-the-connector-nothing-here-moves-a-tag-onto-a-box.md)**
> (issue #1213). `fleet-ops.yml` no longer offers `box=relay`, so every dispatch below naming that
> box — `deploy`/`restart` of `swap-node` or `watchtower` — has to be the equivalent
> `docker compose` command run on the box instead, which each step already spells out beside it.
> (Its `announce` steps were already dead: ADR 0046 / #1074 removed the announce outright.) The
> compose, nginx and config work described here is unchanged.

Operator runbook for [connector#983](https://github.com/toon-protocol/connector/issues/983)
(connector-infra half of [toon-meta#402](https://github.com/toon-protocol/toon-meta/issues/402),
itself a child of toon-meta#394). Modeled on
[`relay-box-bringup.md`](relay-box-bringup.md) and
[`faucet-box-bringup.md`](faucet-box-bringup.md)'s "Who does what" split — most of what
this ticket asks for is a reviewable repo diff; a small, enumerated set of steps needs SSH, key
material or funds this environment does not have.

## What is already done, repo-side

- `infra/linode-relay/docker-compose.relay.swap.yml` — the `swap-node` compose service: pins the
  maker's runtime image to the moving `:release` tag, carries the
  `com.centurylinklabs.watchtower.enable` label (connector#988) so Watchtower auto-redeploys it on
  a new digest, mounts `swap.config.json`, and binds its BTP (`3400`) and health (`8080`) ports to
  loopback.
- `infra/linode-relay/docker-compose.relay.watchtower.yml` (connector#988, toon-meta#403) — a
  label-scoped `containrrr/watchtower` that watches ONLY containers carrying that label (currently
  just `swap-node`) and recreates them on a new image digest, image-only, no config touched. See
  that file's own header for why `connector-rust`/`relay`/`nginx` are deliberately excluded.
- `infra/linode-relay/swap.config.json` — a committed config skeleton expressing the standalone
  direct-dial wiring toon-meta#402 proved (swap#105): no `connector`/`connectorUrl`, so
  `toon-swap --config` auto-creates an embedded, parentless `ConnectorNode` gated on
  `btpServerPort`. That embedded node comes from the **retired** `@toon-protocol/connector` 3.x
  line; its `child` peer relation (which the leg-B return path sets) is that line's, and the Rust
  connector has no parent/child peer relation at all. `evm:84532` `chainProviders` point at the deployed `RollingSwapChannel`
  (connector#974) and the fleet's standard `TokenNetworkRegistry`/USDC. See that file's own
  `_..._comment` fields for every placeholder it carries and why.
- `infra/linode-relay/nginx/node.conf.template` + the rendered `nginx/conf.d/node.conf` — two new
  `location =` blocks, `/swap/ilp/btp` and `/swap/ilp`, proxying to `swap-node:3400` under THIS
  box's existing `proxy.relay.${DOMAIN}` certificate. **No new DNS record or TLS cert is needed** —
  a deliberate simplification over toon-meta#402's original enumeration, which assumed a dedicated
  subdomain.
- `infra/linode-relay/docker-compose.relay.swap-announce.yml` +
  `infra/linode-relay/connector-rust.swap-announce.toml` — the maker's OWN kind:10032 publisher, a
  `connector announce` loop mirroring `docker-compose.relay.announce.yml`'s shape exactly (same
  tool, same publish-sleep-repeat pattern), but signing and paying as the maker's identity, not the
  relay's.
- `.github/workflows/fleet-ops.yml` — `restart`/`deploy` recognize `service=swap-node` and
  `service=watchtower` on the relay box (via the relay's own `COMPOSE` now including
  `docker-compose.relay.swap.yml` and `docker-compose.relay.watchtower.yml`); `announce` recognizes
  `service=swap-announce` as a second, independently-forceable publisher alongside the relay's own
  `announce`.
- `.gitignore` already covers `infra/linode-relay/*.key` and `*.secret` — nothing generated on the
  box in the steps below is committable by accident.

## What this leaves open

- **The maker runtime image now tracks `:release`, not a step a human repoints per build.**
  connector#988 (toon-meta#403) repointed `docker-compose.relay.swap.yml` from an immutable
  `sha-<short-sha>` pin to the moving `ghcr.io/toon-protocol/swap:release` tag — swap#131 makes
  `publish-swap-image.yml` push that tag on every green merge to `main` — and added a label-scoped
  `containrrr/watchtower` (`docker-compose.relay.watchtower.yml`) that recreates `swap-node` when
  the tag's digest moves. Step 1 below is therefore bringing the SIDECAR up once, not repointing an
  image tag per release; `sha-<short-sha>` tags remain available for a manual rollback if a
  `:release` build regresses. The compose service's command invokes
  `node /app/dist/cli.js --config ...` directly (not the `toon-swap` bin) — matching the runtime
  image's own `ENTRYPOINT`, which does the same and never puts `node_modules/.bin` on `PATH` — so
  nothing else in this unit depends on the image's contents beyond that file existing at that path
  under `WORKDIR /app`.
- **`swap.config.json`'s `settlementPrivateKey` is an obviously-fake placeholder.**
  `packages/swap/src/cli.ts`'s env overlay (`SWAP_MNEMONIC`) does **not** derive or set this field —
  it only sets `mnemonic`/`secretKey`. A human must compute the on-box mnemonic's BIP-44
  account-index-2 key (D12-011 — the same key used for leg-B claim signing) and set it in a
  box-local, **uncommitted** copy of `swap.config.json` before the maker can issue a redeemable
  claim. This is a real gap in the current `toon-swap` CLI config surface, and swap#124 (merged as
  swap#125) did not close it: its own text asked to "verify the CLI config surface actually covers
  this... if it has gaps, either extend the CLI or bake a thin entrypoint", and the env overlay it
  shipped still sets only `mnemonic`/`secretKey`. Closing it belongs to a follow-up on the
  toon-swap CLI, not to this ticket.
- **`tokenNetworkAddress` and `channelAddress` are different contracts.** Read them wrong and the
  maker is down. `tokenNetworkAddress` is **leg A** — money coming _in_: the ordinary `TokenNetwork`
  a taker's existing funded channel lives on, the contract the maker verifies the incoming claim
  against. `channelAddress` is **leg B** — money going _out_: the `RollingSwapChannel` (#973/#974),
  a different contract with a different ABI, the one the maker signs its own v2 EIP-712 balance
  proofs against. swap#134 made `tokenNetworkAddress` **required** and there is no fallback to
  `channelAddress`; a maker missing it crash-loops, which is how this was found on the live box.
  Both are committed, and `the_makers_leg_a_token_network_is_the_fleets_and_is_not_its_leg_b_channel`
  in `crates/connector-bin/tests/devnet_configs_load.rs` refuses a config where they are equal or
  where leg A is not the fleet's one deployment.
- **`swap.config.json`'s `swapPairs` is a placeholder pair** (same-chain USDC at parity on
  `evm:84532`), present only so the maker boots. The actual trading pair(s) this maker should quote
  — which chain(s) it accepts leg-A payment on, at what rate, with what inventory — is a business
  decision neither toon-meta#402 nor this ticket pins. A human sets this once the maker is meant to
  actually trade.
- **The `swap_node_state` named volume's ownership** is resolved image-side, not here:
  toon-protocol/swap#125's merged Dockerfile creates and chowns `/app/state` before its `USER swap`
  line, so a fresh volume inherits uid 10001 ownership on first mount and the maker can write its
  boot snapshot to `statePath` (`/app/state/swap-node-state.json`, matching
  `docker-compose.relay.swap.yml`'s mount point). If that ever regresses, fall back to a host bind
  mount pre-chowned the same `chown 10001:10001` way step 3 below already does for the key files,
  in place of the named volume.
- **A SECOND funded channel, beyond what toon-meta#402 enumerated.** toon-meta#402's checklist lists
  "gas + leg-B channel" as the human-gated settlement step. Building the paid-announce loop
  surfaced a step that checklist did not separately call out: the announce loop
  (`connector-rust.swap-announce.toml`'s `[announce] pay_channel`) needs its **own** ordinary
  payment channel — under the fleet's standard `TokenNetworkRegistry`, the SAME kind every other box
  pays the relay from — to pay for the maker's own kind:10032 writes. This is **not** the same
  channel as the leg-B `RollingSwapChannel` channel `swap.config.json`'s `channels.evm:84532` names:
  different contract, different verifying domain, and a leg-B claim would be refused if used to pay
  an ordinary relay write. See `connector-rust.swap-announce.toml`'s own header for the full
  reasoning.

## Who does what

| Step                                     |                Repo-side (this PR)                 |      Human-only (SSH, key material, funds)       |
| ---------------------------------------- | :------------------------------------------------: | :----------------------------------------------: |
| 1. Maker runtime image                   |   ✅ `:release` pin + watchtower overlay (#988)    |     ✅ bring `watchtower` up (one-time SSH)      |
| 2. Identity generation (BIP-39 mnemonic) |                                                    |          ✅ generated ON the relay box           |
| 3. Extract the two derived key files     |                                                    | ✅ index-0 Nostr key, index-2 EVM settlement key |
| 4. Announce-loop pay channel             |                                                    |          ✅ opened + funded (see above)          |
| 5. Leg-B channel + gas                   |                                                    | ✅ RollingSwapChannel open/fund (toon-meta#402)  |
| 6. Trading pair / inventory config       |                                                    |               ✅ business decision               |
| 7. Bring the sidecar up                  | ✅ compose files, config skeleton, nginx locations |        ✅ runs `docker compose ... up -d`        |
| 8. Verify                                |                                                    |    ✅ curls + reads the announce loop's logs     |

## Order — image through verification

1. **Maker runtime image.** `docker-compose.relay.swap.yml` already pins the moving
   `ghcr.io/toon-protocol/swap:release` tag (connector#988) — no per-build repo edit needed any
   more. The one remaining human step is bringing the label-scoped Watchtower up alongside the
   sidecar (`docker compose ... up -d watchtower`, or dispatch `fleet-ops.yml` with
   `box=relay operation=deploy service=watchtower apply=true`) so future `:release` moves are
   picked up automatically; until then a new digest sits published but not deployed.

2. **Identity generation.** On the relay box, generate a **fresh** BIP-39 mnemonic — the same
   `TOON_MNEMONIC` convention `infra/linode-relay/.env.example` already documents for this box's own
   connector identity, but a **separate** phrase: the maker is a different node with a different
   identity, never the relay's own `[signer]`. Never let the phrase leave the box. Write it to
   `infra/linode-relay/swap-mnemonic.secret` (git-ignored) — the path
   `docker-compose.relay.swap.yml` mounts and its entrypoint reads into `SWAP_MNEMONIC`.

3. **Extract the two derived keys.** From that SAME mnemonic, derive:
   - the **index-0 NIP-06 Nostr identity key** — write its raw scalar to
     `infra/linode-relay/swap-signer.key`, the file `connector-rust.swap-announce.toml`'s
     `[signer]` reads. This MUST be the exact key the swap-node container's own
     `SWAP_MNEMONIC`-derived identity uses, or the announce loop publishes a kind:10032 under a
     pubkey the maker cannot itself open gift wraps sealed to (see that file's own header).
   - the **BIP-44 account-index-2 settlement key** (D12-011) — write its raw scalar to
     `infra/linode-relay/swap-settlement.key` (the announce loop's
     `[settlement.evm.key]`) **and** set it as `settlementPrivateKey` in a box-local,
     **uncommitted** copy of `swap.config.json` (see "What this leaves open" above — the committed
     file's value is a deliberately-fake placeholder).

   Both files — and step 2's `swap-mnemonic.secret` — are bind-mounted read-only into containers
   that run as **uid 10001** (`connector` in the Rust image, `swap` in the maker image). A bind
   mount keeps the HOST's ownership, so a root-owned `0600` file is unreadable inside the
   container: the announce loop exits before it publishes anything, and the maker's entrypoint
   `cat` fails under `set -eu`. `chown 10001:10001` all three before the first `up -d`, exactly as
   `deploy/connector-rust/README.md` step 1 already requires for `signer-rust.key`.

4. **Announce-loop pay channel.** Open and fund an ordinary EVM payment channel (the fleet's
   standard `TokenNetworkRegistry`, `0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1`) from the
   index-2 settlement address to the relay box, mirroring how
   `infra/linode-store/connector-rust.toml`'s own `[announce] pay_channel` was opened and funded
   before ADR 0046 removed it. Replace
   `connector-rust.swap-announce.toml`'s `pay_channel = "0xdead..."` placeholder with the real id in
   a box-local copy (or land it as a follow-up repo PR once the id is known — it is not secret).

5. **Leg-B channel + gas.** Fund the index-2 address with Base Sepolia gas, and open/fund the leg-B
   `RollingSwapChannel` (`0xd329aBf86ceae23F904641F992ca90e3721FeF83`) per toon-meta#402's own
   checklist. Replace `swap.config.json`'s placeholder `channels.evm:84532[0].channelId` with the
   real id in the box-local copy.

6. **Trading pair / inventory.** Replace `swap.config.json`'s placeholder `swapPairs`/`inventory`
   with the real values this maker should quote, in the box-local copy.

7. **Bring the sidecar up.**

   ```sh
   cd /root/connector
   docker compose -f infra/linode-relay/docker-compose.relay.yml \
                  -f infra/linode-relay/docker-compose.relay.rust.yml \
                  -f infra/linode-relay/docker-compose.relay.swap.yml \
                  up -d swap-node
   docker compose -f infra/linode-relay/docker-compose.relay.yml \
                  -f infra/linode-relay/docker-compose.relay.rust.yml \
                  -f infra/linode-relay/docker-compose.relay.swap.yml \
                  -f infra/linode-relay/docker-compose.relay.swap-announce.yml \
                  up -d swap-announce
   docker compose -f infra/linode-relay/docker-compose.relay.yml \
                  -f infra/linode-relay/docker-compose.relay.rust.yml \
                  -f infra/linode-relay/docker-compose.relay.swap.yml \
                  -f infra/linode-relay/docker-compose.relay.watchtower.yml \
                  up -d watchtower
   ```

   Or dispatch `fleet-ops.yml` with `box=relay`, `operation=deploy`, `service=swap-node`,
   `apply=true` (pulls the pin the repo names and recreates the container — run `restart` instead if
   the pin is already correct), then `operation=announce`, `service=swap-announce`, `apply=true`,
   then `operation=deploy`, `service=watchtower`, `apply=true` (one-time — after this, a new
   `:release` digest is picked up without a further dispatch).

8. **Verify.**

   ```sh
   # Reaches the maker's HTTP surface. The embedded connector's BTP listener serves only
   # `POST /ilp` and 404s everything else, so a GET answering `404` IS the pass here — it is
   # the maker's own answer. `502` is the failure: that is nginx reporting an absent or
   # crash-looping `swap-node` container, not the maker replying.
   curl -s -o /dev/null -w '%{http_code}\n' https://proxy.relay.devnet.toonprotocol.dev/swap/ilp
   ```

   and that the announce loop's log carries `[swap-announce] OK -- g.toon.swap.maker published`
   (`fleet-ops.yml`'s `announce` operation reads this back itself and fails the job if it does not
   appear within 90s). Confirm the published kind:10032 content carries the maker's own
   `btpEndpoint` (`wss://proxy.relay.devnet.toonprotocol.dev/swap/ilp/btp`) and the `evm:84532`
   settlement facts — verify the content, not the author, because two publishers are easy to
   confuse here: the relay's own announce and the maker's.

   Proving an actual swap against the deployed maker (a stock client discovering the announce,
   direct-dialing the BTP endpoint, completing a rolling swap, redeeming the leg-B claim on-chain)
   is toon-meta#402's own "Proof" checklist item and is out of this runbook's scope — this runbook
   ends at "the maker is reachable and discoverable," not "a swap has been proven against it".

## Rollback

`docker compose ... stop swap-node swap-announce` (or `down`) removes the sidecar and its announce
loop without touching the relay's own `connector-rust`/`announce` services — they are separate
compose services sharing nothing but the compose project's default network (which is how nginx
resolves `swap-node` at all): no config file, no key material and no state volume in common. The
`/swap/ilp*` nginx locations answer `502`/connection-refused once the container is stopped, which is
the correct failure mode (not a silent fallback to the relay's own edge — `location =` blocks are
exact-match and never fall through to `location /`).

If a `:release` build regresses (Watchtower auto-recreates `swap-node` on ANY new digest — it does
no health-gating, so a bad image auto-deploys and the container just crash-loops), roll back by
hand to a known-good immutable `sha-<short-sha>` tag: edit `docker-compose.relay.swap.yml`'s
`image:` line, `up -d --no-deps swap-node`, and either `stop watchtower` until a fix lands or accept
that Watchtower will move `swap-node` straight back to `:release` on its next scan — the sha pin is
a stopgap, not a way to opt this one container out of the label-scoped model permanently (remove the
`com.centurylinklabs.watchtower.enable` label for that).

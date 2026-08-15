# Bringing the rolling-swap maker up on the relay box

Operator runbook for [connector#983](https://github.com/toon-protocol/connector/issues/983)
(connector-infra half of [toon-meta#402](https://github.com/toon-protocol/toon-meta/issues/402),
itself a child of toon-meta#394). Modeled on
[`relay-box-bringup.md`](relay-box-bringup.md) and
[`faucet-box-bringup.md`](../operators/faucet-box-bringup.md)'s "Who does what" split — most of what
this ticket asks for is a reviewable repo diff; a small, enumerated set of steps needs SSH, key
material or funds this environment does not have.

## What is already done, repo-side

- `infra/linode-relay/docker-compose.relay.swap.yml` — the `swap-node` compose service: pins the
  maker's runtime image (currently a placeholder — see "What this leaves open" below), mounts
  `swap.config.json` and a mnemonic key file (path only), binds its BTP (`3400`) and health
  (`8080`) ports to loopback.
- `infra/linode-relay/swap.config.json` — a committed config skeleton expressing the standalone
  direct-dial wiring toon-meta#402 proved (swap#105): no `connector`/`connectorUrl`, so
  `toon-swap --config` auto-creates an embedded, parentless `ConnectorNode` gated on
  `btpServerPort`. `evm:84532` `chainProviders` point at the deployed `RollingSwapChannel`
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
- `.github/workflows/fleet-ops.yml` — `restart`/`deploy` recognize `service=swap-node` on the relay
  box (via the relay's own `COMPOSE` now including `docker-compose.relay.swap.yml`); `announce`
  recognizes `service=swap-announce` as a second, independently-forceable publisher alongside the
  relay's own `announce`.
- `.gitignore` already covers `infra/linode-relay/*.key` and `*.secret` — nothing generated on the
  box in the steps below is committable by accident.

## What this leaves open

- **The maker runtime image.** `docker-compose.relay.swap.yml` pins
  `ghcr.io/toon-protocol/swap:PENDING-swap-124` — a placeholder. toon-protocol/swap#124 (the GHCR
  publish workflow for the maker image) had not landed a pushed tag as of this change. Repoint the
  `image:` line to the real tag once it does; nothing else in this unit depends on the image's
  contents beyond "the `toon-swap` binary is on `PATH`".
- **`swap.config.json`'s `settlementPrivateKey` is an obviously-fake placeholder.**
  `packages/swap/src/cli.ts`'s env overlay (`SWAP_MNEMONIC`) does **not** derive or set this field —
  it only sets `mnemonic`/`secretKey`. A human must compute the on-box mnemonic's BIP-44
  account-index-2 key (D12-011 — the same key used for leg-B claim signing) and set it in a
  box-local, **uncommitted** copy of `swap.config.json` before the maker can issue a redeemable
  claim. This is a real gap in the current `toon-swap` CLI config surface (see swap#124's own text:
  "verify the CLI config surface actually covers this... if it has gaps, either extend the CLI or
  bake a thin entrypoint") — closing it belongs to whichever ticket finishes swap#124, not this one.
- **`swap.config.json`'s `swapPairs` is a placeholder pair** (same-chain USDC at parity on
  `evm:84532`), present only so the maker boots. The actual trading pair(s) this maker should quote
  — which chain(s) it accepts leg-A payment on, at what rate, with what inventory — is a business
  decision neither toon-meta#402 nor this ticket pins. A human sets this once the maker is meant to
  actually trade.
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
| 1. Maker runtime image                   |                                                    |      ✅ swap#124 publishes; repoint the tag      |
| 2. Identity generation (BIP-39 mnemonic) |                                                    |          ✅ generated ON the relay box           |
| 3. Extract the two derived key files     |                                                    | ✅ index-0 Nostr key, index-2 EVM settlement key |
| 4. Announce-loop pay channel             |                                                    |          ✅ opened + funded (see above)          |
| 5. Leg-B channel + gas                   |                                                    | ✅ RollingSwapChannel open/fund (toon-meta#402)  |
| 6. Trading pair / inventory config       |                                                    |               ✅ business decision               |
| 7. Bring the sidecar up                  | ✅ compose files, config skeleton, nginx locations |         runs `docker compose ... up -d`          |
| 8. Verify                                |                         —                          |    ✅ curls + reads the announce loop's logs     |

## Order — image through verification

1. **Maker runtime image.** Confirm toon-protocol/swap#124 has pushed a pullable tag. Edit
   `infra/linode-relay/docker-compose.relay.swap.yml`'s `image:` line to name it (a small,
   reviewable repo PR — not a live-box step by itself).

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

4. **Announce-loop pay channel.** Open and fund an ordinary EVM payment channel (the fleet's
   standard `TokenNetworkRegistry`, `0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1`) from the
   index-2 settlement address to the relay box, mirroring how
   `infra/linode-store/connector-rust.toml`'s own `[announce] pay_channel` is opened and funded
   (`docs/operators/announcing-a-node.md`, "What the node needs before this can work"). Replace
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
   ```

   Or dispatch `fleet-ops.yml` with `box=relay`, `operation=deploy`, `service=swap-node`,
   `apply=true` (pulls the pin the repo names and recreates the container — run `restart` instead if
   the pin is already correct), then `operation=announce`, `service=swap-announce`, `apply=true`.

8. **Verify.**

   ```sh
   curl -sf https://proxy.relay.devnet.toonprotocol.dev/swap/ilp   # reaches the maker's HTTP surface
   ```

   and that the announce loop's log carries `[swap-announce] OK -- g.toon.swap.maker published`
   (`fleet-ops.yml`'s `announce` operation reads this back itself and fails the job if it does not
   appear within 90s). Confirm the published kind:10032 content carries `btpEndpoint:
"wss://proxy.relay.devnet.toonprotocol.dev/swap/ilp/btp"` and the `evm:84532` settlement facts —
   the same content-not-author verification `docs/operators/announcing-a-node.md` already asks for
   when two publishers might be confused, here between the relay's own announce and the maker's.

   Proving an actual swap against the deployed maker (a stock client discovering the announce,
   direct-dialing the BTP endpoint, completing a rolling swap, redeeming the leg-B claim on-chain)
   is toon-meta#402's own "Proof" checklist item and is out of this runbook's scope — this runbook
   ends at "the maker is reachable and discoverable," not "a swap has been proven against it".

## Rollback

`docker compose ... stop swap-node swap-announce` (or `down`) removes the sidecar and its announce
loop without touching the relay's own `connector-rust`/`announce` services — they are independent
compose services on independent networks-within-the-project, sharing nothing but the box. The
`/swap/ilp*` nginx locations answer `502`/connection-refused once the container is stopped, which is
the correct failure mode (not a silent fallback to the relay's own edge — `location =` blocks are
exact-match and never fall through to `location /`).

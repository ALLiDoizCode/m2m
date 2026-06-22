# Handoff — "Connector as App Front Door" (epic toon-protocol/toon-meta#52)

> Session handoff so a fresh session can continue without the prior chat.
> Date of handoff: 2026-06-22. Repo: `toon-protocol/connector`. `origin/main` @ `215327d` (release 3.22.0).

---

## TL;DR

The "connector-as-terminator" epic (#216–#225) is **shipped** — 3 PRs merged, 2 open and mergeable. Along the way two pre-existing `main` defects were fixed. The conversation then pivoted into a **redesign** of the operator config + the client-facing edge that is **not yet implemented** — that's the work for the next session. Nothing in the redesign has touched code yet.

**Terminology note (decided this session):** stop using the word **"terminator"** — it's just the **connector** acting as a paid reverse proxy. The two roles are **`app`** and **`connector`**. See the rename plan below.

---

## What shipped (issues #216–#225, #228)

| # | What | Status |
|---|------|--------|
| 216 | Generic HTTP reverse-proxy local-delivery handler (`HttpProxyHandler`) | ✅ merged (#226) |
| 217 | x402 **v2** `402` greeting (vanilla `exact` + `toon-channel` upgrade) | ✅ merged (#226) |
| 218 | nginx-style route→upstream config (`RouteTermination` + registry) | ✅ merged (#226) |
| 219 | `connector` CLI (`up`, `app add`, `route add/ls`, `--json`) | ✅ merged (#226) |
| 220 | RFC 9421 claim↔request binding (MVP; ed25519, signed-price header) | ✅ merged (#226) |
| 221 | Local docker compose: connector + app + chain | ✅ scaffold merged (#226); **AC3 paid round-trip completed in PR #229 (OPEN)** |
| 222 | Linode public-internet deploy of connector + relay | 🔶 **PR #230 (OPEN)** — code only, deploy gated, not run |
| 224 | RFC 9421 hardening (replay cache, JWKS, key lifecycle) | ⏸ parked; decomposed into 12 stories; **now unblocked** (#220 merged) |
| 225 | ILP-over-HTTP egress (`HttpPeerClientManager` + `PeerEgress`) | ✅ merged (#227) |
| 228 | 6-decimal default channel deposit fix (regression from #188/#195) | ✅ merged |

### PRs
- **#226** terminator epic (#216–#221) — **MERGED**
- **#227** ILP-over-HTTP egress (#225) — **MERGED**
- **#228** 6-decimal channel-deposit fix — **MERGED**
- **#229** completes #221 (real paid round-trip, verified vs `relay:latest`) — **OPEN, MERGEABLE**
- **#230** #222 Linode deploy (gated, no auto-run) — **OPEN, MERGEABLE**
- **relay#26** (publish oblivious relay image) — **CLOSED/done** by the relay team

### Two pre-existing `main` defects fixed while triaging CI
1. **Devbox CI**: the `Devbox Environment Validation` smoke build was the only `npm ci` in `ci.yml` without `--ignore-scripts`, so it ran the `@anyone-protocol/anyone-client` postinstall → hit the anonymous `api.github.com` rate limit (403). Fixed with `--ignore-scripts` (in #226).
2. **`standalone-settlement-e2e` red on `main` for 17 runs** (since `3eba25d`, the #188/#195 6-decimal USDC migration): the channel auto-open default deposit was hardcoded `1e18` (= 1e12 USDC at 6 decimals) → on-chain "Insufficient balance". Fixed to `1e6` in `channel-manager.ts` + the test helper's `MIN_USDC_BALANCE` (**#228**).

---

## Verified facts (don't re-derive these)

### Images (both public, HTTP 200 anonymous)
- **Connector**: `ghcr.io/toon-protocol/connector:latest` — built by `build-and-publish.yml`; used by `docker-compose.prod.yml`. **The connector is distributed like nginx: a Docker image + a config file.**
- **Relay (oblivious app)**: `ghcr.io/toon-protocol/relay:latest` — built from the relay repo `packages/relay/Dockerfile` (issue #26). Tags: `latest`, `sha-b8ec120`, `sha-2e1676f`.
  - Entrypoint = the `relay` CLI (`dist/cli.js`), runs oblivious out of the box.
  - `POST /write` on `TOON_BLS_PORT` (default **3100**), body `{ "event": <NostrEvent> }` → `200 {eventId, storedAt}`.
  - `GET /health` on 3100. Free NIP-01 WS reads on `TOON_RELAY_PORT` (default **7100**).
  - **Requires** `NOSTR_SECRET_KEY`/`--secret-key`/`TOON_MNEMONIC` to boot (won't start without an identity).
  - `RELAY_DEV_MODE` toggles Nostr signature verification (must be **false** in public deploys).
  - NIP-01 read shape: `EVENT[2]` is a **TOON-encoded string** containing `id: <eventId>` — substring-match, do NOT `JSON.parse`.

### toon-devnet chain values (from `infra/linode/endpoints.json`; DOMAIN = `devnet.toonprotocol.dev`)
- **EVM**: `rpcUrl https://evm-rpc.devnet.toonprotocol.dev`, `chainId evm:31337`, registry `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`, token `0x5FbDB2315678afecb367f032d93F642f64180aa3`, 6 decimals, faucet `https://faucet.devnet.toonprotocol.dev`. (Same deterministic anvil deploy as local — addresses identical.)
- **Solana**: `rpcUrl https://solana-rpc.devnet.toonprotocol.dev`, `wss://solana-ws.devnet.toonprotocol.dev`, `programId 598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W` (canonical program ID from all Rust tests — **confirm vs the live deploy**), `tokenMint H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H`, 6 decimals.
- **Mina**: `graphqlUrl https://mina.devnet.toonprotocol.dev/graphql` (passthrough to public devnet `api.minascan.io`). **`tokenAddress`/`tokenId` are NOT in the repo** — they only exist in the live deploy output `infra/mina/usdc-token.json` (or `MINA_USDC_TOKEN`/`MINA_USDC_ADMIN_CONTRACT` env). Deployed once by `tools/mina/deploy-usdc-token.ts`. **Action: read off the live host or have the user provide.**

### Config / addressing facts
- `deploymentMode` is **optional and inferred** from `adminApi`/`localDelivery` flags (`getDeploymentMode()` in `connector-node.ts`). It's **redundant** — drop it.
- The route `prefix` is **literal**. `deriveLocalPrefixes`: a connector has no single configured "own address"; its self-prefixes are the routes whose `nextHop === nodeId`/`'local'`. `nodeId` prepends **nothing**. So `prefix: g.connector.relay` must be written literally; it does not derive from `nodeId`.
- **Seed phrase**: there is a BIP-39 HD seed manager (`packages/connector/src/wallet/wallet-seed-manager.ts`) but it is **NOT wired into the standalone YAML boot path**. The current standalone config signs with a raw `chainProviders[].keyId` private key (anvil acct 0). `key-manager.ts` backends: `env | aws-kms | gcp-kms | azure-kv | hsm`. Wiring mnemonic mode is a **build item** (see redesign).

---

## Decisions LOCKED this session (apply in the redesign)

1. **Naming → `app` + `connector`** (kill "terminator" and "app-behind-X"). Scope = prose/comments **and** user-facing artifacts, **NOT** code type names (`RouteTermination*` stay):
   | was | now |
   |-----|-----|
   | service `terminator` | service `connector` |
   | service `relay` | service `app` (runs the relay image) |
   | profile `app-behind-terminator` | profile `app` |
   | `scripts/app-behind-terminator/terminator.yaml` | `scripts/app/connector.yaml` |
   | route `g.terminator.relay` | `g.connector.relay` |
   | `make app-up/down/logs/test` | unchanged (already clean) |
2. **Point at toon-devnet, not bundled anvil/faucet** → dropping anvil+faucet makes the compose a clean **2 services: `connector` + `app`**.
3. **All supported chains under `chainProviders`** (evm + solana + mina), each pointing at the devnet endpoints above.
4. **Mnemonic signing key** — wire `wallet-seed-manager.ts` into the standalone boot so one `TOON_MNEMONIC` (env-injected) derives the EVM/Solana/Mina keys (the hub's "mnemonic mode"; reuse the faucet's existing HD derivation scheme so addresses match).
5. **Drop `deploymentMode`** (inferred).

### Target `connector.yaml` (the config the redesign produces)
```yaml
nodeId: connector
btpServerPort: 3000          # POST /ilp edge (multi-hop); see edge redesign below
healthCheckPort: 8080
adminApi: { enabled: true, port: 8081 }
mnemonic: ${TOON_MNEMONIC}   # derives per-chain keys (build item)
settlement:
  enableSettlement: true
  connectorFeePercentage: 0.1
  thresholds: { defaultThreshold: '5000', pollingInterval: 100 }
chainProviders:
  - chainType: evm
    chainId: evm:31337
    rpcUrl: https://evm-rpc.devnet.toonprotocol.dev
    registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512'
    tokenAddress:    '0x5FbDB2315678afecb367f032d93F642f64180aa3'
  - chainType: solana
    rpcUrl: https://solana-rpc.devnet.toonprotocol.dev
    programId: '598iSn5tfXsLcTPKj97SzKiCLVbKf7okNY4AEjgpLg2W'   # confirm vs live
    tokenMint: 'H8HSreUF2s8r8hem4qMttE3bWYCpFuh71jbuos5bA77H'
  - chainType: mina
    graphqlUrl: https://mina.devnet.toonprotocol.dev/graphql
    tokenAddress: '<FILL FROM LIVE DEVNET infra/mina/usdc-token.json>'
    tokenId:      '<FILL FROM LIVE DEVNET>'
routes:
  - prefix: g.connector.relay
    nextHop: connector
    upstream: http://app:3100
    price: '1000'
    chains: [evm, solana, mina]
    ilpAddress: g.connector.relay
    settlementAddresses: { evm: '0x…', solana: '…', mina: 'B62q…' }   # mnemonic-derived
```

---

## The architectural pivot (NOT yet built — the heart of the next session)

**Problem the user raised:** making the *client* serialize an ILP PREPARE + sign a channel claim + parse a FULFILL is too much friction.

**Conclusion reached:** there are **two distinct edges**, and the client was pointed at the wrong one.
- **connector ↔ connector (multi-hop forwarding):** genuinely needs ILP packets (PREPARE/FULFILL, conditions/**preimages**, HTLC) because trust is spread across hops. This is the `/ilp` edge (#225 egress, BTP). Keep it.
- **client → connector (the app front door):** should be **plain HTTP + x402 / RFC 9421 payment headers**. The client sends a **normal HTTP request + one signature header**; the **connector is the only party that touches packets/claims/preimages/on-chain settlement**.

**We already have the pieces** — they're just wired behind the ILP-packet adapter today:
- #217 = the 402 greeting (price + how to pay).
- #220 = RFC 9421 verification (sig covers `@method`,`@path`,`content-digest`,price).
- #216 = the reverse proxy to the app.

**Target client flow:**
```
client:   POST /write  (the real request, normal)
          Signature-Input / Signature   ← RFC 9421, ONE signature, dual-purpose:
                                            (i) request binding (#220) ⊗ (ii) channel claim
          (the body)
connector: verify once → record/redeem channel claim, gen preimage, settle  (all internal)
          → reverse-proxy POST /write to the app (#216) → return the app's response
client:   HTTP 200 { app's real response }   ← normal HTTP response
```

**Key insights that shaped this (from the user):**
- **Payment channels are prefunded by design** — lock funds on-chain once, then spend with off-chain claims. So a separate "prepaid account" model is redundant; the channel *is* the account. The per-request friction floor is **exactly one signature** (no packet, no preimage, no per-request on-chain tx).
- **One signature can be dual-purpose**: the RFC 9421 request-sig over `("@method" "@path" "content-digest" "channel-claim")` simultaneously binds the request to the price AND authorizes the channel spend. One header, verified once.
- **What x402 is doing**: x402 `exact` = sign an **on-chain transfer authorization** (EIP-3009 `transferWithAuthorization` on EVM / signed SPL transfer on Solana), settled by a facilitator **per request** (or batched). That's pay-per-call on-chain — different from channels. The `toon-channel` scheme = prefunded channel + off-chain claims (cheaper at volume). **Both are carried identically** (normal HTTP + a `PAYMENT-SIGNATURE` header); the connector settles each per its scheme. The 402 advertises both (drive-by x402 clients degrade gracefully; TOON-aware clients upgrade).
- **Gift-wrapped (NIP-59) claims** = claim **privacy** (encrypt the claim so a *relaying* intermediary can't read it), a different layer:
  - Direct client→connector hop: the connector IS the settler and must read the claim → **no gift-wrap** there.
  - Still relevant for **multi-hop** / Nostr-relayed claims (a claim reaching a specific connector through an intermediary). `ILP-Payment-Channel-Claim-Wrapped` stays supported for those.
  - **The relay's obliviousness does NOT come from gift-wrap** — it comes from the connector terminating payment and stripping it before proxying. Orthogonal concepts.

---

## OPEN decisions needed before building the redesign

1. **Payment-carriage model for the client edge** — recommended: **a single dual-purpose signature** (RFC 9421 request-binding ⊗ channel claim) carried in the x402 `PAYMENT-SIGNATURE` header, settled against the prefunded channel. (The deeper "request-sig literally IS the on-chain claim" touches channel/settlement semantics; the prepaid-account option is redundant with channels.)
2. **Hermetic-CI fork** — recommended: **keep a local-anvil flavor** (for `make app-up` + CI e2e, hermetic) AND ship the all-chains devnet+mnemonic config as the canonical "real" deploy. Alternative: devnet-only (then the e2e becomes a gated network test needing a funded `TOON_MNEMONIC` CI secret).
3. **Sequencing vs the open PRs** — recommended: **merge #229 and #230 first**, then do the redesign as one comprehensive follow-up (the redesign renames + re-architects files those two PRs still edit).
4. **Mina token address/id** — fetch from the live devnet (`infra/mina/usdc-token.json` on the box) or user provides.
5. **Solana programId** — confirm `598iSn5…Lg2W` against the live devnet deploy.

---

## Redesign work list (next session, once decisions above are made)

1. **Plain-HTTP paid edge** for client→connector: normal HTTP request + one dual-purpose signature header; connector does verify (#220) → channel claim/settle → proxy (#216) → return normal HTTP response. (The `/ilp` packet edge stays for connector↔connector.)
2. **Rename** app+connector (option b — artifacts + prose, not code types).
3. **Mnemonic mode** — wire `wallet-seed-manager.ts` into standalone boot; `TOON_MNEMONIC` → per-chain keys.
4. **All-chains devnet config** (`scripts/app/connector.yaml` per the target above) + drop anvil/faucet/`deploymentMode` → 2-service compose.
5. **Reconcile with #229/#230** (and #224 hardening is available whenever wanted).

---

## Gotchas / operational notes

- **Worktree agents base off `origin/main`, not the local working tree.** When fanning out, instruct each agent to `git merge <branch>` the prerequisites by name (refs are shared).
- **Pre-existing fragility (follow-up, not a regression):** the dockerized anvil contract deploy fails in a *freshly-checked-out worktree* when `packages/contracts/lib/` submodules are partially initialized (`forge-std` present, `openzeppelin-contracts` absent) — the self-healing `forge install` fallback errors. CI is unaffected (`submodules: recursive`). Worth hardening the deploy script's partial-`lib/` handling.
- **#230 added a runtime dep**: `nostr-tools@^2.20.0` (for valid signed Nostr events in the paid probe when `RELAY_DEV_MODE=false`). It's in `packages/connector/package.json` + the lockfile.
- **#222 deploy is gated**: `devnet-deploy.yml` is `workflow_dispatch`-only with `action: deploy|destroy`, both jobs behind a required-reviewers `devnet` Environment. Pre-deploy checklist is in the PR #230 body (secrets, DNS A-records for the subdomains, $ ceiling, **teardown via `action: destroy` — nothing auto-deletes the VM**).
- **House terminology** (CLAUDE.md): "app"/"handler" preferred; "BLS" and "agent runtime" deprecated. "terminator" should join the deprecated list — this handoff's rename does that.

---

## Quick-start for the fresh session

1. Read this doc. Confirm `origin/main` and that **#229/#230** are still open (or merged).
2. Get the 5 open decisions answered (esp. #1 payment-carriage, #2 hermetic-CI, #3 sequencing).
3. Fetch the **Mina token** values off the live devnet; confirm the **Solana programId**.
4. If merging #229/#230 first: do that, then fan out the redesign work list (1–5) — one agent per surface, verify green, PR each.

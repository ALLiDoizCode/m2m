# relay-edge — a real Nostr relay deployed BEHIND TOON

The canonical TOON relay deployment: the **connector (payment proxy, "nginx for
payments")** sits in front of a real, payment-oblivious **Nostr relay**. The
connector **monetizes WRITES**; **READS are free** and hit the relay's WS
directly. Settlement runs against the **shared live devnet**.

```
payer  ──paid POST /ilp──▶ connector ──paid write (POST /write)──▶ relay :3100  (store; PRIVATE)
reader ──wss free REQ──────────────────────────────────────────▶ relay :7100  (Nostr reads; PUBLIC)
```

A paid request enters the connector's `POST /ilp` edge; the connector terminates
the payment on-chain and reverse-proxies the carried `POST /write` to the relay's
**private** store port (3100); the relay's HTTP response is returned in the ILP
FULFILL. Free reads bypass the connector entirely — a Nostr client REQs the
relay's WS read port (7100) over `wss://relay-ws.toonprotocol.xyz`.

## Client endpoints — what to point at

| Purpose                                          | URL                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| **Paid write** — where paid writes go            | `https://connector.toonprotocol.xyz/ilp` (ILP-over-HTTP; see note below)         |
| **Free read** — what a Nostr client connects to  | `wss://relay-ws.toonprotocol.xyz` (NIP-01 reads; free, no payment)               |
| **Chain RPC** — to open/fund the payment channel | `https://evm-rpc.devnet.toonprotocol.dev` (chainId 31337, USDC 6-dp)             |
| **Faucet** — to get test funds                   | `https://faucet.devnet.toonprotocol.dev` (`POST /api/request {"address":"0x…"}`) |

- **Writers speak ILP-over-HTTP, not plain HTTP.** A paid write serializes an ILP
  PREPARE addressed to `g.connector.relay.store` whose `data` is the literal
  `POST /write` HTTP request (body `{event}` — a signed Nostr kind:1 event), plus
  a channel-claim header, and POSTs it to `/ilp`. Use the toon-client
  **`h402Fetch`** shim, or the `PaidRoundTripClient` /
  `scripts/app/ci-acceptance-probe.ts` prover. There is no `curl` one-liner yet.
- **Readers speak plain Nostr.** Point any NIP-01 client at
  `wss://relay-ws.toonprotocol.xyz` — reads are free and never touch the connector.
- The public edge serves **trusted** Let's Encrypt certs (Caddy). Only the
  devnet _chain_ endpoints are self-signed (hence `NODE_TLS_REJECT_UNAUTHORIZED=0`
  for the connector's and the prover's chain/faucet calls — never for the edge).
- **There is no public relay store (`:3100`) URL.** The paid-write store is never
  exposed; the only way to write is a paid `POST /ilp` to the connector.

## Drop-in steps

1. **Set identities.** Copy the env template:

   ```bash
   cp .env.example .env
   # RELAY_NOSTR_SECRET_KEY is REQUIRED (the relay won't boot without it):
   #   openssl rand -hex 32   → paste into RELAY_NOSTR_SECRET_KEY
   # TOON_MNEMONIC is optional (empty → pre-funded anvil account-0 devnet fallback).
   ```

   If you set `TOON_MNEMONIC`, also set `routes[].settlementAddresses.evm` in
   `connector.yaml` to the EVM address the connector prints at boot.

2. **Bring it up** (connector + relay + Caddy, settling on the live devnet):

   ```bash
   docker compose up -d
   docker compose logs -f caddy        # watch it obtain trusted LE certs for both vhosts
   docker compose logs -f connector    # watch it register the route + chain provider
   ```

   Caddy needs 10–60s to issue both certs on first boot. The relay's paid-write
   port (3100) and the connector's :3000/admin are NEVER host-published — only
   Caddy's 80/443 are. Verify: `docker compose ps` shows no host bindings except
   on the `caddy` service.

3. **Prove the round-trip end-to-end.** From the **connector repo root** (the
   prover needs the repo + native `libsql`):

   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 \
   CONNECTOR_ILP_URL=https://connector.toonprotocol.xyz/ilp \
   RELAY_WS_URL=wss://relay-ws.toonprotocol.xyz \
   EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
   FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
   RELAY_STORE_PROBE_URL=https://relay-store.toonprotocol.xyz/write \
   npx ts-node --project packages/connector/tsconfig.json \
     scripts/app/ci-acceptance-probe.ts
   ```

   The prover funds a fresh wallet from the devnet faucet, opens an on-chain USDC
   channel toward the connector, signs a per-packet claim, and asserts:
   - **paid `POST /ilp` → FULFILL** carrying the relay store's response;
   - the written event is **returned over `wss://relay-ws.toonprotocol.xyz`** (free read);
   - **negatives:** an unpaid `POST /ilp` → REJECT (not FULFILL), and the relay
     store (`:3100`) is NOT publicly reachable.

## Files

| file                 | purpose                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| `docker-compose.yml` | connector (payment proxy) + real Nostr relay + Caddy; only 80/443 public                |
| `connector.yaml`     | connector config (route `g.connector.relay` → `http://relay:3100`), devnet RPC baked in |
| `Caddyfile`          | two auto-TLS vhosts: `connector.toonprotocol.xyz` (paid) + `relay-ws.toonprotocol.xyz`  |
| `.env.example`       | copy to `.env`; `TOON_MNEMONIC` + `RELAY_NOSTR_SECRET_KEY` (required) + devnet URLs     |

## Privacy invariant

- **relay `:3100` (paid-write store) is never host-published** — the only way in
  is a paid `POST /ilp` to the connector. Enforcement is by construction.
- **connector `:3000` / `:8080` / admin `:8081` are never host-published** —
  reachable only as `connector:3000` over the compose network (via Caddy).
- **relay `:7100` (free reads) is reachable ONLY through Caddy's `relay-ws`
  vhost** — it is not bound on the host.
- The only host-bound ports are **Caddy's 80/443**.

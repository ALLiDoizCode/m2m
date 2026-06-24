# pay-edge — put a TOON payment proxy in front of your app

Run the TOON **connector as a payment proxy** ("nginx for payments") in front of
any generic, payment-oblivious HTTP backend, settling against the **shared live
devnet**. A paid request enters the connector's `POST /ilp` edge; the connector
terminates the payment on-chain and reverse-proxies the request to your app; the
app's HTTP response is returned in the ILP FULFILL. Your app never sees ILP,
payments, or settlement.

```
payer ──POST /ilp (3000)──▶ connector ──proxies the paid HTTP request──▶ app:8080
                              (terminates payment,                         (oblivious
                               opens/uses on-chain channel)                 echo app)
```

## Drop-in steps

1. **Set your identity.** Copy the env template and put your seed phrase in it:

   ```bash
   cp .env.example .env
   # edit .env → set TOON_MNEMONIC=...   (or leave empty for the devnet fallback)
   ```

   Leaving `TOON_MNEMONIC` empty uses the pre-funded anvil account-0 key, which
   the devnet recognises — good enough for a first smoke test. If you set your
   own mnemonic, also set `routes[].settlementAddresses.evm` in `connector.yaml`
   to the EVM address the connector prints at boot (`evmAddress=0x…`).

2. **Bring it up** (connector + generic echo app, settling on the live devnet):

   ```bash
   docker compose up -d
   docker compose logs -f connector   # watch it register the route + chain provider
   ```

3. **Drop in YOUR app.** Replace the `app` service in `docker-compose.yml` with
   your own image listening on `:8080`, and point `connector.yaml`'s `upstream`
   at it (`http://<your-service>:8080`). Nothing else changes — your app stays
   payment-oblivious. The connector injects `X-TOON-Payer` / `X-TOON-Amount` /
   `X-TOON-Chain` request headers so your app _can_ do per-payer logic if it
   wants, but never has to.

4. **Make a paid call** (proves the round-trip end-to-end). From the connector
   repo root:

   ```bash
   NODE_TLS_REJECT_UNAUTHORIZED=0 \
   CONNECTOR_ILP_URL=http://127.0.0.1:3000/ilp \
   EVM_RPC_URL=https://evm-rpc.devnet.toonprotocol.dev \
   FAUCET_URL=https://faucet.devnet.toonprotocol.dev \
   npx ts-node --project packages/connector/tsconfig.json \
     deploy/pay-edge/prove-roundtrip.ts
   ```

   (If the devnet box ever moves and public DNS lags, preload the `dns-pin.js`
   helper: `... ts-node --require ./deploy/pay-edge/dns-pin.js ...` with
   `DEVNET_IP=<new-ip>`. Not needed while DNS is correct.)

   The prover funds a fresh wallet from the devnet faucet, opens an on-chain
   USDC channel toward the connector, signs a per-packet claim, and asserts:
   paid `POST /ilp` → FULFILL carrying the backend echo, and unpaid → 402 REJECT.

## Client endpoints — what a payer points to

A client/agent paying this edge needs **three** URLs (live values for this deploy):

| Purpose                                          | URL                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| **Paid edge** — where paid requests go           | `https://connector.pay.toonprotocol.dev/ilp` (or call your origin and read the `402`) |
| **Chain RPC** — to open/fund the payment channel | `https://evm-rpc.devnet.toonprotocol.dev` (+ `solana-rpc.*`, `mina.*/graphql`)        |
| **Faucet** — to get test funds                   | `https://faucet.devnet.toonprotocol.dev` (`POST /api/request {"address":"0x…"}`)      |

- **Payers speak ILP-over-HTTP, not plain HTTP.** A paid call serializes an ILP PREPARE
  (the HTTP request in `data`) + a channel-claim header and POSTs it to `/ilp`. Use the
  toon-client **`h402Fetch`** shim or `prove-roundtrip.ts` — there is no `curl` one-liner yet.
- **No relay endpoint here.** pay-edge fronts a _generic_ HTTP backend, so there is **no
  `relay-ws`** to point at. (`relay-ws.devnet.toonprotocol.dev` belongs to the separate
  chains-box `with_connector_edge` deploy — its free-read Nostr WS — not to pay-edge.)
- The public edge serves a **trusted** Let's Encrypt cert (Caddy); only the devnet _chain_
  endpoints are self-signed (hence `NODE_TLS_REJECT_UNAUTHORIZED=0` for chain/faucet calls).

## Files

| file                 | purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `docker-compose.yml` | connector (payment proxy) + generic echo app; optional `local-devnet` profile        |
| `connector.yaml`     | connector config (route `g.connector.echo` → `http://app:8080`), devnet RPC baked in |
| `.env.example`       | copy to `.env`; primary knob `TOON_MNEMONIC` + devnet URLs                           |
| `prove-roundtrip.ts` | end-to-end paid round-trip proof against a generic backend                           |
| `dns-pin.js`         | optional Node preload pinning the devnet hostname to the live IP                     |

## How close to "nginx-grade" is this?

Close, with caveats:

- **Generic backend works.** The connector's `HttpProxyHandler` forwards the
  literal HTTP request (method/path/headers/body) to _any_ upstream and returns
  its response byte-faithfully. We proved it with a stock `mendhak/http-https-echo`
  image — zero TOON awareness in the app.
- **The app port is never published.** The only way to reach the app is through a
  paid request to the connector. That is the enforcement, by construction.

Where it falls short of literal nginx:

- **Clients aren't plain HTTP.** A payer must speak ILP-over-HTTP: serialize an
  ILP PREPARE whose `data` is the literal HTTP request, attach a payment-channel
  claim header, and POST it to `/ilp`. `prove-roundtrip.ts` (and the toon-client
  `h402Fetch`) do this; a curl-grade one-liner does not exist yet.
- **`${...}` is not interpolated in `connector.yaml`.** Every value is literal;
  only `TOON_MNEMONIC` (env) flows in dynamically. Changing the RPC means editing
  the YAML, not just `.env`.
- **Devnet TLS is untrusted** (Let's Encrypt _staging_) → `NODE_TLS_REJECT_UNAUTHORIZED=0`.
  Devnet-only.
- **DNS** for `devnet.toonprotocol.dev` points at the live box (`*.devnet` A
  record → 50.116.58.45). If the box moves, repoint that Porkbun record;
  `dns-pin.js` / docker `extra_hosts` are a stopgap if DNS lags.

## Local proof (no devnet)

To prove with zero external deps, use the repo's root anvil+faucet (they
auto-deploy the registry + USDC):

```bash
# from the connector repo root
docker compose --profile app up -d --wait anvil faucet
# point connector.yaml rpcUrl → http://anvil:8545, run connector+app on the
# connector_default network, then run prove-roundtrip.ts with
# EVM_RPC_URL=http://127.0.0.1:8545 FAUCET_URL=http://127.0.0.1:3500
```

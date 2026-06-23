#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TOON Linode devnet lifecycle (the Akash `akash-deploy.sh`/`akash-status.sh`
# analogue for this host). Run from anywhere; it locates the connector root.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#   ./devnet.sh up        Start chains + proxy
#   ./devnet.sh down      Stop everything (keeps volumes/certs)
#   ./devnet.sh redeploy  down + up — wipes chain state; deterministic addresses
#                         reproduce (anvil reverts, validator --reset)
#   ./devnet.sh status    Probe every backend + every public TLS URL
#   ./devnet.sh wait      Block until chains report healthy
#   ./devnet.sh endpoints Regenerate endpoints.json from .env + live values
#   ./devnet.sh fund-sol  <pubkey> [usdc] [sol]  Airdrop SOL + transfer USDC
#   ./devnet.sh fund-mina <b58> [usdc]           Admin-mint USDC on Mina devnet
#   ./devnet.sh logs [svc]  Follow logs
#   ./devnet.sh reload    Reload nginx (after a cert renewal)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; . "$HERE/.env"; set +a

DC=(docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/infra/linode/docker-compose.linode.yml")
PROFILE_ARGS=(); IFS=',' read -ra _P <<< "${COMPOSE_PROFILES:-evm,solana}"; for p in "${_P[@]}"; do PROFILE_ARGS+=(--profile "$p"); done
dc() { ( cd "$ROOT" && "${DC[@]}" "${PROFILE_ARGS[@]}" "$@" ); }

# Deterministic addresses from connector's DeployLocal.s.sol (see init-anvil.sh).
EVM_TOKEN="0x5FbDB2315678afecb367f032d93F642f64180aa3"
EVM_REGISTRY="0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"

wait_health() {
  echo "Waiting for chains to be healthy (up to ~120s)..."
  for i in $(seq 1 60); do
    local anvil_ok=1 sol_ok=1
    dc exec -T anvil cast client --rpc-url http://localhost:8545 2>/dev/null | grep -q anvil || anvil_ok=0
    if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q solana; then
      dc exec -T solana-validator curl -sf http://localhost:8899/health 2>/dev/null | grep -q ok || sol_ok=0
    fi
    if [ "$anvil_ok" = 1 ] && [ "$sol_ok" = 1 ]; then echo "Chains healthy."; return 0; fi
    sleep 2
  done
  echo "WARNING: chains not healthy after timeout; check '$0 logs'." >&2
  return 1
}

probe() { # url, label
  if curl -fsS -m 8 -o /dev/null "$1" 2>/dev/null; then echo "  OK   $2  ($1)"; else echo "  DOWN $2  ($1)"; fi
}

# Probe a TLS edge that has no GET-able health path (e.g. the connector's POST-only
# /ilp). We only need to know the TLS handshake + nginx routing work: ANY HTTP status
# (even 404/405) means UP; only a connection/TLS failure means DOWN.
probe_tls() { # url, label
  if curl -sS -m 8 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null | grep -qE '^[1-5][0-9][0-9]$'; then
    echo "  OK   $2  ($1)"
  else
    echo "  DOWN $2  ($1)"
  fi
}

write_endpoints() {
  local sol_program="" sol_mint=""
  # Best-effort: derive the deployed program id + USDC mint from their keypairs.
  if command -v solana-keygen >/dev/null 2>&1; then
    [ -f "$ROOT/packages/solana-program/target/deploy/payment_channel-keypair.json" ] && \
      sol_program="$(solana-keygen pubkey "$ROOT/packages/solana-program/target/deploy/payment_channel-keypair.json" 2>/dev/null || true)"
    [ -f "$ROOT/infra/solana/usdc-mint.json" ] && \
      sol_mint="$(solana-keygen pubkey "$ROOT/infra/solana/usdc-mint.json" 2>/dev/null || true)"
  fi

  # Mina USDC token zkApp is deployed ONCE to the public devnet (we only proxy it,
  # no node here) by tools/mina/deploy-usdc-token.ts, which writes the deploy
  # result to infra/mina/usdc-token.json. Read tokenAddress/tokenId from it.
  local mina_token="" mina_token_id=""
  if [ -f "$ROOT/infra/mina/usdc-token.json" ] && command -v jq >/dev/null 2>&1; then
    mina_token="$(jq -r '.tokenAddress // empty' "$ROOT/infra/mina/usdc-token.json" 2>/dev/null || true)"
    mina_token_id="$(jq -r '.tokenId // empty' "$ROOT/infra/mina/usdc-token.json" 2>/dev/null || true)"
  fi
  # Emit JSON values: a quoted string when known, literal null when not.
  local mina_token_json="null" mina_token_id_json="null"
  [ -n "$mina_token" ] && mina_token_json="\"${mina_token}\""
  [ -n "$mina_token_id" ] && mina_token_id_json="\"${mina_token_id}\""

  # Issue #222: the app edge (only when that profile is active).
  # The connector settles EVM-only on this box's anvil via the public deployer key
  # + the HTTP faucet — no Mina/Solana settlement is wired for this route. `route`
  # and `price` mirror scripts/app/connector.yaml.
  local connector_json="null"
  if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q app; then
    connector_json=$(cat <<TERM
{
    "ilpUrl": "https://connector.${DOMAIN}/ilp",
    "relayWsUrl": "wss://relay-ws.${DOMAIN}",
    "route": "g.connector.relay",
    "price": "1000",
    "settlementChain": "evm:31337",
    "_note": "App-behind-connector (issue #222): POST a paid ILP PREPARE (with an ILP-Payment-Channel-Claim header) to ilpUrl; free Nostr reads hit relayWsUrl directly. EVM-only settlement on this box's anvil. The relay paid-write store port and the connector admin API are NOT public."
  }
TERM
)
  fi

  cat > "$HERE/endpoints.json" <<JSON
{
  "_note": "Public TOON devnet on Linode. Generated by devnet.sh — do not hand-edit.",
  "evm": {
    "rpcUrl": "https://evm-rpc.${DOMAIN}",
    "chainId": 31337,
    "tokenAddress": "${EVM_TOKEN}",
    "tokenDecimals": 6,
    "registryAddress": "${EVM_REGISTRY}",
    "faucetUrl": "https://faucet.${DOMAIN}"
  },
  "solana": {
    "rpcUrl": "https://solana-rpc.${DOMAIN}",
    "wsUrl": "wss://solana-ws.${DOMAIN}",
    "programId": "${sol_program}",
    "tokenMint": "${sol_mint}",
    "tokenDecimals": 6,
    "_fund": "infra/solana/fund-solana.sh <pubkey> — airdrops SOL + transfers USDC from treasury"
  },
  "mina": {
    "graphqlUrl": "https://mina.${DOMAIN}/graphql",
    "upstream": "https://api.minascan.io/node/devnet/v1/graphql",
    "tokenAddress": ${mina_token_json},
    "tokenId": ${mina_token_id_json},
    "tokenDecimals": 6,
    "_fund": "infra/mina/fund-mina-usdc.sh <b58> [usdc] — admin-mints USDC on the public devnet",
    "_note": "Passthrough proxy of the PUBLIC Mina devnet. USDC token zkApp deployed once to public devnet (deploy-usdc-token.ts → infra/mina/usdc-token.json); null here means not yet deployed."
  },
  "connector": ${connector_json}
}
JSON
  echo "Wrote $HERE/endpoints.json"
}

# Re-create the mock-USDC SPL mint (validator wipes it on every --reset).
mint_usdc() {
  if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q solana; then
    "$ROOT/infra/solana/create-usdc-mint.sh" "http://localhost:8899" \
      || echo "WARNING: USDC mint bootstrap failed (need spl-token CLI + healthy validator)." >&2
  fi
}

case "${1:-}" in
  up)        envsubst '${DOMAIN}' < "$HERE/nginx/devnet.conf.template" > "$HERE/nginx/conf.d/devnet.conf"; dc up -d; wait_health; mint_usdc; write_endpoints;;
  down)      dc down;;
  redeploy)  dc down; dc up -d; wait_health; mint_usdc; write_endpoints;;
  wait)      wait_health;;
  mint)      mint_usdc;;
  fund-sol)  shift; "$ROOT/infra/solana/fund-solana.sh" "$@";;
  fund-mina) shift; "$ROOT/infra/mina/fund-mina-usdc.sh" "$@";;
  status)
    echo "Containers:"; dc ps
    echo "Public endpoints:"
    probe "https://evm-rpc.${DOMAIN}"      "evm-rpc"
    probe "https://solana-rpc.${DOMAIN}/health" "solana-rpc"
    probe "https://faucet.${DOMAIN}/health"     "faucet"
    probe "https://mina.${DOMAIN}/graphql"      "mina-proxy"
    if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q app; then
      # The /ilp edge is POST-only (a GET yields 404/405), so use probe_tls: any
      # HTTP status proves the TLS edge + nginx route to connector:3000 are up.
      probe_tls "https://connector.${DOMAIN}/ilp" "connector-ilp"
    fi
    ;;
  endpoints) write_endpoints;;
  logs)      shift; dc logs -f "$@";;
  reload)    dc exec nginx nginx -s reload;;
  *) sed -n '2,20p' "$0"; exit 1;;
esac

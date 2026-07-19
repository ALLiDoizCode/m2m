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
#   ./devnet.sh mina-provision  Check Mina USDC token is live + faucet/admin funded
#   ./devnet.sh fund-sol  <pubkey> [usdc] [sol]  Airdrop SOL + transfer USDC
#   ./devnet.sh fund-mina <b58> [usdc]           Admin-mint USDC on Mina devnet
#   ./devnet.sh logs [svc]  Follow logs
#   ./devnet.sh reload    Reload nginx (after a cert renewal)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
set -a; . "$HERE/.env"; set +a

# ── Mina USDC token addresses for the faucet's USDC drip ─────────────────────
# The faucet container drips USDC by treasury TRANSFER, replenished by the
# treasury's own rate-limited SELF-MINT (see packages/faucet/src/mina-usdc.mjs
# — the rate-limited public-devnet token has no admin-mint), which needs the
# deployed token + admin-contract addresses. Resolve them (env overrides win,
# else the committed live deploy result infra/mina/usdc-token.json) and EXPORT
# them so docker compose substitutes ${MINA_USDC_TOKEN} /
# ${MINA_USDC_ADMIN_CONTRACT} into the faucet service. (MINA_USDC_TREASURY_KEY
# — the treasury private key; legacy name MINA_USDC_ADMIN_KEY still accepted —
# is a SECRET that comes from .env / the CI secret, never from this file.)
# Empty when not yet deployed → faucet drips native only.
MINA_USDC_TOKEN_JSON="$ROOT/infra/mina/usdc-token.json"
MINA_ENDPOINTS_JSON="$HERE/endpoints.json"
if command -v jq >/dev/null 2>&1; then
  # Prefer the gitignored live deploy result; else fall back to the committed
  # endpoints.json (which pins the same PUBLIC live token/admin-contract — the
  # token is deployed ONCE to public devnet and survives box rebuilds).
  if [ -f "$MINA_USDC_TOKEN_JSON" ]; then
    : "${MINA_USDC_TOKEN:=$(jq -r '.tokenAddress // empty' "$MINA_USDC_TOKEN_JSON")}"
    : "${MINA_USDC_ADMIN_CONTRACT:=$(jq -r '.adminContractAddress // empty' "$MINA_USDC_TOKEN_JSON")}"
  elif [ -f "$MINA_ENDPOINTS_JSON" ]; then
    : "${MINA_USDC_TOKEN:=$(jq -r '.mina.tokenAddress // empty' "$MINA_ENDPOINTS_JSON")}"
    : "${MINA_USDC_ADMIN_CONTRACT:=$(jq -r '.mina.adminContractAddress // empty' "$MINA_ENDPOINTS_JSON")}"
  fi
  export MINA_USDC_TOKEN MINA_USDC_ADMIN_CONTRACT
fi

DC=(docker compose -f "$ROOT/docker-compose.yml" -f "$ROOT/infra/linode/docker-compose.linode.yml")
PROFILE_ARGS=(); IFS=',' read -ra _P <<< "${COMPOSE_PROFILES:-evm,solana}"; for p in "${_P[@]}"; do PROFILE_ARGS+=(--profile "$p"); done
dc() { ( cd "$ROOT" && "${DC[@]}" "${PROFILE_ARGS[@]}" "$@" ); }

# Deterministic addresses from connector's DeployLocal.s.sol (see init-anvil.sh).
EVM_TOKEN="0x5FbDB2315678afecb367f032d93F642f64180aa3"
EVM_REGISTRY="0xe7f1725e7734ce288f8367e1bb143e90bb3f0512"

wait_health() {
  # Mina lightnet takes ~3 minutes to start; extend the timeout for it.
  local max_iters=60
  printf '%s' "${COMPOSE_PROFILES:-}" | grep -q mina && max_iters=120
  echo "Waiting for chains to be healthy (up to ~$((max_iters * 2))s)..."
  for i in $(seq 1 $max_iters); do
    local anvil_ok=1 sol_ok=1 mina_ok=1
    if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q evm; then
      dc exec -T anvil cast client --rpc-url http://localhost:8545 2>/dev/null | grep -q anvil || anvil_ok=0
    fi
    if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q solana; then
      dc exec -T solana-validator curl -sf http://localhost:8899/health 2>/dev/null | grep -q ok || sol_ok=0
    fi
    if printf '%s' "${COMPOSE_PROFILES:-}" | grep -q mina; then
      dc exec -T mina-lightnet curl -sf http://localhost:8181/list-acquired-accounts 2>/dev/null | grep -q . || mina_ok=0
    fi
    if [ "$anvil_ok" = 1 ] && [ "$sol_ok" = 1 ] && [ "$mina_ok" = 1 ]; then echo "Chains healthy."; return 0; fi
    sleep 2
  done
  echo "WARNING: chains not healthy after timeout; check '$0 logs'." >&2
  return 1
}

probe() { # url, label
  if curl -fsS -m 8 -o /dev/null "$1" 2>/dev/null; then echo "  OK   $2  ($1)"; else echo "  DOWN $2  ($1)"; fi
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
  # no node here) by tools/mina/deploy-usdc-token.mts, which writes the deploy
  # result to infra/mina/usdc-token.json. Read tokenAddress/tokenId from it.
  #
  # Source order: the gitignored live deploy result (usdc-token.json) wins; else
  # reuse the values already in this endpoints.json (so a regen on a box that has
  # only the committed PUBLIC live values — no usdc-token.json — preserves them).
  local mina_token="" mina_token_id="" mina_admin_contract="" mina_admin_authority=""
  local src=""
  if [ -f "$ROOT/infra/mina/usdc-token.json" ] && command -v jq >/dev/null 2>&1; then
    src="$ROOT/infra/mina/usdc-token.json"
    mina_token="$(jq -r '.tokenAddress // empty' "$src" 2>/dev/null || true)"
    mina_token_id="$(jq -r '.tokenId // empty' "$src" 2>/dev/null || true)"
    mina_admin_contract="$(jq -r '.adminContractAddress // empty' "$src" 2>/dev/null || true)"
    mina_admin_authority="$(jq -r '.adminAuthority // empty' "$src" 2>/dev/null || true)"
  elif [ -f "$HERE/endpoints.json" ] && command -v jq >/dev/null 2>&1; then
    src="$HERE/endpoints.json"
    mina_token="$(jq -r '.mina.tokenAddress // empty' "$src" 2>/dev/null || true)"
    mina_token_id="$(jq -r '.mina.tokenId // empty' "$src" 2>/dev/null || true)"
    mina_admin_contract="$(jq -r '.mina.adminContractAddress // empty' "$src" 2>/dev/null || true)"
    mina_admin_authority="$(jq -r '.mina.adminAuthority // empty' "$src" 2>/dev/null || true)"
  fi
  # Emit JSON values: a quoted string when known, literal null when not.
  local mina_token_json="null" mina_token_id_json="null"
  local mina_admin_contract_json="null" mina_admin_authority_json="null"
  [ -n "$mina_token" ] && mina_token_json="\"${mina_token}\""
  [ -n "$mina_token_id" ] && mina_token_id_json="\"${mina_token_id}\""
  [ -n "$mina_admin_contract" ] && mina_admin_contract_json="\"${mina_admin_contract}\""
  [ -n "$mina_admin_authority" ] && mina_admin_authority_json="\"${mina_admin_authority}\""

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
    "adminContractAddress": ${mina_admin_contract_json},
    "adminAuthority": ${mina_admin_authority_json},
    "tokenDecimals": 6,
    "_fund": "POST {address} to https://faucet.${DOMAIN}/api/mina/request (native MINA + USDC) or /api/mina/usdc-request (USDC only) — USDC drips by treasury TRANSFER (replenished via the treasury's rate-limited self-mint, ≤1,000 USDC/day, per-address cooldown). Holders of ~1.2 devnet MINA can self-mint 1,000 USDC/day directly: infra/mina/fund-mina-usdc.sh <b58> [usdc] (wraps tools/mina/self-mint-usdc.mts).",
    "_note": "Passthrough proxy of the PUBLIC Mina devnet. USDC token zkApp deployed once to public devnet (deploy-usdc-token.mts → infra/mina/usdc-token.json); null here means not yet deployed. The token is gated by RateLimitedUsdcAdmin (permissionless recipient-signed mints, 1,000 USDC/address/~24h; NO admin-mint — admin = pause/upgrade only). The faucet's USDC leg is a treasury self-mint + transfer using MINA_USDC_TREASURY_KEY (a CI secret; legacy name MINA_USDC_ADMIN_KEY)."
  }
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

# Idempotent Mina settlement check: the USDC token zkApp is deployed ONCE to the
# public devnet (survives box rebuilds), so this DETECTS-and-warns rather than
# recreating — and checks the faucet/admin accounts are funded with native MINA
# (an unfunded treasury/admin is what silently broke the Mina round-trip before).
# Always exits 0 (warnings only) so EVM/Solana stay green if Mina needs attention.
provision_mina() {
  "$ROOT/infra/mina/provision-mina.sh" || true
}

case "${1:-}" in
  up)        envsubst '${DOMAIN}' < "$HERE/nginx/${NGINX_TEMPLATE:-devnet.conf.template}" > "$HERE/nginx/conf.d/devnet.conf"; dc up -d; wait_health; mint_usdc; provision_mina; write_endpoints;;
  down)      dc down;;
  redeploy)  dc down; dc up -d; wait_health; mint_usdc; provision_mina; write_endpoints;;
  wait)      wait_health;;
  mint)      mint_usdc;;
  mina-provision) provision_mina;;
  fund-sol)  shift; "$ROOT/infra/solana/fund-solana.sh" "$@";;
  fund-mina) shift; "$ROOT/infra/mina/fund-mina-usdc.sh" "$@";;
  status)
    echo "Containers:"; dc ps
    echo "Public endpoints:"
    probe "https://evm-rpc.${DOMAIN}"      "evm-rpc"
    probe "https://solana-rpc.${DOMAIN}/health" "solana-rpc"
    probe "https://faucet.${DOMAIN}/health"     "faucet"
    probe "https://mina.${DOMAIN}/graphql"      "mina-proxy"
    ;;
  endpoints) write_endpoints;;
  logs)      shift; dc logs -f "$@";;
  reload)    dc exec nginx nginx -s reload;;
  *) sed -n '2,20p' "$0"; exit 1;;
esac

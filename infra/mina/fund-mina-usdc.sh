#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Fund a Mina address on the (public) devnet with mock USDC (admin-mint).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Mina analog of infra/solana/fund-solana.sh. There is no Mina token CLI, so the
# mint goes through o1js via tools/mina/fund-usdc.mts (pure-ESM, run via tsx).
#
# The USDC token-owner zkApp is deployed ONCE to the public devnet by
# tools/mina/deploy-usdc-token.mts (which writes infra/mina/usdc-token.json with
# tokenAddress / adminContractAddress). This script reads that file (or env
# overrides) and admin-mints USDC to the recipient. The recipient's token account
# is auto-created on first mint (fee paid by the admin authority).
#
# NOTE: unlike Solana/EVM, this does NOT airdrop native gas (MINA). Mina fees are
# paid in MINA by the admin authority itself; recipients that need to submit their
# own txs must top up from the public Mina faucet (https://faucet.minaprotocol.com).
#
# Requires:
#   - MINA_USDC_ADMIN_KEY  (base58 admin AUTHORITY private key — the FUNDED mint
#                           authority set at deploy time; never commit it)
#   - infra/mina/usdc-token.json  OR  MINA_USDC_TOKEN / MINA_USDC_ADMIN_CONTRACT env
#   - ts-node + o1js resolvable from the connector root (npm i at repo root)
#
#   ./fund-mina-usdc.sh <RECIPIENT_B58> [USDC_AMOUNT=1000] [NETWORK_GRAPHQL_URL]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY_JSON="$HERE/usdc-token.json"

RECIPIENT="${1:?usage: fund-mina-usdc.sh <recipient-b58> [usdc] [graphql-url]}"
USDC_AMOUNT="${2:-1000}"
NETWORK="${3:-${MINA_GRAPHQL_URL:-https://api.minascan.io/node/devnet/v1/graphql}}"

if [ -z "${MINA_USDC_ADMIN_KEY:-}" ]; then
  echo "ERROR: MINA_USDC_ADMIN_KEY (base58 admin authority private key) must be set." >&2
  exit 1
fi

# Resolve the deployed token + admin-contract addresses: env overrides, else the
# committed deploy-result JSON written by deploy-usdc-token.mts.
TOKEN_ADDR="${MINA_USDC_TOKEN:-}"
ADMIN_CONTRACT="${MINA_USDC_ADMIN_CONTRACT:-}"
if { [ -z "$TOKEN_ADDR" ] || [ -z "$ADMIN_CONTRACT" ]; } && [ -f "$DEPLOY_JSON" ]; then
  if command -v jq >/dev/null 2>&1; then
    [ -z "$TOKEN_ADDR" ] && TOKEN_ADDR="$(jq -r '.tokenAddress' "$DEPLOY_JSON")"
    [ -z "$ADMIN_CONTRACT" ] && ADMIN_CONTRACT="$(jq -r '.adminContractAddress' "$DEPLOY_JSON")"
  else
    echo "WARNING: jq not found and MINA_USDC_TOKEN/_ADMIN_CONTRACT unset; cannot read $DEPLOY_JSON" >&2
  fi
fi

if [ -z "$TOKEN_ADDR" ] || [ -z "$ADMIN_CONTRACT" ]; then
  echo "ERROR: token/admin-contract address unknown. Deploy first (deploy-usdc-token.mts" >&2
  echo "       --out infra/mina/usdc-token.json) or set MINA_USDC_TOKEN + MINA_USDC_ADMIN_CONTRACT." >&2
  exit 1
fi

echo "==> Admin-minting $USDC_AMOUNT USDC to $RECIPIENT on $NETWORK"
echo "    token=$TOKEN_ADDR admin-contract=$ADMIN_CONTRACT"

cd "$ROOT"
# fund-usdc is a PURE-ESM CLI (single-o1js-instance requirement, issue #352) run
# via tsx; it imports the packages/mina-zkapp dist-esm build, so build it first.
npm run build:esm --workspace=packages/mina-zkapp
npx tsx tools/mina/fund-usdc.mts \
  --network "$NETWORK" \
  --token "$TOKEN_ADDR" \
  --admin-contract "$ADMIN_CONTRACT" \
  --recipient "$RECIPIENT" \
  --amount "$USDC_AMOUNT"

echo "Funded $RECIPIENT: $USDC_AMOUNT USDC (Mina devnet)"

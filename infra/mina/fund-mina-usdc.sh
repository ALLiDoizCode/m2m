#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Fund a Mina address on the (public) devnet with mock USDC — SELF-MINT flow.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Mina analog of infra/solana/fund-solana.sh. There is no Mina token CLI, so the
# funding goes through o1js via tools/mina/*.mts (pure-ESM, run via tsx).
#
# The CURRENT public-devnet USDC token (infra/linode/endpoints.json "mina") is
# gated by RateLimitedUsdcAdmin: mints are PERMISSIONLESS but capped at 1,000
# USDC per address per ~24h window, and the RECIPIENT must sign the mint (its
# mint-receipt account update) — nobody can mint AT a stranger, and no admin
# key mints at all. So the default path here is the SELF-MINT CLI
# (tools/mina/self-mint-usdc.mts): the recipient mints their own allowance.
#
# Requires (default self-mint mode):
#   - MINA_FEE_PAYER_KEY   (base58 private key, FUNDED with devnet MINA — pays
#                           the 0.1 MINA fee + up to 2× 1-MINA account creation
#                           on a first mint; may be the same key as the recipient)
#   - MINA_RECIPIENT_KEY   (base58 private key of the RECIPIENT — must sign;
#                           defaults to MINA_FEE_PAYER_KEY when unset)
#   - infra/mina/usdc-token.json  OR  MINA_USDC_TOKEN / MINA_USDC_ADMIN_CONTRACT
#
#   ./fund-mina-usdc.sh <RECIPIENT_B58> [USDC_AMOUNT=1000] [NETWORK_GRAPHQL_URL] \
#       [--first-mint]     # fund the recipient's token + receipt accounts (2 MINA)
#       [--admin-mint]     # LEGACY: stock-admin deploys only (e.g. lightnet box)
#
# The <RECIPIENT_B58> argument is checked against the address MINA_RECIPIENT_KEY
# derives — with this token you can only fund an address whose key signs.
#
# Zero-MINA recipients: use the faucet instead — POST {"address": "B62q…"} to
# /api/mina/usdc-request (or /api/mina/request for MINA + USDC) on the deployed
# faucet (packages/faucet). It drips by TRANSFER from a treasury that self-mints
# its own daily allowance, so recipients need no MINA and no signature.
#
# ── LEGACY --admin-mint mode ──────────────────────────────────────────────────
# The pre-rate-limit flow (tools/mina/fund-usdc.mts: the admin authority mints
# and pays; requires MINA_USDC_ADMIN_KEY). It does NOT work against the current
# public-devnet token — kept ONLY for stock-FungibleTokenAdmin deploys (e.g. the
# lightnet box's local token).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DEPLOY_JSON="$HERE/usdc-token.json"

RECIPIENT="${1:?usage: fund-mina-usdc.sh <recipient-b58> [usdc] [graphql-url] [--first-mint] [--admin-mint]}"
shift

USDC_AMOUNT="1000"
NETWORK="${MINA_GRAPHQL_URL:-https://api.minascan.io/node/devnet/v1/graphql}"
FIRST_MINT=0
ADMIN_MINT=0
POSITIONAL=0
for arg in "$@"; do
  case "$arg" in
    --first-mint) FIRST_MINT=1 ;;
    --admin-mint) ADMIN_MINT=1 ;;
    *)
      POSITIONAL=$((POSITIONAL + 1))
      if [ "$POSITIONAL" -eq 1 ]; then USDC_AMOUNT="$arg"; else NETWORK="$arg"; fi
      ;;
  esac
done

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

cd "$ROOT"
# The CLIs are PURE-ESM (single-o1js-instance requirement, issue #352) run via
# tsx; they import the packages/mina-zkapp dist-esm build, so build it first.
npm run build:esm --workspace=packages/mina-zkapp

if [ "$ADMIN_MINT" -eq 1 ]; then
  # ── LEGACY admin-mint (stock-admin deploys ONLY — not the public devnet) ──
  if [ -z "${MINA_USDC_ADMIN_KEY:-}" ]; then
    echo "ERROR: --admin-mint requires MINA_USDC_ADMIN_KEY (base58 admin authority private key)." >&2
    exit 1
  fi
  echo "==> [LEGACY] Admin-minting $USDC_AMOUNT USDC to $RECIPIENT on $NETWORK"
  echo "    token=$TOKEN_ADDR admin-contract=$ADMIN_CONTRACT"
  echo "    NOTE: this does NOT work against the rate-limited public-devnet token."
  npx tsx tools/mina/fund-usdc.mts \
    --network "$NETWORK" \
    --token "$TOKEN_ADDR" \
    --admin-contract "$ADMIN_CONTRACT" \
    --recipient "$RECIPIENT" \
    --amount "$USDC_AMOUNT"
  echo "Funded $RECIPIENT: $USDC_AMOUNT USDC (Mina devnet, legacy admin-mint)"
  exit 0
fi

# ── Default: permissionless SELF-MINT (rate-limited public-devnet token) ──────
if [ -z "${MINA_FEE_PAYER_KEY:-}" ]; then
  echo "ERROR: MINA_FEE_PAYER_KEY (funded base58 private key) must be set." >&2
  echo "       The recipient key must also sign: set MINA_RECIPIENT_KEY (defaults" >&2
  echo "       to MINA_FEE_PAYER_KEY). Zero-MINA recipients: use the faucet's" >&2
  echo "       POST /api/mina/usdc-request instead." >&2
  exit 1
fi
export MINA_RECIPIENT_KEY="${MINA_RECIPIENT_KEY:-$MINA_FEE_PAYER_KEY}"

# The CLI mints to the address MINA_RECIPIENT_KEY derives — refuse up front if
# that is not the recipient the caller asked for (with the rate-limited token
# you can only mint to an address whose key signs).
node -e '
  const { PrivateKey } = require("o1js");
  const derived = PrivateKey.fromBase58(process.env.MINA_RECIPIENT_KEY).toPublicKey().toBase58();
  const wanted = process.argv[1];
  if (derived !== wanted) {
    console.error(`ERROR: MINA_RECIPIENT_KEY derives ${derived}, not the requested recipient ${wanted}.`);
    console.error("       With the rate-limited token you can only mint to an address whose key signs.");
    console.error("       Zero-MINA / keyless recipients: use the faucet POST /api/mina/usdc-request.");
    process.exit(2);
  }
' "$RECIPIENT"

echo "==> Self-minting $USDC_AMOUNT USDC to $RECIPIENT on $NETWORK"
echo "    token=$TOKEN_ADDR admin-contract=$ADMIN_CONTRACT (recipient signs; ≤1,000 USDC/~24h)"

SELF_MINT_ARGS=(
  --network "$NETWORK"
  --token "$TOKEN_ADDR"
  --admin-contract "$ADMIN_CONTRACT"
  --amount "$USDC_AMOUNT"
)
[ "$FIRST_MINT" -eq 1 ] && SELF_MINT_ARGS+=(--first-mint)

npx tsx tools/mina/self-mint-usdc.mts "${SELF_MINT_ARGS[@]}"

echo "Funded $RECIPIENT: $USDC_AMOUNT USDC (Mina devnet, self-mint)"

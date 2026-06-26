#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Idempotently deploy the Mina zkApps (USDC FungibleToken + PaymentChannel) to the
# fresh Mina LIGHTNET and wire their addresses into connector.yaml + the faucet.
#
# The lightnet RESETS on every box recreate, so the zkApps must be (re)deployed
# each `/deploy-devnet up`. Funding comes from the o1labs accounts-manager
# (GET /acquire-account → a fresh FUNDED genesis keypair) — NO manual top-up.
#
# Run from the connector repo ROOT on the TOON node (it has Docker; o1js proving
# needs glibc so we run the deploy in node:22-bookworm-slim, NOT alpine):
#   ./infra/linode-node/provision-mina-lightnet.sh
#
# Reads/writes:
#   - infra/linode-node/connector.yaml   (Mina graphqlUrl / zkAppAddress / tokenAddress / tokenId)
#   - infra/linode-node/.env             (appends MINA_USDC_* faucet envs)
#   - infra/linode-node/mina-lightnet.json (the deploy result, incl. sensitive keys — gitignored)
#
# Env (override as needed):
#   MINA_GRAPHQL_URL    default https://mina.<DOMAIN>/graphql
#   MINA_ACCOUNTS_URL   default https://mina-accounts.<DOMAIN>
#   DOMAIN              default devnet.toonprotocol.dev
#   MINA_TX_FEE         default 0.2  (whole MINA per zkapp tx)
#   FORCE_REDEPLOY=1    redeploy even if connector.yaml already has a live token
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
DOMAIN="${DOMAIN:-devnet.toonprotocol.dev}"
MINA_GRAPHQL_URL="${MINA_GRAPHQL_URL:-https://mina.${DOMAIN}/graphql}"
MINA_ACCOUNTS_URL="${MINA_ACCOUNTS_URL:-https://mina-accounts.${DOMAIN}}"
MINA_TX_FEE="${MINA_TX_FEE:-0.2}"
YAML="$HERE/connector.yaml"
ENV_FILE="$HERE/.env"
OUT="$HERE/mina-lightnet.json"
NODE_IMAGE="node:22-bookworm-slim"

echo "==> Mina lightnet provisioning"
echo "    graphql:  $MINA_GRAPHQL_URL"
echo "    accounts: $MINA_ACCOUNTS_URL"

# ── Idempotency: skip if the configured token is already live on this lightnet ──
if [ "${FORCE_REDEPLOY:-0}" != "1" ] && [ -f "$YAML" ]; then
  cur_token="$(grep -E "^\s*tokenAddress:\s*'B62" "$YAML" | head -1 | sed -E "s/.*'(B62[^']+)'.*/\1/" || true)"
  if [ -n "${cur_token:-}" ]; then
    live="$(curl -fsS -m 15 "$MINA_GRAPHQL_URL" -H 'content-type: application/json' \
      -d "{\"query\":\"{ account(publicKey: \\\"$cur_token\\\") { balance { total } } }\"}" 2>/dev/null || true)"
    if echo "$live" | grep -q '"balance"'; then
      echo "    Token $cur_token already live on the lightnet — skipping (FORCE_REDEPLOY=1 to override)."
      exit 0
    fi
    echo "    Configured token $cur_token NOT live on this (reset) lightnet — redeploying."
  fi
fi

# ── 1. Acquire three FUNDED genesis keypairs from the accounts-manager ──────────
acquire() { curl -fsS -m 25 "$MINA_ACCOUNTS_URL/acquire-account?isRegularAccount=true"; }
DEPLOYER_SK="$(acquire | jq -r .sk)"
ADMIN_SK="$(acquire | jq -r .sk)"
CHANNEL_SK="$(acquire | jq -r .sk)"
[ -n "$DEPLOYER_SK" ] && [ -n "$ADMIN_SK" ] && [ -n "$CHANNEL_SK" ] || { echo "ERROR: accounts-manager acquire failed"; exit 1; }
echo "    Acquired 3 funded genesis accounts (deployer / admin / channel)."

# ── 2. Build the ESM token+channel classes (glibc node, single o1js instance) ──
echo "==> Building mina-zkapp ESM (dist-esm/) + deploying zkApps in $NODE_IMAGE"
docker run --rm \
  -e MINA_GRAPHQL_URL="$MINA_GRAPHQL_URL" \
  -e MINA_DEPLOYER_KEY="$DEPLOYER_SK" \
  -e MINA_USDC_ADMIN_KEY="$ADMIN_SK" \
  -e MINA_CHANNEL_DEPLOYER_KEY="$CHANNEL_SK" \
  -e MINA_TX_FEE="$MINA_TX_FEE" \
  -e OUT="/repo/infra/linode-node/mina-lightnet.json" \
  -v "$ROOT":/repo -w /repo \
  "$NODE_IMAGE" bash -c '
    set -e
    # Install only the mina-zkapp deps (o1js, mina-fungible-token, typescript) —
    # the deploy needs nothing else. They install into packages/mina-zkapp/
    # node_modules; build-esm + the deploy script (tools/mina/, dist-esm/) resolve
    # o1js by walking up the tree, so symlink it to the repo root node_modules too.
    npm install --no-audit --no-fund --prefix packages/mina-zkapp
    mkdir -p node_modules
    for dep in o1js mina-fungible-token typescript; do
      [ -e "node_modules/$dep" ] || ln -s "../packages/mina-zkapp/node_modules/$dep" "node_modules/$dep"
    done
    node packages/mina-zkapp/scripts/build-esm.mjs
    node tools/mina/deploy-lightnet-zkapps.mjs
  '

[ -f "$OUT" ] || { echo "ERROR: deploy produced no $OUT"; exit 1; }
TOKEN_ADDR="$(jq -r .usdc.tokenAddress "$OUT")"
TOKEN_ID="$(jq -r .usdc.tokenId "$OUT")"
ADMIN_CONTRACT="$(jq -r .usdc.adminContractAddress "$OUT")"
CHANNEL_ADDR="$(jq -r .paymentChannel.zkAppAddress "$OUT")"
echo "    USDC token:   $TOKEN_ADDR (id $TOKEN_ID)"
echo "    PaymentChannel: $CHANNEL_ADDR"

# ── 3. Patch connector.yaml Mina block ─────────────────────────────────────────
cp "$YAML" "$YAML.bak-mina-$(date +%Y%m%d-%H%M%S)"
python3 - "$YAML" "$MINA_GRAPHQL_URL" "$CHANNEL_ADDR" "$TOKEN_ADDR" "$TOKEN_ID" <<'PY'
import re, sys
yaml, gql, ch, tok, tid = sys.argv[1:6]
s = open(yaml).read()
# Replace the value on each Mina key line (first occurrence within the mina block).
s = re.sub(r"(graphqlUrl:\s*)\S+", r"\1" + gql, s, count=1)
s = re.sub(r"(zkAppAddress:\s*)'[^']*'", r"\1'%s'" % ch, s, count=1)
s = re.sub(r"(tokenAddress:\s*)'B62[^']*'", r"\1'%s'" % tok, s, count=1)
s = re.sub(r"(tokenId:\s*)'[^']*'", r"\1'%s'" % tid, s, count=1)
open(yaml, "w").write(s)
print("connector.yaml Mina block patched")
PY

# ── 4. Wire the faucet USDC-mint envs (native MINA already drips via MINA_FAUCET_KEY) ──
# The faucet admin-mints USDC on the lightnet via o1js proving (packages/faucet/
# src/mina-usdc.mjs). MINA_USDC_ADMIN_KEY can mint unlimited USDC — keep it out of
# git; it is written only to the box's .env here.
touch "$ENV_FILE"
sed -i '/^MINA_USDC_ADMIN_KEY=/d;/^MINA_USDC_TOKEN=/d;/^MINA_USDC_ADMIN_CONTRACT=/d;/^MINA_GRAPHQL_URL=/d' "$ENV_FILE"
{
  echo "MINA_GRAPHQL_URL=$MINA_GRAPHQL_URL"
  echo "MINA_USDC_ADMIN_KEY=$ADMIN_SK"
  echo "MINA_USDC_TOKEN=$TOKEN_ADDR"
  echo "MINA_USDC_ADMIN_CONTRACT=$ADMIN_CONTRACT"
} >> "$ENV_FILE"
echo "    faucet .env updated (MINA_USDC_* + MINA_GRAPHQL_URL)"

# ── 5. Restart connector + (rebuilt) faucet to pick up the new config ──────────
echo "==> Restarting connector + faucet"
( cd "$ROOT" && docker compose -f infra/linode-node/docker-compose.node.yml up -d --build faucet )
( cd "$ROOT" && docker compose -f infra/linode-node/docker-compose.node.yml restart connector )

echo
echo "✅ Mina lightnet provisioned:"
echo "   graphqlUrl   : $MINA_GRAPHQL_URL"
echo "   USDC token   : $TOKEN_ADDR"
echo "   tokenId      : $TOKEN_ID"
echo "   PaymentChannel: $CHANNEL_ADDR"
echo "   (addresses + keys in $OUT — gitignored)"

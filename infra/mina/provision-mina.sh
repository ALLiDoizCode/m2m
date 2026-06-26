#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Idempotently provision Mina settlement (USDC token + faucet funding) on the
# PUBLIC Mina devnet. The Mina analogue of infra/solana/create-usdc-mint.sh.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# We PROXY the public Mina devnet (no self-hosted node), so unlike EVM (anvil
# redeploys on every reset) and Solana (the SPL mint is recreated on --reset), the
# Mina USDC token zkApp is deployed ONCE to public devnet and SURVIVES box
# rebuilds. This script therefore does DETECT-then-act, never destroy:
#
#   1. USDC token zkApp — detect if the token account is live on public devnet.
#      If live: skip (re-deploying would mint a NEW token at a NEW address and
#      break every pinned consumer). If NOT live: print the exact deploy command
#      (deploy-usdc-token.ts) — a deploy needs FUNDED deployer/admin keys that
#      only the operator holds, so we never auto-deploy silently.
#
#   2. Faucet funding — the two faucet/admin accounts that must stay funded with
#      native MINA on public devnet (Mina has no self-hosted faucet to airdrop
#      from — they're topped from https://faucet.minaprotocol.com):
#        - the native-MINA drip treasury   (derived from MINA_FAUCET_KEY)
#        - the USDC mint authority / fee payer (derived from MINA_USDC_ADMIN_KEY,
#          which also pays each recipient's token-account creation fee)
#      We can't auto-fund these on public devnet, so we CHECK their balances and
#      warn LOUDLY (with the address + the faucet link) when underfunded — this is
#      what silently broke the Mina round-trip before (an unfunded treasury drips
#      "success" but transfers nothing; an unfunded admin can't mint).
#
# Non-destructive + idempotent: safe to run on every up/redeploy. Never fails the
# deploy (warnings only) so EVM/Solana stay green even if Mina needs operator
# attention.
#
#   ./provision-mina.sh                 # check token + faucet/admin funding
#   MINA_GRAPHQL_URL=... ./provision-mina.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

NETWORK="${MINA_GRAPHQL_URL:-https://api.minascan.io/node/devnet/v1/graphql}"
PUBLIC_FAUCET="https://faucet.minaprotocol.com"
# Minimum liquid MINA each funded account should hold (nanomina). A zkApp mint is
# ~0.1 MINA fee + up to 1 MINA recipient account-creation; we warn under 5 MINA.
MIN_MINA_NANO=5000000000

# Resolve token + admin-contract addresses (env wins, else committed deploy
# result, else endpoints.json — the same fallback order as devnet.sh).
TOKEN_ADDR="${MINA_USDC_TOKEN:-}"
ADMIN_CONTRACT="${MINA_USDC_ADMIN_CONTRACT:-}"
if command -v jq >/dev/null 2>&1; then
  if { [ -z "$TOKEN_ADDR" ] || [ -z "$ADMIN_CONTRACT" ]; } && [ -f "$HERE/usdc-token.json" ]; then
    [ -z "$TOKEN_ADDR" ]    && TOKEN_ADDR="$(jq -r '.tokenAddress // empty' "$HERE/usdc-token.json")"
    [ -z "$ADMIN_CONTRACT" ] && ADMIN_CONTRACT="$(jq -r '.adminContractAddress // empty' "$HERE/usdc-token.json")"
  fi
  if { [ -z "$TOKEN_ADDR" ] || [ -z "$ADMIN_CONTRACT" ]; } && [ -f "$ROOT/infra/linode/endpoints.json" ]; then
    [ -z "$TOKEN_ADDR" ]    && TOKEN_ADDR="$(jq -r '.mina.tokenAddress // empty' "$ROOT/infra/linode/endpoints.json")"
    [ -z "$ADMIN_CONTRACT" ] && ADMIN_CONTRACT="$(jq -r '.mina.adminContractAddress // empty' "$ROOT/infra/linode/endpoints.json")"
  fi
fi

# Query an account's liquid balance (nanomina) on the public devnet. The minascan
# upstream is load-balanced and intermittently returns an empty body, so we retry
# a few times before treating an empty result as "no account". Empty only after
# all retries fail (genuinely-absent account or sustained network hiccup).
mina_liquid() { # pubkey -> nanomina (string) | ""
  local pk="$1" i out
  for i in 1 2 3; do
    out="$(curl -s -m 20 -X POST "$NETWORK" -H 'Content-Type: application/json' \
      -d "{\"query\":\"query{account(publicKey:\\\"$pk\\\"){balance{liquid}}}\"}" 2>/dev/null \
      | jq -r '.data.account.balance.liquid // empty' 2>/dev/null)"
    [ -n "$out" ] && { printf '%s' "$out"; return 0; }
    sleep 1
  done
  return 0
}

# Derive a Mina public key from a base58 private key using mina-signer (no o1js,
# works anywhere node + the faucet deps are installed). Empty on failure.
mina_pubkey() { # base58-priv -> B62… | ""
  local key="$1"
  node -e "try{const C=require('mina-signer').default||require('mina-signer');console.log(new C({network:'testnet'}).derivePublicKey('$key'))}catch(e){process.exit(1)}" 2>/dev/null
}

warn_balance() { # label, pubkey, liquid-nano
  local label="$1" pk="$2" liq="$3"
  if [ -z "$liq" ]; then
    echo "  ⚠️  $label $pk has NO account / 0 balance on $NETWORK." >&2
    echo "      Fund it from $PUBLIC_FAUCET (paste the address) before the faucet can use it." >&2
  elif [ "$liq" -lt "$MIN_MINA_NANO" ] 2>/dev/null; then
    echo "  ⚠️  $label $pk is LOW: $(awk "BEGIN{printf \"%.2f\", $liq/1e9}") MINA (< 5)." >&2
    echo "      Top it up from $PUBLIC_FAUCET so it doesn't run dry." >&2
  else
    echo "  OK   $label $pk: $(awk "BEGIN{printf \"%.2f\", $liq/1e9}") MINA"
  fi
}

echo "==> Mina provisioning (public devnet: $NETWORK)"

# ── 1. USDC token zkApp: detect-if-live ──────────────────────────────────────
if [ -z "$TOKEN_ADDR" ]; then
  echo "  ⚠️  No Mina USDC token address known (MINA_USDC_TOKEN unset and none in" >&2
  echo "      infra/mina/usdc-token.json / endpoints.json). Deploy it ONCE with:" >&2
  echo "        export MINA_DEPLOYER_KEY=<funded base58>  MINA_USDC_ADMIN_KEY=<funded base58>" >&2
  echo "        npx ts-node tools/mina/deploy-usdc-token.ts --out infra/mina/usdc-token.json" >&2
  echo "      then pin tokenAddress/tokenId/adminContractAddress into endpoints.json." >&2
else
  # A deployed token-OWNER zkApp account has on-chain zkappState; a never-deployed
  # account reports null. Retry against the load-balanced upstream's empty blips.
  TOKEN_EXISTS=""
  for _i in 1 2 3; do
    TOKEN_EXISTS="$(curl -s -m 20 -X POST "$NETWORK" -H 'Content-Type: application/json' \
      -d "{\"query\":\"query{account(publicKey:\\\"$TOKEN_ADDR\\\"){zkappState}}\"}" 2>/dev/null \
      | jq -r '.data.account.zkappState // empty' 2>/dev/null)"
    [ -n "$TOKEN_EXISTS" ] && break
    sleep 1
  done
  if [ -n "$TOKEN_EXISTS" ]; then
    echo "  OK   USDC token zkApp live at $TOKEN_ADDR (admin-contract $ADMIN_CONTRACT) — skip deploy."
  else
    echo "  ⚠️  USDC token $TOKEN_ADDR is NOT live on $NETWORK." >&2
    echo "      Re-deploy ONCE (operator keys required):" >&2
    echo "        npx ts-node tools/mina/deploy-usdc-token.ts --out infra/mina/usdc-token.json" >&2
  fi
fi

# ── 2. Faucet + admin funding: check, warn, never auto-fail ──────────────────
if command -v node >/dev/null 2>&1; then
  if [ -n "${MINA_FAUCET_KEY:-}" ]; then
    TPK="$(mina_pubkey "$MINA_FAUCET_KEY" || true)"
    [ -n "$TPK" ] && warn_balance "native-MINA drip treasury" "$TPK" "$(mina_liquid "$TPK" || true)" \
      || echo "  ⚠️  MINA_FAUCET_KEY set but not a valid base58 private key." >&2
  else
    echo "  ℹ️  MINA_FAUCET_KEY unset — native-MINA drip disabled (faucet route 503s + links out)."
  fi

  if [ -n "${MINA_USDC_ADMIN_KEY:-}" ]; then
    APK="$(mina_pubkey "$MINA_USDC_ADMIN_KEY" || true)"
    [ -n "$APK" ] && warn_balance "USDC mint authority / fee payer" "$APK" "$(mina_liquid "$APK" || true)" \
      || echo "  ⚠️  MINA_USDC_ADMIN_KEY set but not a valid base58 private key." >&2
  else
    echo "  ℹ️  MINA_USDC_ADMIN_KEY unset — faucet drips native MINA only (no USDC mint)."
  fi
else
  echo "  ℹ️  node not on PATH — skipping faucet/admin balance checks."
fi

echo "==> Mina provisioning check complete."
exit 0

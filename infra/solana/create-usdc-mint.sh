#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Create the devnet mock-USDC SPL mint + seed a treasury.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# The payment-channel program is already SPL-token-aware (channel state stores a
# token_mint; vault is an SPL token account). It just needs a mint to settle in.
#
# The mint lands at a DETERMINISTIC address (committed usdc-mint.json) so it is
# the SAME across `solana-test-validator --reset` wipes — peers can hardcode it.
# Idempotent: skips creation if the mint already exists, always tops the treasury.
#
# Runs on the HOST (the beeman validator image has no spl-token CLI) against the
# validator's published RPC. Requires spl-token + solana CLIs on PATH.
#
#   ./create-usdc-mint.sh [RPC_URL]      # default http://localhost:8899
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RPC_URL="${1:-${SOLANA_RPC_URL:-http://localhost:8899}}"
MINT_KP="$HERE/usdc-mint.json"
AUTH_KP="$HERE/usdc-authority.json"
DECIMALS=6                                   # real-USDC standard (EVM mock is 18)
TREASURY_USDC="${SOLANA_USDC_TREASURY:-100000000}"   # 100M USDC minted to the authority treasury

MINT_ADDR="$(solana-keygen pubkey "$MINT_KP")"
AUTH_ADDR="$(solana-keygen pubkey "$AUTH_KP")"

echo "==> Funding mint authority $AUTH_ADDR with SOL (fees)"
solana airdrop 100 "$AUTH_ADDR" --url "$RPC_URL" >/dev/null 2>&1 \
  || echo "    airdrop skipped (already funded or faucet busy)"

if solana account "$MINT_ADDR" --url "$RPC_URL" >/dev/null 2>&1; then
  echo "==> USDC mint $MINT_ADDR already exists"
else
  echo "==> Creating USDC mint $MINT_ADDR ($DECIMALS decimals)"
  spl-token --url "$RPC_URL" --fee-payer "$AUTH_KP" \
    create-token --decimals "$DECIMALS" --mint-authority "$AUTH_ADDR" "$MINT_KP"
fi

echo "==> Treasury ATA + minting $TREASURY_USDC USDC to $AUTH_ADDR"
spl-token --url "$RPC_URL" --fee-payer "$AUTH_KP" --owner "$AUTH_KP" \
  create-account "$MINT_ADDR" >/dev/null 2>&1 || true
spl-token --url "$RPC_URL" --fee-payer "$AUTH_KP" --mint-authority "$AUTH_KP" \
  mint "$MINT_ADDR" "$TREASURY_USDC"

echo "USDC mint ready: $MINT_ADDR  (decimals=$DECIMALS, authority=$AUTH_ADDR)"

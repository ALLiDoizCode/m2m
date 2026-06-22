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

# Point a throwaway solana config at the authority keypair + RPC, so the authority
# is the DEFAULT signer for every spl-token subcommand (mint authority + ATA owner).
# This avoids per-subcommand signer-flag placement (spl-token 3.x wants
# --mint-authority/--owner AFTER the subcommand) and never mutates the global config.
SOLCFG="$(mktemp)"
trap 'rm -f "$SOLCFG"' EXIT
solana -C "$SOLCFG" config set --keypair "$AUTH_KP" --url "$RPC_URL" >/dev/null
spl() { spl-token --config "$SOLCFG" "$@"; }

echo "==> Funding mint authority $AUTH_ADDR with SOL (fees)"
solana -C "$SOLCFG" airdrop 100 "$AUTH_ADDR" >/dev/null 2>&1 \
  || echo "    airdrop skipped (already funded or faucet busy)"

if solana -C "$SOLCFG" account "$MINT_ADDR" >/dev/null 2>&1; then
  echo "==> USDC mint $MINT_ADDR already exists"
else
  echo "==> Creating USDC mint $MINT_ADDR ($DECIMALS decimals)"
  spl create-token --decimals "$DECIMALS" "$MINT_KP"
fi

echo "==> Treasury ATA + minting $TREASURY_USDC USDC to $AUTH_ADDR"
spl create-account "$MINT_ADDR" >/dev/null 2>&1 || true
spl mint "$MINT_ADDR" "$TREASURY_USDC"

echo "USDC mint ready: $MINT_ADDR  (decimals=$DECIMALS, authority=$AUTH_ADDR)"

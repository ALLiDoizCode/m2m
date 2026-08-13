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
# NEVER point this at mainnet-beta (issue #954): it mints an unlimited supply of a
# mock token from a keypair committed to this repo, which has no relationship to
# real USDC. Mainnet channels bind Circle's real mint instead (see
# docs/solana-deployment.md's "Mainnet Deployment Runbook") -- this script has no
# mainnet-shaped mode at all, only the hard refusal below, which rejects any RPC URL
# that names mainnet (see that guard for what the heuristic does and does not catch).
#
#   ./create-usdc-mint.sh [RPC_URL]      # default http://localhost:8899
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RPC_URL="${1:-${SOLANA_RPC_URL:-http://localhost:8899}}"

# Case-insensitive substring match on "mainnet" anywhere in the URL -- deliberately
# broad rather than an exact match on api.mainnet-beta.solana.com: a hosted RPC
# provider (Helius, QuickNode, Alchemy, ...) names its mainnet endpoint however it
# likes, and a false positive here just means re-running with the intended devnet/
# localhost URL, while a false negative mints a mock token against real mainnet.
case "${RPC_URL,,}" in
    *mainnet*)
        echo "Error: refusing to run against a mainnet-shaped RPC URL: $RPC_URL" >&2
        echo "This script creates a MOCK USDC mint from a keypair committed to this repo -- it" >&2
        echo "must never target Solana mainnet. Mainnet channels bind Circle's real USDC mint" >&2
        echo "instead; see docs/solana-deployment.md's \"Mainnet Deployment Runbook\"." >&2
        exit 1
        ;;
esac

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

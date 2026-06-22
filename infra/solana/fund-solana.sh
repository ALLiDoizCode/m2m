#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Fund a Solana address on the devnet with SOL (gas) + mock USDC.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SOL comes from the validator faucet (airdrop); USDC is transferred from the
# treasury seeded by create-usdc-mint.sh, auto-creating the recipient's ATA.
#
#   ./fund-solana.sh <RECIPIENT_PUBKEY> [USDC_AMOUNT=1000] [SOL_AMOUNT=10] [RPC_URL]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RECIPIENT="${1:?usage: fund-solana.sh <recipient-pubkey> [usdc] [sol] [rpc]}"
USDC_AMOUNT="${2:-1000}"
SOL_AMOUNT="${3:-10}"
RPC_URL="${4:-${SOLANA_RPC_URL:-http://localhost:8899}}"

AUTH_KP="$HERE/usdc-authority.json"
MINT_ADDR="$(solana-keygen pubkey "$HERE/usdc-mint.json")"

# Throwaway config: the treasury authority is the default signer (transfer source
# owner), so no fragile per-subcommand --owner placement and no global-config mutation.
SOLCFG="$(mktemp)"
trap 'rm -f "$SOLCFG"' EXIT
solana -C "$SOLCFG" config set --keypair "$AUTH_KP" --url "$RPC_URL" >/dev/null

echo "==> Airdropping $SOL_AMOUNT SOL to $RECIPIENT"
solana -C "$SOLCFG" airdrop "$SOL_AMOUNT" "$RECIPIENT" || echo "    airdrop failed (continuing)"

echo "==> Transferring $USDC_AMOUNT USDC ($MINT_ADDR) to $RECIPIENT"
spl-token --config "$SOLCFG" transfer "$MINT_ADDR" "$USDC_AMOUNT" "$RECIPIENT" \
  --fund-recipient --allow-unfunded-recipient

echo "Funded $RECIPIENT: $SOL_AMOUNT SOL + $USDC_AMOUNT USDC"

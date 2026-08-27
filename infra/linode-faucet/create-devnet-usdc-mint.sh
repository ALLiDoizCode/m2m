#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Create THIS BOX's Solana-devnet mock-USDC mint, with this box's own treasury
# keypair as the mint authority (docs/operators/faucet-box-bringup.md step 5).
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run ON THE FAUCET BOX, after ./generate-solana-treasury.sh.
#
# WHY the faucet owns the mint. The Solana leg mints on demand
# (packages/faucet/src/solana.js), exactly like the Base Sepolia leg's ungated
# mint(): a drip coins fresh tokens rather than spending a finite balance, so
# the leg cannot run dry and nobody has to remember to top it up. That only
# works if this box's keypair IS the mint's authority, which is what this
# script arranges.
#
# It exists because the previous arrangement failed in the worst way available:
# the mint the fleet used until now was created in 2026-07 from a keypair that
# was never committed anywhere and is now lost. Nobody can mint that token, and
# nobody can refill a treasury holding it -- so the devnet Solana leg has been
# dead with no repair path. A mint whose authority lives on the box that serves
# it has no such failure mode; if the box is lost, this script makes another.
#
# The mint ACCOUNT keypair is deliberately discarded. It signs the creation
# transaction and is never needed again -- only the mint AUTHORITY (this box's
# treasury) can mint afterwards. infra/solana/create-usdc-mint.sh keeps its
# equivalent solely so a local validator's `--reset` lands on the same address;
# public devnet never resets, and a spare key-shaped file on a box is a
# liability rather than an asset.
#
#   ./create-devnet-usdc-mint.sh [TREASURY_KEYPAIR] [RPC_URL]
#     TREASURY_KEYPAIR  default /root/keys/solana-usdc-treasury.json
#     RPC_URL           default https://api.devnet.solana.com
#
# Requires solana, solana-keygen and spl-token on PATH. bootstrap.sh installs
# none of them; install the version docs/operators/faucet-box-bringup.md step 4
# names, with the command it gives. No version literal here on purpose -- the
# runbook holds the single copy so the two cannot drift
# (crates/connector-settlement-solana/tests/solana_cli_pins.rs).
set -euo pipefail

TREASURY_KP="${1:-/root/keys/solana-usdc-treasury.json}"
RPC_URL="${2:-${SOLANA_RPC_URL:-https://api.devnet.solana.com}}"
DECIMALS=6 # real-USDC standard, and what every fleet config pins

# Case-insensitive substring match on "mainnet" anywhere in the URL --
# deliberately broad rather than an exact match on api.mainnet-beta.solana.com:
# a hosted RPC provider names its mainnet endpoint however it likes, and a false
# positive here just means re-running with the intended devnet URL, while a
# false negative creates a mock token on real mainnet. Same guard, same
# reasoning, as infra/solana/create-usdc-mint.sh.
case "${RPC_URL,,}" in
*mainnet*)
    echo "Error: refusing to run against a mainnet-shaped RPC URL: $RPC_URL" >&2
    echo "This script creates a MOCK USDC mint for a devnet faucet. Mainnet channels bind" >&2
    echo "Circle's real USDC mint instead; see docs/solana-deployment.md." >&2
    exit 1
    ;;
esac

for bin in solana solana-keygen spl-token jq; do
    command -v "$bin" >/dev/null 2>&1 || {
        echo "Error: $bin not found on PATH." >&2
        exit 1
    }
done

if [ ! -f "$TREASURY_KP" ]; then
    echo "Error: no treasury keypair at $TREASURY_KP." >&2
    echo "Run ./generate-solana-treasury.sh first -- the mint's authority is that keypair." >&2
    exit 1
fi

# Refuse to mint a SECOND token for a box that already names one. Two mints
# would strand every channel opened against the first, and the fleet configs
# pin exactly one address.
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env"
if [ -f "$ENV_FILE" ] && grep -qE '^SOLANA_USDC_MINT=.+' "$ENV_FILE"; then
    echo "Error: $ENV_FILE already names a mint:" >&2
    grep -E '^SOLANA_USDC_MINT=' "$ENV_FILE" >&2
    echo "Creating a second one would strand every channel opened against the first." >&2
    echo "Remove that line deliberately if you really mean to re-mint." >&2
    exit 1
fi

TREASURY_ADDR="$(solana-keygen pubkey "$TREASURY_KP")"

# Throwaway config so the treasury is the DEFAULT signer for every spl-token
# subcommand -- which is what makes it the mint authority -- without mutating
# the box's global solana config. Mirrors infra/solana/create-usdc-mint.sh.
SOLCFG="$(mktemp)"
trap 'rm -f "$SOLCFG"' EXIT
solana -C "$SOLCFG" config set --keypair "$TREASURY_KP" --url "$RPC_URL" >/dev/null
spl() { spl-token --config "$SOLCFG" "$@"; }

BALANCE="$(solana -C "$SOLCFG" balance "$TREASURY_ADDR" | awk '{print $1}')"
echo "==> Treasury $TREASURY_ADDR holds $BALANCE SOL"
echo "    (creating a mint costs a fraction of a SOL in rent + fees)"

echo "==> Creating a 6-decimal mock USDC mint, authority = the treasury"
# No --enable-freeze: a freeze authority on a faucet token is a footgun with no
# use here. No initial supply: the faucet mints per drip.
#
# The address is dug out of the JSON tolerantly. spl-token's envelope has moved
# between major versions -- 4.x wraps a create in `.commandOutput`, and nothing
# in this repository pins which spl-token an operator has on PATH (the CLI is a
# bringup tool, installed by hand per the runbook). Reading only one shape would
# make this script fail on a version bump AFTER creating the mint, which is the
# one failure that loses track of a token that already exists. So: try both
# shapes, and if neither matches, print the raw output rather than swallowing
# the address of a mint that is now live on chain.
CREATE_OUT="$(spl --output json create-token --decimals "$DECIMALS")"
MINT_ADDR="$(printf '%s' "$CREATE_OUT" | jq -r '.commandOutput.address // .address // empty')"
if [ -z "$MINT_ADDR" ]; then
    echo "Error: the mint was CREATED but its address could not be read from:" >&2
    printf '%s\n' "$CREATE_OUT" >&2
    echo "Find it with: solana -C \"$SOLCFG\" transaction-history $TREASURY_ADDR" >&2
    exit 1
fi

# Verify against the CHAIN rather than trusting the command: the whole point of
# this script is that one specific key can mint this specific token, and that
# is a fact worth reading back before a box is wired to it.
ACTUAL_AUTH="$(spl --output json display "$MINT_ADDR" | jq -r '.mintAuthority')"
if [ "$ACTUAL_AUTH" != "$TREASURY_ADDR" ]; then
    echo "Error: the new mint's authority is $ACTUAL_AUTH, not the treasury $TREASURY_ADDR." >&2
    echo "Do NOT wire this box to $MINT_ADDR -- its drips would fail." >&2
    exit 1
fi

cat <<EOF

==> Mint created and verified
    Mint address:   $MINT_ADDR
    Mint authority: $TREASURY_ADDR  (this box's faucet treasury)
    Decimals:       $DECIMALS
    Supply:         0 -- every token in circulation will have been dripped

==> Next steps (not done by this script):
    1. Add this line to $ENV_FILE:
         SOLANA_USDC_MINT=$MINT_ADDR
    2. Restart the faucet so it picks the mint up:
         docker compose -f infra/linode-faucet/docker-compose.faucet.yml up -d faucet
       Its log must say "Mint authority confirmed"; a mismatch is named in full.
    3. Prove a drip lands (faucet-box-bringup.md gate (c)), then open the
       cutover PR that pins $MINT_ADDR in both fleet configs. Until that lands
       and is applied, the fleet is still settling against the OLD mint.
EOF

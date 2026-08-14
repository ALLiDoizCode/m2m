#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Generate the faucet box's fresh Mina USDC treasury key (issue #919,
# docs/operators/faucet-box-bringup.md step 4) and append it to an env file.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Run ON THE FAUCET BOX ITSELF (§4.4 -- never copy a key generated elsewhere,
# including from box 1/the apex). Uses mina-signer (not o1js -- key generation
# needs no zkApp circuit, and mina-signer is already a faucet dependency, so
# this avoids the ~6s/~3min RateLimitedUsdcAdmin/UsdcChannelToken compile
# packages/faucet/src/mina-usdc.mjs pays lazily on first drip).
#
# The private key is NEVER printed to stdout/stderr: it is appended directly
# to ENV_FILE as MINA_USDC_TREASURY_KEY=<base58>. Only the public key (safe to
# share -- it is not a secret) is echoed.
#
# MINA_USDC_TOKEN / MINA_USDC_ADMIN_CONTRACT are NOT written by this script --
# they are the shared, already-deployed devnet USDC token identifiers this
# issue already recorded in faucet-box-bringup.md step 4 (reused verbatim,
# not fresh material) and should be set into ENV_FILE alongside this key.
#
# What this script does NOT do: fund the treasury. Unlike Solana's devnet SOL
# airdrop, Mina's public faucet (https://faucet.minaprotocol.com) sits behind
# a bot-detection challenge with no unauthenticated API -- confirmed live
# (2026-08-14): a plain HTTPS request gets Vercel's "Security Checkpoint" page,
# not MINA. infra/mina/provision-mina.sh reaches the identical conclusion
# ("We can't auto-fund these on public devnet") and only checks + warns.
# Funding this key is an irreducibly human, browser-driven step (~1.2 devnet
# MINA covers fees + first-mint account creation -- see faucet-box-bringup.md
# step 5).
#
#   ./generate-mina-treasury.sh [ENV_FILE]
#     ENV_FILE  default ./.env (appends MINA_USDC_TREASURY_KEY=... to it;
#               created if it does not exist)
#
# Requires `node` on PATH with this repo's node_modules (mina-signer)
# reachable -- run it from the connector repo root, or anywhere node can
# resolve `mina-signer` (e.g. packages/faucet's own node_modules on the box).
set -euo pipefail

ENV_FILE="${1:-.env}"

command -v node >/dev/null 2>&1 || {
  echo "Error: node not found on PATH." >&2
  exit 1
}

if [ -f "$ENV_FILE" ] && grep -q '^MINA_USDC_TREASURY_KEY=.\+' "$ENV_FILE"; then
  echo "Error: $ENV_FILE already has a non-empty MINA_USDC_TREASURY_KEY -- refusing to" >&2
  echo "append a second one. Remove that line first if you really mean to replace it." >&2
  exit 1
fi

echo "==> Generating a fresh Mina keypair"

# Tighten permissions BEFORE any secret lands in the file, so the key is never
# briefly world-readable.
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

# One node invocation on purpose: the private key goes straight from keygen
# into ENV_FILE, never through argv (which `ps` exposes to every local user)
# nor through a shell variable. Only the public key crosses back to the shell.
PUBKEY="$(node -e '
const Client = require("mina-signer");
const C = Client.default || Client;
const { publicKey, privateKey } = new C({ network: "testnet" }).genKeys();
require("fs").appendFileSync(process.argv[1], `MINA_USDC_TREASURY_KEY=${privateKey}\n`);
process.stdout.write(publicKey);
' "$ENV_FILE")"

echo "==> Treasury public key: $PUBKEY"
echo "==> Appended MINA_USDC_TREASURY_KEY to $ENV_FILE (never printed)."

cat <<EOF

==> Next steps (not done by this script):
    1. Set MINA_USDC_TOKEN / MINA_USDC_ADMIN_CONTRACT in $ENV_FILE to the
       values already recorded in docs/operators/faucet-box-bringup.md step 4
       (the shared devnet USDC token -- reuse verbatim, they are not secrets).
    2. Fund $PUBKEY with ~1.2 devnet MINA at https://faucet.minaprotocol.com
       (human/browser step -- the faucet has no unauthenticated API; see this
       script's header). The treasury self-mints its own USDC allowance on
       first drip once it holds MINA for fees -- no separate USDC funding step.
    3. Restart the faucet service to pick up the env file, then verify:
       POST /api/mina/usdc-request against this box succeeds
       (faucet-box-bringup.md gate (c)).
EOF

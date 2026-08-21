#!/usr/bin/env bash
# =============================================================================
# Provision the key material a local topology needs, and fund it.
#
#   local/keys.sh <topology>        # e.g. local/keys.sh solo
#
# Everything lands in local/.keys/<topology>/, which is GITIGNORED. Nothing
# this script writes is ever committed: ADR 0012 makes key material a location
# rather than a value, and every committed connector.toml under local/ names
# these as paths. There is no fixed "throwaway" key checked in anywhere, so
# there is no allowlist exception to reason about and no key in git history to
# explain later.
#
# This replaces `deploy/connector-rust/local-stack/prepare.sh`, deleted with
# that bundle. What it adds is the FUNDING: a key that exists is not a key that
# can pay gas, and "the connector refused to start" and "its settlement account
# has no ETH" are different problems that used to present identically.
#
# No faucet is involved on either chain. The faucet is an app-layer service and
# is not part of the connector; local chains fund from genesis.
#
# Idempotent. Re-running keeps existing keys and re-funds them, which is the
# common case: both local chains wipe their state on every start, so the
# accounts survive in this directory while their balances do not.
# =============================================================================
set -euo pipefail

TOPOLOGY="${1:-}"
if [[ -z "$TOPOLOGY" ]]; then
  echo "usage: local/keys.sh <topology>   (e.g. 'solo')" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
KEYS="$HERE/.keys/$TOPOLOGY"
CONNECTOR="$ROOT/target/release/connector"

ANVIL_RPC="${ANVIL_RPC:-http://127.0.0.1:8545}"
SOLANA_RPC="${SOLANA_RPC:-http://127.0.0.1:8899}"

# anvil's own published account 0 -- mnemonic "test test ... junk", public
# knowledge. It is the deployer `DeployLocal.s.sol` runs as, so it owns the
# settlement topology and can mint the mock USDC. Only ever pointed at a
# disposable local chain.
ANVIL_ACCOUNT0_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
MOCK_USDC=0x5FbDB2315678afecb367f032d93F642f64180aa3

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: '$1' is not on PATH. $2" >&2
    exit 1
  }
}

need cast "Install Foundry: https://getfoundry.sh"
need solana "Install the Solana CLI: https://solana.com/docs/intro/installation"
need solana-keygen "Ships with the Solana CLI."
need openssl "openssl generates the key material."

if [[ ! -x "$CONNECTOR" ]]; then
  echo "ERROR: $CONNECTOR is missing. Run 'cargo build --release -p connector' first --" >&2
  echo "       this script derives the operator allowlist value with it, so the value in" >&2
  echo "       write_keys cannot disagree with whatever actually signs." >&2
  exit 1
fi

mkdir -p "$KEYS"
chmod 700 "$KEYS"

# ── Keys ─────────────────────────────────────────────────────────────────────
# 64 hex characters each -- one of the two shapes every `key_file` in this
# repository accepts (32 raw bytes is the other).
for key in signer settlement operator-send; do
  if [[ ! -f "$KEYS/$key.key" ]]; then
    openssl rand -hex 32 > "$KEYS/$key.key"
    chmod 600 "$KEYS/$key.key"
    echo "generated $key.key"
  fi
done

# The operator surface's READ credential. A token, not a key: it gates reads
# and nothing else, and no shared secret can move value (ADR 0008).
if [[ ! -f "$KEYS/operator-bearer-token" ]]; then
  openssl rand -hex 32 > "$KEYS/operator-bearer-token"
  chmod 600 "$KEYS/operator-bearer-token"
  echo "generated operator-bearer-token"
fi

# The Solana settlement key is the one key here that is not simply 64 hex,
# because two tools must agree on it: the connector reads a 32-byte SEED and
# calls `keypair_from_seed` (`build_solana_settlement_backend`), while the
# Solana CLI reads its own file -- a 64-element array of `seed || public key`.
# Generating with `solana-keygen` and deriving the connector's seed from it
# makes the CLI the single source of the pair, so the account this script
# airdrops to is provably the account the connector signs as.
if [[ ! -f "$KEYS/settlement-solana-cli.json" ]]; then
  solana-keygen new --no-bip39-passphrase --force --silent \
    -o "$KEYS/settlement-solana-cli.json" >/dev/null
  chmod 600 "$KEYS/settlement-solana-cli.json"
  echo "generated settlement-solana-cli.json"
fi

# The seed half, hex-encoded. Not cryptography: a slice and an encode.
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert len(p)==64, f"expected a 64-element Solana keypair array, got {len(p)}"; open(sys.argv[2],"w").write(bytes(p[:32]).hex())' \
  "$KEYS/settlement-solana-cli.json" "$KEYS/settlement-solana.key"
chmod 600 "$KEYS/settlement-solana.key"

# The write allowlist: the PUBLIC half of operator-send.key, one 64-hex key per
# line. Derived by the binary that will do the signing, so the allowlisted
# value and the signature cannot disagree.
KEYID="$("$CONNECTOR" send --operator-key "$KEYS/operator-send.key" --print-keyid)"
{
  echo "# Written by local/keys.sh -- the public half of operator-send.key."
  echo "# An allowlist entry is an ed25519 PUBLIC key and holds no secret."
  echo "$KEYID"
} > "$KEYS/operator-write-keys"

# The body the sender posts. A fixture; it lives beside the keys so the sender
# container mounts exactly one directory.
if [[ ! -f "$KEYS/payload.json" ]]; then
  echo '{"hello":"from a paid packet"}' > "$KEYS/payload.json"
fi

# The connector container mounts this directory READ-ONLY as uid 10001, so the
# files must be world-readable to it. They are mode 600 above for the host's
# sake; relax to 644 now that generation is done. This is a disposable local
# chain and none of these keys has ever held value anywhere else.
chmod 755 "$KEYS"
chmod 644 "$KEYS"/*

# ── Funding ──────────────────────────────────────────────────────────────────
# The mock USDC must actually be ON the chain before anything mints from it. A
# `cast send` of `mint(...)` to an address with no code does NOT revert -- it
# is an ordinary call to a plain account -- so without this check a race
# against the anvil deploy reports a funded account and leaves an empty one.
# The compose anvil healthcheck gates on the same fact; this is the second half,
# for anyone running the script against a chain they brought up themselves.
if [[ "$(cast code "$MOCK_USDC" --rpc-url "$ANVIL_RPC" 2>/dev/null)" == "0x" ]]; then
  echo "ERROR: no contract at $MOCK_USDC on $ANVIL_RPC." >&2
  echo "       The settlement topology is not deployed yet -- DeployLocal.s.sol runs as part" >&2
  echo "       of the compose anvil service's startup. Wait for that container to report" >&2
  echo "       healthy (it gates on exactly this) and re-run." >&2
  exit 1
fi

EVM_ADDRESS="$(cast wallet address --private-key "0x$(cat "$KEYS/settlement.key")")"
echo "funding EVM settlement account $EVM_ADDRESS"
cast send --rpc-url "$ANVIL_RPC" --private-key "$ANVIL_ACCOUNT0_KEY" \
  --value 100ether "$EVM_ADDRESS" >/dev/null
# Mock USDC is MINTABLE (packages/contracts/test/mocks/MockERC20.sol), so this
# is a mint rather than a transfer out of somebody's balance.
cast send --rpc-url "$ANVIL_RPC" --private-key "$ANVIL_ACCOUNT0_KEY" \
  "$MOCK_USDC" "mint(address,uint256)" "$EVM_ADDRESS" 1000000000 >/dev/null
echo "  100 ETH + 1000 USDC (6dp)"

SOLANA_ADDRESS="$(solana address --keypair "$KEYS/settlement-solana-cli.json")"
echo "funding Solana settlement account $SOLANA_ADDRESS"
solana airdrop 100 "$SOLANA_ADDRESS" --url "$SOLANA_RPC" >/dev/null
echo "  100 SOL"

echo
echo "keys for '$TOPOLOGY' are in $KEYS (gitignored)"
echo "operator write key (keyid): $KEYID"

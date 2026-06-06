#!/bin/sh
# Solana Test Validator Entrypoint
# Starts the validator, waits for readiness, derives a funded fee-payer from
# the genesis keypairs the validator itself creates, and deploys all .so
# programs from /programs.
#
# Follows the same non-fatal deploy pattern as the Anvil entrypoint.
#
# NOTE on keypairs / why NO committed key is needed:
#   The ghcr.io/beeman/solana-test-validator image ships `solana` +
#   `solana-test-validator` but NOT `solana-keygen`, so we cannot generate a
#   wallet at runtime, and we deliberately do NOT bake/commit one into the repo.
#   Instead we reuse a keypair the validator creates for us at genesis:
#   `<ledger>/validator-keypair.json`. In local `solana-test-validator` genesis
#   this validator identity account is funded heavily (hundreds of SOL), which
#   is more than enough to pay for `solana program deploy`. We point the Solana
#   CLI at it as the default signer, so the deploy needs neither a committed key
#   nor solana-keygen.
#
#   Programs are deployed with an explicit, mounted program keypair
#   (/programs/<name>-keypair.json) when present so the program id is
#   DETERMINISTIC across `up`/`down` cycles (the connector reads it from
#   SOLANA_TEST_PROGRAM_ID).
set -eu

# Explicit ledger dir so we can reliably locate the genesis-created keypairs.
# (Default is ./test-ledger relative to CWD; we pin it to be robust.)
LEDGER_DIR=/workspace/test-ledger

# Trap SIGTERM/SIGINT and forward to the validator for graceful shutdown
cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ]; then
    kill -TERM "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

solana-test-validator --reset --ledger "$LEDGER_DIR" --limit-ledger-size 50000000 &
VALIDATOR_PID=$!

# Wait for readiness
echo "Waiting for Solana validator to be ready..."
until solana cluster-version --url http://localhost:8899 2>/dev/null; do
  sleep 1
done
echo "Validator ready."

# Establish a default signer WITHOUT any committed key or solana-keygen:
# reuse the genesis-funded validator identity keypair the validator just wrote
# into the ledger dir. Copy it into the CLI config dir (the source may be
# read-only / owned differently) and point the CLI at it.
DEFAULT_KEYPAIR="/home/solana/.config/solana/id.json"
GENESIS_KEYPAIR="$LEDGER_DIR/validator-keypair.json"
mkdir -p "$(dirname "$DEFAULT_KEYPAIR")"

# Wait briefly for the genesis keypair to materialize (the validator writes it
# during genesis init, which completes around the time RPC comes up).
for i in $(seq 1 10); do
  [ -f "$GENESIS_KEYPAIR" ] && break
  echo "Waiting for genesis keypair at $GENESIS_KEYPAIR ($i/10)..."
  sleep 1
done

if [ -f "$GENESIS_KEYPAIR" ] && cp "$GENESIS_KEYPAIR" "$DEFAULT_KEYPAIR" 2>/dev/null; then
  solana config set --keypair "$DEFAULT_KEYPAIR" --url http://localhost:8899 >/dev/null 2>&1 || true
  echo "Using genesis validator-identity keypair as fee-payer: $(solana address --keypair "$DEFAULT_KEYPAIR" 2>/dev/null || echo '<unknown>')"
else
  # Fallbacks (in order): genesis faucet keypair, then solana-keygen if it
  # happens to exist. These keep the entrypoint robust if the layout changes.
  FAUCET_KEYPAIR="$LEDGER_DIR/faucet-keypair.json"
  if [ -f "$FAUCET_KEYPAIR" ] && cp "$FAUCET_KEYPAIR" "$DEFAULT_KEYPAIR" 2>/dev/null; then
    solana config set --keypair "$DEFAULT_KEYPAIR" --url http://localhost:8899 >/dev/null 2>&1 || true
    echo "Using genesis faucet keypair as fee-payer: $(solana address --keypair "$DEFAULT_KEYPAIR" 2>/dev/null || echo '<unknown>')"
  else
    echo "No genesis keypair found; attempting solana-keygen (may be unavailable in this image)."
    solana-keygen new --no-bip39-passphrase --force --silent 2>/dev/null || true
  fi
fi

# Top up the fee-payer via airdrop (best-effort). The genesis validator/faucet
# identity is already heavily funded, so this is just belt-and-suspenders and is
# fine if it fails.
AIRDROP_RETRIES=5
for i in $(seq 1 $AIRDROP_RETRIES); do
  if solana airdrop 1000 --url http://localhost:8899 2>/dev/null; then
    echo "Airdrop successful."
    break
  fi
  echo "Airdrop attempt $i/$AIRDROP_RETRIES failed, retrying..."
  sleep 2
done

# Warn if the fee-payer somehow has no SOL (deploy will fail without it).
if ! solana balance --url http://localhost:8899 2>/dev/null | grep -q '[1-9]'; then
  echo "WARNING: fee-payer has no SOL. Program deploys will likely fail."
fi

# Deploy all programs from /programs (non-fatal, matching Anvil pattern).
# When a sibling <name>-keypair.json is present, pass it as --program-id so the
# deployed program lands at the deterministic, known program id.
for so_file in /programs/*.so; do
  if [ -f "$so_file" ]; then
    base="${so_file%.so}"
    program_keypair="${base}-keypair.json"
    writable_program_keypair="/tmp/$(basename "$program_keypair")"
    # Copy the (read-only, possibly root-owned) mounted program keypair somewhere
    # writable so the CLI can read it as a signer. Guard the copy with `|| true`
    # so a permission error here never crashes the entrypoint (set -e); we simply
    # fall back to a fresh-id deploy below.
    if [ -f "$program_keypair" ] && cp "$program_keypair" "$writable_program_keypair" 2>/dev/null; then
      echo "Deploying $so_file with program id $(solana address --keypair "$writable_program_keypair" 2>/dev/null || echo '<unknown>')"
      solana program deploy "$so_file" \
        --program-id "$writable_program_keypair" \
        --url http://localhost:8899 \
        || echo "Deploy of $so_file failed (non-fatal)"
    else
      echo "No readable program keypair for $so_file; deploying with a fresh (non-deterministic) id."
      solana program deploy "$so_file" --url http://localhost:8899 \
        || echo "Deploy of $so_file failed (non-fatal)"
    fi
  fi
done

echo "Solana validator ready with programs deployed!"
wait $VALIDATOR_PID

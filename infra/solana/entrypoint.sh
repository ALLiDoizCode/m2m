#!/bin/sh
# Solana Test Validator Entrypoint
# Starts the validator, waits for readiness, funds the default keypair,
# and deploys all .so programs from /programs.
#
# Follows the same non-fatal deploy pattern as the Anvil entrypoint.
set -eu

# Trap SIGTERM/SIGINT and forward to the validator for graceful shutdown
cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ]; then
    kill -TERM "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

solana-test-validator --reset --limit-ledger-size 50000000 &
VALIDATOR_PID=$!

# Wait for readiness
echo "Waiting for Solana validator to be ready..."
until solana cluster-version --url http://localhost:8899 2>/dev/null; do
  sleep 1
done
echo "Validator ready."

# Generate default keypair if not present
solana-keygen new --no-bip39-passphrase --force --silent 2>/dev/null || true

# Fund default keypair (retry up to 5 times -- airdrop can be flaky)
AIRDROP_RETRIES=5
for i in $(seq 1 $AIRDROP_RETRIES); do
  if solana airdrop 1000 --url http://localhost:8899 2>/dev/null; then
    echo "Airdrop successful."
    break
  fi
  echo "Airdrop attempt $i/$AIRDROP_RETRIES failed, retrying..."
  sleep 2
done

# Warn if airdrop never succeeded (deploy will likely fail without SOL)
if ! solana balance --url http://localhost:8899 2>/dev/null | grep -q '[1-9]'; then
  echo "WARNING: Airdrop may have failed -- deployer has no SOL. Program deploys will likely fail."
fi

# Deploy all programs from /programs (non-fatal, matching Anvil pattern)
for so_file in /programs/*.so; do
  if [ -f "$so_file" ]; then
    solana program deploy "$so_file" --url http://localhost:8899 \
      || echo "Deploy of $so_file failed (non-fatal)"
  fi
done

echo "Solana validator ready with programs deployed!"
wait $VALIDATOR_PID

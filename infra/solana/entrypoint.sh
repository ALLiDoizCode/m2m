#!/bin/sh
# Solana Test Validator Entrypoint
#
# Loads the payment-channel program into GENESIS at a fixed program id and
# starts the validator. Nothing is deployed after startup and no keypair is
# needed for any of it.
#
# ── Why --bpf-program and not `solana program deploy` ──────────────────────
#   This used to start the validator, derive a fee payer from the genesis
#   keypairs, and then `solana program deploy --program-id <keypair>` every
#   .so in /programs. That required a `payment_channel-keypair.json` sitting
#   beside the .so to make the program id deterministic -- and that file is
#   UNTRACKED (tools/ci/check-tracked-secrets.sh matches `*-keypair.json`, and
#   program keypairs are exactly the class that guard exists to catch, see
#   connector#920/#922). `cargo build-sbf` generates one per machine on first
#   build, so the id was deterministic for whoever happened to have built the
#   program locally and random for everyone else -- the entrypoint's fallback
#   branch deployed "with a fresh (non-deterministic) id" on every `up`.
#
#   A program id that changes per machine cannot appear in a committed
#   `connector.toml`, and ADR 0009 gives no environment-variable layer to
#   patch one in at runtime. So this now does what the Rust test harness
#   already does (connector-settlement-solana's `SolanaValidator::spawn`):
#   passes the .so to `--bpf-program` under a BARE program id at genesis. No
#   keypair, no deploy step, no fee payer, and the SAME id both tiers use --
#   which is what makes the id committable.
#
#   PROGRAM_ID below must stay equal to
#   `connector_settlement_solana::test_support::LOCAL_TEST_PROGRAM_ID`.
#   `crates/connector-settlement-solana/tests/local_program_id_is_shared.rs`
#   fails if they drift.
set -eu

# The program id the .so is loaded under, in this validator's genesis only.
# Distinct from the deployed devnet program (see
# packages/solana-program/deployments/devnet-public.md).
PROGRAM_ID=HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR
PROGRAM_SO=/programs/payment_channel.so

# Explicit ledger dir rather than the default ./test-ledger relative to CWD.
LEDGER_DIR=/workspace/test-ledger

# Trap SIGTERM/SIGINT and forward to the validator for graceful shutdown
cleanup() {
  if [ -n "${VALIDATOR_PID:-}" ]; then
    kill -TERM "$VALIDATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup TERM INT

# The .so is bind-mounted from ./target/deploy, which `make solana-build`
# produces. Coming up WITHOUT it is a real state -- somebody ran `docker
# compose up` directly on a tree that has never built the program -- and the
# validator is still useful for anything that doesn't touch settlement, so
# this warns loudly rather than refusing. Every settlement call against such
# a validator fails with the program not existing, which is a clear enough
# error to trace back to this line. `make solana-up` depends on solana-build
# so the supported path never reaches here.
if [ -f "$PROGRAM_SO" ]; then
  echo "Loading $PROGRAM_SO into genesis at $PROGRAM_ID"
  set -- --bpf-program "$PROGRAM_ID" "$PROGRAM_SO"
else
  echo "WARNING: $PROGRAM_SO is missing -- starting with NO payment-channel program."
  echo "WARNING: run 'make solana-build' and recreate this container before settling."
  set --
fi

# --limit-ledger-size caps how many shreds the rocksdb ledger retains. NOTE the
# `solana-test-validator` default is only 10000 shreds (NOT the full validator's
# 200,000,000) -- so the old explicit 50,000,000 here was a ~5000x override that
# let rocksdb grow to ~63 GB in ~21h and fill the 80 GB devnet box's disk. When
# the disk is full the validator silently STOPS producing blocks (slot freezes)
# while /health still returns "ok", so faucet/settlement writes hang then 500.
# 10,000,000 shreds bounds the ledger to ~12-13 GB (~1.26 KB/shred observed) --
# generous recent history for claim verification, with wide headroom on disk.
# Verified accepted by this image's validator (agave 4.0.3, ghcr.io/beeman/
# solana-test-validator): `--limit-ledger-size` defaults to only 10000 shreds and
# enforces NO 50M minimum (that floor is the full `solana-validator`, not the
# test validator), so 10,000,000 starts cleanly -- no crash-loop risk.
solana-test-validator --reset --ledger "$LEDGER_DIR" --limit-ledger-size 10000000 "$@" &
VALIDATOR_PID=$!

echo "Waiting for Solana validator to be ready..."
until solana cluster-version --url http://localhost:8899 2>/dev/null; do
  sleep 1
done

echo "Solana validator ready."
wait $VALIDATOR_PID

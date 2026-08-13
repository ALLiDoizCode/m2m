// Integration test for issue #945: faucet.drip() against a REAL, disposable
// solana-test-validator — no docker, no mocks. This mirrors
// crates/connector-settlement-solana/src/test_support.rs's own pattern of
// spawning solana-test-validator directly (ADR 0007's "each integration test
// spawns its own disposable chain" is chain-agnostic, and this npm workspace
// has no docker daemon available, same as the Rust harness's non-CI fallback).
//
// Proves, against real transactions on a real chain:
//   - drip() performs exactly one on-chain action, the USDC transfer (no
//     `sol` field in the result at all — the SOL leg removed by #945 has no
//     successor);
//   - the recipient's own USDC token-account balance actually rose by the
//     drip amount, not just that a signature was returned;
//   - the recipient receives no SOL at all, before or after the drip.
//
// Skips (does not fail) when solana-test-validator is not on PATH — this repo
// has no equivalent, on the npm side, of the Rust gate's CI-only hard
// requirement; every other optional-infra faucet test in this directory
// (solana-treasury.test.js) already degrades the same way when its
// prerequisites are missing.
//
// Config is read from env at solana.js's module-load time, so — like
// solana-treasury.test.js — this file sets env vars BEFORE importing it, and
// node's test runner isolates each test FILE in its own process.
//
// Run: node --test test/solana-drip-live.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  createMint,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from '@solana/spl-token';

function solanaTestValidatorAvailable() {
  try {
    execFileSync('solana-test-validator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = solanaTestValidatorAvailable();

// The drip this test configures the faucet with, named once so the env var
// the faucet reads and the amount asserted below cannot drift apart.
const DRIP_USDC = 10;
const DRIP_DECIMALS = 6;
const DRIP_RAW_AMOUNT = BigInt(DRIP_USDC * 10 ** DRIP_DECIMALS);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `confirmTransaction` already waits for the signature to reach 'confirmed'
// (or for its blockhash to expire, which rejects) — a retry loop around it
// would only re-poll a transaction that has already landed or already failed.
async function confirmAirdrop(connection, signature) {
  const { value } = await connection.confirmTransaction(signature, 'confirmed');
  if (value.err) {
    throw new Error(`airdrop transaction failed: ${JSON.stringify(value.err)}`);
  }
}

test(
  'drip() delivers real, verified USDC and performs no SOL action',
  { skip: !available && 'solana-test-validator not on PATH' },
  async (t) => {
    // Assigned mid-test, referenced by the teardown below — declared up
    // here so a test that fails before the faucet exists still tears down.
    let faucet;
    let connection;
    const rpcPort = 21000 + Math.floor(Math.random() * 3000);
    const rpcUrl = `http://127.0.0.1:${rpcPort}`;
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-solana-live-'));

    const child = spawn(
      'solana-test-validator',
      [
        '--ledger',
        ledgerDir,
        '--rpc-port',
        String(rpcPort),
        // rpcPort + 1 is reserved by --rpc-port for the RPC websocket
        // (solana-test-validator --help); the faucet port must not collide
        // with it or transaction confirmation's websocket subscription
        // silently fails to connect.
        '--faucet-port',
        String(rpcPort + 2),
        '--dynamic-port-range',
        `${rpcPort + 3}-${rpcPort + 40}`,
        '--reset',
        '--quiet',
      ],
      { stdio: 'ignore' }
    );
    t.after(() => {
      // Close both RPC websockets FIRST, while the validator is still up: a
      // deliberate close with no live subscriptions is final, whereas a
      // socket that watches its validator die retries its reconnect forever
      // and keeps this process's event loop alive. With both released, the
      // process exits naturally, so the TAP results AND the exit code are
      // the runner's own (crib from PR #943's fix on sandcastle/issue-691,
      // c83b9c42: an unconditional `process.exit(0)` here previously ran
      // before the test's result was flushed, reporting assertion failures
      // as `ok` with exit code 0).
      faucet?.close();
      try {
        connection?._rpcWebSocket.close();
      } catch {
        // Never connected — nothing to release.
      }
      child.kill();
      fs.rmSync(ledgerDir, { recursive: true, force: true });
      // Fallback only, and unref'd so it cannot keep the process alive
      // itself: if some straggling handle still pins the event loop, exit
      // with the verdict node:test has set by then (a failed test file sets
      // `process.exitCode` nonzero), never a hardcoded 0.
      setTimeout(() => process.exit(process.exitCode ?? 0), 5_000).unref();
    });

    connection = new Connection(rpcUrl, 'confirmed');
    let ready = false;
    for (let i = 0; i < 600; i++) {
      try {
        await connection.getVersion();
        ready = true;
        break;
      } catch {
        // Not listening yet — retry.
      }
      await sleep(100);
    }
    assert.ok(ready, `solana-test-validator did not become ready at ${rpcUrl}`);

    // Treasury: funded via the local validator's own (effectively unlimited)
    // airdrop faucet — real signatures, real confirmed transactions. Only SOL
    // needed is the treasury's own tx fees + the recipient ATA's rent.
    const treasury = Keypair.generate();
    const fundSig = await connection.requestAirdrop(treasury.publicKey, 10 * LAMPORTS_PER_SOL);
    await confirmAirdrop(connection, fundSig);

    const mint = await createMint(connection, treasury, treasury.publicKey, null, DRIP_DECIMALS);

    // drip()'s USDC transfer moves FROM the treasury's own ATA — mint it
    // enough to cover every drip this test issues (mint authority is the
    // treasury itself, mirroring infra/solana/create-usdc-mint.sh's real
    // devnet setup).
    const treasuryAta = await getOrCreateAssociatedTokenAccount(
      connection,
      treasury,
      mint,
      treasury.publicKey
    );
    await mintTo(connection, treasury, mint, treasuryAta.address, treasury, 1_000_000_000);

    const keypairPath = path.join(ledgerDir, 'treasury.json');
    fs.writeFileSync(keypairPath, JSON.stringify(Array.from(treasury.secretKey)));

    process.env.SOLANA_RPC_URL = rpcUrl;
    process.env.SOLANA_FAUCET_KEYPAIR = keypairPath;
    process.env.SOLANA_USDC_MINT = mint.toBase58();
    process.env.SOLANA_USDC_AMOUNT = String(DRIP_USDC);
    process.env.SOLANA_DRIP_COOLDOWN_MS = '1';

    const { createSolanaFaucet } = await import('../src/solana.js');
    faucet = createSolanaFaucet();
    assert.ok(faucet, 'faucet should be enabled against the live validator');

    // The recipient never receives SOL from the faucet at all — generate it
    // with zero balance and confirm it stays that way.
    const recipient = Keypair.generate();
    const recipientStartBalance = await connection.getBalance(recipient.publicKey, 'confirmed');
    assert.equal(
      recipientStartBalance,
      0,
      'recipient must start with no SOL for this case to be meaningful'
    );

    const result = await faucet.drip(recipient.publicKey.toBase58());

    // AC: exactly one on-chain action — the USDC transfer. No `sol` field of
    // any shape (skipped/treasury/airdrop-fallback) survives in the result.
    assert.equal(result.sol, undefined);
    assert.ok(result.usdc.signature);
    assert.equal(result.usdc.mint, mint.toBase58());

    // Real delivery, not just a returned signature: read the recipient's own
    // USDC token account back from the chain. The address is derived, never
    // created here — the drip is what must have created it, so a drip that
    // silently skipped the ATA fails this read instead of being papered over.
    const recipientAta = getAssociatedTokenAddressSync(mint, recipient.publicKey);
    const recipientAccount = await getAccount(connection, recipientAta);
    assert.equal(recipientAccount.amount, DRIP_RAW_AMOUNT);

    // The faucet never sent the recipient any SOL, at all, in the course of
    // that drip — the treasury paid the fee and the ATA rent.
    const recipientBalanceAfter = await connection.getBalance(recipient.publicKey, 'confirmed');
    assert.equal(recipientBalanceAfter, 0, 'drip() must not fund the recipient with any SOL');
  }
);

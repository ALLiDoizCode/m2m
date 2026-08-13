// Integration test for issue #691's actual fix: dripInner's SOL leg against a
// REAL, disposable solana-test-validator — no docker, no mocks. This mirrors
// crates/connector-settlement-solana/src/test_support.rs's own pattern of
// spawning solana-test-validator directly (ADR 0007's "each integration test
// spawns its own disposable chain" is chain-agnostic, and this npm workspace
// has no docker daemon available, same as the Rust harness's non-CI fallback).
//
// Proves, against real transactions on a real chain:
//   - a treasury SOL transfer that actually lands is reported as delivered
//     (the regression case: before this fix, a confirmed signature alone was
//     trusted, with no re-read of the recipient's balance);
//   - a treasury too low to cover the drip explicitly skips the treasury
//     transfer (rather than surfacing an opaque RPC failure) and still
//     delivers via the requestAirdrop fallback, which a local validator's
//     unlimited internal faucet always has room for.
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
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

function solanaTestValidatorAvailable() {
  try {
    execFileSync('solana-test-validator', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const available = solanaTestValidatorAvailable();

// The drip this test configures the faucet with, named once so the env var the
// faucet reads and the lamport floors asserted below cannot drift apart.
const DRIP_SOL = 0.03;
const DRIP_LAMPORTS = Math.round(DRIP_SOL * LAMPORTS_PER_SOL);
// Solana's base fee: 5,000 lamports per signature (the drain tx below signs once).
const SIGNATURE_FEE_LAMPORTS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function confirmAirdrop(connection, signature) {
  for (let i = 0; i < 300; i++) {
    if (await connection.confirmTransaction(signature, 'confirmed').then((r) => !r.value.err)) {
      return;
    }
    await sleep(100);
  }
  throw new Error('airdrop did not confirm in time');
}

test(
  'dripInner delivers real, verified lamports and explicitly diagnoses a low treasury',
  { skip: !available && 'solana-test-validator not on PATH' },
  async (t) => {
    // Assigned mid-test, referenced by the teardown below — declared up
    // here so a test that fails before the faucet exists still tears down.
    let faucet;
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
      // the runner's own — the previous unconditional `process.exit(0)`
      // here ran before the test's result was flushed, which reported
      // assertion failures as `ok` with exit code 0 (this file was
      // incapable of failing).
      faucet?.close();
      try {
        connection._rpcWebSocket.close();
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

    const connection = new Connection(rpcUrl, 'confirmed');
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
    // airdrop faucet — real signatures, real confirmed transactions.
    const treasury = Keypair.generate();
    const fundSig = await connection.requestAirdrop(treasury.publicKey, 10 * LAMPORTS_PER_SOL);
    await confirmAirdrop(connection, fundSig);

    const mint = await createMint(connection, treasury, treasury.publicKey, null, 6);

    // dripInner's USDC leg transfers FROM the treasury's own ATA — mint it
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
    process.env.SOLANA_SOL_AMOUNT = String(DRIP_SOL);
    process.env.SOLANA_USDC_AMOUNT = '10';
    process.env.SOLANA_DRIP_COOLDOWN_MS = '1';

    const { createSolanaFaucet } = await import('../src/solana.js');
    faucet = createSolanaFaucet();
    assert.ok(faucet, 'faucet should be enabled against the live validator');

    // ── Case 1: a well-funded treasury delivers real, verified lamports ──
    const recipient1 = Keypair.generate();
    const result1 = await faucet.drip(recipient1.publicKey.toBase58());
    assert.equal(result1.sol.source, 'treasury');
    assert.ok(result1.sol.signature);
    const recipient1Balance = await connection.getBalance(recipient1.publicKey, 'confirmed');
    assert.ok(
      recipient1Balance >= DRIP_LAMPORTS,
      `expected recipient to actually hold the drip; got ${recipient1Balance} lamports`
    );

    // ── Case 2: drain the treasury below what a drip + fee needs, but leave
    // enough to cover the USDC leg's ATA rent + fees. Proves the pre-flight
    // check explicitly diagnoses the low balance (issue #691's "surface
    // treasury-low as an explicit error") rather than a drip silently
    // reporting success against a treasury it can't actually cover, or
    // failing with an opaque RPC error. ──
    const currentTreasuryBalance = await connection.getBalance(treasury.publicKey, 'confirmed');
    const targetTreasuryBalance = Math.round(DRIP_LAMPORTS / 3); // well under one drip
    const sink = Keypair.generate();
    const drainTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: treasury.publicKey,
        toPubkey: sink.publicKey,
        lamports: currentTreasuryBalance - targetTreasuryBalance - SIGNATURE_FEE_LAMPORTS,
      })
    );
    await sendAndConfirmTransaction(connection, drainTx, [treasury], { commitment: 'confirmed' });

    const treasuryBalanceBeforeDrip2 = await connection.getBalance(treasury.publicKey, 'confirmed');
    assert.ok(
      treasuryBalanceBeforeDrip2 < DRIP_LAMPORTS,
      'treasury must genuinely be below the drip amount for this case to be meaningful'
    );

    const recipient2 = Keypair.generate();
    const result2 = await faucet.drip(recipient2.publicKey.toBase58());

    // The local validator's internal faucet has no rate limit, so the
    // airdrop fallback succeeds — but it must carry the explicit diagnosis
    // of why the treasury path itself was skipped.
    assert.equal(result2.sol.source, 'airdrop-fallback');
    assert.equal(result2.sol.fallbackReason, 'treasury sol balance too low');
    assert.equal(result2.sol.treasuryBalanceLamports, treasuryBalanceBeforeDrip2);
    const recipient2Balance = await connection.getBalance(recipient2.publicKey, 'confirmed');
    assert.ok(
      recipient2Balance >= DRIP_LAMPORTS,
      `expected the airdrop fallback to actually deliver; got ${recipient2Balance} lamports`
    );
  }
);

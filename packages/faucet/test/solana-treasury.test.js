// Tests for createSolanaFaucet's treasury-funded SOL leg (toon-meta#258): the
// conservative default drip amount and the per-address cooldown that protects
// a treasury balance which does NOT self-replenish (the public devnet airdrop
// that would normally top it up is the same rate-limited endpoint this leg
// exists to work around).
//
// createSolanaFaucet() only touches the network INSIDE drip()/dripUsdcOnly()
// (constructing a Connection or loading a Keypair from disk are both local),
// so its wiring — solAmount, cooldownMs, claim()/release() — can be exercised
// with a throwaway generated keypair and no live RPC.
//
// Config (SOLANA_SOL_AMOUNT, SOLANA_DRIP_COOLDOWN_MS, ...) is read from env at
// module load time, so this file sets env vars BEFORE importing solana.js.
// node's test runner isolates each test FILE in its own process, so this
// cannot leak into other test files.
//
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faucet-solana-test-'));
const treasury = Keypair.generate();
const keypairPath = path.join(tmpDir, 'treasury.json');
fs.writeFileSync(keypairPath, JSON.stringify(Array.from(treasury.secretKey)));

process.env.SOLANA_FAUCET_KEYPAIR = keypairPath;
// Any valid base58 pubkey works — these tests never reach a mint-aware call.
process.env.SOLANA_USDC_MINT = Keypair.generate().publicKey.toBase58();
// Never dialed: Connection construction is lazy, and nothing in this file
// calls drip()/dripUsdcOnly().
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1';
process.env.SOLANA_DRIP_COOLDOWN_MS = '60000';
delete process.env.SOLANA_SOL_AMOUNT; // exercise the built-in default

const { createSolanaFaucet } = await import('../src/solana.js');

test('createSolanaFaucet defaults to a conservative SOL drip amount', () => {
  const faucet = createSolanaFaucet();
  assert.ok(faucet, 'faucet should be enabled with a valid mint + keypair');
  // toon-meta#258: the committed devnet treasury has been observed as low as
  // ~0.45 SOL and is not self-replenishing, so the default must stay well
  // under 1 SOL (the pre-fix default of 2 SOL would exhaust the treasury in a
  // single request).
  assert.equal(faucet.solAmount, 0.03);
});

test('createSolanaFaucet wires a per-address cooldown (claim/release)', () => {
  const faucet = createSolanaFaucet();
  const address = Keypair.generate().publicKey.toBase58();

  const first = faucet.claim(address);
  assert.equal(first.allowed, true);

  const second = faucet.claim(address);
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfterMs > 0);

  // release() rolls back so a FAILED drip costs no cooldown.
  faucet.release(address);
  assert.equal(faucet.claim(address).allowed, true);
});

test('createSolanaFaucet reports the configured cooldown window', () => {
  const faucet = createSolanaFaucet();
  assert.equal(faucet.cooldownMs, 60_000);
});

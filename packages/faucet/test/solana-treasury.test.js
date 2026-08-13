// Tests for createSolanaFaucet's per-address cooldown, which protects the
// treasury's USDC balance (the drip's only on-chain leg, issue #945) from
// being drained by repeat requests from a single address.
//
// createSolanaFaucet() only touches the network INSIDE drip() (constructing a
// Connection or loading a Keypair from disk are both local), so its wiring —
// cooldownMs, claim()/release() — can be exercised with a throwaway generated
// keypair and no live RPC.
//
// Config (SOLANA_DRIP_COOLDOWN_MS, ...) is read from env at module load time,
// so this file sets env vars BEFORE importing solana.js. node's test runner
// isolates each test FILE in its own process, so this cannot leak into other
// test files.
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
// calls drip().
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1';
process.env.SOLANA_DRIP_COOLDOWN_MS = '60000';

const { createSolanaFaucet } = await import('../src/solana.js');

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

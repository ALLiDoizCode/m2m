// Tests for createSolanaFaucet's per-address cooldown, which is the only bound
// on the drip's single on-chain leg (issue #945): the faucet holds the mint's
// authority, so nothing on-chain stops one address asking repeatedly.
//
// createSolanaFaucet() only touches the network INSIDE drip() (constructing a
// Connection or loading a Keypair from disk are both local, and the mint's
// authority is read lazily by assertMintAuthority, not in the factory), so its
// wiring — cooldownMs, claim()/release(), mintMode — can be exercised with a
// throwaway generated keypair and no live RPC. That the factory stays
// non-dialling is a property this file depends on: SOLANA_RPC_URL below points
// at a closed port.
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

test('createSolanaFaucet advertises how it sources tokens', () => {
  const faucet = createSolanaFaucet();
  // /api/info publishes this so an operator reading the capability map knows
  // the leg cannot run dry, and does not go hunting for a treasury balance.
  // The Base Sepolia leg's equivalent is 'ungated-mint'.
  assert.equal(faucet.mintMode, 'faucet-is-mint-authority');
});

test('the factory dials nothing: an unreachable RPC still yields a faucet', () => {
  // SOLANA_RPC_URL is 127.0.0.1:1 (a closed port). If the authority check ever
  // moved into the factory, this would hang or throw instead of returning —
  // and routes.test.js, which boots the whole server with every chain
  // unreachable, would go with it.
  const faucet = createSolanaFaucet();
  assert.ok(faucet);
  assert.equal(typeof faucet.assertMintAuthority, 'function');
});

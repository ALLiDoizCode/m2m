// Tests for the Mina native-MINA treasury drip.
//
// We do NOT have the real treasury private key (it's a deploy secret), and we
// don't hit the live network here. Instead we:
//   1. Generate a THROWAWAY mina-signer keypair, sign a payment, and assert the
//      signature verifies — proving the signing path mina.js uses is correct.
//   2. Assert createMinaFaucet() returns null when MINA_FAUCET_KEY is unset.
//   3. Assert createMinaFaucet() THROWS when the configured key derives the
//      wrong public key — proving the treasury-pubkey guard fires (we feed it
//      the throwaway key, whose pubkey is NOT the treasury).
//   4. Assert address validation (B62 accept / reject).
//
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Client from 'mina-signer';
import { isValidMinaAddress, createMinaFaucet, minaInfo, minaFallbackLink } from '../src/mina.js';

const TREASURY = 'B62qqEMaUpm1aZ5M2weUoGXQRGbF3j6VjEtaEdzfM1NAWmeHnywiC2P';

test('mina-signer signs a native payment and the signature verifies (signing path)', () => {
  const client = new Client({ network: 'testnet' });
  const kp = client.genKeys(); // THROWAWAY keypair — never the real treasury
  assert.match(kp.publicKey, /^B62q/);

  const payment = {
    from: kp.publicKey,
    to: kp.publicKey,
    amount: '5000000000', // 5 MINA in nanomina
    fee: '100000000', // 0.1 MINA
    nonce: '0',
  };
  const signed = client.signPayment(payment, kp.privateKey);

  // Shape mina.js submits to sendPayment.
  assert.deepEqual(Object.keys(signed.signature).sort(), ['field', 'scalar']);
  assert.equal(signed.data.amount, '5000000000');
  assert.equal(signed.data.fee, '100000000');
  assert.equal(signed.data.from, kp.publicKey);

  // The proof the signing path is sound.
  assert.equal(client.verifyPayment(signed), true);
});

test('createMinaFaucet() returns null when MINA_FAUCET_KEY is unset', () => {
  const saved = process.env.MINA_FAUCET_KEY;
  delete process.env.MINA_FAUCET_KEY;
  try {
    assert.equal(createMinaFaucet(), null);
  } finally {
    if (saved !== undefined) process.env.MINA_FAUCET_KEY = saved;
  }
});

test('createMinaFaucet() throws when the key derives the WRONG treasury (guard fires)', () => {
  const client = new Client({ network: 'testnet' });
  const kp = client.genKeys(); // a valid key, but NOT the treasury
  assert.notEqual(client.derivePublicKey(kp.privateKey), TREASURY);

  const saved = process.env.MINA_FAUCET_KEY;
  process.env.MINA_FAUCET_KEY = kp.privateKey;
  try {
    assert.throws(
      () => createMinaFaucet(),
      (err) => {
        // Fail-loud about the mismatch, and NEVER leak the key in the message.
        assert.match(err.message, new RegExp(TREASURY));
        assert.ok(!err.message.includes(kp.privateKey), 'error message must not contain the key');
        return true;
      }
    );
  } finally {
    if (saved === undefined) delete process.env.MINA_FAUCET_KEY;
    else process.env.MINA_FAUCET_KEY = saved;
  }
});

test('createMinaFaucet() throws on a non-base58 key (without leaking it)', () => {
  const saved = process.env.MINA_FAUCET_KEY;
  process.env.MINA_FAUCET_KEY = 'not-a-real-key';
  try {
    assert.throws(
      () => createMinaFaucet(),
      (err) => {
        assert.ok(!err.message.includes('not-a-real-key'));
        return /not a valid base58/i.test(err.message);
      }
    );
  } finally {
    if (saved === undefined) delete process.env.MINA_FAUCET_KEY;
    else process.env.MINA_FAUCET_KEY = saved;
  }
});

test('isValidMinaAddress accepts B62 and rejects junk', () => {
  assert.equal(isValidMinaAddress(TREASURY), true);
  assert.equal(isValidMinaAddress('0xdeadbeef'), false);
  assert.equal(isValidMinaAddress(''), false);
  assert.equal(isValidMinaAddress(undefined), false);
  assert.equal(isValidMinaAddress('B62qShort'), false);
});

test('minaInfo() reports link-mode (disabled) when no faucet is configured', () => {
  const info = minaInfo(null);
  assert.equal(info.enabled, false);
  assert.equal(info.drip, false);
  assert.equal(info.mode, 'link');
  assert.ok(info.faucetUrl);
});

test('minaInfo() reports treasury-drip mode when a faucet is configured', () => {
  const info = minaInfo({
    treasury: TREASURY,
    dripAmount: '5',
    graphqlUrl: 'http://x',
    fee: '0.1',
  });
  assert.equal(info.enabled, true);
  assert.equal(info.drip, true);
  assert.equal(info.mode, 'treasury-drip');
  assert.equal(info.treasury, TREASURY);
  assert.equal(info.drips.mina, '5');
});

test('minaFallbackLink encodes the address into the public faucet URL', () => {
  const url = minaFallbackLink(TREASURY);
  assert.ok(url.includes(TREASURY));
  assert.ok(url.startsWith('https://faucet.minaprotocol.com'));
});

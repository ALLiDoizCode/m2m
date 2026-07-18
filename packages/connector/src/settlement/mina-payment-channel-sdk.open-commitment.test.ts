/**
 * MinaPaymentChannelSDK.openBalanceCommitment — REAL-crypto binding (Issue #359 / toon-meta#168)
 *
 * This is the security crux of the Mina value-binding (Option B): the inbound
 * gate treats a Mina claim's plaintext `transferredAmount` as trustworthy ONLY
 * because it recomputes `Poseidon([balanceA, balanceB, salt])` — the SAME hash
 * the client's `signBalanceProof` and the on-chain `claimFromChannel` use — and
 * requires it to equal the commitment the Pallas-Schnorr signature is verified
 * over. A payer cannot present balances that open to a commitment other than the
 * one they signed, because Poseidon is collision-resistant.
 *
 * Unlike the other Mina SDK suites, this file does NOT mock o1js: it exercises
 * the real Poseidon so a tampered plaintext is provably rejected by the hash,
 * not by a stubbed compare. Poseidon.hash is a pure in-process computation (no
 * proving, no workers, no chain RPC), so the test stays local and fast.
 */

import { MinaPaymentChannelSDK } from './mina-payment-channel-sdk';
import type { Logger } from '../utils/logger';

const createLogger = (): Logger =>
  ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    trace: jest.fn(),
    child: jest.fn(function (this: unknown) {
      return this;
    }),
  }) as unknown as Logger;

// A syntactically valid B62 zkApp address (openBalanceCommitment does not use it,
// but the constructor stores it).
const ZKAPP = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';

// Build a serialized proof (base64(JSON)) carrying an arbitrary commitment — the
// wire shape `signBalanceProof` emits. openBalanceCommitment reads only
// `commitment`; the signature/nonce are irrelevant to the preimage check.
const proofWithCommitment = (commitment: string): string =>
  Buffer.from(
    JSON.stringify({ commitment, signature: { r: '1', s: '1' }, nonce: '5' }),
    'utf8'
  ).toString('base64');

describe('MinaPaymentChannelSDK.openBalanceCommitment — real Poseidon binding (#359/#168)', () => {
  let sdk: MinaPaymentChannelSDK;
  let realCommitment: string;
  const balanceA = 600000n;
  const balanceB = 400000n;
  const salt = 123456789012345678901234567890n;

  beforeAll(async () => {
    sdk = new MinaPaymentChannelSDK('http://localhost:3085/graphql', ZKAPP, createLogger());
    // Compute the true commitment with the SAME real Poseidon the SDK uses.
    const { Poseidon, Field } = await import('o1js');
    realCommitment = Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)]).toString();
  }, 120_000);

  it("returns 'match' when the plaintext preimage opens the signed commitment", async () => {
    const proof = proofWithCommitment(realCommitment);
    await expect(sdk.openBalanceCommitment(proof, balanceA, balanceB, salt)).resolves.toBe('match');
  });

  it("returns 'mismatch' when transferredAmount (balanceA) is tampered — the security crux", async () => {
    const proof = proofWithCommitment(realCommitment);
    // A payer bumps the claimed cumulative but cannot change the signed commitment.
    await expect(sdk.openBalanceCommitment(proof, balanceA + 1n, balanceB, salt)).resolves.toBe(
      'mismatch'
    );
  });

  it("returns 'mismatch' when balanceB or salt is tampered", async () => {
    const proof = proofWithCommitment(realCommitment);
    await expect(sdk.openBalanceCommitment(proof, balanceA, balanceB + 1n, salt)).resolves.toBe(
      'mismatch'
    );
    await expect(sdk.openBalanceCommitment(proof, balanceA, balanceB, salt + 1n)).resolves.toBe(
      'mismatch'
    );
  });

  it('accepts a raw-JSON (non-base64) proof and still binds', async () => {
    const rawJson = JSON.stringify({
      commitment: realCommitment,
      signature: { r: '1', s: '1' },
      nonce: '5',
    });
    await expect(sdk.openBalanceCommitment(rawJson, balanceA, balanceB, salt)).resolves.toBe(
      'match'
    );
  });

  it("returns 'unopenable' when the proof carries no parseable commitment", async () => {
    const noCommitment = Buffer.from(
      JSON.stringify({ signature: { r: '1', s: '1' }, nonce: '5' }),
      'utf8'
    ).toString('base64');
    await expect(sdk.openBalanceCommitment(noCommitment, balanceA, balanceB, salt)).resolves.toBe(
      'unopenable'
    );

    const garbage = Buffer.from('not json at all', 'utf8').toString('base64');
    await expect(sdk.openBalanceCommitment(garbage, balanceA, balanceB, salt)).resolves.toBe(
      'unopenable'
    );
  });
});

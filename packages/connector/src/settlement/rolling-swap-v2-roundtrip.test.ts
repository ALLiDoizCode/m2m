/**
 * RollingSwapChannel v2 end-to-end round-trip + fail-closed cutover tests
 * (connector#329 Phase 4b, refs #328).
 *
 * Proves the whole security-critical loop on v2, with NO mocking of the digest
 * crypto:
 *   1. Signer repoint — the connector's own `PaymentChannelSDK.signBalanceProof`
 *      (backed by a real env KeyManager over the well-known Anvil #0 key) builds
 *      the v2 EIP-712 digest via the leaf and signs it; `verifyBalanceProofV2`
 *      and the leaf `verifyEVMClaimV2` both accept it. It reproduces the pinned
 *      golden signature byte-for-byte (RFC-6979 deterministic ECDSA), tying the
 *      connector signer to the leaf + on-chain contract's golden vector.
 *   2. Outbound→inbound loop — a v2-signed claim on the wire is ACCEPTED by the
 *      live `InboundClaimValidator` hot path.
 *   3. Fail-closed — a v1-shaped ('1.0' Raiden fields) claim is rejected
 *      STRUCTURALLY, and a v2-shaped claim carrying a signature over the wrong
 *      digest is rejected CRYPTOGRAPHICALLY. No dual-scheme fallback.
 */

import pino from 'pino';
import { PaymentChannelSDK } from './payment-channel-sdk';
import { KeyManager } from '../security/key-manager';
import { InboundClaimValidator } from '../btp/inbound-claim-validator';
import { verifyEVMClaimV2 } from './eip712-v2-verifier';
import { BTP_CLAIM_PROTOCOL } from '../btp/btp-claim-types';
import { PacketType } from '@toon-protocol/shared';
import type { ILPPreparePacket } from '@toon-protocol/shared';
import type { BTPProtocolData } from '../btp/btp-types';
import {
  makeV2EvmClaim,
  signV2EvmClaim,
  ANVIL_0_PK,
  ANVIL_0_ADDR,
  V2_CHAIN_ID,
  V2_VERIFYING_CONTRACT,
} from '../test-utils/v2-evm-claim';

const logger = pino({ level: 'silent' });

/** The pinned golden v2 vector (mirrors eip712-v2-verifier.test.ts / the leaf). */
const GOLDEN = {
  channelId: '0x' + '00'.repeat(31) + '5b',
  cumulativeAmount: '24000000',
  nonce: 24,
  recipient: '0x' + '00'.repeat(16) + 'deadbeef',
  chainId: 8453,
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
};
const GOLDEN_SIGNATURE =
  '0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b' +
  '196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb1b';

function makeSDK(): PaymentChannelSDK {
  const keyManager = new KeyManager(
    { backend: 'env', nodeId: 'test-node', evmPrivateKey: ANVIL_0_PK },
    logger
  );
  // signBalanceProof / verifyBalanceProofV2 are pure (digest + key), so the
  // provider and registry are never touched here.
  const dummyProvider = {} as never;
  return new PaymentChannelSDK(dummyProvider, keyManager, 'evm-key', '0x00', logger);
}

function preparePacket(amount = 1000n): ILPPreparePacket {
  return {
    type: PacketType.PREPARE,
    amount,
    destination: 'g.alice.wallet',
    expiresAt: new Date(Date.now() + 10_000),
    data: Buffer.alloc(0),
  };
}

function claimProtocolData(claim: unknown): BTPProtocolData[] {
  return [
    {
      protocolName: BTP_CLAIM_PROTOCOL.NAME,
      contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
      data: Buffer.from(JSON.stringify(claim), 'utf8'),
    } as BTPProtocolData,
  ];
}

describe('RollingSwapChannel v2 — signer repoint (PaymentChannelSDK)', () => {
  it('signs the v2 digest and self-verifies via verifyBalanceProofV2 + the leaf', async () => {
    const sdk = makeSDK();
    const sig = await sdk.signBalanceProof(
      GOLDEN.channelId,
      GOLDEN.nonce,
      BigInt(GOLDEN.cumulativeAmount),
      GOLDEN.recipient,
      GOLDEN.chainId,
      GOLDEN.verifyingContract
    );

    expect(sdk.verifyBalanceProofV2(GOLDEN, sig, ANVIL_0_ADDR)).toBe(true);
    expect(verifyEVMClaimV2(GOLDEN, sig, ANVIL_0_ADDR).valid).toBe(true);
  });

  it('reproduces the pinned golden signature byte-for-byte (leaf/contract parity)', async () => {
    const sdk = makeSDK();
    const sig = await sdk.signBalanceProof(
      GOLDEN.channelId,
      GOLDEN.nonce,
      BigInt(GOLDEN.cumulativeAmount),
      GOLDEN.recipient,
      GOLDEN.chainId,
      GOLDEN.verifyingContract
    );
    expect(sig.toLowerCase()).toBe(GOLDEN_SIGNATURE.toLowerCase());
  });

  it('verifyBalanceProofV2 fails closed on a tampered amount', async () => {
    const sdk = makeSDK();
    const sig = await sdk.signBalanceProof(
      GOLDEN.channelId,
      GOLDEN.nonce,
      BigInt(GOLDEN.cumulativeAmount),
      GOLDEN.recipient,
      GOLDEN.chainId,
      GOLDEN.verifyingContract
    );
    expect(
      sdk.verifyBalanceProofV2({ ...GOLDEN, cumulativeAmount: '24000001' }, sig, ANVIL_0_ADDR)
    ).toBe(false);
  });

  it('verifyBalanceProofV2 fails closed on a different chainId (v2 domain binding)', async () => {
    const sdk = makeSDK();
    const sig = await sdk.signBalanceProof(
      GOLDEN.channelId,
      GOLDEN.nonce,
      BigInt(GOLDEN.cumulativeAmount),
      GOLDEN.recipient,
      GOLDEN.chainId,
      GOLDEN.verifyingContract
    );
    expect(sdk.verifyBalanceProofV2({ ...GOLDEN, chainId: 1 }, sig, ANVIL_0_ADDR)).toBe(false);
  });
});

describe('RollingSwapChannel v2 — outbound→inbound round-trip (InboundClaimValidator)', () => {
  // The validator only needs a truthy SDK reference as its "EVM configured" gate;
  // the v2 verify itself is delegated to the dependency-light leaf.
  const validator = new InboundClaimValidator({} as never, 'node-b', logger);

  it('ACCEPTS a genuinely v2-signed claim on the hot path', async () => {
    const claim = await makeV2EvmClaim({
      channelId: '0x' + 'ab'.repeat(32),
      cumulativeAmount: '5000',
      nonce: 7,
    });
    // Sanity: the leaf agrees the claim is well-signed.
    expect(
      verifyEVMClaimV2(
        {
          channelId: claim.channelId,
          cumulativeAmount: claim.cumulativeAmount,
          nonce: claim.nonce,
          recipient: claim.recipient,
          chainId: claim.chainId,
          verifyingContract: claim.verifyingContract,
        },
        claim.signature,
        claim.signerAddress
      ).valid
    ).toBe(true);

    const reject = await validator.validate(claimProtocolData(claim), preparePacket(), 'peer-a');
    expect(reject).toBeNull();
  });
});

describe('RollingSwapChannel v2 — fail-closed cutover (v1 REJECTED)', () => {
  const validator = new InboundClaimValidator({} as never, 'node-b', logger);

  it('rejects a v1-shaped ("1.0" Raiden fields) claim STRUCTURALLY', async () => {
    const v1Claim = {
      version: '1.0',
      blockchain: 'evm',
      messageId: 'legacy-v1',
      timestamp: '2026-07-16T12:00:00.000Z',
      senderId: 'peer-a',
      channelId: '0x' + 'cd'.repeat(32),
      nonce: 3,
      transferredAmount: '1000',
      lockedAmount: '0',
      locksRoot: '0x' + '00'.repeat(32),
      signature: '0x' + '11'.repeat(65),
      signerAddress: ANVIL_0_ADDR,
      chainId: V2_CHAIN_ID,
      tokenNetworkAddress: V2_VERIFYING_CONTRACT,
    };
    const reject = await validator.validate(claimProtocolData(v1Claim), preparePacket(), 'peer-a');
    expect(reject).not.toBeNull();
    // Structural rejection happens before any crypto: F06 with a claim-structure msg.
    expect(reject?.message).toMatch(/Invalid claim structure/i);
  });

  it('rejects a v2-shaped claim whose signature is over the WRONG digest CRYPTOGRAPHICALLY', async () => {
    // Well-formed v2 claim, but the signature was produced over DIFFERENT fields
    // (a stand-in for a v1/legacy signature): it cannot recover to signerAddress
    // under the v2 domain — no dual-scheme fallback.
    const channelId = '0x' + 'ef'.repeat(32);
    const recipient = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
    const { signature } = await signV2EvmClaim({
      channelId,
      cumulativeAmount: '999999', // signed over a mismatched amount
      nonce: 2,
      recipient,
    });
    const forged = {
      version: '2.0',
      blockchain: 'evm',
      messageId: 'forged-v2',
      timestamp: '2026-07-16T12:00:00.000Z',
      senderId: 'peer-a',
      channelId,
      nonce: 2,
      cumulativeAmount: '1000', // claim says 1000; signature was over 999999
      recipient,
      signature,
      signerAddress: ANVIL_0_ADDR,
      chainId: V2_CHAIN_ID,
      verifyingContract: V2_VERIFYING_CONTRACT,
    };
    const reject = await validator.validate(claimProtocolData(forged), preparePacket(), 'peer-a');
    expect(reject).not.toBeNull();
    expect(reject?.message).toMatch(/Invalid EIP-712 signature/i);
  });
});

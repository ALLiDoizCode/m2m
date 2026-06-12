/**
 * Mina Inbound Claim Gate — zk-SNARK verification (Issue #137)
 *
 * Drives the REAL `InboundClaimValidator` end-to-end against a live Mina
 * lightnet: a real channel is opened, a real zk-SNARK balance proof is signed,
 * and the signed claim is run through the inbound gate. Asserts that:
 *   - a valid Mina claim is ACCEPTED at the gate (validate() -> null), and
 *   - a claim whose proof has been tampered with is REJECTED with F06.
 *
 * Mock-free: a real `MinaPaymentChannelSDK` + `MinaPaymentChannelProvider`
 * perform real o1js circuit compilation and zk-SNARK proof verification against
 * on-chain state. No chain behaviour is simulated.
 *
 * Test gating: only runs when MINA_INTEGRATION=true (requires `make mina-up`).
 * When unavailable the suite is skipped — it is NOT silently passed.
 *
 * To run locally:
 *   make mina-up
 *   MINA_INTEGRATION=true npx jest test/integration/mina-inbound-claim-gate.test.ts --verbose
 *   make mina-down
 *
 * @packageDocumentation
 */

import pino from 'pino';
import {
  waitForMinaReady,
  acquireFundedAccount,
  releaseFundedAccount,
  MINA_GRAPHQL_URL,
} from './mina-helpers';
import type { MinaFundedAccount } from './mina-helpers';
import { MinaPaymentChannelSDK } from '../../src/settlement/mina-payment-channel-sdk';
import { MinaPaymentChannelProvider } from '../../src/settlement/provider/mina-payment-channel-provider';
import { ChainProviderRegistry } from '../../src/settlement/provider/chain-provider-registry';
import { InboundClaimValidator } from '../../src/btp/inbound-claim-validator';
import type { Logger } from '../../src/utils/logger';
import type { MinaClaimMessage } from '../../src/btp/btp-claim-types';
import { BTP_CLAIM_PROTOCOL } from '../../src/btp/btp-claim-types';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPPreparePacket } from '@toon-protocol/shared';
import type { BTPProtocolData } from '../../src/btp/btp-types';

const RUN_MINA_TESTS = process.env.MINA_INTEGRATION === 'true';
const describeMina = RUN_MINA_TESTS ? describe : describe.skip;

// Real circuit compilation + proof verification is slow.
jest.setTimeout(600_000);

const logger = (): Logger => pino({ level: 'silent' }) as unknown as Logger;

const prepare = (amount: bigint = 1000n): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount,
  destination: 'g.alice.wallet',
  expiresAt: new Date(Date.now() + 10_000),
  data: Buffer.alloc(0),
});

const protocolData = (claim: MinaClaimMessage): BTPProtocolData[] => [
  {
    protocolName: BTP_CLAIM_PROTOCOL.NAME,
    contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
    data: Buffer.from(JSON.stringify(claim), 'utf8'),
  },
];

describeMina('Mina inbound claim gate (Issue #137)', () => {
  const acquired: MinaFundedAccount[] = [];

  beforeAll(async () => {
    await waitForMinaReady();
  });

  afterAll(async () => {
    for (const a of acquired) {
      await releaseFundedAccount(a.publicKey);
    }
  });

  it('accepts a valid Mina claim and rejects a tampered one', async () => {
    // Acquire two funded lightnet accounts: participant A (signer) and B (peer).
    const alice = await acquireFundedAccount();
    acquired.push(alice);
    const bob = await acquireFundedAccount();
    acquired.push(bob);

    // Real SDK + provider for participant A. The SDK signs with alice's private
    // key; openChannel takes participant public keys (addresses).
    const sdk = new MinaPaymentChannelSDK(MINA_GRAPHQL_URL, '', logger(), alice.privateKey);
    await sdk.compileContract();

    // Open a real channel A<->B and deposit so there is on-chain state to verify
    // claims against. openChannel returns the zkApp address used as channelId.
    const { zkAppAddress: channelId } = await sdk.openChannel(alice.publicKey, bob.publicKey, 300);
    await sdk.deposit(channelId, 1_000_000_000n);

    const provider = new MinaPaymentChannelProvider(
      sdk,
      'mina:devnet',
      channelId,
      alice.privateKey,
      logger(),
      { tokenId: 'MINA', network: 'devnet' }
    );

    const registry = new ChainProviderRegistry();
    registry.register(provider);

    const validator = new InboundClaimValidator(
      undefined,
      'test-node',
      logger(),
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );

    // Sign a real advancing balance proof (nonce 1) via the provider.
    const transferredAmount = '1000';
    const proof = await provider.signBalanceProof({
      channelId,
      nonce: 1,
      transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
      salt: '12345',
    });

    const signerPublicKey = await sdk.getSignerPublicKey();

    const validClaim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'mina-gate-1',
      timestamp: '2026-06-12T12:00:00.000Z',
      senderId: 'peer-a',
      zkAppAddress: channelId,
      tokenId: 'MINA',
      balanceCommitment: transferredAmount,
      nonce: 1,
      proof,
      salt: '12345',
      signerPublicKey,
      network: 'devnet',
    };

    // Valid claim is accepted at the gate.
    const okResult = await validator.validate(protocolData(validClaim), prepare(), 'peer-a');
    expect(okResult).toBeNull();

    // Tampering the serialized proof must flip verification to false → F06.
    const tampered = Buffer.from(
      JSON.stringify({ proof: 'tampered-not-a-real-zk-proof' })
    ).toString('base64');
    const badClaim: MinaClaimMessage = { ...validClaim, messageId: 'mina-gate-2', proof: tampered };

    const rejectResult = await validator.validate(protocolData(badClaim), prepare(), 'peer-a');
    expect(rejectResult).toMatchObject({
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
    });
  });
});

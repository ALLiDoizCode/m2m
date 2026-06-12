/**
 * Inbound Claim Validator — non-EVM (Solana / Mina) verification (Issue #137)
 *
 * Verifies that the inbound BTP claim gate cryptographically validates Solana
 * (Ed25519) and Mina (zk-SNARK) claims before admitting the PREPARE, instead of
 * F06-rejecting every non-EVM `blockchain` value.
 *
 * Mock-free at the crypto layer: a REAL `SolanaPaymentChannelProvider` performs
 * real Ed25519 sign/verify (the provider's `verifyBalanceProof` is pure crypto
 * and never touches RPC), wired through a REAL `ChainProviderRegistry` and the
 * REAL `InboundClaimValidator`. The Solana SDK methods the provider exposes for
 * on-chain operations are never invoked on the verification hot path, so a
 * no-op SDK stand-in is supplied purely to satisfy the constructor — no chain
 * behaviour is mocked.
 *
 * The "valid Mina claim accepted" and tampered-proof rejection assertions drive
 * a REAL `MinaPaymentChannelProvider` (real o1js zk-SNARK crypto) and live in
 * the gated integration test (test/integration/mina-inbound-claim-gate.test.ts),
 * because the Mina provider's `verifyBalanceProof` reads on-chain state and the
 * provider compiles the real zkApp circuit on construction. The co-located
 * suite below covers the chain-dispatch and "no provider registered" branches
 * for Mina without that heavyweight setup.
 */

import * as crypto from 'crypto';
import pino from 'pino';
import { generateKeyPairSigner } from '@solana/kit';
import { InboundClaimValidator } from './inbound-claim-validator';
import type { SolanaClaimMessage, MinaClaimMessage } from './btp-claim-types';
import { BTP_CLAIM_PROTOCOL } from './btp-claim-types';
import { SolanaPaymentChannelSDK } from '../settlement/solana-payment-channel-sdk';
import { SolanaPaymentChannelProvider } from '../settlement/provider/solana-payment-channel-provider';
import { ChainProviderRegistry } from '../settlement/provider/chain-provider-registry';
import type { Logger } from '../utils/logger';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPPreparePacket } from '@toon-protocol/shared';
import type { BTPProtocolData } from './btp-types';

jest.setTimeout(60_000);

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const MINA_ZKAPP_ADDRESS = 'B62qre3erTHfzQckNuibViWQGyyKwZseztqrjPZBv6SQF384Rg6ESAy';
const MINA_TOKEN_ID = 'wSHV2S4qX9jFsLjQo8r1BsMLH2ZRKsZx6EJd1sbozGPieEC4Jf';

const createLogger = (): Logger => pino({ level: 'silent' }) as unknown as Logger;

/**
 * No-op SDK stand-in for the provider constructor. The verification hot path
 * (`SolanaPaymentChannelProvider.verifyBalanceProof`) is pure Ed25519 crypto
 * and never calls into these methods, so no chain behaviour is simulated.
 */
function noopSolanaSdk(): SolanaPaymentChannelSDK {
  return {} as unknown as SolanaPaymentChannelSDK;
}

const createPreparePacket = (amount: bigint = 1000n): ILPPreparePacket => ({
  type: PacketType.PREPARE,
  amount,
  destination: 'g.alice.wallet',
  expiresAt: new Date(Date.now() + 10_000),
  data: Buffer.alloc(0),
});

const claimProtocolData = (claim: SolanaClaimMessage | MinaClaimMessage): BTPProtocolData[] => [
  {
    protocolName: BTP_CLAIM_PROTOCOL.NAME,
    contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
    data: Buffer.from(JSON.stringify(claim), 'utf8'),
  },
];

describe('InboundClaimValidator — Solana Ed25519 claims (Issue #137)', () => {
  it('accepts a PREPARE carrying a valid Ed25519 Solana claim', async () => {
    const signer = await generateKeyPairSigner();
    const peer = await generateKeyPairSigner();
    const tokenMint = await generateKeyPairSigner();
    const tokenMintAddress = tokenMint.address as string;

    const { pda: channelPDA } = SolanaPaymentChannelSDK.deriveChannelPDA(
      signer.address as string,
      peer.address as string,
      tokenMintAddress,
      SYSTEM_PROGRAM_ID
    );

    const provider = new SolanaPaymentChannelProvider(
      noopSolanaSdk(),
      'solana:devnet',
      tokenMintAddress,
      signer,
      SYSTEM_PROGRAM_ID,
      createLogger()
    );

    // Real Ed25519 signature over the canonical 48-byte balance-proof message.
    const transferredAmount = '5000';
    const signature = await provider.signBalanceProof({
      channelId: channelPDA,
      nonce: 1,
      transferredAmount,
      lockedAmount: '0',
      locksRoot: '0x' + '0'.repeat(64),
    });

    const registry = new ChainProviderRegistry();
    registry.register(provider);

    const validator = new InboundClaimValidator(
      undefined, // no EVM SDK — exercising the non-EVM path
      'test-node',
      createLogger(),
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );

    const claim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'sol-msg-1',
      timestamp: '2026-06-12T12:00:00.000Z',
      senderId: 'peer-a',
      programId: SYSTEM_PROGRAM_ID,
      channelAccount: channelPDA,
      nonce: 1,
      transferredAmount,
      signature,
      signerPublicKey: signer.address as string,
      cluster: 'devnet',
    };

    const result = await validator.validate(
      claimProtocolData(claim),
      createPreparePacket(),
      'peer-a'
    );

    expect(result).toBeNull();
  });

  it('rejects a PREPARE whose Solana claim carries an invalid Ed25519 signature', async () => {
    const signer = await generateKeyPairSigner();
    const peer = await generateKeyPairSigner();
    const tokenMint = await generateKeyPairSigner();
    const tokenMintAddress = tokenMint.address as string;

    const { pda: channelPDA } = SolanaPaymentChannelSDK.deriveChannelPDA(
      signer.address as string,
      peer.address as string,
      tokenMintAddress,
      SYSTEM_PROGRAM_ID
    );

    const provider = new SolanaPaymentChannelProvider(
      noopSolanaSdk(),
      'solana:devnet',
      tokenMintAddress,
      signer,
      SYSTEM_PROGRAM_ID,
      createLogger()
    );

    const registry = new ChainProviderRegistry();
    registry.register(provider);

    const validator = new InboundClaimValidator(
      undefined,
      'test-node',
      createLogger(),
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );

    // 64 random bytes — not a valid signature over the balance-proof message.
    const forgedSignature = Buffer.from(crypto.randomBytes(64)).toString('base64');

    const claim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'sol-msg-2',
      timestamp: '2026-06-12T12:00:00.000Z',
      senderId: 'peer-a',
      programId: SYSTEM_PROGRAM_ID,
      channelAccount: channelPDA,
      nonce: 1,
      transferredAmount: '5000',
      signature: forgedSignature,
      signerPublicKey: signer.address as string,
      cluster: 'devnet',
    };

    const result = await validator.validate(
      claimProtocolData(claim),
      createPreparePacket(),
      'peer-a'
    );

    expect(result).toMatchObject({
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      message: 'Invalid Ed25519 signature on claim',
    });
  });

  it('rejects a Solana claim when no provider is registered for its chain', async () => {
    const signer = await generateKeyPairSigner();
    const registry = new ChainProviderRegistry(); // empty

    const validator = new InboundClaimValidator(
      undefined,
      'test-node',
      createLogger(),
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );

    const claim: SolanaClaimMessage = {
      version: '1.0',
      blockchain: 'solana',
      messageId: 'sol-msg-3',
      timestamp: '2026-06-12T12:00:00.000Z',
      senderId: 'peer-a',
      programId: SYSTEM_PROGRAM_ID,
      channelAccount: SYSTEM_PROGRAM_ID,
      nonce: 1,
      transferredAmount: '5000',
      signature: Buffer.from(crypto.randomBytes(64)).toString('base64'),
      signerPublicKey: signer.address as string,
      cluster: 'devnet',
    };

    const result = await validator.validate(
      claimProtocolData(claim),
      createPreparePacket(),
      'peer-a'
    );

    expect(result).toMatchObject({
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      message: 'No settlement provider registered for blockchain: solana',
    });
  });
});

describe('InboundClaimValidator — Mina zk-SNARK claims (Issue #137)', () => {
  it('rejects a Mina claim when no provider is registered for its chain', async () => {
    const registry = new ChainProviderRegistry(); // empty

    const validator = new InboundClaimValidator(
      undefined,
      'test-node',
      createLogger(),
      undefined,
      undefined,
      undefined,
      undefined,
      registry
    );

    const claim: MinaClaimMessage = {
      version: '1.0',
      blockchain: 'mina',
      messageId: 'mina-msg-2',
      timestamp: '2026-06-12T12:00:00.000Z',
      senderId: 'peer-a',
      zkAppAddress: MINA_ZKAPP_ADDRESS,
      tokenId: MINA_TOKEN_ID,
      balanceCommitment: '12345678901234567890123456789012345678901234567890',
      nonce: 1,
      proof: Buffer.from(JSON.stringify({ proof: 'x' })).toString('base64'),
      salt: 'abcdef1234567890',
      network: 'devnet',
    };

    const result = await validator.validate(
      claimProtocolData(claim),
      createPreparePacket(),
      'peer-a'
    );

    expect(result).toMatchObject({
      type: PacketType.REJECT,
      code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
      message: 'No settlement provider registered for blockchain: mina',
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for InboundClaimValidator
 * Targets all branches in validate() and verifyEVMClaim()
 *
 * Branches covered:
 * 1. validate() returns null for zero-amount packets
 * 2. Missing claim data → reject
 * 3. Wrapped claim (NIP-59) when wrapper IS configured → unwrap and validate
 * 4. Wrapped claim when wrapper NOT configured → reject
 * 5. Plaintext claim → JSON.parse and validate
 * 6. Invalid claim structure (catch block) → reject with error message
 * 7. EVM claim → verifyEVMClaim()
 * 8. Non-EVM claim → reject with unsupported chain
 * 9. verifyEVMClaim(): BigInt conversion catch block
 * 10. verifyEVMClaim(): signature verification success and failure
 * 11. verifyEVMClaim(): channelManager not configured vs configured
 * 12. verifyEVMClaim(): channel lookup failure vs success
 */

import { InboundClaimValidator } from './inbound-claim-validator';
import type { Logger } from '../utils/logger';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
import type { ChannelManager } from '../settlement/channel-manager';
import type { NIP59ClaimWrapper } from '../settlement/privacy/nip59-claim-wrapper';
import {
  BTP_WRAPPED_CLAIM_PROTOCOL,
  deserializeWrappedClaim,
} from '../settlement/privacy/nip59-claim-wrapper';
import {
  BTP_CLAIM_PROTOCOL,
  validateClaimMessage,
  isEVMClaim,
  isSolanaClaim,
  isMinaClaim,
} from './btp-claim-types';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPPreparePacket } from '@toon-protocol/shared';

// ---------------------------------------------------------------------------
// Module-level mocks for imports used directly inside validate()
// ---------------------------------------------------------------------------

jest.mock('./btp-claim-types', () => ({
  BTP_CLAIM_PROTOCOL: {
    NAME: 'payment-channel-claim',
    CONTENT_TYPE: 1,
    VERSION: '1.0',
  },
  validateClaimMessage: jest.fn(),
  isEVMClaim: jest.fn(),
  isSolanaClaim: jest.fn(),
  isMinaClaim: jest.fn(),
}));

jest.mock('../settlement/privacy/nip59-claim-wrapper', () => ({
  BTP_WRAPPED_CLAIM_PROTOCOL: {
    NAME: 'claim-wrapped',
    CONTENT_TYPE: 0,
    VERSION: '1.0',
  },
  deserializeWrappedClaim: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockLogger = (): jest.Mocked<Logger> =>
  ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    silent: jest.fn(),
    level: 'info',
    child: jest.fn(function (this: unknown) {
      return this;
    }),
  }) as unknown as jest.Mocked<Logger>;

const createMockPaymentChannelSDK = (): jest.Mocked<PaymentChannelSDK> =>
  ({
    verifyBalanceProof: jest.fn(),
    verifyBalanceProofWithDomain: jest.fn(),
  }) as unknown as jest.Mocked<PaymentChannelSDK>;

const createMockChannelManager = (): jest.Mocked<ChannelManager> =>
  ({
    getChannelById: jest.fn(),
  }) as unknown as jest.Mocked<ChannelManager>;

const createPreparePacket = (amount: bigint = 1000n): ILPPreparePacket => {
  const futureExpiry = new Date(Date.now() + 10000);
  return {
    type: PacketType.PREPARE,
    amount,
    destination: 'g.alice.wallet',
    expiresAt: futureExpiry,
    data: Buffer.alloc(0),
  };
};

interface ValidatorFixture {
  validator: InboundClaimValidator;
  mockLogger: jest.Mocked<Logger>;
  mockPaymentChannelSDK: jest.Mocked<PaymentChannelSDK>;
  mockChannelManager?: jest.Mocked<ChannelManager>;
}

const createValidator = (
  options: {
    channelManager?: jest.Mocked<ChannelManager>;
    nip59Wrapper?: NIP59ClaimWrapper;
    nip59PrivateKey?: Uint8Array;
    getPeerRelation?: (peerId: string) => 'parent' | 'peer' | 'child' | undefined;
  } = {}
): ValidatorFixture => {
  const mockLogger = createMockLogger();
  const mockPaymentChannelSDK = createMockPaymentChannelSDK();

  const validator = new InboundClaimValidator(
    mockPaymentChannelSDK,
    'test-node',
    mockLogger,
    options.channelManager,
    options.nip59Wrapper,
    options.nip59PrivateKey,
    options.getPeerRelation
  );

  return {
    validator,
    mockLogger,
    mockPaymentChannelSDK,
    mockChannelManager: options.channelManager,
  };
};

const createEVMClaimJSON = (overrides?: Record<string, unknown>): string => {
  const claim = {
    version: '1.0',
    blockchain: 'evm',
    messageId: 'msg-1',
    timestamp: new Date().toISOString(),
    senderId: 'peer-a',
    channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
    nonce: 1,
    transferredAmount: '100',
    lockedAmount: '0',
    locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
    signature: '0xabc',
    signerAddress: '0xdef',
    ...overrides,
  };
  return JSON.stringify(claim);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InboundClaimValidator branch coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Branch 1: zero-amount packets skip validation
  // -------------------------------------------------------------------------
  describe('Branch 1: zero-amount packets', () => {
    it('should return null for zero-amount packets', async () => {
      const { validator, mockLogger } = createValidator();
      const packet = createPreparePacket(0n);

      const result = await validator.validate([], packet, 'peer-a');

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_skip_zero', peerId: 'peer-a' }),
        'Skipping claim validation for zero-amount packet'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Issue #78: relation-aware skip for parent-forwarded packets
  // -------------------------------------------------------------------------
  describe('Issue #78: relation-aware parent skip', () => {
    it('should accept a value-bearing PREPARE from a parent peer WITHOUT an inline claim', async () => {
      const { validator, mockLogger } = createValidator({
        getPeerRelation: () => 'parent',
      });
      const packet = createPreparePacket(1_000_000n);

      // No claim protocol data — a parent forwards value to children claim-less.
      const result = await validator.validate([], packet, 'g.connector');

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_skip_parent', peerId: 'g.connector' }),
        'Skipping inbound claim requirement for packet forwarded by parent peer'
      );
    });

    it.each(['peer', 'child', undefined] as const)(
      'should still REQUIRE a claim for a %s source peer (F06 when missing)',
      async (relation) => {
        const { validator } = createValidator({
          getPeerRelation: () => relation,
        });
        const packet = createPreparePacket(1_000_000n);

        const result = await validator.validate([], packet, 'peer-a');

        expect(result).toEqual(
          expect.objectContaining({
            type: PacketType.REJECT,
            code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
            message: 'No payment channel claim attached to packet',
          })
        );
      }
    );

    it('should REQUIRE a claim when no relation resolver is configured (legacy behavior)', async () => {
      const { validator } = createValidator();
      const packet = createPreparePacket(1_000_000n);

      const result = await validator.validate([], packet, 'peer-a');

      expect(result).toEqual(
        expect.objectContaining({ code: ILPErrorCode.F06_UNEXPECTED_PAYMENT })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 2: missing claim data
  // -------------------------------------------------------------------------
  describe('Branch 2: missing claim data', () => {
    it('should reject when no claim protocol data is present', async () => {
      const { validator, mockLogger } = createValidator();
      const packet = createPreparePacket(1000n);

      const result = await validator.validate([], packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'No payment channel claim attached to packet',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_missing', peerId: 'peer-a' }),
        'Rejecting ILP PREPARE: no payment channel claim attached'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 3 & 4: wrapped claims (NIP-59)
  // -------------------------------------------------------------------------
  describe('Branch 3 & 4: wrapped claims', () => {
    it('should reject wrapped claim when NIP-59 wrapper is NOT configured', async () => {
      const { validator } = createValidator();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
          contentType: 0,
          data: Buffer.from('{}'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Received NIP-59 wrapped claim but unwrapping not configured',
        data: Buffer.alloc(0),
      });
    });

    it('should unwrap and validate wrapped claim when wrapper IS configured', async () => {
      const unwrappedClaim = {
        version: '1.0',
        blockchain: 'evm',
        messageId: 'msg-1',
        timestamp: new Date().toISOString(),
        senderId: 'peer-a',
        channelId: '0x1234',
        nonce: 1,
        transferredAmount: '100',
        lockedAmount: '0',
        locksRoot: '0x0000',
        signature: '0xabc',
        signerAddress: '0xdef',
        chainId: 1,
        tokenNetworkAddress: '0xtoken',
      };

      const mockNip59Wrapper = {
        unwrapClaim: jest.fn().mockReturnValue(unwrappedClaim),
      } as unknown as NIP59ClaimWrapper;

      (deserializeWrappedClaim as jest.Mock).mockReturnValue({
        ephemeralPublicKey: '0xpub',
        encryptedPayload: 'enc',
        timestamp: 1,
        version: '1.0',
      });
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK } = createValidator({
        nip59Wrapper: mockNip59Wrapper,
        nip59PrivateKey: new Uint8Array(32),
      });
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockResolvedValue(true);

      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
          contentType: 0,
          data: Buffer.from('{}'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toBeNull();
      expect(deserializeWrappedClaim).toHaveBeenCalledWith(Buffer.from('{}'));
      expect(mockNip59Wrapper.unwrapClaim).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.0' }),
        new Uint8Array(32)
      );
      expect(mockPaymentChannelSDK.verifyBalanceProofWithDomain).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: '0x1234', transferredAmount: 100n, lockedAmount: 0n }),
        '0xabc',
        '0xdef',
        1,
        '0xtoken'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 5: plaintext claim
  // -------------------------------------------------------------------------
  describe('Branch 5: plaintext claim', () => {
    it('should parse and validate a plaintext JSON claim', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockResolvedValue(true);

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toBeNull();
      expect(validateClaimMessage).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Branch 6: invalid claim structure (catch block)
  // -------------------------------------------------------------------------
  describe('Branch 6: invalid claim structure', () => {
    it('should reject when JSON.parse fails on plaintext claim data', async () => {
      const { validator } = createValidator();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from('not-json-at-all', 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: expect.stringContaining('Invalid claim structure'),
        data: Buffer.alloc(0),
      });
    });

    it('should reject when validateClaimMessage throws', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {
        throw new Error('validation failed');
      });

      const { validator, mockLogger } = createValidator();
      const claimJson = createEVMClaimJSON();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Invalid claim structure: validation failed',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_invalid_structure' }),
        'Rejecting ILP PREPARE: invalid claim structure'
      );
    });

    it('should reject when validateClaimMessage throws a non-Error value', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {
        throw 'string-error-value';
      });

      const { validator } = createValidator();
      const claimJson = createEVMClaimJSON();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Invalid claim structure: string-error-value',
        data: Buffer.alloc(0),
      });
    });

    it('should reject when deserializeWrappedClaim throws', async () => {
      (deserializeWrappedClaim as jest.Mock).mockImplementation(() => {
        throw new Error('bad wrapped claim');
      });

      const mockNip59Wrapper = {
        unwrapClaim: jest.fn(),
      } as unknown as NIP59ClaimWrapper;

      const { validator } = createValidator({
        nip59Wrapper: mockNip59Wrapper,
        nip59PrivateKey: new Uint8Array(32),
      });

      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
          contentType: 0,
          data: Buffer.from('{}'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: expect.stringContaining('Invalid claim structure: bad wrapped claim'),
        data: Buffer.alloc(0),
      });
    });

    it('should reject when unwrapClaim throws', async () => {
      (deserializeWrappedClaim as jest.Mock).mockReturnValue({
        ephemeralPublicKey: '0xpub',
        encryptedPayload: 'enc',
        timestamp: 1,
        version: '1.0',
      });

      const mockNip59Wrapper = {
        unwrapClaim: jest.fn().mockImplementation(() => {
          throw new Error('unwrap failed');
        }),
      } as unknown as NIP59ClaimWrapper;

      const { validator } = createValidator({
        nip59Wrapper: mockNip59Wrapper,
        nip59PrivateKey: new Uint8Array(32),
      });

      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_WRAPPED_CLAIM_PROTOCOL.NAME,
          contentType: 0,
          data: Buffer.from('{}'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: expect.stringContaining('Invalid claim structure: unwrap failed'),
        data: Buffer.alloc(0),
      });
    });
  });

  // -------------------------------------------------------------------------
  // Branch 7 & 8: EVM vs non-EVM claim dispatch
  // -------------------------------------------------------------------------
  describe('Branch 7 & 8: EVM vs non-EVM dispatch', () => {
    it('should dispatch to verifyEVMClaim for EVM claims', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockResolvedValue(true);

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');
      expect(result).toBeNull();
      expect(isEVMClaim).toHaveBeenCalled();
    });

    it('should reject non-EVM claims when no settlement provider is registered', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(false);
      (isSolanaClaim as unknown as jest.Mock).mockReturnValue(true);
      (isMinaClaim as unknown as jest.Mock).mockReturnValue(false);

      const { validator, mockLogger } = createValidator();
      const solanaClaim = {
        version: '1.0',
        blockchain: 'solana',
        messageId: 'msg-1',
        timestamp: new Date().toISOString(),
        senderId: 'peer-a',
        programId: '11111111111111111111111111111111',
        channelAccount: '11111111111111111111111111111111',
        nonce: 1,
        transferredAmount: '100',
        signature: 'sig',
        signerPublicKey: '11111111111111111111111111111111',
      };
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(solanaClaim), 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'No settlement provider registered for blockchain: solana',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_unsupported_chain', blockchain: 'solana' }),
        'Rejecting ILP PREPARE: no settlement provider registered for this blockchain'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 9: verifyEVMClaim — BigInt conversion catch block
  // -------------------------------------------------------------------------
  describe('Branch 9: BigInt conversion catch block', () => {
    it('should reject when transferredAmount cannot be converted to BigInt', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator();
      const claimJson = createEVMClaimJSON({
        transferredAmount: 'not-a-number',
        chainId: 1,
        tokenNetworkAddress: '0xtoken',
      });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Invalid claim amounts',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_invalid_amount' }),
        'Rejecting ILP PREPARE: invalid transferredAmount or lockedAmount for BigInt conversion'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 10: verifyEVMClaim — signature verification success / failure
  // -------------------------------------------------------------------------
  describe('Branch 10: signature verification success and failure', () => {
    it('should accept when self-describing signature verification succeeds', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockResolvedValue(true);

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toBeNull();
      expect(mockPaymentChannelSDK.verifyBalanceProofWithDomain).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          transferredAmount: 100n,
          lockedAmount: 0n,
        }),
        '0xabc',
        '0xdef',
        1,
        '0xtoken'
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_validated' }),
        'Inbound claim validated successfully'
      );
    });

    it('should reject when self-describing signature verification returns false', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockResolvedValue(false);

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Invalid EIP-712 signature on claim',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_invalid_signature' }),
        'Rejecting ILP PREPARE: invalid EIP-712 signature'
      );
    });

    it('should reject when self-describing signature verification throws', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockRejectedValue(
        new Error('network error')
      );

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Signature verification failed',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_signature_error' }),
        'Rejecting ILP PREPARE: signature verification error'
      );
    });

    it('should reject when self-describing signature verification throws a non-Error value', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator();
      mockPaymentChannelSDK.verifyBalanceProofWithDomain.mockRejectedValue('network-down');

      const claimJson = createEVMClaimJSON({ chainId: 1, tokenNetworkAddress: '0xtoken' });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Signature verification failed',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_signature_error', error: 'network-down' }),
        'Rejecting ILP PREPARE: signature verification error'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 11 & 12: channelManager not configured vs configured / lookup failure vs success
  // -------------------------------------------------------------------------
  describe('Branch 11 & 12: channelManager configuration and lookup', () => {
    it('should reject when channelManager is NOT configured and no self-describing fields', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator(); // no channelManager
      const claimJson = createEVMClaimJSON(); // no chainId, no tokenNetworkAddress
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Unknown channel: claim must include chainId and tokenNetworkAddress',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_unknown_channel' }),
        'Rejecting ILP PREPARE: unknown channel and no self-describing fields'
      );
    });

    it('should reject when channelManager IS configured but channel lookup fails', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue(null);

      const { validator, mockLogger } = createValidator({ channelManager: mockChannelManager });
      const claimJson = createEVMClaimJSON(); // no chainId, no tokenNetworkAddress
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Unknown channel: claim must include chainId and tokenNetworkAddress',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_unknown_channel' }),
        'Rejecting ILP PREPARE: unknown channel and no self-describing fields'
      );
    });

    it('should accept when channelManager finds channel and verifyBalanceProof succeeds', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
        peerId: 'peer-a',
        tokenId: 'USDC',
        tokenAddress: '0xusdc',
        chain: 'evm:base:8453',
        createdAt: new Date(),
        lastActivityAt: new Date(),
        status: 'opened',
      } as any);

      const { validator, mockPaymentChannelSDK } = createValidator({
        channelManager: mockChannelManager,
      });
      mockPaymentChannelSDK.verifyBalanceProof.mockResolvedValue(true);

      const claimJson = createEVMClaimJSON(); // no self-describing fields
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toBeNull();
      expect(mockChannelManager.getChannelById).toHaveBeenCalledWith(
        '0x1234567890123456789012345678901234567890123456789012345678901234'
      );
      expect(mockPaymentChannelSDK.verifyBalanceProof).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
          transferredAmount: 100n,
          lockedAmount: 0n,
        }),
        '0xabc',
        '0xdef'
      );
    });

    it('should reject when channelManager finds channel but verifyBalanceProof returns false', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1234',
        peerId: 'peer-a',
        status: 'opened',
      } as any);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator({
        channelManager: mockChannelManager,
      });
      mockPaymentChannelSDK.verifyBalanceProof.mockResolvedValue(false);

      const claimJson = createEVMClaimJSON();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Invalid EIP-712 signature on claim',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_invalid_signature' }),
        'Rejecting ILP PREPARE: invalid EIP-712 signature'
      );
    });

    it('should reject when channelManager finds channel but verifyBalanceProof throws', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const mockChannelManager = createMockChannelManager();
      mockChannelManager.getChannelById.mockReturnValue({
        channelId: '0x1234',
        peerId: 'peer-a',
        status: 'opened',
      } as any);

      const { validator, mockPaymentChannelSDK, mockLogger } = createValidator({
        channelManager: mockChannelManager,
      });
      mockPaymentChannelSDK.verifyBalanceProof.mockRejectedValue(new Error('verify crash'));

      const claimJson = createEVMClaimJSON();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(claimJson, 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'Signature verification failed',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_signature_error' }),
        'Rejecting ILP PREPARE: signature verification error'
      );
    });
  });
});

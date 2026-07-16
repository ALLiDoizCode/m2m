/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

/**
 * Branch coverage tests for InboundClaimValidator
 * Targets all branches in validate() and verifyEVMClaim()
 *
 * connector#329 Phase 4b: verifyEVMClaim no longer calls the PaymentChannelSDK.
 * It rebuilds the v2 RollingSwapChannel EIP-712 digest and recovers the signer
 * via the pure `verifyEVMClaimV2` leaf. So the EVM accept/reject branches are
 * driven with REAL v2-signed claims (via the shared `makeV2EvmClaim` helper)
 * rather than by mocking an SDK verify method. The SDK argument survives only as
 * the "EVM is configured" truthiness gate.
 *
 * Branches covered:
 * 1. validate() returns null for zero-amount packets
 * 2. Relation-aware parent skip (issue #78)
 * 3. Missing claim data → reject
 * 4. Wrapped claim (NIP-59) when wrapper IS configured → unwrap and validate
 * 5. Wrapped claim when wrapper NOT configured → reject
 * 6. Plaintext claim → JSON.parse and validate
 * 7. Invalid claim structure (catch block) → reject with error message
 * 8. EVM claim → verifyEVMClaim()
 * 9. Non-EVM claim → reject with unsupported chain
 * 10. verifyEVMClaim(): EVM SDK not configured → reject
 * 11. verifyEVMClaim(): real v2 signature verification success and failure
 * 12. verifyEVMClaim(): verify leaf throws → reject
 */

import { InboundClaimValidator } from './inbound-claim-validator';
import type { Logger } from '../utils/logger';
import type { PaymentChannelSDK } from '../settlement/payment-channel-sdk';
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
import { makeV2EvmClaim } from '../test-utils/v2-evm-claim';
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

// The v2 verify path is a pure signature recovery — the SDK is never invoked by
// verifyEVMClaim; a truthy stand-in only satisfies the "EVM configured" gate.
const createMockPaymentChannelSDK = (): jest.Mocked<PaymentChannelSDK> =>
  ({
    verifyBalanceProofV2: jest.fn(),
  }) as unknown as jest.Mocked<PaymentChannelSDK>;

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
}

const createValidator = (
  options: {
    paymentChannelSDK?: jest.Mocked<PaymentChannelSDK> | undefined;
    nip59Wrapper?: NIP59ClaimWrapper;
    nip59PrivateKey?: Uint8Array;
    getPeerRelation?: (peerId: string) => 'parent' | 'peer' | 'child' | undefined;
    withoutSDK?: boolean;
  } = {}
): ValidatorFixture => {
  const mockLogger = createMockLogger();
  const mockPaymentChannelSDK = createMockPaymentChannelSDK();

  const validator = new InboundClaimValidator(
    options.withoutSDK ? undefined : mockPaymentChannelSDK,
    'test-node',
    mockLogger,
    undefined,
    options.nip59Wrapper,
    options.nip59PrivateKey,
    options.getPeerRelation
  );

  return {
    validator,
    mockLogger,
    mockPaymentChannelSDK,
  };
};

// A structurally-valid v2 EVM claim JSON with a dummy signature — used where the
// signature path is NOT reached (validateClaimMessage is mocked to throw, or the
// content is otherwise irrelevant to the branch under test).
const createEVMClaimJSON = (overrides?: Record<string, unknown>): string => {
  const claim = {
    version: '2.0',
    blockchain: 'evm',
    messageId: 'msg-1',
    timestamp: new Date().toISOString(),
    senderId: 'peer-a',
    channelId: '0x1234567890123456789012345678901234567890123456789012345678901234',
    nonce: 1,
    cumulativeAmount: '100',
    recipient: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    signature: '0xabc',
    signerAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    chainId: 8453,
    verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
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
      // A REAL, leaf-verifiable v2 EVM claim is what the unwrapper yields, so the
      // pure verifyEVMClaimV2 signature recovery accepts it.
      const unwrappedClaim = await makeV2EvmClaim({ channelId: '0x' + '22'.repeat(32) });

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

      expect(result).toBeNull();
      expect(deserializeWrappedClaim).toHaveBeenCalledWith(Buffer.from('{}'));
      expect(mockNip59Wrapper.unwrapClaim).toHaveBeenCalledWith(
        expect.objectContaining({ version: '1.0' }),
        new Uint8Array(32)
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

      const { validator } = createValidator();

      const claim = await makeV2EvmClaim();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
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

      const { validator } = createValidator();

      const claim = await makeV2EvmClaim();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
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
  // Branch 10: verifyEVMClaim — EVM SDK not configured
  // -------------------------------------------------------------------------
  describe('Branch 10: EVM settlement not configured', () => {
    it('should reject an EVM claim when no EVM payment-channel SDK is configured', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator({ withoutSDK: true });

      const claim = await makeV2EvmClaim();
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toEqual({
        type: PacketType.REJECT,
        code: ILPErrorCode.F06_UNEXPECTED_PAYMENT,
        triggeredBy: 'test-node',
        message: 'EVM claim received but EVM settlement is not configured',
        data: Buffer.alloc(0),
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_no_evm_sdk' }),
        'Rejecting ILP PREPARE: EVM claim received but no EVM payment-channel SDK configured'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 11: verifyEVMClaim — real v2 signature verification success / failure
  // -------------------------------------------------------------------------
  describe('Branch 11: v2 signature verification success and failure', () => {
    it('should accept when the real v2 EIP-712 signature verifies', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator();

      const claim = await makeV2EvmClaim({ cumulativeAmount: '100', nonce: 1 });
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
        },
      ];

      const result = await validator.validate(protocolData, packet, 'peer-a');

      expect(result).toBeNull();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'inbound_claim_validated' }),
        'Inbound claim validated successfully'
      );
    });

    it('should reject when the v2 signature does not match the signed fields', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator();

      // Sign over nonce=1, then advertise nonce=2 — the recovered signer no longer
      // matches signerAddress, so the pure leaf reports valid=false.
      const claim = await makeV2EvmClaim({ nonce: 1 });
      claim.nonce = 2;
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
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
        'Rejecting ILP PREPARE: invalid v2 EIP-712 signature'
      );
    });
  });

  // -------------------------------------------------------------------------
  // Branch 12: verifyEVMClaim — verify leaf throws
  // -------------------------------------------------------------------------
  describe('Branch 12: signature verification throws', () => {
    it('should reject when the v2 verify leaf throws (malformed signature)', async () => {
      (validateClaimMessage as jest.Mock).mockImplementation(() => {});
      (isEVMClaim as unknown as jest.Mock).mockReturnValue(true);

      const { validator, mockLogger } = createValidator();

      // A non-65-byte signature makes the leaf's normalizeSignature65 throw.
      const claim = await makeV2EvmClaim();
      claim.signature = '0xabc';
      const packet = createPreparePacket(1000n);
      const protocolData = [
        {
          protocolName: BTP_CLAIM_PROTOCOL.NAME,
          contentType: 1,
          data: Buffer.from(JSON.stringify(claim), 'utf8'),
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

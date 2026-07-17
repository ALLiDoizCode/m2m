/**
 * ILP Send Handler Tests
 *
 * Unit tests for the POST /admin/ilp/send endpoint handler.
 * Tests request validation, response mapping, timeout handling,
 * and connector readiness checks.
 */

import express, { Express } from 'express';
import request from 'supertest';
import pino from 'pino';
import { PacketType, ILPErrorCode } from '@toon-protocol/shared';
import type { ILPFulfillPacket, ILPRejectPacket } from '@toon-protocol/shared';
import { IlpSendHandler, validateIlpSendRequest } from './ilp-send-handler';
import type { PacketSenderFn, IsReadyFn } from './ilp-send-handler';
import type { SendPacketParams } from '../config/types';

/** Silent logger for tests */
const logger = pino({ level: 'silent' });

/** Helper to build a valid request body */
function validRequestBody(): Record<string, unknown> {
  return {
    destination: 'g.connector.peer1',
    amount: '1500000',
    data: Buffer.from('Hello World').toString('base64'),
  };
}

/** Helper to create an Express app with the handler */
function createApp(
  sendPacket: PacketSenderFn | null,
  isReady: IsReadyFn | null = () => true
): Express {
  const app = express();
  app.use(express.json());
  const handler = new IlpSendHandler(sendPacket, isReady, logger);
  app.post('/ilp/send', handler.handle.bind(handler));
  return app;
}

describe('validateIlpSendRequest', () => {
  it('should accept a valid request with all fields', () => {
    expect(validateIlpSendRequest(validRequestBody())).toBeNull();
  });

  it('should accept a request without optional timeoutMs (defaults to 30000)', () => {
    const body = validRequestBody();
    delete body.timeoutMs;
    expect(validateIlpSendRequest(body)).toBeNull();
  });

  it('should accept a valid request with timeoutMs', () => {
    const body = { ...validRequestBody(), timeoutMs: 5000 };
    expect(validateIlpSendRequest(body)).toBeNull();
  });

  describe('destination validation', () => {
    it('should reject missing destination', () => {
      const body = validRequestBody();
      delete body.destination;
      expect(validateIlpSendRequest(body)).toBe('Missing required field: destination');
    });

    it('should reject empty destination', () => {
      const body = { ...validRequestBody(), destination: '' };
      expect(validateIlpSendRequest(body)).toBe('Missing required field: destination');
    });

    it('should reject invalid ILP address', () => {
      const body = { ...validRequestBody(), destination: '..invalid..address' };
      expect(validateIlpSendRequest(body)).toBe('Invalid ILP address: ..invalid..address');
    });

    it('should reject non-string destination', () => {
      const body = { ...validRequestBody(), destination: 123 };
      expect(validateIlpSendRequest(body)).toBe('Missing required field: destination');
    });
  });

  describe('amount validation', () => {
    it('should reject missing amount', () => {
      const body = validRequestBody();
      delete body.amount;
      expect(validateIlpSendRequest(body)).toBe('Missing required field: amount');
    });

    it('should reject negative amount', () => {
      const body = { ...validRequestBody(), amount: '-100' };
      expect(validateIlpSendRequest(body)).toBe('Amount must be a non-negative integer string');
    });

    it('should reject float amount', () => {
      const body = { ...validRequestBody(), amount: '12.5' };
      expect(validateIlpSendRequest(body)).toBe('Amount must be a non-negative integer string');
    });

    it('should reject empty string amount', () => {
      const body = { ...validRequestBody(), amount: '' };
      expect(validateIlpSendRequest(body)).toBe('Amount must be a non-negative integer string');
    });

    it('should accept zero amount', () => {
      const body = { ...validRequestBody(), amount: '0' };
      expect(validateIlpSendRequest(body)).toBeNull();
    });

    it('should reject non-string amount', () => {
      const body = { ...validRequestBody(), amount: 100 };
      expect(validateIlpSendRequest(body)).toBe('Missing required field: amount');
    });
  });

  describe('data validation', () => {
    it('should reject missing data field', () => {
      const body = validRequestBody();
      delete body.data;
      expect(validateIlpSendRequest(body)).toBe('Missing required field: data');
    });

    it('should reject non-base64 data', () => {
      const body = { ...validRequestBody(), data: '!!!not-base64!!!' };
      expect(validateIlpSendRequest(body)).toBe('Data must be valid base64');
    });

    it('should accept empty base64 data', () => {
      const body = { ...validRequestBody(), data: '' };
      // Empty string decodes to empty buffer and re-encodes to empty string
      expect(validateIlpSendRequest(body)).toBeNull();
    });

    it('should reject data exceeding 64KB decoded', () => {
      const largeData = Buffer.alloc(65537); // 1 byte over 64KB
      const body = { ...validRequestBody(), data: largeData.toString('base64') };
      expect(validateIlpSendRequest(body)).toBe('Data exceeds maximum size of 65536 bytes');
    });

    it('should accept data exactly at 64KB decoded', () => {
      const exactData = Buffer.alloc(65536); // Exactly 64KB
      const body = { ...validRequestBody(), data: exactData.toString('base64') };
      expect(validateIlpSendRequest(body)).toBeNull();
    });
  });

  describe('timeoutMs validation', () => {
    it('should reject negative timeoutMs', () => {
      const body = { ...validRequestBody(), timeoutMs: -1 };
      expect(validateIlpSendRequest(body)).toBe('timeoutMs must be a positive integer');
    });

    it('should reject zero timeoutMs', () => {
      const body = { ...validRequestBody(), timeoutMs: 0 };
      expect(validateIlpSendRequest(body)).toBe('timeoutMs must be a positive integer');
    });

    it('should reject float timeoutMs', () => {
      const body = { ...validRequestBody(), timeoutMs: 1.5 };
      expect(validateIlpSendRequest(body)).toBe('timeoutMs must be a positive integer');
    });

    it('should reject string timeoutMs', () => {
      const body = { ...validRequestBody(), timeoutMs: '5000' };
      expect(validateIlpSendRequest(body)).toBe('timeoutMs must be a positive integer');
    });
  });

  describe('condition validation (issue #309/PR #310 egress symmetry)', () => {
    const validCondition = Buffer.alloc(32, 0x42).toString('base64');

    it('should accept a valid 32-byte base64 condition', () => {
      const body = { ...validRequestBody(), condition: validCondition };
      expect(validateIlpSendRequest(body)).toBeNull();
    });

    it('should accept a request without condition (legacy path)', () => {
      expect(validateIlpSendRequest(validRequestBody())).toBeNull();
    });

    it('should reject a non-string condition', () => {
      const body = { ...validRequestBody(), condition: 42 };
      expect(validateIlpSendRequest(body)).toBe('condition must be a base64 string');
    });

    it('should reject invalid base64', () => {
      const body = { ...validRequestBody(), condition: 'not-valid-base64!!!' };
      expect(validateIlpSendRequest(body)).toBe('condition must be valid base64');
    });

    it('should reject a condition that does not decode to 32 bytes', () => {
      const body = { ...validRequestBody(), condition: Buffer.alloc(16, 7).toString('base64') };
      expect(validateIlpSendRequest(body)).toBe(
        'condition must decode to exactly 32 bytes, got 16'
      );
    });

    it('should reject an all-zero condition', () => {
      const body = { ...validRequestBody(), condition: Buffer.alloc(32).toString('base64') };
      expect(validateIlpSendRequest(body)).toBe(
        'condition must not be all-zero (omit it for unconditional packets)'
      );
    });
  });
});

describe('IlpSendHandler', () => {
  let mockSendPacket: jest.Mock<Promise<ILPFulfillPacket | ILPRejectPacket>, [SendPacketParams]>;
  let mockIsReady: jest.Mock<boolean>;
  let app: Express;
  const pendingTimers: NodeJS.Timeout[] = [];

  beforeEach(() => {
    mockSendPacket = jest.fn();
    mockIsReady = jest.fn().mockReturnValue(true);
    app = createApp(mockSendPacket, mockIsReady);
  });

  afterEach(() => {
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.length = 0;
  });

  describe('sender not configured', () => {
    it('should return 503 when sendPacket is null', async () => {
      const nullApp = createApp(null, null);

      const res = await request(nullApp).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Service unavailable',
        message: 'Outbound sender not configured',
      });
    });
  });

  describe('connector not ready', () => {
    it('should return 503 when isReady() returns false', async () => {
      mockIsReady.mockReturnValue(false);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: 'Service unavailable',
        message: 'Connector not ready',
      });
    });
  });

  describe('request validation (HTTP integration)', () => {
    it('should return 400 for missing destination', async () => {
      const body = validRequestBody();
      delete body.destination;

      const res = await request(app).post('/ilp/send').send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Bad request');
    });

    it('should return 400 for invalid ILP address', async () => {
      const res = await request(app)
        .post('/ilp/send')
        .send({ ...validRequestBody(), destination: '..bad' });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain('Invalid ILP address');
    });
  });

  describe('FULFILL response mapping', () => {
    it('should return accepted: true on FULFILL response', async () => {
      const responseData = Buffer.from('response data');

      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: responseData,
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      expect(res.body.data).toBe(responseData.toString('base64'));
    });

    it('should return accepted: false on REJECT response', async () => {
      const rejectPacket: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.F02_UNREACHABLE,
        triggeredBy: 'g.connector',
        message: 'No route to destination',
        data: Buffer.from('error details'),
      };
      mockSendPacket.mockResolvedValue(rejectPacket);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(false);
      expect(res.body.code).toBe('F02');
      expect(res.body.message).toBe('No route to destination');
      expect(res.body.data).toBe(Buffer.from('error details').toString('base64'));
    });

    it('should omit data field when response data is empty', async () => {
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      expect(res.body.data).toBeUndefined();
    });
  });

  describe('REJECT response mapping', () => {
    it('should omit data field when reject data is empty', async () => {
      const rejectPacket: ILPRejectPacket = {
        type: PacketType.REJECT,
        code: ILPErrorCode.T00_INTERNAL_ERROR,
        triggeredBy: 'g.connector',
        message: 'Internal error',
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(rejectPacket);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(false);
      expect(res.body.data).toBeUndefined();
    });
  });

  describe('timeout handling', () => {
    it('should return 408 when sender times out', async () => {
      // Mock sender that resolves after the timeout
      mockSendPacket.mockImplementation(
        () =>
          new Promise((resolve) => {
            const timer = setTimeout(
              () =>
                resolve({
                  type: PacketType.FULFILL,
                  data: Buffer.alloc(0),
                } as ILPFulfillPacket),
              500
            );
            pendingTimers.push(timer);
          })
      );

      const res = await request(app)
        .post('/ilp/send')
        .send({ ...validRequestBody(), timeoutMs: 50 });

      expect(res.status).toBe(408);
      expect(res.body.error).toBe('Request timeout');
      expect(res.body.message).toContain('50ms');
    }, 10000);

    it('should use default timeout of 30000ms when timeoutMs not specified', async () => {
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(200);

      // Verify the SendPacketParams was constructed with correct expiresAt
      const paramsArg = mockSendPacket.mock.calls[0]![0] as SendPacketParams;
      const expectedExpiry = Date.now() + 30000;
      // Allow 2 second tolerance
      expect(Math.abs(paramsArg.expiresAt.getTime() - expectedExpiry)).toBeLessThan(2000);
    });
  });

  describe('packet construction', () => {
    it('should construct SendPacketParams with correct fields', async () => {
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      const body = validRequestBody();
      body.timeoutMs = 5000;
      await request(app).post('/ilp/send').send(body);

      expect(mockSendPacket).toHaveBeenCalledTimes(1);
      const paramsArg = mockSendPacket.mock.calls[0]![0] as SendPacketParams;

      expect(paramsArg.destination).toBe('g.connector.peer1');
      expect(paramsArg.amount).toBe(BigInt('1500000'));
      expect(paramsArg.data!.equals(Buffer.from('Hello World'))).toBe(true);
    }, 60_000);

    it('should pass a sender-chosen condition through as executionCondition (issue #309/PR #310)', async () => {
      const condition = Buffer.alloc(32, 0x42).toString('base64');
      const preimage = Buffer.alloc(32, 0x24);
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        fulfillment: new Uint8Array(preimage),
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      const res = await request(app)
        .post('/ilp/send')
        .send({ ...validRequestBody(), condition });

      expect(mockSendPacket).toHaveBeenCalledTimes(1);
      const paramsArg = mockSendPacket.mock.calls[0]![0] as SendPacketParams;
      expect(paramsArg.executionCondition).toBe(condition);

      // The resolved preimage is surfaced so the caller can verify sha256(P) === C.
      expect(res.status).toBe(200);
      expect(res.body.accepted).toBe(true);
      expect(res.body.fulfillment).toBe(preimage.toString('base64'));
    }, 60_000);

    it('should omit executionCondition when the request carries no condition', async () => {
      const fulfillPacket: ILPFulfillPacket = {
        type: PacketType.FULFILL,
        data: Buffer.alloc(0),
      };
      mockSendPacket.mockResolvedValue(fulfillPacket);

      await request(app).post('/ilp/send').send(validRequestBody());

      const paramsArg = mockSendPacket.mock.calls[0]![0] as SendPacketParams;
      expect('executionCondition' in paramsArg).toBe(false);
    }, 60_000);
  });

  describe('internal error handling', () => {
    it('should return 500 when sendPacket throws an unexpected error', async () => {
      mockSendPacket.mockRejectedValue(new Error('Connection reset'));

      const res = await request(app).post('/ilp/send').send(validRequestBody());

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.message).toBe('Connection reset');
    });
  });
});

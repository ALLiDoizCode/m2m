import type { NostrEvent } from '../../toon-codec';
import {
  formatDVMJobResult,
  formatDVMErrorResult,
  DVM_RESULT_KIND_OFFSET,
  type DVMJobResult,
} from '../index';

/**
 * Creates a test DVM job event with optional overrides.
 */
function createDVMJobEvent(overrides?: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    kind: 5000,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [['i', 'test input', 'text']],
    sig: 'c'.repeat(128),
    ...overrides,
  };
}

/**
 * Creates a test DVM job result with optional overrides.
 */
function createDVMJobResult(overrides?: Partial<DVMJobResult>): DVMJobResult {
  const requestEvent = createDVMJobEvent();
  return {
    requestEvent,
    content: 'Test result content',
    amount: 5000n,
    status: 'success',
    ...overrides,
  };
}

describe('formatDVMJobResult', () => {
  describe('kind calculation', () => {
    it('should calculate Kind 6000 from Kind 5000 request', () => {
      // Arrange
      const result = createDVMJobResult({
        requestEvent: createDVMJobEvent({ kind: 5000 }),
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.kind).toBe(6000);
    });

    it('should calculate Kind 6100 from Kind 5100 request', () => {
      // Arrange
      const result = createDVMJobResult({
        requestEvent: createDVMJobEvent({ kind: 5100 }),
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.kind).toBe(6100);
    });

    it('should calculate Kind 6900 from Kind 5900 request', () => {
      // Arrange
      const result = createDVMJobResult({
        requestEvent: createDVMJobEvent({ kind: 5900 }),
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.kind).toBe(6900);
    });
  });

  describe('request tag', () => {
    it('should contain valid stringified JSON of original request', () => {
      // Arrange
      const requestEvent = createDVMJobEvent({
        id: 'test_id_' + 'a'.repeat(56),
        pubkey: 'test_pubkey_' + 'b'.repeat(52),
        kind: 5000,
        content: 'test content',
      });
      const result = createDVMJobResult({ requestEvent });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const requestTag = event.tags.find((tag) => tag[0] === 'request');
      expect(requestTag).toBeDefined();
      expect(requestTag![0]).toBe('request');

      // Verify it's valid JSON
      const parsed = JSON.parse(requestTag![1]!);
      expect(parsed.id).toBe(requestEvent.id);
      expect(parsed.pubkey).toBe(requestEvent.pubkey);
      expect(parsed.kind).toBe(requestEvent.kind);
      expect(parsed.content).toBe(requestEvent.content);
    });

    it('should preserve all original event fields in stringified request', () => {
      // Arrange
      const requestEvent = createDVMJobEvent({
        tags: [
          ['i', 'test', 'text'],
          ['param', 'key', 'value'],
        ],
      });
      const result = createDVMJobResult({ requestEvent });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const requestTag = event.tags.find((tag) => tag[0] === 'request');
      const parsed = JSON.parse(requestTag![1]!);
      expect(parsed.tags).toEqual(requestEvent.tags);
      expect(parsed.sig).toBe(requestEvent.sig);
    });
  });

  describe('e tag (event reference)', () => {
    it('should contain correct request event ID', () => {
      // Arrange
      const eventId = 'specific_event_id_' + 'x'.repeat(46);
      const result = createDVMJobResult({
        requestEvent: createDVMJobEvent({ id: eventId }),
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const eTag = event.tags.find((tag) => tag[0] === 'e');
      expect(eTag).toBeDefined();
      expect(eTag).toEqual(['e', eventId]);
    });
  });

  describe('p tag (pubkey reference)', () => {
    it('should contain correct requester pubkey', () => {
      // Arrange
      const pubkey = 'requester_pubkey_' + 'y'.repeat(47);
      const result = createDVMJobResult({
        requestEvent: createDVMJobEvent({ pubkey }),
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const pTag = event.tags.find((tag) => tag[0] === 'p');
      expect(pTag).toBeDefined();
      expect(pTag).toEqual(['p', pubkey]);
    });
  });

  describe('amount tag', () => {
    it('should contain bigint converted to string', () => {
      // Arrange
      const result = createDVMJobResult({ amount: 12345n });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toBeDefined();
      expect(amountTag).toEqual(['amount', '12345']);
    });

    it('should handle zero amount (0n)', () => {
      // Arrange
      const result = createDVMJobResult({ amount: 0n });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', '0']);
    });

    it('should handle very large amount (max safe bigint)', () => {
      // Arrange
      const largeAmount = 9007199254740993n; // Larger than Number.MAX_SAFE_INTEGER
      const result = createDVMJobResult({ amount: largeAmount });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', '9007199254740993']);
    });
  });

  describe('status tag', () => {
    it('should set status tag to success', () => {
      // Arrange
      const result = createDVMJobResult({ status: 'success' });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'success']);
    });

    it('should set status tag to error', () => {
      // Arrange
      const result = createDVMJobResult({ status: 'error' });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'error']);
    });

    it('should set status tag to partial', () => {
      // Arrange
      const result = createDVMJobResult({ status: 'partial' });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'partial']);
    });
  });

  describe('content formatting - plain text', () => {
    it('should pass through plain text unchanged', () => {
      // Arrange
      const result = createDVMJobResult({
        content: 'Hello, world!',
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe('Hello, world!');
    });

    it('should handle empty string content', () => {
      // Arrange
      const result = createDVMJobResult({
        content: '',
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe('');
    });

    it('should handle Unicode content (emojis)', () => {
      // Arrange
      const unicodeContent = '🎉 Hello! 你好 مرحبا こんにちは';
      const result = createDVMJobResult({
        content: unicodeContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe(unicodeContent);
    });

    it('should handle CJK characters', () => {
      // Arrange
      const cjkContent = '中文测试内容 日本語テスト 한국어 테스트';
      const result = createDVMJobResult({
        content: cjkContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe(cjkContent);
    });

    it('should handle large content (near 64KB)', () => {
      // Arrange
      const largeContent = 'x'.repeat(60000); // Near 64KB limit
      const result = createDVMJobResult({
        content: largeContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe(largeContent);
      expect(event.content.length).toBe(60000);
    });
  });

  describe('content formatting - JSON object', () => {
    it('should serialize JSON object', () => {
      // Arrange
      const jsonContent = { result: 'translated text', confidence: 0.95 };
      const result = createDVMJobResult({
        content: jsonContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe('{"result":"translated text","confidence":0.95}');
      expect(JSON.parse(event.content)).toEqual(jsonContent);
    });

    it('should serialize deeply nested JSON object', () => {
      // Arrange
      const nestedContent = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
                array: [1, 2, { nested: true }],
              },
            },
          },
        },
      };
      const result = createDVMJobResult({
        content: nestedContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const parsed = JSON.parse(event.content);
      expect(parsed.level1.level2.level3.level4.value).toBe('deep');
      expect(parsed.level1.level2.level3.level4.array).toEqual([1, 2, { nested: true }]);
    });

    it('should serialize array as JSON', () => {
      // Arrange
      const arrayContent = ['item1', 'item2', { key: 'value' }];
      const result = createDVMJobResult({
        content: arrayContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(JSON.parse(event.content)).toEqual(arrayContent);
    });
  });

  describe('content formatting - Buffer (base64)', () => {
    it('should convert Buffer to base64 string', () => {
      // Arrange
      const bufferContent = Buffer.from('Hello World', 'utf-8');
      const result = createDVMJobResult({
        content: bufferContent,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe('SGVsbG8gV29ybGQ=');
      expect(Buffer.from(event.content, 'base64').toString()).toBe('Hello World');
    });

    it('should handle binary Buffer data', () => {
      // Arrange
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
      const result = createDVMJobResult({
        content: binaryData,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const decoded = Buffer.from(event.content, 'base64');
      expect(decoded).toEqual(binaryData);
    });

    it('should handle empty Buffer', () => {
      // Arrange
      const emptyBuffer = Buffer.alloc(0);
      const result = createDVMJobResult({
        content: emptyBuffer,
        status: 'success',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe('');
    });
  });

  describe('error content formatting', () => {
    it('should wrap plain string error in error object', () => {
      // Arrange
      const result = createDVMJobResult({
        content: 'Something went wrong',
        status: 'error',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const parsed = JSON.parse(event.content);
      expect(parsed.error).toBe(true);
      expect(parsed.message).toBe('Something went wrong');
    });

    it('should preserve existing JSON error object', () => {
      // Arrange
      const errorJson = JSON.stringify({ error: true, code: 'F99', message: 'Query failed' });
      const result = createDVMJobResult({
        content: errorJson,
        status: 'error',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.content).toBe(errorJson);
    });

    it('should serialize error object content directly', () => {
      // Arrange
      const errorObject = { error: true, code: 'TIMEOUT', details: { elapsed: 30000 } };
      const result = createDVMJobResult({
        content: errorObject,
        status: 'error',
      });

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const parsed = JSON.parse(event.content);
      expect(parsed.error).toBe(true);
      expect(parsed.code).toBe('TIMEOUT');
      expect(parsed.details.elapsed).toBe(30000);
    });
  });

  describe('timestamp (created_at)', () => {
    it('should set created_at to reasonable Unix timestamp', () => {
      // Arrange
      const beforeTime = Math.floor(Date.now() / 1000);
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);
      const afterTime = Math.floor(Date.now() / 1000);

      // Assert
      expect(event.created_at).toBeGreaterThanOrEqual(beforeTime);
      expect(event.created_at).toBeLessThanOrEqual(afterTime);
    });

    it('should be in seconds (not milliseconds)', () => {
      // Arrange
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      // Unix timestamp in seconds should be around 10 digits (e.g., 1706400000)
      // Milliseconds would be 13 digits
      expect(event.created_at.toString().length).toBeLessThanOrEqual(10);
      expect(event.created_at).toBeGreaterThan(1700000000); // After 2023
      expect(event.created_at).toBeLessThan(2000000000); // Before 2033
    });
  });

  describe('unsigned event fields', () => {
    it('should have empty id (to be filled after signing)', () => {
      // Arrange
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.id).toBe('');
    });

    it('should have empty pubkey (to be filled with agent pubkey)', () => {
      // Arrange
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.pubkey).toBe('');
    });

    it('should have empty sig (to be filled after signing)', () => {
      // Arrange
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      expect(event.sig).toBe('');
    });
  });

  describe('tag ordering', () => {
    it('should include all required tags', () => {
      // Arrange
      const result = createDVMJobResult();

      // Act
      const event = formatDVMJobResult(result);

      // Assert
      const tagNames = event.tags.map((t) => t[0]);
      expect(tagNames).toContain('request');
      expect(tagNames).toContain('e');
      expect(tagNames).toContain('p');
      expect(tagNames).toContain('amount');
      expect(tagNames).toContain('status');
      expect(event.tags.length).toBe(5);
    });
  });
});

describe('formatDVMErrorResult', () => {
  it('should create error result with correct content structure', () => {
    // Arrange
    const requestEvent = createDVMJobEvent();
    const errorCode = 'F99';
    const errorMessage = 'Query execution failed';
    const amount = 5000n;

    // Act
    const event = formatDVMErrorResult(requestEvent, errorCode, errorMessage, amount);

    // Assert
    const parsed = JSON.parse(event.content);
    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('F99');
    expect(parsed.message).toBe('Query execution failed');
  });

  it('should set status to error', () => {
    // Arrange
    const requestEvent = createDVMJobEvent();

    // Act
    const event = formatDVMErrorResult(requestEvent, 'ERR001', 'Test error', 0n);

    // Assert
    const statusTag = event.tags.find((tag) => tag[0] === 'status');
    expect(statusTag).toEqual(['status', 'error']);
  });

  it('should calculate correct result kind from request', () => {
    // Arrange
    const requestEvent = createDVMJobEvent({ kind: 5100 });

    // Act
    const event = formatDVMErrorResult(requestEvent, 'ERR', 'Error', 0n);

    // Assert
    expect(event.kind).toBe(6100);
  });

  it('should include correct amount tag', () => {
    // Arrange
    const requestEvent = createDVMJobEvent();

    // Act
    const event = formatDVMErrorResult(requestEvent, 'ERR', 'Error', 2500n);

    // Assert
    const amountTag = event.tags.find((tag) => tag[0] === 'amount');
    expect(amountTag).toEqual(['amount', '2500']);
  });

  it('should reference correct request event', () => {
    // Arrange
    const requestEvent = createDVMJobEvent({
      id: 'error_request_id_' + 'z'.repeat(47),
      pubkey: 'error_requester_' + 'w'.repeat(48),
    });

    // Act
    const event = formatDVMErrorResult(requestEvent, 'ERR', 'Error', 0n);

    // Assert
    const eTag = event.tags.find((tag) => tag[0] === 'e');
    const pTag = event.tags.find((tag) => tag[0] === 'p');
    expect(eTag![1]).toBe(requestEvent.id);
    expect(pTag![1]).toBe(requestEvent.pubkey);
  });
});

describe('DVM_RESULT_KIND_OFFSET constant', () => {
  it('should be 1000', () => {
    expect(DVM_RESULT_KIND_OFFSET).toBe(1000);
  });
});

import { formatDVMFeedback } from '../dvm-feedback';
import { DVM_FEEDBACK_KIND } from '../types';
import type { DVMFeedback } from '../types';

/**
 * Helper function to create a DVMFeedback object for testing.
 */
function createDVMFeedback(overrides?: Partial<DVMFeedback>): DVMFeedback {
  return {
    kind: 7000,
    status: 'processing',
    jobEventId: 'a'.repeat(64),
    requesterPubkey: 'b'.repeat(64),
    message: 'Test feedback message',
    ...overrides,
  };
}

describe('formatDVMFeedback', () => {
  describe('Kind and basic structure', () => {
    it('should use Kind 7000 for all feedback events', () => {
      // Arrange
      const feedback = createDVMFeedback();

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.kind).toBe(DVM_FEEDBACK_KIND);
      expect(event.kind).toBe(7000);
    });

    it('should create unsigned event with empty id, pubkey, and sig', () => {
      // Arrange
      const feedback = createDVMFeedback();

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.id).toBe('');
      expect(event.pubkey).toBe('');
      expect(event.sig).toBe('');
    });

    it('should set created_at to reasonable Unix timestamp', () => {
      // Arrange
      const feedback = createDVMFeedback();
      const nowSeconds = Math.floor(Date.now() / 1000);

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.created_at).toBeGreaterThanOrEqual(nowSeconds - 1);
      expect(event.created_at).toBeLessThanOrEqual(nowSeconds + 1);
    });
  });

  describe('Status values', () => {
    it('should handle payment-required status', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'payment-required', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'payment-required']);
      expect(event.content).toBe('Payment required to process this request');
    });

    it('should handle processing status', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'processing', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'processing']);
      expect(event.content).toBe('Processing your request...');
    });

    it('should handle error status', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'error', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'error']);
      expect(event.content).toBe('An error occurred while processing your request');
    });

    it('should handle success status', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'success', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'success']);
      expect(event.content).toBe('Request completed successfully');
    });

    it('should handle partial status', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'partial', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'partial']);
      expect(event.content).toBe('Partial results available');
    });
  });

  describe('Event tag', () => {
    it('should include e tag with job event ID', () => {
      // Arrange
      const jobEventId = 'c'.repeat(64);
      const feedback = createDVMFeedback({ jobEventId });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const eTag = event.tags.find((tag) => tag[0] === 'e');
      expect(eTag).toEqual(['e', jobEventId]);
    });
  });

  describe('Pubkey tag', () => {
    it('should include p tag with requester pubkey', () => {
      // Arrange
      const requesterPubkey = 'd'.repeat(64);
      const feedback = createDVMFeedback({ requesterPubkey });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const pTag = event.tags.find((tag) => tag[0] === 'p');
      expect(pTag).toEqual(['p', requesterPubkey]);
    });
  });

  describe('Amount tag', () => {
    it('should include amount tag when amount provided', () => {
      // Arrange
      const feedback = createDVMFeedback({ amount: 5000n });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', '5000']);
    });

    it('should omit amount tag when amount not provided', () => {
      // Arrange
      const feedback = createDVMFeedback({ amount: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toBeUndefined();
    });

    it('should convert bigint amount to string', () => {
      // Arrange
      const feedback = createDVMFeedback({ amount: 123456789012345n });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', '123456789012345']);
    });

    it('should handle zero amount (0n)', () => {
      // Arrange
      const feedback = createDVMFeedback({ amount: 0n });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', '0']);
    });

    it('should handle very large amount (max safe bigint)', () => {
      // Arrange
      const maxSafeBigInt = BigInt(Number.MAX_SAFE_INTEGER);
      const feedback = createDVMFeedback({ amount: maxSafeBigInt });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toEqual(['amount', maxSafeBigInt.toString()]);
    });
  });

  describe('Content field', () => {
    it('should use custom message when provided', () => {
      // Arrange
      const customMessage = 'Custom status update message';
      const feedback = createDVMFeedback({ message: customMessage });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe(customMessage);
    });

    it('should use default message when message not provided', () => {
      // Arrange
      const feedback = createDVMFeedback({ status: 'processing', message: undefined });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe('Processing your request...');
    });

    it('should handle empty message string', () => {
      // Arrange
      const feedback = createDVMFeedback({ message: '' });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe('');
    });

    it('should handle very long message (near 64KB)', () => {
      // Arrange
      const longMessage = 'a'.repeat(65000);
      const feedback = createDVMFeedback({ message: longMessage });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe(longMessage);
      expect(event.content.length).toBe(65000);
    });

    it('should handle Unicode message with emojis', () => {
      // Arrange
      const unicodeMessage = '✅ Processing complete! 🎉';
      const feedback = createDVMFeedback({ message: unicodeMessage });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe(unicodeMessage);
    });

    it('should handle Unicode message with CJK characters', () => {
      // Arrange
      const cjkMessage = '処理中です。お待ちください。';
      const feedback = createDVMFeedback({ message: cjkMessage });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.content).toBe(cjkMessage);
    });
  });

  describe('Status-specific edge cases', () => {
    it('should handle payment-required with custom message and amount', () => {
      // Arrange
      const feedback = createDVMFeedback({
        status: 'payment-required',
        amount: 5000n,
        message: 'Please pay 5000 msats to continue',
      });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(statusTag).toEqual(['status', 'payment-required']);
      expect(amountTag).toEqual(['amount', '5000']);
      expect(event.content).toBe('Please pay 5000 msats to continue');
    });

    it('should handle error status with custom error message', () => {
      // Arrange
      const feedback = createDVMFeedback({
        status: 'error',
        message: 'Query execution failed: timeout exceeded after 30s',
      });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'error']);
      expect(event.content).toBe('Query execution failed: timeout exceeded after 30s');
    });

    it('should handle partial status with progress information', () => {
      // Arrange
      const feedback = createDVMFeedback({
        status: 'partial',
        message: 'Partial results available (50% complete)',
      });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      const statusTag = event.tags.find((tag) => tag[0] === 'status');
      expect(statusTag).toEqual(['status', 'partial']);
      expect(event.content).toBe('Partial results available (50% complete)');
    });
  });

  describe('All status values with and without message', () => {
    const statuses: Array<'payment-required' | 'processing' | 'error' | 'success' | 'partial'> = [
      'payment-required',
      'processing',
      'error',
      'success',
      'partial',
    ];

    statuses.forEach((status) => {
      it(`should handle ${status} status with custom message`, () => {
        // Arrange
        const customMessage = `Custom message for ${status}`;
        const feedback = createDVMFeedback({ status, message: customMessage });

        // Act
        const event = formatDVMFeedback(feedback);

        // Assert
        const statusTag = event.tags.find((tag) => tag[0] === 'status');
        expect(statusTag).toEqual(['status', status]);
        expect(event.content).toBe(customMessage);
      });

      it(`should handle ${status} status without message (default)`, () => {
        // Arrange
        const feedback = createDVMFeedback({ status, message: undefined });

        // Act
        const event = formatDVMFeedback(feedback);

        // Assert
        const statusTag = event.tags.find((tag) => tag[0] === 'status');
        expect(statusTag).toEqual(['status', status]);
        expect(event.content).toBeTruthy(); // Default message should be present
      });
    });
  });

  describe('Tags structure', () => {
    it('should include all required tags in correct structure', () => {
      // Arrange
      const feedback = createDVMFeedback({
        jobEventId: 'e'.repeat(64),
        requesterPubkey: 'f'.repeat(64),
        status: 'processing',
        amount: 1000n,
      });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['e', 'e'.repeat(64)],
          ['p', 'f'.repeat(64)],
          ['status', 'processing'],
          ['amount', '1000'],
        ])
      );
      expect(event.tags.length).toBe(4);
    });

    it('should include only required tags when amount not provided', () => {
      // Arrange
      const feedback = createDVMFeedback({
        jobEventId: 'g'.repeat(64),
        requesterPubkey: 'h'.repeat(64),
        status: 'success',
        amount: undefined,
      });

      // Act
      const event = formatDVMFeedback(feedback);

      // Assert
      expect(event.tags).toEqual(
        expect.arrayContaining([
          ['e', 'g'.repeat(64)],
          ['p', 'h'.repeat(64)],
          ['status', 'success'],
        ])
      );
      expect(event.tags.length).toBe(3);
      const amountTag = event.tags.find((tag) => tag[0] === 'amount');
      expect(amountTag).toBeUndefined();
    });
  });
});

import type { DVMFeedback, DVMFeedbackEvent, DVMFeedbackStatus, TaskFeedback } from './types';
import { DVM_FEEDBACK_KIND } from './types';

/**
 * Create an 'e' tag referencing the job request event.
 *
 * @param jobEventId - The job request event ID
 * @returns Tag array ['e', jobEventId]
 */
function createEventTag(jobEventId: string): string[] {
  return ['e', jobEventId];
}

/**
 * Create a 'p' tag with the requester's pubkey.
 *
 * @param requesterPubkey - The requester's public key
 * @returns Tag array ['p', requesterPubkey]
 */
function createPubkeyTag(requesterPubkey: string): string[] {
  return ['p', requesterPubkey];
}

/**
 * Create a 'status' tag with the feedback status.
 *
 * @param status - The feedback status
 * @returns Tag array ['status', status]
 */
function createStatusTag(status: DVMFeedbackStatus): string[] {
  return ['status', status];
}

/**
 * Create an 'amount' tag with the payment amount.
 *
 * @param amount - The payment amount in millisatoshis
 * @returns Tag array ['amount', amountString]
 */
function createAmountTag(amount: bigint): string[] {
  return ['amount', amount.toString()];
}

/**
 * Format feedback content with a default message if not provided.
 *
 * @param status - The feedback status
 * @param message - Optional custom message
 * @returns Formatted content string
 */
function formatFeedbackContent(status: DVMFeedbackStatus, message?: string): string {
  if (message !== undefined) {
    return message;
  }

  // Default messages for each status
  const defaultMessages: Record<DVMFeedbackStatus, string> = {
    'payment-required': 'Payment required to process this request',
    processing: 'Processing your request...',
    error: 'An error occurred while processing your request',
    success: 'Request completed successfully',
    partial: 'Partial results available',
  };

  return defaultMessages[status];
}

/**
 * Create a 'progress' tag with progress percentage (Story 17.8).
 *
 * @param progress - Progress percentage (0-100)
 * @returns Tag array ['progress', progressString]
 * @throws Error if progress is out of valid range
 */
export function createProgressTag(progress: number): string[] {
  if (progress < 0 || progress > 100) {
    throw new Error(`Invalid progress value: ${progress}. Must be between 0 and 100.`);
  }
  return ['progress', Math.floor(progress).toString()];
}

/**
 * Create an 'eta' tag with estimated seconds remaining (Story 17.8).
 *
 * @param seconds - Estimated seconds remaining
 * @returns Tag array ['eta', secondsString]
 * @throws Error if seconds is negative
 */
export function createEtaTag(seconds: number): string[] {
  if (seconds < 0) {
    throw new Error(`Invalid ETA value: ${seconds}. Must be non-negative.`);
  }
  return ['eta', Math.floor(seconds).toString()];
}

/**
 * Format a DVM job feedback event (Kind 7000).
 *
 * Creates an unsigned Nostr event template with all required tags and content.
 * The event must be signed separately by the caller before publishing.
 *
 * @param feedback - The feedback data to format
 * @returns Unsigned DVM feedback event ready for signing
 *
 * @example
 * ```typescript
 * const feedback: DVMFeedback = {
 *   kind: 7000,
 *   status: 'processing',
 *   jobEventId: 'abc123...',
 *   requesterPubkey: 'def456...',
 *   message: 'Analyzing your query...'
 * };
 *
 * const event = formatDVMFeedback(feedback);
 * // event.id, event.pubkey, event.sig are empty - to be filled by signing
 * ```
 */
export function formatDVMFeedback(feedback: DVMFeedback): DVMFeedbackEvent {
  const tags: string[][] = [];

  // Required tags
  tags.push(createEventTag(feedback.jobEventId));
  tags.push(createPubkeyTag(feedback.requesterPubkey));
  tags.push(createStatusTag(feedback.status));

  // Optional amount tag
  if (feedback.amount !== undefined) {
    tags.push(createAmountTag(feedback.amount));
  }

  // Format content
  const content = formatFeedbackContent(feedback.status, feedback.message);

  // Create unsigned event template
  const event: DVMFeedbackEvent = {
    id: '',
    pubkey: '',
    kind: DVM_FEEDBACK_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags,
    sig: '',
  };

  return event;
}

/**
 * Format a task-specific feedback event with progress/eta tracking (Story 17.8).
 *
 * Creates an unsigned Kind 7000 event with optional progress and ETA tags.
 * This is a convenience wrapper around formatDVMFeedback for task tracking use cases.
 *
 * @param feedback - The task feedback data to format
 * @returns Unsigned DVM feedback event with progress/eta tags
 *
 * @example
 * ```typescript
 * const taskFeedback: TaskFeedback = {
 *   kind: 7000,
 *   status: 'processing',
 *   jobEventId: 'task-123...',
 *   requesterPubkey: 'requester-pubkey...',
 *   progress: 50,
 *   eta: 30,
 *   message: 'Processing translation task...'
 * };
 *
 * const event = formatTaskFeedback(taskFeedback);
 * // event includes progress and eta tags
 * ```
 */
export function formatTaskFeedback(feedback: TaskFeedback): DVMFeedbackEvent {
  // Start with base feedback event
  const event = formatDVMFeedback(feedback);

  // Add progress tag if provided
  if (feedback.progress !== undefined) {
    event.tags.push(createProgressTag(feedback.progress));
  }

  // Add ETA tag if provided
  if (feedback.eta !== undefined) {
    event.tags.push(createEtaTag(feedback.eta));
  }

  return event;
}

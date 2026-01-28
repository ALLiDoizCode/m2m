import type { NostrEvent } from '../toon-codec';

/**
 * DVM kind range as specified in NIP-90.
 * Valid DVM job request kinds are 5000-5999.
 */
export const DVM_KIND_RANGE = { min: 5000, max: 5999 } as const;

/**
 * Offset to calculate result kind from request kind.
 * Result kind = request kind + 1000 (e.g., Kind 5000 request → Kind 6000 result)
 */
export const DVM_RESULT_KIND_OFFSET = 1000;

/**
 * Valid input types for DVM job requests per NIP-90.
 */
export type DVMInputType = 'text' | 'url' | 'event' | 'job';

/**
 * Input data extracted from 'i' tags in DVM job requests.
 */
export interface DVMInput {
  /** The input data value */
  data: string;
  /** Type hint for input interpretation */
  type: DVMInputType;
  /** Optional relay hint for event/job types */
  relay?: string;
  /** Optional marker for input identification */
  marker?: string;
}

/**
 * Parsed DVM job request containing all extracted fields.
 */
export interface DVMJobRequest {
  /** Event kind (5000-5999) */
  kind: number;
  /** Input data from 'i' tags */
  inputs: DVMInput[];
  /** Expected output MIME type from 'output' tag */
  outputType?: string;
  /** Key-value parameters from 'param' tags */
  params: Map<string, string>;
  /** Bid amount in millisatoshis from 'bid' tag (informational) */
  bid?: bigint;
  /** Preferred relay URLs from 'relays' tag */
  relays: string[];
  /** Original Nostr event for downstream access */
  event: NostrEvent;
  /** Job dependencies (event IDs from 'e' tags with 'dependency' marker) */
  dependencies: string[];
}

/**
 * Priority level for task delegation requests (Kind 5900).
 * Used to indicate task urgency for agent-to-agent collaboration.
 */
export type TaskPriority = 'high' | 'normal' | 'low';

/**
 * Task delegation request (Kind 5900) with agent-specific fields.
 * Extends DVMJobRequest with timeout, priority, and preferred agent fields.
 */
export interface TaskDelegationRequest extends DVMJobRequest {
  /** Event kind (always 5900 for task delegation) */
  kind: 5900;
  /** Maximum execution time in seconds */
  timeout?: number;
  /** Preferred agent pubkeys for task execution */
  preferredAgents: string[];
  /** Task priority level */
  priority: TaskPriority;
  /** Optional schema URL for input/output validation */
  schema?: string;
}

/**
 * Result status for DVM job results.
 */
export type DVMResultStatus = 'success' | 'error' | 'partial';

/**
 * Input to the DVM job result formatter.
 * Contains all information needed to create a result event.
 */
export interface DVMJobResult {
  /** Original request event (required for tags and kind calculation) */
  requestEvent: NostrEvent;
  /** Result content (string, object, or Buffer) */
  content: string | object | Buffer;
  /** Payment amount received from ILP packet */
  amount: bigint;
  /** Result status */
  status: DVMResultStatus;
}

/**
 * Token usage metrics for AI-powered task delegation.
 * Includes input and output token counts for cost tracking and optimization.
 */
export interface TokenMetrics {
  /** Number of input tokens consumed */
  input: number;
  /** Number of output tokens generated */
  output: number;
}

/**
 * Task delegation result (Kind 6900) with execution metrics.
 * Extends DVMJobResult with runtime and token tracking for performance monitoring.
 */
export interface TaskDelegationResult extends DVMJobResult {
  /** Execution time in milliseconds */
  runtime?: number;
  /** Token usage metrics (for AI tasks) */
  tokens?: TokenMetrics;
}

/**
 * Unsigned DVM result event template ready for signing.
 * Matches NostrEvent structure with empty signature fields.
 */
export interface DVMResultEvent {
  /** Empty string - to be filled after signing */
  id: string;
  /** Empty string - to be filled with agent pubkey before signing */
  pubkey: string;
  /** Calculated kind (request kind + 1000) */
  kind: number;
  /** Unix timestamp in seconds */
  created_at: number;
  /** Result content (may be JSON string, plain text, or base64) */
  content: string;
  /** Tags array with request, e, p, amount, status */
  tags: string[][];
  /** Empty string - to be filled after signing */
  sig: string;
}

/**
 * Error codes for DVM parsing failures.
 */
export type DVMErrorCode =
  | 'INVALID_KIND'
  | 'INVALID_INPUT_TYPE'
  | 'INVALID_BID'
  | 'MISSING_DEPENDENCY'
  | 'CIRCULAR_DEPENDENCY'
  | 'MAX_DEPTH_EXCEEDED'
  | 'INVALID_DEPENDENCY_TIMESTAMP';

/**
 * Constant object for programmatic error code access.
 */
export const DVM_ERROR_CODES = {
  INVALID_KIND: 'INVALID_KIND',
  INVALID_INPUT_TYPE: 'INVALID_INPUT_TYPE',
  INVALID_BID: 'INVALID_BID',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  CIRCULAR_DEPENDENCY: 'CIRCULAR_DEPENDENCY',
  MAX_DEPTH_EXCEEDED: 'MAX_DEPTH_EXCEEDED',
  INVALID_DEPENDENCY_TIMESTAMP: 'INVALID_DEPENDENCY_TIMESTAMP',
} as const satisfies Record<DVMErrorCode, DVMErrorCode>;

/**
 * Error thrown when DVM job request parsing fails.
 * Contains a typed error code and optional field reference.
 */
export class DVMParseError extends Error {
  readonly code: DVMErrorCode;
  readonly field?: string;

  constructor(code: DVMErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'DVMParseError';
    this.code = code;
    this.field = field;
  }
}

/**
 * NIP-90 job feedback kind constant.
 */
export const DVM_FEEDBACK_KIND = 7000;

/**
 * Valid status values for DVM job feedback events.
 * Per NIP-90 specification.
 */
export type DVMFeedbackStatus = 'payment-required' | 'processing' | 'error' | 'success' | 'partial';

/**
 * Input to the DVM feedback formatter.
 * Contains all information needed to create a feedback event.
 */
export interface DVMFeedback {
  /** Event kind (always 7000) */
  kind: 7000;
  /** Feedback status */
  status: DVMFeedbackStatus;
  /** Job request event ID being referenced */
  jobEventId: string;
  /** Requester's pubkey */
  requesterPubkey: string;
  /** Optional payment amount (for payment-required status) */
  amount?: bigint;
  /** Optional status message or error details */
  message?: string;
}

/**
 * Unsigned DVM feedback event template ready for signing.
 * Matches NostrEvent structure with empty signature fields.
 */
export interface DVMFeedbackEvent {
  /** Empty string - to be filled after signing */
  id: string;
  /** Empty string - to be filled with agent pubkey before signing */
  pubkey: string;
  /** Always 7000 */
  kind: number;
  /** Unix timestamp in seconds */
  created_at: number;
  /** Status message or error details */
  content: string;
  /** Tags array with e, p, status, amount (optional) */
  tags: string[][];
  /** Empty string - to be filled after signing */
  sig: string;
}

/**
 * Resolved dependency result containing extracted job result data.
 * Used for job chaining where one job depends on another's results.
 */
export interface ResolvedDependency {
  /** Kind of the dependency result event (6000-6999) */
  kind: number;
  /** Result content extracted from the event */
  content: string;
  /** Status of the dependency job */
  status: DVMResultStatus;
  /** Original timestamp of the dependency event */
  created_at: number;
}

/**
 * Map of dependency event IDs to their resolved results.
 * Used to pass resolved dependencies to job execution.
 */
export interface ResolvedDependencies {
  [eventId: string]: ResolvedDependency;
}

/**
 * Task state for status tracking (Story 17.8).
 * Tracks the lifecycle of a task from queuing to completion/failure.
 */
export type TaskState =
  | 'queued' // Task accepted, waiting to start
  | 'processing' // Currently executing
  | 'waiting' // Blocked on dependency (e.g., waiting for delegated task)
  | 'completed' // Successfully finished
  | 'failed' // Error occurred during execution
  | 'cancelled'; // Manually stopped or timed out

/**
 * Metadata for tracking task status locally (Story 17.8).
 * Used by TaskStatusTracker to manage task lifecycle and emit progress updates.
 */
export interface TaskTrackingMetadata {
  /** Event ID of Kind 5900 task request */
  taskId: string;
  /** Requester's pubkey */
  requesterPubkey: string;
  /** Unix timestamp when task started */
  startTime: number;
  /** Current task state */
  currentState: TaskState;
  /** Optional progress indicator (0-100) */
  progress?: number;
  /** Optional estimated seconds remaining */
  eta?: number;
  /** Unix timestamp of last Kind 7000 emission (for throttling) */
  lastUpdateTime: number;
}

/**
 * Task-specific feedback extending DVMFeedback with progress/eta (Story 17.8).
 * Used for Kind 7000 events with task tracking extensions.
 */
export interface TaskFeedback extends Omit<DVMFeedback, 'kind'> {
  /** Always 7000 */
  kind: 7000;
  /** Optional progress indicator (0-100) */
  progress?: number;
  /** Optional estimated seconds remaining */
  eta?: number;
}

/**
 * Metadata for tracking retry attempts (Story 17.9).
 * Used to record retry history for task execution failures.
 */
export interface RetryMetadata {
  /** Current attempt number (0-indexed, 0 = first attempt) */
  attemptNumber: number;
  /** Maximum number of retries allowed */
  maxRetries: number;
  /** Last error message encountered */
  lastError: string;
  /** Backoff delays used between retries (milliseconds) */
  backoffHistory: number[];
}

/**
 * Error thrown when operation exceeds timeout (Story 17.9).
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, TimeoutError.prototype);
  }
}

/**
 * Options for retry execution with exponential backoff (Story 17.9).
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base backoff delay in milliseconds (default: 1000) */
  baseBackoffMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30000) */
  maxBackoffMs?: number;
  /** Predicate to determine if error is retryable (default: always true) */
  shouldRetry?: (error: Error) => boolean;
  /** Callback invoked before each retry with attempt number and error */
  onRetry?: (attempt: number, error: Error) => void | Promise<void>;
}

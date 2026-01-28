/**
 * DVM (Data Vending Machine) Module - NIP-90 Compatibility
 *
 * This module provides parsing and formatting for NIP-90 DVM job requests and results,
 * enabling interoperability with the Nostr DVM ecosystem.
 */

// Types
export type {
  DVMJobRequest,
  DVMInput,
  DVMInputType,
  DVMErrorCode,
  DVMJobResult,
  DVMResultEvent,
  DVMResultStatus,
  DVMFeedback,
  DVMFeedbackEvent,
  DVMFeedbackStatus,
  ResolvedDependency,
  ResolvedDependencies,
  TaskPriority,
  TaskDelegationRequest,
  TaskDelegationResult,
  TokenMetrics,
  TaskState,
  TaskTrackingMetadata,
  TaskFeedback,
  RetryMetadata,
  RetryOptions,
} from './types';

// Constants and Error classes
export {
  DVM_KIND_RANGE,
  DVM_RESULT_KIND_OFFSET,
  DVM_FEEDBACK_KIND,
  DVM_ERROR_CODES,
  DVMParseError,
  TimeoutError,
} from './types';

// Parser
export { parseDVMJobRequest, parseTaskDelegationRequest } from './dvm-job-parser';

// Result formatter
export {
  formatDVMJobResult,
  formatDVMErrorResult,
  formatTaskDelegationResult,
} from './dvm-result-formatter';

// Feedback formatter
export {
  formatDVMFeedback,
  formatTaskFeedback,
  createProgressTag,
  createEtaTag,
} from './dvm-feedback';

// Job resolver (for job chaining)
export { resolveJobDependencies } from './job-resolver';

// Task status tracker (Story 17.8)
export {
  TaskStatusTracker,
  DEFAULT_TASK_TRACKING_CONFIG,
  type TaskTrackingConfig,
  type FeedbackEmitter,
} from './task-status-tracker';

// Timeout utilities (Story 17.9)
export { executeWithTimeout, createTimeoutPromise } from './timeout-utils';

// Retry utilities (Story 17.9)
export { executeWithRetry, calculateBackoff, sleep } from './retry-utils';

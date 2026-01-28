import type {
  TaskState,
  TaskTrackingMetadata,
  TaskFeedback,
  DVMFeedbackEvent,
  DVMFeedbackStatus,
} from './types';
import { formatTaskFeedback } from './dvm-feedback';

/**
 * Configuration for task status tracking (Story 17.8).
 */
export interface TaskTrackingConfig {
  /** Enable/disable task status tracking */
  enabled: boolean;
  /** Minimum milliseconds between status updates (throttle) */
  minUpdateIntervalMs: number;
  /** Emit progress updates or only state changes */
  emitProgressUpdates: boolean;
}

/**
 * Default task tracking configuration.
 */
export const DEFAULT_TASK_TRACKING_CONFIG: TaskTrackingConfig = {
  enabled: true,
  minUpdateIntervalMs: 5000, // 5 seconds
  emitProgressUpdates: true,
};

/**
 * Callback function for emitting Kind 7000 feedback events.
 * TaskStatusTracker uses this to publish events without coupling to event publishing infrastructure.
 */
export type FeedbackEmitter = (event: DVMFeedbackEvent) => void | Promise<void>;

/**
 * TaskStatusTracker manages task lifecycle and emits Kind 7000 progress updates (Story 17.8).
 *
 * Features:
 * - Tracks task state transitions (queued → processing → completed/failed)
 * - Emits Kind 7000 feedback events on state changes
 * - Supports progress (0-100) and ETA (seconds) tracking
 * - Throttles rapid updates to prevent spam
 * - In-memory task metadata storage
 *
 * @example
 * ```typescript
 * const tracker = new TaskStatusTracker(
 *   DEFAULT_TASK_TRACKING_CONFIG,
 *   (event) => publishToNostr(event)
 * );
 *
 * // Track new task
 * tracker.trackTask('task-123', {
 *   taskId: 'task-123',
 *   requesterPubkey: 'requester-pubkey',
 *   startTime: Date.now() / 1000,
 *   currentState: 'queued',
 *   lastUpdateTime: 0,
 * });
 *
 * // Update progress
 * await tracker.updateProgress('task-123', 50, 30); // 50%, 30s ETA
 *
 * // Transition state
 * await tracker.transitionState('task-123', 'completed');
 * ```
 */
export class TaskStatusTracker {
  private readonly config: TaskTrackingConfig;
  private readonly emitFeedback: FeedbackEmitter;
  private readonly tasks: Map<string, TaskTrackingMetadata>;

  /**
   * Create a new TaskStatusTracker.
   *
   * @param config - Task tracking configuration
   * @param emitFeedback - Callback to emit Kind 7000 events
   */
  constructor(config: TaskTrackingConfig, emitFeedback: FeedbackEmitter) {
    this.config = config;
    this.emitFeedback = emitFeedback;
    this.tasks = new Map();
  }

  /**
   * Start tracking a new task.
   *
   * @param taskId - Task event ID
   * @param metadata - Initial task metadata
   */
  trackTask(taskId: string, metadata: TaskTrackingMetadata): void {
    if (!this.config.enabled) {
      return;
    }

    this.tasks.set(taskId, metadata);
  }

  /**
   * Update task progress and optionally emit Kind 7000 feedback.
   *
   * Progress updates are throttled based on minUpdateIntervalMs config.
   * Updates are only emitted if emitProgressUpdates is enabled.
   *
   * @param taskId - Task event ID
   * @param progress - Progress percentage (0-100)
   * @param eta - Optional estimated seconds remaining
   * @throws Error if task ID is unknown or progress is out of range
   */
  async updateProgress(taskId: string, progress: number, eta?: number): Promise<void> {
    if (!this.config.enabled || !this.config.emitProgressUpdates) {
      return;
    }

    const metadata = this.tasks.get(taskId);
    if (!metadata) {
      throw new Error(`Unknown task ID: ${taskId}`);
    }

    // Validate progress range
    if (progress < 0 || progress > 100) {
      throw new Error(`Invalid progress value: ${progress}. Must be between 0 and 100.`);
    }

    // Throttle updates
    const now = Date.now() / 1000;
    const timeSinceLastUpdate = (now - metadata.lastUpdateTime) * 1000; // Convert to ms

    if (timeSinceLastUpdate < this.config.minUpdateIntervalMs) {
      // Update metadata but don't emit event (throttled)
      metadata.progress = progress;
      metadata.eta = eta;
      return;
    }

    // Update metadata
    metadata.progress = progress;
    metadata.eta = eta;
    metadata.lastUpdateTime = now;

    // Emit feedback event
    await this._emitStatusUpdate(metadata, 'processing');
  }

  /**
   * Transition task to a new state and emit Kind 7000 feedback.
   *
   * State transitions always emit feedback events (not throttled).
   *
   * @param taskId - Task event ID
   * @param newState - New task state
   * @throws Error if task ID is unknown
   */
  async transitionState(taskId: string, newState: TaskState): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const metadata = this.tasks.get(taskId);
    if (!metadata) {
      throw new Error(`Unknown task ID: ${taskId}`);
    }

    // Update state
    metadata.currentState = newState;
    metadata.lastUpdateTime = Date.now() / 1000;

    // Map TaskState to DVMFeedbackStatus
    const status = this._mapStateToStatus(newState);

    // Emit feedback event
    await this._emitStatusUpdate(metadata, status);

    // Clean up completed/failed/cancelled tasks
    if (newState === 'completed' || newState === 'failed' || newState === 'cancelled') {
      this.tasks.delete(taskId);
    }
  }

  /**
   * Get current metadata for a task.
   *
   * @param taskId - Task event ID
   * @returns Task metadata or undefined if not found
   */
  getTaskMetadata(taskId: string): TaskTrackingMetadata | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tracked task IDs.
   *
   * @returns Array of task event IDs
   */
  getTrackedTaskIds(): string[] {
    return Array.from(this.tasks.keys());
  }

  /**
   * Map TaskState to DVMFeedbackStatus.
   *
   * @param state - Task state
   * @returns Corresponding feedback status
   */
  private _mapStateToStatus(state: TaskState): DVMFeedbackStatus {
    switch (state) {
      case 'queued':
      case 'waiting':
        return 'processing'; // Both are "in progress" from requester perspective
      case 'processing':
        return 'processing';
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      case 'cancelled':
        return 'error'; // Treat cancellation as error with appropriate message
      default:
        return 'processing';
    }
  }

  /**
   * Emit a Kind 7000 feedback event with current task metadata.
   *
   * @param metadata - Task metadata
   * @param status - Feedback status
   */
  private async _emitStatusUpdate(
    metadata: TaskTrackingMetadata,
    status: DVMFeedbackStatus
  ): Promise<void> {
    // Generate status message based on state
    const message = this._generateStatusMessage(metadata.currentState, metadata.progress);

    // Create task feedback
    const feedback: TaskFeedback = {
      kind: 7000,
      status,
      jobEventId: metadata.taskId,
      requesterPubkey: metadata.requesterPubkey,
      progress: metadata.progress,
      eta: metadata.eta,
      message,
    };

    // Format and emit event
    const event = formatTaskFeedback(feedback);
    await this.emitFeedback(event);
  }

  /**
   * Generate a status message based on task state and progress.
   *
   * @param state - Current task state
   * @param progress - Optional progress percentage
   * @returns Status message string
   */
  private _generateStatusMessage(state: TaskState, progress?: number): string {
    switch (state) {
      case 'queued':
        return 'Task queued, waiting to start...';
      case 'processing':
        return progress !== undefined
          ? `Processing task... ${progress}% complete`
          : 'Processing task...';
      case 'waiting':
        return 'Task waiting for dependencies...';
      case 'completed':
        return 'Task completed successfully';
      case 'failed':
        return 'Task failed';
      case 'cancelled':
        return 'Task cancelled';
      default:
        return 'Task status update';
    }
  }
}

import {
  TaskStatusTracker,
  DEFAULT_TASK_TRACKING_CONFIG,
  type TaskTrackingConfig,
  type FeedbackEmitter,
} from '../task-status-tracker';
import type { TaskTrackingMetadata, DVMFeedbackEvent, TaskState } from '../types';

describe('TaskStatusTracker', () => {
  let mockEmitter: jest.MockedFunction<FeedbackEmitter>;
  let tracker: TaskStatusTracker;
  let config: TaskTrackingConfig;

  beforeEach(() => {
    mockEmitter = jest.fn();
    config = { ...DEFAULT_TASK_TRACKING_CONFIG };
    tracker = new TaskStatusTracker(config, mockEmitter);
  });

  describe('trackTask', () => {
    it('should track a new task', () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };

      // Act
      tracker.trackTask('task-123', metadata);

      // Assert
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved).toEqual(metadata);
    });

    it('should not track task when disabled', () => {
      // Arrange
      config.enabled = false;
      tracker = new TaskStatusTracker(config, mockEmitter);
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };

      // Act
      tracker.trackTask('task-123', metadata);

      // Assert
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('updateProgress', () => {
    it('should update progress and emit feedback event', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.updateProgress('task-123', 50, 30);

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.kind).toBe(7000);
      expect(event.tags).toContainEqual(['e', 'task-123']);
      expect(event.tags).toContainEqual(['p', 'requester-pubkey']);
      expect(event.tags).toContainEqual(['status', 'processing']);
      expect(event.tags).toContainEqual(['progress', '50']);
      expect(event.tags).toContainEqual(['eta', '30']);
    });

    it('should validate progress range (0-100)', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act & Assert
      await expect(tracker.updateProgress('task-123', -1)).rejects.toThrow(
        'Invalid progress value: -1'
      );
      await expect(tracker.updateProgress('task-123', 101)).rejects.toThrow(
        'Invalid progress value: 101'
      );
    });

    it('should throttle rapid updates', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: Date.now() / 1000,
      };
      tracker.trackTask('task-123', metadata);

      // Act - Update within throttle window
      await tracker.updateProgress('task-123', 25);

      // Assert - No event emitted (throttled)
      expect(mockEmitter).not.toHaveBeenCalled();

      // Check metadata was still updated
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved?.progress).toBe(25);
    });

    it('should throw error for unknown task ID', async () => {
      // Act & Assert
      await expect(tracker.updateProgress('unknown-task', 50)).rejects.toThrow(
        'Unknown task ID: unknown-task'
      );
    });

    it('should not update when disabled', async () => {
      // Arrange
      config.enabled = false;
      tracker = new TaskStatusTracker(config, mockEmitter);
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.updateProgress('task-123', 50);

      // Assert
      expect(mockEmitter).not.toHaveBeenCalled();
    });

    it('should not emit when emitProgressUpdates is false', async () => {
      // Arrange
      config.emitProgressUpdates = false;
      tracker = new TaskStatusTracker(config, mockEmitter);
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.updateProgress('task-123', 50);

      // Assert
      expect(mockEmitter).not.toHaveBeenCalled();
    });
  });

  describe('transitionState', () => {
    it('should transition to processing state', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'processing');

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.kind).toBe(7000);
      expect(event.tags).toContainEqual(['status', 'processing']);
      expect(event.content).toContain('Processing');

      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved?.currentState).toBe('processing');
    });

    it('should transition to completed state and clean up task', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'completed');

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['status', 'success']);
      expect(event.content).toContain('completed successfully');

      // Task should be cleaned up
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved).toBeUndefined();
    });

    it('should transition to failed state and clean up task', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'failed');

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['status', 'error']);
      expect(event.content).toContain('failed');

      // Task should be cleaned up
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved).toBeUndefined();
    });

    it('should transition to cancelled state and clean up task', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'cancelled');

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['status', 'error']);
      expect(event.content).toContain('cancelled');

      // Task should be cleaned up
      const retrieved = tracker.getTaskMetadata('task-123');
      expect(retrieved).toBeUndefined();
    });

    it('should transition to waiting state', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'waiting');

      // Assert
      expect(mockEmitter).toHaveBeenCalledTimes(1);
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['status', 'processing']); // waiting maps to processing
      expect(event.content).toContain('waiting for dependencies');
    });

    it('should throw error for unknown task ID', async () => {
      // Act & Assert
      await expect(tracker.transitionState('unknown-task', 'processing')).rejects.toThrow(
        'Unknown task ID: unknown-task'
      );
    });

    it('should not transition when disabled', async () => {
      // Arrange
      config.enabled = false;
      tracker = new TaskStatusTracker(config, mockEmitter);
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'processing');

      // Assert
      expect(mockEmitter).not.toHaveBeenCalled();
    });
  });

  describe('getTrackedTaskIds', () => {
    it('should return all tracked task IDs', () => {
      // Arrange
      const metadata1: TaskTrackingMetadata = {
        taskId: 'task-1',
        requesterPubkey: 'requester-1',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      const metadata2: TaskTrackingMetadata = {
        taskId: 'task-2',
        requesterPubkey: 'requester-2',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-1', metadata1);
      tracker.trackTask('task-2', metadata2);

      // Act
      const taskIds = tracker.getTrackedTaskIds();

      // Assert
      expect(taskIds).toHaveLength(2);
      expect(taskIds).toContain('task-1');
      expect(taskIds).toContain('task-2');
    });

    it('should return empty array when no tasks tracked', () => {
      // Act
      const taskIds = tracker.getTrackedTaskIds();

      // Assert
      expect(taskIds).toHaveLength(0);
    });
  });

  describe('progress and eta tag formatting', () => {
    it('should include progress tag when progress is provided', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.updateProgress('task-123', 75);

      // Assert
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['progress', '75']);
    });

    it('should include eta tag when eta is provided', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'processing',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.updateProgress('task-123', 50, 120);

      // Assert
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      expect(event.tags).toContainEqual(['eta', '120']);
    });

    it('should not include progress/eta tags when not provided', async () => {
      // Arrange
      const metadata: TaskTrackingMetadata = {
        taskId: 'task-123',
        requesterPubkey: 'requester-pubkey',
        startTime: Date.now() / 1000,
        currentState: 'queued',
        lastUpdateTime: 0,
      };
      tracker.trackTask('task-123', metadata);

      // Act
      await tracker.transitionState('task-123', 'processing');

      // Assert
      const call = mockEmitter.mock.calls[0];
      expect(call).toBeDefined();
      const event = call![0] as DVMFeedbackEvent;
      const progressTag = event.tags.find((tag) => tag[0] === 'progress');
      const etaTag = event.tags.find((tag) => tag[0] === 'eta');
      expect(progressTag).toBeUndefined();
      expect(etaTag).toBeUndefined();
    });
  });

  describe('state machine transitions', () => {
    const states: TaskState[] = [
      'queued',
      'processing',
      'waiting',
      'completed',
      'failed',
      'cancelled',
    ];

    it('should handle all valid state transitions', async () => {
      for (const state of states) {
        // Arrange
        const metadata: TaskTrackingMetadata = {
          taskId: `task-${state}`,
          requesterPubkey: 'requester-pubkey',
          startTime: Date.now() / 1000,
          currentState: 'queued',
          lastUpdateTime: 0,
        };
        tracker.trackTask(`task-${state}`, metadata);

        // Act
        await tracker.transitionState(`task-${state}`, state);

        // Assert
        expect(mockEmitter).toHaveBeenCalled();
        const calls = mockEmitter.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
        const lastCall = calls[calls.length - 1];
        expect(lastCall).toBeDefined();
        const event = lastCall![0] as DVMFeedbackEvent;
        expect(event.kind).toBe(7000);
        expect(event.tags).toContainEqual(['e', `task-${state}`]);
      }
    });
  });
});

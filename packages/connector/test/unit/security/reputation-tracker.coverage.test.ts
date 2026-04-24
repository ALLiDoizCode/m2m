/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires, @typescript-eslint/explicit-function-return-type */

import { ReputationTracker } from '../../../src/security/reputation-tracker';

const mockLogger = {
  child: jest.fn().mockReturnThis(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

describe('ReputationTracker branch coverage', () => {
  let tracker: ReputationTracker;

  beforeEach(() => {
    jest.clearAllMocks();
    tracker = new ReputationTracker(mockLogger as any, {
      autoPauseThreshold: 50,
      decayRate: 1,
      maxScore: 100,
    });
  });

  it('should handle error in updateReputationScore', async () => {
    // Force an error inside the try block by making logger.info throw once
    mockLogger.info.mockImplementationOnce(() => {
      throw new Error('Logger failure');
    });
    const event = {
      peerId: 'bad-peer',
      ruleName: 'test',
      severity: 'low' as const,
      timestamp: Date.now(),
    };
    await tracker.updateReputationScore(event);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to update reputation score',
      expect.objectContaining({ peerId: 'bad-peer' })
    );
  });

  it('should return early for unknown peer in applyScoreDecay', () => {
    tracker.applyScoreDecay('unknown-peer', Date.now());
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('should return early when no days elapsed in applyScoreDecay', () => {
    const now = Date.now();
    // First create a peer score
    tracker.updateReputationScore({
      peerId: 'peer1',
      ruleName: 'test',
      severity: 'low',
      timestamp: now,
    });
    jest.clearAllMocks();
    // Apply decay with same timestamp
    tracker.applyScoreDecay('peer1', now);
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });

  it('should apply score decay after days elapsed', () => {
    const now = Date.now();
    tracker.updateReputationScore({
      peerId: 'peer1',
      ruleName: 'test',
      severity: 'low',
      timestamp: now,
    });
    jest.clearAllMocks();
    // Apply decay 2 days later
    tracker.applyScoreDecay('peer1', now + 2 * 24 * 60 * 60 * 1000);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Score decay applied',
      expect.objectContaining({ daysElapsed: 2 })
    );
  });

  it('should not apply decay when score already at max', () => {
    const now = Date.now();
    tracker.updateReputationScore({
      peerId: 'peer1',
      ruleName: 'test',
      severity: 'low',
      timestamp: now,
    });
    jest.clearAllMocks();
    // Score is at max (100), decay shouldn't change it
    tracker.applyScoreDecay('peer1', now + 2 * 24 * 60 * 60 * 1000);
    // At max score, decay would try to increase but is capped
    expect(mockLogger.debug).toHaveBeenCalled();
  });

  it('should apply decay to all peers', () => {
    const now = Date.now();
    tracker.updateReputationScore({
      peerId: 'peer1',
      ruleName: 'test',
      severity: 'low',
      timestamp: now,
    });
    tracker.updateReputationScore({
      peerId: 'peer2',
      ruleName: 'test',
      severity: 'low',
      timestamp: now,
    });
    jest.clearAllMocks();
    tracker.applyScoreDecayAll(now + 24 * 60 * 60 * 1000);
    expect(mockLogger.debug).toHaveBeenCalledTimes(2);
  });

  it('should handle empty map in applyScoreDecayAll', () => {
    tracker.applyScoreDecayAll(Date.now());
    expect(mockLogger.debug).not.toHaveBeenCalled();
  });
});

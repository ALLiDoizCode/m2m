import pino from 'pino';
import {
  FraudDetector,
  FraudRule,
  FraudDetection,
  SettlementEvent,
  PacketEvent,
  ChannelEvent,
} from '../../../src/security/fraud-detector';

// Mock fraud rule for testing
class MockFraudRule implements FraudRule {
  name = 'MockFraudRule';
  severity = 'medium' as const;
  private shouldDetect = false;

  setShouldDetect(value: boolean): void {
    this.shouldDetect = value;
  }

  async check(_event: SettlementEvent | PacketEvent | ChannelEvent): Promise<FraudDetection> {
    if (this.shouldDetect) {
      return {
        detected: true,
        peerId: 'test-peer-123',
        details: {
          description: 'Mock fraud detected',
        },
      };
    }
    return { detected: false };
  }
}

describe('FraudDetector', () => {
  let fraudDetector: FraudDetector;
  let logger: pino.Logger;
  let mockRule: MockFraudRule;
  const peerId = 'test-peer-123';

  beforeEach(() => {
    logger = pino({ level: 'silent' });
    mockRule = new MockFraudRule();

    fraudDetector = new FraudDetector(logger, {
      enabled: true,
      autoPauseThreshold: 50,
      rules: [mockRule],
    });
  });

  describe('constructor', () => {
    it('should initialize with config', () => {
      expect(fraudDetector).toBeDefined();
    });

    it('should initialize with disabled state', () => {
      const disabledDetector = new FraudDetector(logger, {
        enabled: false,
        autoPauseThreshold: 50,
        rules: [],
      });

      expect(disabledDetector).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start fraud detection', () => {
      fraudDetector.start();

      const listenerCount = fraudDetector.listenerCount('SETTLEMENT_EVENT');
      expect(listenerCount).toBe(1);
    });

    it('should stop fraud detection and cleanup listeners', () => {
      fraudDetector.start();
      fraudDetector.stop();

      expect(fraudDetector.listenerCount('SETTLEMENT_EVENT')).toBe(0);
      expect(fraudDetector.listenerCount('PACKET_EVENT')).toBe(0);
      expect(fraudDetector.listenerCount('CHANNEL_EVENT')).toBe(0);
    });

    it('should not start when disabled', () => {
      const disabledDetector = new FraudDetector(logger, {
        enabled: false,
        autoPauseThreshold: 50,
        rules: [],
      });

      disabledDetector.start();

      expect(disabledDetector.listenerCount('SETTLEMENT_EVENT')).toBe(0);
    });
  });

  describe('analyzeEvent', () => {
    it('should analyze settlement event', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      await fraudDetector.analyzeEvent(event);
      // Should complete without error
    });

    it('should analyze packet event', async () => {
      const event: PacketEvent = {
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: Date.now(),
      };

      await fraudDetector.analyzeEvent(event);
      // Should complete without error
    });

    it('should analyze channel event', async () => {
      const event: ChannelEvent = {
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-123',
        timestamp: Date.now(),
      };

      await fraudDetector.analyzeEvent(event);
      // Should complete without error
    });

    it('should emit FRAUD_DETECTED event when fraud is detected', async () => {
      mockRule.setShouldDetect(true);

      const fraudDetectedPromise = new Promise<void>((resolve) => {
        fraudDetector.once('FRAUD_DETECTED', (event) => {
          expect(event.ruleName).toBe('MockFraudRule');
          expect(event.severity).toBe('medium');
          expect(event.peerId).toBe(peerId);
          resolve();
        });
      });

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      await fraudDetector.analyzeEvent(event);
      await fraudDetectedPromise;
    });

    it('should ignore events from paused peers', async () => {
      await fraudDetector.pausePeer(peerId, 'Test pause', 'TestRule', 'high');

      mockRule.setShouldDetect(true);

      let fraudDetected = false;
      fraudDetector.once('FRAUD_DETECTED', () => {
        fraudDetected = true;
      });

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      await fraudDetector.analyzeEvent(event);

      expect(fraudDetected).toBe(false);
    });

    it('should not analyze events when disabled', async () => {
      const disabledDetector = new FraudDetector(logger, {
        enabled: false,
        autoPauseThreshold: 50,
        rules: [mockRule],
      });

      mockRule.setShouldDetect(true);

      let fraudDetected = false;
      disabledDetector.once('FRAUD_DETECTED', () => {
        fraudDetected = true;
      });

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      await disabledDetector.analyzeEvent(event);

      expect(fraudDetected).toBe(false);
    });

    it('should continue with remaining rules if one rule fails', async () => {
      const failingRule: FraudRule = {
        name: 'FailingRule',
        severity: 'high',
        async check() {
          throw new Error('Rule evaluation failed');
        },
      };

      const workingRule: FraudRule = {
        name: 'WorkingRule',
        severity: 'medium',
        async check() {
          return { detected: false };
        },
      };

      const detector = new FraudDetector(logger, {
        enabled: true,
        autoPauseThreshold: 50,
        rules: [failingRule, workingRule],
      });

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      // Should not throw
      await expect(detector.analyzeEvent(event)).resolves.not.toThrow();
    });
  });

  describe('pausePeer', () => {
    it('should pause peer', async () => {
      await fraudDetector.pausePeer(
        peerId,
        'Critical fraud detected',
        'DoubleSpendRule',
        'critical'
      );

      expect(fraudDetector.isPeerPaused(peerId)).toBe(true);
    });

    it('should emit PEER_PAUSED event', async () => {
      const peerPausedPromise = new Promise<void>((resolve) => {
        fraudDetector.once('PEER_PAUSED', (event) => {
          expect(event.peerId).toBe(peerId);
          expect(event.reason).toBe('Test pause');
          resolve();
        });
      });

      await fraudDetector.pausePeer(peerId, 'Test pause', 'TestRule', 'high');
      await peerPausedPromise;
    });

    it('should store pause reason', async () => {
      await fraudDetector.pausePeer(peerId, 'Fraud detected', 'TestRule', 'critical');

      const pauseReason = fraudDetector.getPauseReason(peerId);
      expect(pauseReason).toBeDefined();
      expect(pauseReason?.reason).toBe('Fraud detected');
      expect(pauseReason?.ruleViolated).toBe('TestRule');
      expect(pauseReason?.severity).toBe('critical');
    });
  });

  describe('resumePeer', () => {
    it('should resume paused peer', async () => {
      await fraudDetector.pausePeer(peerId, 'Test pause', 'TestRule', 'high');
      await fraudDetector.resumePeer(peerId);

      expect(fraudDetector.isPeerPaused(peerId)).toBe(false);
    });

    it('should emit PEER_RESUMED event', async () => {
      await fraudDetector.pausePeer(peerId, 'Test pause', 'TestRule', 'high');

      const peerResumedPromise = new Promise<void>((resolve) => {
        fraudDetector.once('PEER_RESUMED', (event) => {
          expect(event.peerId).toBe(peerId);
          resolve();
        });
      });

      await fraudDetector.resumePeer(peerId);
      await peerResumedPromise;
    });

    it('should handle resume of non-paused peer gracefully', async () => {
      await expect(fraudDetector.resumePeer(peerId)).resolves.not.toThrow();
    });
  });

  describe('getPausedPeers', () => {
    it('should return empty map initially', () => {
      const pausedPeers = fraudDetector.getPausedPeers();
      expect(pausedPeers.size).toBe(0);
    });

    it('should return all paused peers', async () => {
      await fraudDetector.pausePeer('peer-1', 'Reason 1', 'Rule1', 'high');
      await fraudDetector.pausePeer('peer-2', 'Reason 2', 'Rule2', 'critical');

      const pausedPeers = fraudDetector.getPausedPeers();
      expect(pausedPeers.size).toBe(2);
      expect(pausedPeers.has('peer-1')).toBe(true);
      expect(pausedPeers.has('peer-2')).toBe(true);
    });
  });

  describe('event processing via EventEmitter', () => {
    it('should process SETTLEMENT_EVENT', async () => {
      fraudDetector.start();

      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      fraudDetector.emit('SETTLEMENT_EVENT', event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('should process PACKET_EVENT', async () => {
      fraudDetector.start();

      const event: PacketEvent = {
        type: 'packet',
        peerId,
        packetCount: 100,
        timestamp: Date.now(),
      };

      fraudDetector.emit('PACKET_EVENT', event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    it('should process CHANNEL_EVENT', async () => {
      fraudDetector.start();

      const event: ChannelEvent = {
        type: 'channel',
        peerId,
        action: 'close',
        channelId: 'channel-123',
        timestamp: Date.now(),
      };

      fraudDetector.emit('CHANNEL_EVENT', event);

      // Wait for async processing
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  });

  describe('async timeout patterns', () => {
    it('should complete event analysis within 50ms', async () => {
      const event: SettlementEvent = {
        type: 'settlement',
        peerId,
        amount: 1000,
        timestamp: Date.now(),
      };

      const startTime = Date.now();
      await fraudDetector.analyzeEvent(event);
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });

    it('should complete peer pause within 50ms', async () => {
      const startTime = Date.now();
      await fraudDetector.pausePeer(peerId, 'Test', 'Rule', 'high');
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeLessThan(50);
    });
  });
});

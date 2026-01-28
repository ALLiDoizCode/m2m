/**
 * Tests for CapabilityPublisher
 *
 * Validates that the publisher correctly generates Kind 31990 capability events
 * with all required tags, metadata, and proper signing.
 */

import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { CapabilityPublisher, type CapabilityPublisherConfig } from '../capability-publisher';
import type { SkillRegistry } from '../../ai/skill-registry';
import type { AgentEventDatabase } from '../../event-database';
import { TAG_NAMES, type AgentMetadata, type CapacityInfo } from '../types';
import type { Logger } from 'pino';

// Mock nostr-tools
jest.mock('nostr-tools', () => ({
  finalizeEvent: jest.fn(
    (event: { created_at: number; [key: string]: unknown }, _privateKey: Uint8Array) => ({
      ...event,
      id: 'test-event-id-' + event.created_at,
      pubkey: '0'.repeat(64),
      sig: 'test-signature-64-chars-hex-test-signature-64-chars-hex-test-sig',
    })
  ),
}));

describe('CapabilityPublisher', () => {
  let mockSkillRegistry: jest.Mocked<SkillRegistry>;
  let mockEventDatabase: jest.Mocked<AgentEventDatabase>;
  let mockLogger: Logger;
  let config: CapabilityPublisherConfig;

  beforeEach(() => {
    // Mock SkillRegistry
    mockSkillRegistry = {
      getSkillSummary: jest.fn(),
    } as unknown as jest.Mocked<SkillRegistry>;

    // Mock AgentEventDatabase
    mockEventDatabase = {
      storeEvent: jest.fn(),
    } as unknown as jest.Mocked<AgentEventDatabase>;

    // Mock Logger
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn(),
      trace: jest.fn(),
      silent: jest.fn(),
      level: 'info',
    } as unknown as Logger;

    // Default config
    const metadata: AgentMetadata = {
      name: 'Test Agent',
      about: 'A test agent for capability publishing',
      picture: 'https://example.com/avatar.png',
      website: 'https://example.com',
      nip05: 'test@example.com',
      lud16: 'test@getalby.com',
      capabilities: {
        languages: ['en', 'es'],
        domains: ['translation', 'qa'],
        maxContextTokens: 8000,
      },
    };

    config = {
      pubkey: '0'.repeat(64),
      privateKey: '1'.repeat(64),
      ilpAddress: 'g.agent.test',
      agentType: 'dvm',
      metadata,
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  describe('publish()', () => {
    it('should generate Kind 31990 event with all required tags', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([
        { name: 'store_note', description: 'Store a note', eventKinds: [1] },
        { name: 'query_events', description: 'Query events', eventKinds: [10000] },
      ]);

      const publisher = new CapabilityPublisher(
        config,
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      const event = await publisher.publish();

      // Verify event structure
      expect(event.kind).toBe(31990);
      expect(event.pubkey).toBe(config.pubkey);
      expect(event.id).toMatch(/^test-event-id-/);
      expect(event.sig).toMatch(/^test-signature-/);
      expect(event.created_at).toBeGreaterThan(0);

      // Verify required tags
      const tags = event.tags;
      expect(tags).toContainEqual([TAG_NAMES.IDENTIFIER, 'g.agent.test']);
      expect(tags).toContainEqual([TAG_NAMES.KIND, '1']);
      expect(tags).toContainEqual([TAG_NAMES.KIND, '10000']);
      expect(tags).toContainEqual([TAG_NAMES.NIP, '89']);
      expect(tags).toContainEqual([TAG_NAMES.NIP, '90']);
      expect(tags).toContainEqual([TAG_NAMES.NIP, 'xx1']);
      expect(tags).toContainEqual([TAG_NAMES.AGENT_TYPE, 'dvm']);
      expect(tags).toContainEqual([TAG_NAMES.ILP_ADDRESS, 'g.agent.test']);

      // Verify metadata content
      const content = JSON.parse(event.content);
      expect(content.name).toBe('Test Agent');
      expect(content.about).toBe('A test agent for capability publishing');
      expect(content.picture).toBe('https://example.com/avatar.png');
      expect(content.website).toBe('https://example.com');
      expect(content.nip05).toBe('test@example.com');
      expect(content.lud16).toBe('test@getalby.com');
      expect(content.capabilities).toEqual({
        languages: ['en', 'es'],
        domains: ['translation', 'qa'],
        maxContextTokens: 8000,
      });

      // Verify event stored
      expect(mockEventDatabase.storeEvent).toHaveBeenCalledWith(event);
    });

    it('should include capacity tags when capacity is configured', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const capacity: CapacityInfo = {
        maxConcurrent: 10,
        queueDepth: 100,
      };

      const publisher = new CapabilityPublisher(
        { ...config, capacity },
        mockSkillRegistry,
        mockEventDatabase
      );

      const event = await publisher.publish();

      expect(event.tags).toContainEqual([TAG_NAMES.CAPACITY, '10', '100']);
    });

    it('should not include capacity tags when capacity is not configured', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      const capacityTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.CAPACITY);
      expect(capacityTags).toHaveLength(0);
    });

    it('should include model tag when model is configured', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        { ...config, model: 'anthropic:claude-haiku-4-5' },
        mockSkillRegistry,
        mockEventDatabase
      );

      const event = await publisher.publish();

      expect(event.tags).toContainEqual([TAG_NAMES.MODEL, 'anthropic:claude-haiku-4-5']);
    });

    it('should not include model tag when model is not configured', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      const modelTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.MODEL);
      expect(modelTags).toHaveLength(0);
    });

    it('should include skills tag with all skill names', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([
        { name: 'store_note', description: 'Store a note', eventKinds: [1] },
        { name: 'update_follow', description: 'Update follows', eventKinds: [3] },
        { name: 'query_events', description: 'Query events', eventKinds: [10000] },
      ]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      expect(event.tags).toContainEqual([
        TAG_NAMES.SKILLS,
        'store_note',
        'update_follow',
        'query_events',
      ]);
    });

    it('should handle empty skill registry', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      // Should have no k tags
      const kindTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.KIND);
      expect(kindTags).toHaveLength(0);

      // Should have no skills tag
      const skillsTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.SKILLS);
      expect(skillsTags).toHaveLength(0);

      // Should still have required tags
      expect(event.tags).toContainEqual([TAG_NAMES.IDENTIFIER, 'g.agent.test']);
      expect(event.tags).toContainEqual([TAG_NAMES.AGENT_TYPE, 'dvm']);
    });

    it('should deduplicate event kinds from multiple skills', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([
        { name: 'skill1', description: 'Skill 1', eventKinds: [1, 3] },
        { name: 'skill2', description: 'Skill 2', eventKinds: [3, 5] },
        { name: 'skill3', description: 'Skill 3', eventKinds: [1] },
      ]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      // Should have unique, sorted kinds
      const kindTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.KIND);
      expect(kindTags).toEqual([
        [TAG_NAMES.KIND, '1'],
        [TAG_NAMES.KIND, '3'],
        [TAG_NAMES.KIND, '5'],
      ]);
    });

    it('should handle skills without eventKinds', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([
        { name: 'meta_skill', description: 'Meta skill', eventKinds: undefined },
        { name: 'store_note', description: 'Store a note', eventKinds: [1] },
      ]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      const kindTags = event.tags.filter((tag) => tag[0] === TAG_NAMES.KIND);
      expect(kindTags).toEqual([[TAG_NAMES.KIND, '1']]);
    });

    it('should handle missing optional metadata fields', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const minimalMetadata: AgentMetadata = {
        name: 'Minimal Agent',
      };

      const publisher = new CapabilityPublisher(
        { ...config, metadata: minimalMetadata },
        mockSkillRegistry,
        mockEventDatabase
      );

      const event = await publisher.publish();

      const content = JSON.parse(event.content);
      expect(content.name).toBe('Minimal Agent');
      expect(content.about).toBeUndefined();
      expect(content.picture).toBeUndefined();
      expect(content.website).toBeUndefined();
      expect(content.nip05).toBeUndefined();
      expect(content.lud16).toBeUndefined();
      expect(content.capabilities).toBeUndefined();
    });

    it('should log events during publish', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        config,
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      await publisher.publish();

      expect(mockLogger.info).toHaveBeenCalledWith('Publishing capability advertisement event');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: expect.any(String) }),
        'Capability event stored locally'
      );
    });

    it('should not fail if broadcast fails', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        config,
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      // Broadcast internally logs but doesn't throw
      const event = await publisher.publish();

      expect(event).toBeDefined();
      expect(mockEventDatabase.storeEvent).toHaveBeenCalled();
    });
  });

  describe('publishNow()', () => {
    it('should be an alias for publish()', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publishNow();

      expect(event.kind).toBe(31990);
      expect(mockEventDatabase.storeEvent).toHaveBeenCalled();
    });
  });

  describe('auto-refresh', () => {
    beforeEach(() => {
      jest.useFakeTimers({ legacyFakeTimers: false });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start auto-refresh timer when configured', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        { ...config, refreshInterval: 3600000 }, // 1 hour
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      publisher.startAutoRefresh();

      expect(mockLogger.info).toHaveBeenCalledWith(
        { intervalMs: 3600000 },
        'Starting capability auto-refresh'
      );

      // Fast-forward time
      jest.advanceTimersByTime(3600000);

      // Should have called publish once after 1 hour
      await Promise.resolve(); // Allow async operations to complete
      expect(mockEventDatabase.storeEvent).toHaveBeenCalledTimes(1);

      // Fast-forward another hour
      jest.advanceTimersByTime(3600000);
      await Promise.resolve();
      expect(mockEventDatabase.storeEvent).toHaveBeenCalledTimes(2);
    });

    it('should not start auto-refresh when refreshInterval is not configured', () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        config,
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      publisher.startAutoRefresh();

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Auto-refresh not configured (no refreshInterval)'
      );

      // Fast-forward time
      jest.advanceTimersByTime(10000000);

      // Should not have called storeEvent
      expect(mockEventDatabase.storeEvent).not.toHaveBeenCalled();
    });

    it('should warn if auto-refresh is already running', () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        { ...config, refreshInterval: 3600000 },
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      publisher.startAutoRefresh();
      publisher.startAutoRefresh(); // Second call

      expect(mockLogger.warn).toHaveBeenCalledWith('Auto-refresh already running');
    });

    it('should stop auto-refresh timer', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(
        { ...config, refreshInterval: 3600000 },
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      publisher.startAutoRefresh();
      publisher.stopAutoRefresh();

      expect(mockLogger.info).toHaveBeenCalledWith('Capability auto-refresh stopped');

      // Fast-forward time after stop
      jest.advanceTimersByTime(10000000);
      await Promise.resolve();

      // Should not have called storeEvent
      expect(mockEventDatabase.storeEvent).not.toHaveBeenCalled();
    });

    it('should handle errors during auto-refresh without crashing', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);
      mockEventDatabase.storeEvent.mockRejectedValue(new Error('Database error'));

      const publisher = new CapabilityPublisher(
        { ...config, refreshInterval: 1000 },
        mockSkillRegistry,
        mockEventDatabase,
        mockLogger
      );

      publisher.startAutoRefresh();

      // Advance timers and wait for all async operations
      await jest.advanceTimersByTimeAsync(1000);

      // Should have logged error
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(Error) }),
        'Auto-refresh publish failed'
      );

      // Should not crash - interval continues running
      const errorCalls = mockLogger.error.mock.calls.length;
      await jest.advanceTimersByTimeAsync(1000);

      // Should have logged another error (proves it's still running)
      expect(mockLogger.error.mock.calls.length).toBeGreaterThan(errorCalls);

      publisher.stopAutoRefresh();
    });
  });

  describe('event signing', () => {
    it('should sign event with private key', async () => {
      mockSkillRegistry.getSkillSummary.mockReturnValue([]);

      const publisher = new CapabilityPublisher(config, mockSkillRegistry, mockEventDatabase);

      const event = await publisher.publish();

      expect(event.sig).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.sig.length).toBeGreaterThan(0);
    });
  });

  describe('different agent types', () => {
    it.each(['dvm', 'assistant', 'specialist', 'coordinator', 'relay'] as const)(
      'should handle agent type: %s',
      async (agentType) => {
        mockSkillRegistry.getSkillSummary.mockReturnValue([]);

        const publisher = new CapabilityPublisher(
          { ...config, agentType },
          mockSkillRegistry,
          mockEventDatabase
        );

        const event = await publisher.publish();

        expect(event.tags).toContainEqual([TAG_NAMES.AGENT_TYPE, agentType]);
      }
    );
  });
});

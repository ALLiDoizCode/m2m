import { createDVMQuerySkill } from '../dvm-query-skill';
import type { SkillExecuteContext } from '../../skill-registry';
import type { NostrEvent } from '../../../toon-codec';
import type { AgentEventDatabase } from '../../../event-database';
import type { ILPPreparePacket } from '@m2m/shared';

/**
 * Helper function to create a Kind 5000 DVM query request event for testing.
 */
function createDVMQueryEvent(overrides?: Partial<NostrEvent>): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    kind: 5000,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Query my event database',
    tags: [
      ['i', 'optional-query-text', 'text'],
      ['param', 'kinds', '[1,3,7]'],
      ['param', 'authors', '["' + 'c'.repeat(64) + '"]'],
      ['param', 'limit', '50'],
    ],
    sig: 'd'.repeat(128),
    ...overrides,
  };
}

/**
 * Helper function to create a mock SkillExecuteContext for testing.
 */
function createMockContext(
  event: NostrEvent,
  queryResults: NostrEvent[] = []
): SkillExecuteContext {
  const mockDatabase: Partial<AgentEventDatabase> = {
    queryEvents: jest.fn().mockResolvedValue(queryResults),
  };

  return {
    event,
    packet: {} as ILPPreparePacket,
    amount: 100n,
    source: 'test-peer',
    agentPubkey: 'agent-pubkey',
    database: mockDatabase as AgentEventDatabase,
  };
}

describe('createDVMQuerySkill', () => {
  describe('Kind 5000 event handling', () => {
    it('should accept Kind 5000 events', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const context = createMockContext(event, []);

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(true);
    });

    it('should reject non-Kind-5000 events', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent({ kind: 5100 }); // Wrong kind
      const context = createMockContext(event, []);

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Expected Kind 5000');
    });
  });

  describe('Parameter extraction', () => {
    it('should extract kinds param from JSON array', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent({
        tags: [['param', 'kinds', '[1,3,7]']],
      });
      const context = createMockContext(event, []);

      // Act
      await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(context.database.queryEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          kinds: [1, 3, 7],
        })
      );
    });

    it('should extract limit param and enforce max results', async () => {
      // Arrange
      const skill = createDVMQuerySkill(50); // Max 50 results
      const event = createDVMQueryEvent({
        tags: [['param', 'limit', '1000']], // Request 1000
      });
      const context = createMockContext(event, []);

      // Act
      await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(context.database.queryEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 50, // Capped at 50
        })
      );
    });

    it('should handle missing param tags (use defaults)', async () => {
      // Arrange
      const skill = createDVMQuerySkill(100);
      const event = createDVMQueryEvent({
        tags: [], // No param tags
      });
      const context = createMockContext(event, []);

      // Act
      await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(context.database.queryEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 100, // Default limit
        })
      );
    });
  });

  describe('Query execution', () => {
    it('should return matching events in Kind 6000 result', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const matchingEvents: NostrEvent[] = [
        createDVMQueryEvent({ kind: 1, content: 'Note 1' }),
        createDVMQueryEvent({ kind: 1, content: 'Note 2' }),
      ];
      const context = createMockContext(event, matchingEvents);

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(true);
      expect(result.responseEvents).toHaveLength(1);
      const response = result.responseEvents![0]!;
      expect(response.kind).toBe(6000); // Kind 6000 result
      // Content should be JSON array of matching events
      const content = JSON.parse(response.content);
      expect(Array.isArray(content)).toBe(true);
      expect(content).toHaveLength(2);
    });

    it('should handle empty query results', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const context = createMockContext(event, []); // Empty results

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(true);
      expect(result.responseEvents).toHaveLength(1);
      const response = result.responseEvents![0]!;
      expect(response.kind).toBe(6000);
      const content = JSON.parse(response.content);
      expect(content).toEqual([]);
    });
  });

  describe('Kind 6000 result formatting', () => {
    it('should include amount tag with payment amount', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const context = createMockContext(event, []);
      context.amount = 500n;

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(true);
      const response = result.responseEvents![0]!;
      const amountTag = response.tags.find((t) => t[0] === 'amount');
      expect(amountTag).toEqual(['amount', '500']);
    });

    it('should include status tag with success', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const context = createMockContext(event, []);

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(true);
      const response = result.responseEvents![0]!;
      const statusTag = response.tags.find((t) => t[0] === 'status');
      expect(statusTag).toEqual(['status', 'success']);
    });
  });

  describe('Error handling', () => {
    it('should handle database query errors', async () => {
      // Arrange
      const skill = createDVMQuerySkill();
      const event = createDVMQueryEvent();
      const mockDatabase: Partial<AgentEventDatabase> = {
        queryEvents: jest.fn().mockRejectedValue(new Error('Database connection failed')),
      };
      const context: SkillExecuteContext = {
        event,
        packet: {} as ILPPreparePacket,
        amount: 100n,
        source: 'test-peer',
        agentPubkey: 'agent-pubkey',
        database: mockDatabase as AgentEventDatabase,
      };

      // Act
      const result = await skill.execute({ reason: 'test' }, context);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Database query failed');
      // Should return error result as Kind 6000
      expect(result.responseEvents).toHaveLength(1);
      const response = result.responseEvents![0]!;
      expect(response.kind).toBe(6000);
      const statusTag = response.tags.find((t) => t[0] === 'status');
      expect(statusTag).toEqual(['status', 'error']);
    });
  });
});

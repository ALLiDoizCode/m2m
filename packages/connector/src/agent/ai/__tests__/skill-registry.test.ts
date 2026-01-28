/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from 'zod';
import { SkillRegistry, type AgentSkill, type SkillExecuteContext } from '../skill-registry';
import type { NostrEvent } from '../../toon-codec';

// ============================================
// Test Utilities
// ============================================

function createTestSkill(overrides?: Partial<AgentSkill>): AgentSkill {
  return {
    name: 'test_skill',
    description: 'A test skill',
    parameters: z.object({ reason: z.string() }),
    execute: async () => ({ success: true }),
    eventKinds: [1],
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<SkillExecuteContext>): SkillExecuteContext {
  return {
    event: {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'Test',
      sig: 'c'.repeat(128),
    } as NostrEvent,
    packet: {
      type: 12,
      amount: 1000n,
      destination: 'g.agent.test',
      executionCondition: Buffer.alloc(32),
      expiresAt: new Date(),
      data: Buffer.alloc(0),
    },
    amount: 1000n,
    source: 'peer-1',
    agentPubkey: 'd'.repeat(64),
    database: {} as any,
    ...overrides,
  };
}

// ============================================
// Tests
// ============================================

describe('SkillRegistry', () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  describe('register', () => {
    it('should register a skill', () => {
      const skill = createTestSkill();
      registry.register(skill);
      expect(registry.has('test_skill')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('should throw if skill name is already registered', () => {
      registry.register(createTestSkill());
      expect(() => registry.register(createTestSkill())).toThrow('Skill already registered');
    });

    it('should register multiple skills', () => {
      registry.register(createTestSkill({ name: 'skill_a' }));
      registry.register(createTestSkill({ name: 'skill_b' }));
      expect(registry.size).toBe(2);
    });
  });

  describe('unregister', () => {
    it('should unregister a skill', () => {
      registry.register(createTestSkill());
      expect(registry.unregister('test_skill')).toBe(true);
      expect(registry.has('test_skill')).toBe(false);
    });

    it('should return false for non-existent skill', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('get', () => {
    it('should return a registered skill', () => {
      const skill = createTestSkill();
      registry.register(skill);
      expect(registry.get('test_skill')).toEqual(skill);
    });

    it('should return undefined for non-existent skill', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getSkillNames', () => {
    it('should return all skill names', () => {
      registry.register(createTestSkill({ name: 'skill_a' }));
      registry.register(createTestSkill({ name: 'skill_b' }));
      expect(registry.getSkillNames()).toEqual(['skill_a', 'skill_b']);
    });

    it('should return empty array when no skills registered', () => {
      expect(registry.getSkillNames()).toEqual([]);
    });
  });

  describe('has', () => {
    it('should return true for registered skill', () => {
      registry.register(createTestSkill());
      expect(registry.has('test_skill')).toBe(true);
    });

    it('should return false for non-existent skill', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('size', () => {
    it('should return 0 when empty', () => {
      expect(registry.size).toBe(0);
    });

    it('should return correct count after registrations', () => {
      registry.register(createTestSkill({ name: 'a' }));
      registry.register(createTestSkill({ name: 'b' }));
      registry.register(createTestSkill({ name: 'c' }));
      expect(registry.size).toBe(3);
    });

    it('should decrement after unregister', () => {
      registry.register(createTestSkill({ name: 'a' }));
      registry.register(createTestSkill({ name: 'b' }));
      registry.unregister('a');
      expect(registry.size).toBe(1);
    });
  });

  describe('getSkillsForKind', () => {
    it('should return skills for a specific event kind', () => {
      registry.register(createTestSkill({ name: 'note', eventKinds: [1] }));
      registry.register(createTestSkill({ name: 'follow', eventKinds: [3] }));
      registry.register(createTestSkill({ name: 'delete', eventKinds: [5] }));

      const kind1Skills = registry.getSkillsForKind(1);
      expect(kind1Skills).toHaveLength(1);
      expect(kind1Skills[0]!.name).toBe('note');
    });

    it('should return empty array for unmatched kind', () => {
      registry.register(createTestSkill({ name: 'note', eventKinds: [1] }));
      expect(registry.getSkillsForKind(999)).toEqual([]);
    });
  });

  describe('getSkillSummary', () => {
    it('should return summary of all skills', () => {
      registry.register(
        createTestSkill({ name: 'note', description: 'Store notes', eventKinds: [1] })
      );
      const summary = registry.getSkillSummary();
      expect(summary).toEqual([{ name: 'note', description: 'Store notes', eventKinds: [1] }]);
    });
  });

  describe('toTools', () => {
    it('should convert skills to AI SDK tools', () => {
      const executeFn = jest.fn().mockResolvedValue({ success: true });
      registry.register(createTestSkill({ execute: executeFn }));

      const context = createTestContext();
      const tools = registry.toTools(context);

      expect(tools).toHaveProperty('test_skill');
      expect(typeof tools['test_skill']).toBe('object');
    });

    it('should create tools with correct AI SDK structure', () => {
      registry.register(createTestSkill({ description: 'Test description' }));

      const context = createTestContext();
      const tools = registry.toTools(context);

      const tool = tools['test_skill'] as any;
      expect(tool).toBeDefined();
      // AI SDK CoreTool must have description, parameters, and execute
      expect(tool.description).toBe('Test description');
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeDefined();
      expect(typeof tool.execute).toBe('function');
    });

    it('should bind context to tool execute function', async () => {
      const executeFn = jest.fn().mockResolvedValue({ success: true });
      registry.register(createTestSkill({ execute: executeFn }));

      const context = createTestContext();
      const tools = registry.toTools(context);

      const tool = tools['test_skill'] as any;
      await tool.execute({ reason: 'test' });

      expect(executeFn).toHaveBeenCalledWith({ reason: 'test' }, context);
    });

    it('should return empty record when no skills registered', () => {
      const context = createTestContext();
      const tools = registry.toTools(context);
      expect(Object.keys(tools)).toHaveLength(0);
    });
  });
});

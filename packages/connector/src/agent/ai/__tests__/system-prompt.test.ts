import { SystemPromptBuilder, type PromptContext } from '../system-prompt';
import { SkillRegistry } from '../skill-registry';
import { z } from 'zod';
import type { NostrEvent } from '../../toon-codec';

function createTestPromptContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    event: {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'Hello, world!',
      sig: 'c'.repeat(128),
    } as NostrEvent,
    source: 'peer-1',
    amount: 1000n,
    destination: 'g.agent.test',
    ...overrides,
  };
}

function createTestRegistry(): SkillRegistry {
  const registry = new SkillRegistry();
  registry.register({
    name: 'store_note',
    description: 'Store a text note',
    parameters: z.object({ reason: z.string() }),
    execute: async () => ({ success: true }),
    eventKinds: [1],
  });
  registry.register({
    name: 'query_events',
    description: 'Query the event database',
    parameters: z.object({ reason: z.string() }),
    execute: async () => ({ success: true }),
    eventKinds: [10000],
  });
  return registry;
}

describe('SystemPromptBuilder', () => {
  let builder: SystemPromptBuilder;
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = createTestRegistry();
    builder = new SystemPromptBuilder({
      agentPubkey: 'a'.repeat(64),
      ilpAddress: 'g.agent.alice',
      skillRegistry: registry,
    });
  });

  describe('build', () => {
    it('should include agent identity', () => {
      const prompt = builder.build(createTestPromptContext());
      expect(prompt).toContain('a'.repeat(64));
      expect(prompt).toContain('g.agent.alice');
    });

    it('should include protocol context', () => {
      const prompt = builder.build(createTestPromptContext());
      expect(prompt).toContain('Nostr events');
      expect(prompt).toContain('ILP');
    });

    it('should include available skills', () => {
      const prompt = builder.build(createTestPromptContext());
      expect(prompt).toContain('store_note');
      expect(prompt).toContain('query_events');
      expect(prompt).toContain('Store a text note');
    });

    it('should include decision framework', () => {
      const prompt = builder.build(createTestPromptContext());
      expect(prompt).toContain('Decision Framework');
    });

    it('should include event context', () => {
      const context = createTestPromptContext();
      const prompt = builder.build(context);
      expect(prompt).toContain('Kind: 1');
      expect(prompt).toContain('peer-1');
      expect(prompt).toContain('Hello, world!');
    });

    it('should truncate long content', () => {
      const context = createTestPromptContext({
        event: {
          id: 'a'.repeat(64),
          pubkey: 'b'.repeat(64),
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [],
          content: 'x'.repeat(600),
          sig: 'c'.repeat(128),
        } as NostrEvent,
      });
      const prompt = builder.build(context);
      expect(prompt).toContain('...');
      expect(prompt).not.toContain('x'.repeat(600));
    });

    it('should include tags summary', () => {
      const context = createTestPromptContext({
        event: {
          id: 'a'.repeat(64),
          pubkey: 'b'.repeat(64),
          created_at: Math.floor(Date.now() / 1000),
          kind: 1,
          tags: [
            ['e', 'eventid123'],
            ['p', 'pubkey456'],
          ],
          content: 'Test',
          sig: 'c'.repeat(128),
        } as NostrEvent,
      });
      const prompt = builder.build(context);
      expect(prompt).toContain('Tags (2 total)');
    });
  });

  describe('personality', () => {
    it('should include personality name and role', () => {
      const personalizedBuilder = new SystemPromptBuilder({
        agentPubkey: 'a'.repeat(64),
        personality: {
          name: 'Agent Alice',
          role: 'Network relay',
          instructions: 'Be concise.',
        },
        skillRegistry: registry,
      });
      const prompt = personalizedBuilder.build(createTestPromptContext());
      expect(prompt).toContain('Agent Alice');
      expect(prompt).toContain('Network relay');
      expect(prompt).toContain('Be concise.');
    });

    it('should use defaults when no personality configured', () => {
      const prompt = builder.build(createTestPromptContext());
      expect(prompt).toContain('AI Agent');
    });
  });

  describe('buildStatic', () => {
    it('should not include event-specific context', () => {
      const staticPrompt = builder.buildStatic();
      expect(staticPrompt).toContain('Identity');
      expect(staticPrompt).toContain('store_note');
      expect(staticPrompt).not.toContain('Current Event');
    });
  });
});

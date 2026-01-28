/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
// Mock the ESM-only @toon-format/toon package
jest.mock('@toon-format/toon', () => ({
  encode: (input: unknown) => JSON.stringify(input),
  decode: (input: string) => JSON.parse(input),
}));

import { SkillRegistry } from '../skill-registry';
import { SystemPromptBuilder } from '../system-prompt';
import { TokenBudget } from '../token-budget';
import { parseAIConfig, isValidModelString, parseModelString } from '../ai-agent-config';
import { registerBuiltInSkills } from '../skills';
import type { NostrEvent } from '../../toon-codec';

// ============================================
// AI Config Tests
// ============================================

describe('AI Agent Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('parseAIConfig', () => {
    it('should return defaults when no config provided', () => {
      const config = parseAIConfig();
      expect(config.enabled).toBe(true);
      expect(config.model).toBe('anthropic:claude-haiku-4-5');
      expect(config.maxTokensPerRequest).toBe(1024);
      expect(config.budget.maxTokensPerHour).toBe(100000);
      expect(config.budget.fallbackOnExhaustion).toBe(true);
    });

    it('should override defaults with YAML config', () => {
      const config = parseAIConfig({
        enabled: false,
        model: 'openai:gpt-4o-mini',
        maxTokensPerRequest: 2048,
        budget: { maxTokensPerHour: 50000, fallbackOnExhaustion: false },
      });
      expect(config.enabled).toBe(false);
      expect(config.model).toBe('openai:gpt-4o-mini');
      expect(config.maxTokensPerRequest).toBe(2048);
      expect(config.budget.maxTokensPerHour).toBe(50000);
    });

    it('should override with environment variables', () => {
      process.env.AI_AGENT_ENABLED = 'false';
      process.env.AI_AGENT_MODEL = 'openai:gpt-4o';
      process.env.AI_MAX_TOKENS_PER_REQUEST = '512';
      process.env.AI_MAX_TOKENS_PER_HOUR = '25000';

      const config = parseAIConfig();
      expect(config.enabled).toBe(false);
      expect(config.model).toBe('openai:gpt-4o');
      expect(config.maxTokensPerRequest).toBe(512);
      expect(config.budget.maxTokensPerHour).toBe(25000);
    });

    it('should throw on invalid model format', () => {
      expect(() => parseAIConfig({ model: 'invalid' })).toThrow('Invalid AI model format');
    });

    it('should throw on zero budget', () => {
      expect(() =>
        parseAIConfig({
          budget: { maxTokensPerHour: 0, fallbackOnExhaustion: true },
        })
      ).toThrow('positive number');
    });

    it('should throw on zero maxTokensPerRequest', () => {
      expect(() => parseAIConfig({ maxTokensPerRequest: 0 })).toThrow('positive number');
    });

    it('should include personality from config', () => {
      const config = parseAIConfig({
        personality: {
          name: 'Agent Alice',
          role: 'Relay',
          instructions: 'Be brief.',
        },
      });
      expect(config.personality?.name).toBe('Agent Alice');
    });
  });

  describe('isValidModelString', () => {
    it('should accept valid provider:model strings', () => {
      expect(isValidModelString('anthropic:claude-haiku-4-5')).toBe(true);
      expect(isValidModelString('openai:gpt-4o-mini')).toBe(true);
      expect(isValidModelString('google:gemini-2.0-flash')).toBe(true);
      expect(isValidModelString('mistral:mistral-small-latest')).toBe(true);
    });

    it('should reject invalid format', () => {
      expect(isValidModelString('no-colon')).toBe(false);
      expect(isValidModelString(':model')).toBe(false);
      expect(isValidModelString('provider:')).toBe(false);
      expect(isValidModelString('')).toBe(false);
    });
  });

  describe('parseModelString', () => {
    it('should parse provider and model name', () => {
      const result = parseModelString('anthropic:claude-haiku-4-5');
      expect(result.provider).toBe('anthropic');
      expect(result.modelName).toBe('claude-haiku-4-5');
    });

    it('should handle colons in model name', () => {
      const result = parseModelString('provider:model:variant');
      expect(result.provider).toBe('provider');
      expect(result.modelName).toBe('model:variant');
    });

    it('should throw on invalid format', () => {
      expect(() => parseModelString('invalid')).toThrow('Invalid model format');
    });
  });
});

// ============================================
// Skill Registration Integration Tests
// ============================================

describe('Built-in Skills Registration', () => {
  it('should register all 6 built-in skills', () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowCount: jest.fn().mockReturnValue(0),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    expect(registry.size).toBe(6);
    expect(registry.has('store_note')).toBe(true);
    expect(registry.has('update_follow')).toBe(true);
    expect(registry.has('delete_events')).toBe(true);
    expect(registry.has('query_events')).toBe(true);
    expect(registry.has('forward_packet')).toBe(true);
    expect(registry.has('get_agent_info')).toBe(true);
  });

  it('should associate skills with correct event kinds', () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowCount: jest.fn().mockReturnValue(0),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    expect(registry.getSkillsForKind(1)).toHaveLength(1);
    expect(registry.getSkillsForKind(1)[0]!.name).toBe('store_note');

    expect(registry.getSkillsForKind(3)).toHaveLength(1);
    expect(registry.getSkillsForKind(3)[0]!.name).toBe('update_follow');

    expect(registry.getSkillsForKind(5)).toHaveLength(1);
    expect(registry.getSkillsForKind(5)[0]!.name).toBe('delete_events');

    expect(registry.getSkillsForKind(10000)).toHaveLength(1);
    expect(registry.getSkillsForKind(10000)[0]!.name).toBe('query_events');
  });
});

// ============================================
// Skill Execution Tests
// ============================================

describe('Skill Execution', () => {
  const createSkillContext = (eventOverrides?: Partial<NostrEvent>) => ({
    event: {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'Test',
      sig: 'c'.repeat(128),
      ...eventOverrides,
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
    database: {
      storeEvent: jest.fn().mockResolvedValue(undefined),
      queryEvents: jest.fn().mockResolvedValue([]),
      deleteEvents: jest.fn().mockResolvedValue(0),
    } as any,
  });

  it('store_note skill should store event in database', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const storeNote = registry.get('store_note')!;
    const context = createSkillContext();
    const result = await storeNote.execute({ reason: 'test' }, context);

    expect(result.success).toBe(true);
    expect(context.database.storeEvent).toHaveBeenCalledWith(context.event);
  });

  it('query_events skill should query database', async () => {
    const mockEvents = [{ id: 'x'.repeat(64), kind: 1, content: 'Result' }];

    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const queryEvents = registry.get('query_events')!;
    const context = createSkillContext({
      kind: 10000,
      content: JSON.stringify({ kinds: [1] }),
    });
    context.database.queryEvents.mockResolvedValue(mockEvents);

    const result = await queryEvents.execute({ reason: 'test' }, context);

    expect(result.success).toBe(true);
    expect(result.responseEvents).toEqual(mockEvents);
  });

  it('query_events skill should handle malformed filter', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const queryEvents = registry.get('query_events')!;
    const context = createSkillContext({
      kind: 10000,
      content: 'not valid json',
    });

    const result = await queryEvents.execute({ reason: 'test' }, context);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('F01');
  });

  it('delete_events skill should verify authorship', async () => {
    const authorPubkey = 'b'.repeat(64);
    const otherPubkey = 'f'.repeat(64);

    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const deleteEvents = registry.get('delete_events')!;
    const context = createSkillContext({
      kind: 5,
      pubkey: authorPubkey,
      tags: [
        ['e', 'event1'],
        ['e', 'event2'],
      ],
    });

    // event1 is authored by requester, event2 by someone else
    context.database.queryEvents.mockResolvedValue([
      { id: 'event1', pubkey: authorPubkey },
      { id: 'event2', pubkey: otherPubkey },
    ]);

    const result = await deleteEvents.execute({ reason: 'test' }, context);

    expect(result.success).toBe(true);
    // Only event1 should be deleted (author matches)
    expect(context.database.deleteEvents).toHaveBeenCalledWith(['event1']);
  });

  it('get_agent_info skill should return agent info', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest
        .fn()
        .mockReturnValue([{ pubkey: 'p1'.repeat(32), ilpAddress: 'g.agent.bob', petname: 'Bob' }]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const getAgentInfo = registry.get('get_agent_info')!;
    const context = createSkillContext();

    const result = await getAgentInfo.execute({ reason: 'test' }, context);

    expect(result.success).toBe(true);
    expect(result.responseEvent).toBeDefined();
    const info = JSON.parse(result.responseEvent!.content);
    expect(info.supportedKinds).toEqual([1, 3, 5, 10000]);
    expect(info.peers).toHaveLength(1);
    expect(info.peers[0].petname).toBe('Bob');
  });

  it('forward_packet skill should find route', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn().mockReturnValue({
        pubkey: 'target',
        ilpAddress: 'g.agent.bob',
      }),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const forwardPacket = registry.get('forward_packet')!;
    const context = createSkillContext();

    const result = await forwardPacket.execute(
      { destinationPubkey: 'target', reason: 'test' },
      context
    );

    expect(result.success).toBe(true);
  });

  it('forward_packet skill should fail when no route found', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn().mockReturnValue(undefined),
      getNextHop: jest.fn().mockReturnValue(undefined),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const forwardPacket = registry.get('forward_packet')!;
    const context = createSkillContext();

    const result = await forwardPacket.execute(
      { destinationPubkey: 'nonexistent', reason: 'test' },
      context
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('F02');
  });

  it('update_follow skill should update routing table and store event', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const updateFollow = registry.get('update_follow')!;
    const context = createSkillContext({
      kind: 3,
      tags: [['ilp', 'peer1', 'g.agent.peer1']],
    });

    const result = await updateFollow.execute({ reason: 'test' }, context);

    expect(result.success).toBe(true);
    expect(mockRouter.updateFromFollowEvent).toHaveBeenCalledWith(context.event);
    expect(context.database.storeEvent).toHaveBeenCalledWith(context.event);
  });

  it('store_note skill should handle DatabaseSizeExceededError', async () => {
    const { DatabaseSizeExceededError } = await import('../../event-database');

    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const storeNote = registry.get('store_note')!;
    const context = createSkillContext();
    context.database.storeEvent.mockRejectedValue(
      new DatabaseSizeExceededError('Database size limit exceeded')
    );

    const result = await storeNote.execute({ reason: 'test' }, context);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('T00');
    expect(result.error?.message).toContain('Storage limit exceeded');
  });

  it('forward_packet skill should use auto routing via ILP destination', async () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn().mockReturnValue('auto-peer'),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const forwardPacket = registry.get('forward_packet')!;
    const context = createSkillContext();

    const result = await forwardPacket.execute(
      { destinationPubkey: 'auto', reason: 'test' },
      context
    );

    expect(result.success).toBe(true);
    expect(mockRouter.getNextHop).toHaveBeenCalledWith('g.agent.test');
  });
});

// ============================================
// System Prompt + Skills Integration
// ============================================

describe('System Prompt with Skills', () => {
  it('should include all registered skills in prompt', () => {
    const registry = new SkillRegistry();
    const mockRouter = {
      updateFromFollowEvent: jest.fn(),
      getAllFollows: jest.fn().mockReturnValue([]),
      getFollowByPubkey: jest.fn(),
      getNextHop: jest.fn(),
    } as any;

    registerBuiltInSkills(registry, {
      followGraphRouter: mockRouter,
      registeredKinds: () => [1, 3, 5, 10000],
    });

    const builder = new SystemPromptBuilder({
      agentPubkey: 'a'.repeat(64),
      skillRegistry: registry,
    });

    const prompt = builder.buildStatic();

    expect(prompt).toContain('store_note');
    expect(prompt).toContain('update_follow');
    expect(prompt).toContain('delete_events');
    expect(prompt).toContain('query_events');
    expect(prompt).toContain('forward_packet');
    expect(prompt).toContain('get_agent_info');
  });
});

// ============================================
// Token Budget + Dispatcher Integration
// ============================================

describe('Token Budget Integration', () => {
  it('should track cumulative usage across requests', () => {
    const budget = new TokenBudget({ maxTokensPerWindow: 1000 });

    budget.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 150 });
    budget.recordUsage({ promptTokens: 200, completionTokens: 100, totalTokens: 300 });
    budget.recordUsage({ promptTokens: 150, completionTokens: 100, totalTokens: 250 });

    const status = budget.getStatus();
    expect(status.tokensUsedInWindow).toBe(700);
    expect(status.remainingTokens).toBe(300);
    expect(status.requestCount).toBe(3);
    expect(status.usagePercent).toBe(70);
  });

  it('should emit warnings at correct thresholds', () => {
    const events: string[] = [];
    const budget = new TokenBudget({
      maxTokensPerWindow: 100,
      onTelemetry: (event) => events.push(event.type),
    });

    // 80% usage
    budget.recordUsage({ promptTokens: 40, completionTokens: 40, totalTokens: 80 });
    expect(events).toContain('AI_BUDGET_WARNING');

    // Clear and test 95%
    events.length = 0;
    budget.reset();
    budget.recordUsage({ promptTokens: 48, completionTokens: 47, totalTokens: 95 });
    expect(events).toContain('AI_BUDGET_WARNING');

    // Clear and test exhaustion
    events.length = 0;
    budget.reset();
    budget.recordUsage({ promptTokens: 50, completionTokens: 50, totalTokens: 100 });
    expect(events).toContain('AI_BUDGET_EXHAUSTED');
  });
});

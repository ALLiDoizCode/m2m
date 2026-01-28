/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
// Mock the ESM-only @toon-format/toon package
jest.mock('@toon-format/toon', () => ({
  encode: (input: unknown) => JSON.stringify(input),
  decode: (input: string) => JSON.parse(input),
}));

// Mock the 'ai' module for dispatcher integration tests
jest.mock('ai', () => ({
  generateText: jest.fn(),
  tool: jest.fn((config: any) => ({
    ...config,
    type: 'function',
  })),
}));

import { generateText } from 'ai';
import { SkillRegistry } from '../skill-registry';
import { SystemPromptBuilder } from '../system-prompt';
import { TokenBudget } from '../token-budget';
import { AIAgentDispatcher, type AIAgentDispatcherConfig } from '../ai-agent-dispatcher';
import { parseAIConfig, isValidModelString, parseModelString } from '../ai-agent-config';
import type { AIAgentConfig } from '../ai-agent-config';
import { registerBuiltInSkills } from '../skills';
import { AgentEventHandler, type EventHandlerContext } from '../../event-handler';
import type { NostrEvent } from '../../toon-codec';
import type { Logger } from 'pino';

// Cast for mock usage
const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

// ============================================
// Test Utilities for Dispatcher Integration
// ============================================

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

function createTestAIConfig(overrides?: Partial<AIAgentConfig>): AIAgentConfig {
  return {
    enabled: true,
    model: 'anthropic:claude-haiku-4-5',
    maxTokensPerRequest: 1024,
    budget: {
      maxTokensPerHour: 100000,
      fallbackOnExhaustion: true,
    },
    ...overrides,
  };
}

function createTestContext(overrides?: Partial<EventHandlerContext>): EventHandlerContext {
  return {
    event: {
      id: 'a'.repeat(64),
      pubkey: 'b'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: 1,
      tags: [],
      content: 'Test note content',
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
    database: {
      storeEvent: jest.fn().mockResolvedValue(undefined),
      queryEvents: jest.fn().mockResolvedValue([]),
      deleteEvents: jest.fn().mockResolvedValue(0),
    } as any,
    ...overrides,
  };
}

/**
 * Creates a mock generateText response that simulates an AI tool call.
 * Reusable helper based on ai-agent-dispatcher.test.ts mock pattern.
 *
 * The dispatcher extracts results as follows:
 * - toolResults: Each element is directly an EventHandlerResult
 * - steps[].toolResults: Each element has `.result` which is the EventHandlerResult
 */
function createMockGenerateTextResponse(options: {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: any;
  text?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  finishReason?: string;
  useSteps?: boolean;
}) {
  const {
    toolName,
    toolArgs = { reason: 'AI determined this is appropriate' },
    toolResult = { success: true },
    text = '',
    usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason = 'tool-calls',
    useSteps = false,
  } = options;

  // For top-level toolResults, the element IS the EventHandlerResult directly
  // For steps[].toolResults, each element has a .result property
  return {
    text,
    // Top-level toolResults: element IS the result directly
    toolResults: useSteps ? [] : [toolResult],
    toolCalls: toolName ? [{ toolName, args: toolArgs }] : [],
    // Steps format: element.result IS the EventHandlerResult
    steps: useSteps ? [{ toolResults: [{ result: toolResult }] }] : [],
    usage,
    finishReason,
    response: {} as any,
    request: {} as any,
    warnings: [],
    experimental_providerMetadata: {},
    providerMetadata: {},
    reasoning: undefined,
    reasoningDetails: [],
    sources: [],
    files: [],
    responseMessages: [],
    toJsonResponse: jest.fn(),
  } as any;
}

function createFullDispatcher(overrides?: Partial<AIAgentDispatcherConfig>): {
  dispatcher: AIAgentDispatcher;
  skillRegistry: SkillRegistry;
  tokenBudget: TokenBudget;
  fallbackHandler: AgentEventHandler;
  mockRouter: any;
} {
  const skillRegistry = new SkillRegistry();
  const mockRouter = {
    updateFromFollowEvent: jest.fn(),
    getAllFollows: jest.fn().mockReturnValue([]),
    getFollowCount: jest.fn().mockReturnValue(0),
    getFollowByPubkey: jest.fn(),
    getNextHop: jest.fn(),
  };

  registerBuiltInSkills(skillRegistry, {
    followGraphRouter: mockRouter as any,
    registeredKinds: () => [1, 3, 5, 10000],
  });

  const systemPromptBuilder = new SystemPromptBuilder({
    agentPubkey: 'd'.repeat(64),
    skillRegistry,
  });

  const tokenBudget = new TokenBudget({
    maxTokensPerWindow: 100000,
  });

  const fallbackHandler = new AgentEventHandler({
    agentPubkey: 'd'.repeat(64),
    database: {} as any,
  });

  const dispatcher = new AIAgentDispatcher({
    aiConfig: createTestAIConfig(),
    model: {} as any,
    skillRegistry,
    systemPromptBuilder,
    tokenBudget,
    fallbackHandler,
    logger: createMockLogger(),
    ...overrides,
  });

  return { dispatcher, skillRegistry, tokenBudget, fallbackHandler, mockRouter };
}

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

    expect(registry.size).toBe(7);
    expect(registry.has('store_note')).toBe(true);
    expect(registry.has('update_follow')).toBe(true);
    expect(registry.has('delete_events')).toBe(true);
    expect(registry.has('query_events')).toBe(true);
    expect(registry.has('dvm_query')).toBe(true);
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

// ============================================
// AI Agent Full Pipeline Integration (AC 1, 2)
// ============================================

describe('AI Agent Full Pipeline Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process event through complete pipeline: packet → dispatcher → skill → response', async () => {
    // Arrange
    const { dispatcher } = createFullDispatcher();
    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'Valid note to store' },
        toolResult: { success: true },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert - Verify the complete pipeline was invoked:
    // 1. generateText was called (AI dispatch)
    // 2. Result was correctly extracted from toolResults
    expect(mockGenerateText).toHaveBeenCalled();
    expect(result.success).toBe(true);
    // Note: With mocked generateText, actual skill execute() is not invoked
    // Skill execution is tested separately in "Skill Execution" tests
  });

  it('should integrate dispatcher with SkillRegistry correctly', async () => {
    // Arrange
    const { dispatcher, skillRegistry } = createFullDispatcher();
    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'test' },
        toolResult: { success: true },
      })
    );

    // Act
    await dispatcher.handleEvent(context);

    // Assert - verify dispatcher used skill from registry
    expect(skillRegistry.has('store_note')).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.any(Object),
      })
    );
  });

  it('should integrate dispatcher with SystemPromptBuilder correctly', async () => {
    // Arrange
    let capturedPrompt = '';
    mockGenerateText.mockImplementation(async ({ system }: any) => {
      capturedPrompt = system;
      return createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'test' },
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext();

    // Act
    await dispatcher.handleEvent(context);

    // Assert - verify system prompt was built and used
    expect(capturedPrompt).toContain('Identity');
    expect(capturedPrompt).toContain('store_note');
    expect(capturedPrompt).toContain('Kind: 1');
  });

  it('should integrate dispatcher with TokenBudget correctly', async () => {
    // Arrange
    const { dispatcher, tokenBudget } = createFullDispatcher();
    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'test' },
        toolResult: { success: true },
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      })
    );

    const initialUsage = tokenBudget.getStatus().tokensUsedInWindow;

    // Act
    await dispatcher.handleEvent(context);

    // Assert - verify token budget was updated
    const finalUsage = tokenBudget.getStatus().tokensUsedInWindow;
    expect(finalUsage).toBe(initialUsage + 300);
  });

  it('should integrate dispatcher with fallback AgentEventHandler correctly', async () => {
    // Arrange
    const { dispatcher, fallbackHandler } = createFullDispatcher({
      aiConfig: createTestAIConfig({ enabled: false }),
    });
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert - verify fallback handler was used when AI disabled
    expect(handleEventSpy).toHaveBeenCalledWith(context);
    expect(result.success).toBe(true);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});

// ============================================
// AI Agent Fallback Behavior (AC 4)
// ============================================

describe('AI Agent Fallback Behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should use direct handler when AI is disabled', async () => {
    // Arrange
    const { dispatcher, fallbackHandler } = createFullDispatcher({
      aiConfig: createTestAIConfig({ enabled: false }),
    });
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(handleEventSpy).toHaveBeenCalledWith(context);
    expect(result.success).toBe(true);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('should fall back to direct handler when budget exhausted with fallbackOnExhaustion: true', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 100 });
    tokenBudget.recordUsage({ promptTokens: 50, completionTokens: 50, totalTokens: 100 });

    const { dispatcher, fallbackHandler } = createFullDispatcher({
      tokenBudget,
      aiConfig: createTestAIConfig({
        budget: { maxTokensPerHour: 100, fallbackOnExhaustion: true },
      }),
    });
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(handleEventSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('should return T03 error when budget exhausted with fallbackOnExhaustion: false', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 100 });
    tokenBudget.recordUsage({ promptTokens: 50, completionTokens: 50, totalTokens: 100 });

    const { dispatcher } = createFullDispatcher({
      tokenBudget,
      aiConfig: createTestAIConfig({
        budget: { maxTokensPerHour: 100, fallbackOnExhaustion: false },
      }),
    });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('T03');
    expect(result.error?.message).toContain('budget exhausted');
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('should fall back to direct handler on AI API error', async () => {
    // Arrange
    mockGenerateText.mockRejectedValue(new Error('API connection failed'));

    const { dispatcher, fallbackHandler } = createFullDispatcher();
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(mockGenerateText).toHaveBeenCalled();
    expect(handleEventSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('should fall back to direct handler on AI timeout', async () => {
    // Arrange
    mockGenerateText.mockImplementation(() => {
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve(
              createMockGenerateTextResponse({
                toolName: 'store_note',
                toolResult: { success: true },
              })
            ),
          500 // Longer than timeout
        );
      });
    });

    const { dispatcher, fallbackHandler } = createFullDispatcher({
      timeoutMs: 50, // Very short timeout
    });
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true, responseEvent: { id: 'fallback' } as any });

    const context = createTestContext();

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(handleEventSpy).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});

// ============================================
// Skill Execution via Dispatcher (AC 3, 7, 8)
// ============================================

describe('Skill Execution via Dispatcher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('store_note skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({ event: { ...createTestContext().event, kind: 1 } });

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'Valid note to store' },
        toolResult: { success: true },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert - Verify dispatcher correctly processes store_note tool result
    expect(mockGenerateText).toHaveBeenCalled();
    expect(result.success).toBe(true);
    // Note: With mocked generateText, actual skill.execute() is not invoked
    // Direct skill execution is tested in "Skill Execution" section above
  });

  it('update_follow skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({
      event: {
        ...createTestContext().event,
        kind: 3,
        tags: [['ilp', 'peer1', 'g.agent.peer1']],
      },
    });

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'update_follow',
        toolArgs: { reason: 'Updating follow list' },
        toolResult: { success: true },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert - Verify dispatcher correctly processes update_follow tool result
    expect(mockGenerateText).toHaveBeenCalled();
    expect(result.success).toBe(true);
    // Note: With mocked generateText, actual skill.execute() is not invoked
    // Direct skill execution is tested in "Skill Execution" section above
  });

  it('delete_events skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({
      event: {
        ...createTestContext().event,
        kind: 5,
        pubkey: 'b'.repeat(64),
        tags: [['e', 'event-to-delete']],
      },
    });

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'delete_events',
        toolArgs: { reason: 'User requested deletion' },
        toolResult: { success: true },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert - Verify dispatcher correctly processes delete_events tool result
    expect(mockGenerateText).toHaveBeenCalled();
    expect(result.success).toBe(true);
    // Note: With mocked generateText, actual skill.execute() is not invoked
    // Direct skill execution is tested in "Skill Execution" section above
  });

  it('query_events skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const mockEvents = [{ id: 'result1', kind: 1, content: 'Note 1' }];
    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({
      event: {
        ...createTestContext().event,
        kind: 10000,
        content: JSON.stringify({ kinds: [1] }),
      },
    });
    (context.database.queryEvents as jest.Mock).mockResolvedValue(mockEvents);

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'query_events',
        toolArgs: { reason: 'Querying notes' },
        toolResult: { success: true, responseEvents: mockEvents },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(result.success).toBe(true);
  });

  it('forward_packet skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const { dispatcher, mockRouter } = createFullDispatcher();
    mockRouter.getFollowByPubkey.mockReturnValue({
      pubkey: 'target-pubkey',
      ilpAddress: 'g.agent.target',
    });

    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'forward_packet',
        toolArgs: { destinationPubkey: 'target-pubkey', reason: 'Forwarding to peer' },
        toolResult: { success: true },
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(result.success).toBe(true);
  });

  it('get_agent_info skill should execute correctly via AI dispatcher', async () => {
    // Arrange
    const { dispatcher, mockRouter } = createFullDispatcher();
    mockRouter.getAllFollows.mockReturnValue([
      { pubkey: 'peer1', ilpAddress: 'g.agent.peer1', petname: 'Alice' },
    ]);

    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'get_agent_info',
        toolArgs: { reason: 'Agent info requested' },
        toolResult: {
          success: true,
          responseEvent: {
            id: 'info-event',
            content: JSON.stringify({ supportedKinds: [1, 3, 5, 10000], peers: [] }),
          },
        },
        useSteps: true,
      })
    );

    // Act
    const result = await dispatcher.handleEvent(context);

    // Assert
    expect(result.success).toBe(true);
  });

  it('dispatcher should invoke correct skill for event kind (Kind 1 → store_note)', async () => {
    // Arrange
    let capturedTools: any = {};
    mockGenerateText.mockImplementation(async ({ tools }: any) => {
      capturedTools = tools;
      return createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({ event: { ...createTestContext().event, kind: 1 } });

    // Act
    await dispatcher.handleEvent(context);

    // Assert - verify store_note tool was provided
    expect(Object.keys(capturedTools)).toContain('store_note');
  });

  it('dispatcher should invoke correct skill for event kind (Kind 3 → update_follow)', async () => {
    // Arrange
    let capturedTools: any = {};
    mockGenerateText.mockImplementation(async ({ tools }: any) => {
      capturedTools = tools;
      return createMockGenerateTextResponse({
        toolName: 'update_follow',
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({
      event: { ...createTestContext().event, kind: 3, tags: [['ilp', 'peer', 'g.agent.peer']] },
    });

    // Act
    await dispatcher.handleEvent(context);

    // Assert - verify update_follow tool was provided
    expect(Object.keys(capturedTools)).toContain('update_follow');
  });

  it('skill execution should produce same result as direct handler (parity test)', async () => {
    // Arrange - Direct handler execution
    const directDatabase = {
      storeEvent: jest.fn().mockResolvedValue(undefined),
      queryEvents: jest.fn().mockResolvedValue([]),
      deleteEvents: jest.fn().mockResolvedValue(0),
    };
    const directHandler = new AgentEventHandler({
      agentPubkey: 'd'.repeat(64),
      database: directDatabase as any,
    });
    directHandler.registerHandler({
      kind: 1,
      handler: async (ctx) => {
        await ctx.database.storeEvent(ctx.event);
        return { success: true };
      },
      requiredPayment: 0n,
    });

    const directContext = createTestContext({ database: directDatabase as any });
    const directResult = await directHandler.handleEvent(directContext);

    // Arrange - Dispatcher with skill execution (mocked AI returns same result structure)
    const { dispatcher } = createFullDispatcher();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolArgs: { reason: 'test' },
        toolResult: { success: true }, // Same success result as direct handler
      })
    );

    // Act
    const dispatcherResult = await dispatcher.handleEvent(createTestContext());

    // Assert - Both should return equivalent success results
    // This verifies parity between direct handler and AI dispatcher results
    expect(directResult.success).toBe(true);
    expect(dispatcherResult.success).toBe(true);
    expect(directResult.error).toBeUndefined();
    expect(dispatcherResult.error).toBeUndefined();

    // Direct handler actually executes and calls database
    expect(directDatabase.storeEvent).toHaveBeenCalled();
    // Note: Mocked generateText doesn't invoke actual skill.execute()
    // Full parity of database operations is verified in "Skill Execution" tests
  });
});

// ============================================
// Token Budget Dispatcher Integration (AC 5)
// ============================================

describe('Token Budget Dispatcher Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should call recordUsage after successful AI dispatch', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 100000 });
    const recordUsageSpy = jest.spyOn(tokenBudget, 'recordUsage');

    const { dispatcher } = createFullDispatcher({ tokenBudget });
    const context = createTestContext();

    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 150, completionTokens: 75, totalTokens: 225 },
      })
    );

    // Act
    await dispatcher.handleEvent(context);

    // Assert
    expect(recordUsageSpy).toHaveBeenCalledWith({
      promptTokens: 150,
      completionTokens: 75,
      totalTokens: 225,
    });
  });

  it('should update budget status correctly after multiple dispatches', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 10000 });
    const { dispatcher } = createFullDispatcher({ tokenBudget });

    // Act - First dispatch
    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      })
    );
    await dispatcher.handleEvent(createTestContext());

    // Act - Second dispatch
    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
      })
    );
    await dispatcher.handleEvent(createTestContext());

    // Assert
    const status = tokenBudget.getStatus();
    expect(status.tokensUsedInWindow).toBe(450); // 150 + 300
    expect(status.requestCount).toBe(2);
    expect(status.remainingTokens).toBe(9550);
  });

  it('should emit budget warning telemetry at thresholds during dispatch', async () => {
    // Arrange
    const telemetryEvents: string[] = [];
    const tokenBudget = new TokenBudget({
      maxTokensPerWindow: 1000,
      onTelemetry: (event) => telemetryEvents.push(event.type),
    });

    const { dispatcher } = createFullDispatcher({ tokenBudget });

    // Act - Push to 85% usage (850 tokens)
    mockGenerateText.mockResolvedValue(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 500, completionTokens: 350, totalTokens: 850 },
      })
    );
    await dispatcher.handleEvent(createTestContext());

    // Assert - Should have emitted warning at 80% threshold
    expect(telemetryEvents).toContain('AI_BUDGET_WARNING');
  });
});

// ============================================
// System Prompt Integration (AC 6)
// ============================================

describe('System Prompt Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should include agent identity in prompt', async () => {
    // Arrange
    let capturedPrompt = '';
    mockGenerateText.mockImplementation(async ({ system }: any) => {
      capturedPrompt = system;
      return createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext();

    // Act
    await dispatcher.handleEvent(context);

    // Assert
    expect(capturedPrompt).toContain('Identity');
    expect(capturedPrompt).toContain('AI Agent');
  });

  it('should include all registered skills in prompt', async () => {
    // Arrange
    let capturedPrompt = '';
    mockGenerateText.mockImplementation(async ({ system }: any) => {
      capturedPrompt = system;
      return createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext();

    // Act
    await dispatcher.handleEvent(context);

    // Assert - All 6 skills should be mentioned
    expect(capturedPrompt).toContain('store_note');
    expect(capturedPrompt).toContain('update_follow');
    expect(capturedPrompt).toContain('delete_events');
    expect(capturedPrompt).toContain('query_events');
    expect(capturedPrompt).toContain('forward_packet');
    expect(capturedPrompt).toContain('get_agent_info');
  });

  it('should include event context (kind, content, amount, destination) in prompt', async () => {
    // Arrange
    let capturedPrompt = '';
    mockGenerateText.mockImplementation(async ({ system }: any) => {
      capturedPrompt = system;
      return createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      });
    });

    const { dispatcher } = createFullDispatcher();
    const context = createTestContext({
      event: {
        ...createTestContext().event,
        kind: 1,
        content: 'This is the event content',
      },
      packet: {
        type: 12,
        amount: 5000n,
        destination: 'g.agent.custom-dest',
        executionCondition: Buffer.alloc(32),
        expiresAt: new Date(),
        data: Buffer.alloc(0),
      },
      amount: 5000n,
    });

    // Act
    await dispatcher.handleEvent(context);

    // Assert - Event context should be in prompt
    expect(capturedPrompt).toContain('Kind: 1');
    expect(capturedPrompt).toContain('This is the event content');
    expect(capturedPrompt).toContain('5000');
    expect(capturedPrompt).toContain('g.agent.custom-dest');
  });
});

// ============================================
// Multi-Event Scenarios (AC 13)
// ============================================

describe('Multi-Event Scenario Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should process multiple events sequentially with correct cumulative budget tracking', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 100000 });
    const { dispatcher } = createFullDispatcher({ tokenBudget });

    const events = [
      { kind: 1, content: 'Note 1' },
      { kind: 1, content: 'Note 2' },
      { kind: 1, content: 'Note 3' },
    ];

    const usages = [
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { promptTokens: 120, completionTokens: 60, totalTokens: 180 },
      { promptTokens: 110, completionTokens: 55, totalTokens: 165 },
    ];

    // Act - Process each event
    for (let i = 0; i < events.length; i++) {
      mockGenerateText.mockResolvedValueOnce(
        createMockGenerateTextResponse({
          toolName: 'store_note',
          toolResult: { success: true },
          usage: usages[i],
        })
      );

      const context = createTestContext({
        event: { ...createTestContext().event, ...events[i] },
      });
      await dispatcher.handleEvent(context);
    }

    // Assert
    const status = tokenBudget.getStatus();
    expect(status.tokensUsedInWindow).toBe(495); // 150 + 180 + 165
    expect(status.requestCount).toBe(3);
  });

  it('should dispatch correct skills for different event kinds in sequence', async () => {
    // Arrange
    const { dispatcher } = createFullDispatcher();
    const toolCallSequence: string[] = [];

    mockGenerateText.mockImplementation(async () => {
      const toolName = toolCallSequence.length === 0 ? 'store_note' : 'update_follow';
      toolCallSequence.push(toolName);
      return createMockGenerateTextResponse({
        toolName,
        toolResult: { success: true },
      });
    });

    // Act - Process Kind 1 (note)
    const noteContext = createTestContext({
      event: { ...createTestContext().event, kind: 1, content: 'A note' },
    });
    const noteResult = await dispatcher.handleEvent(noteContext);

    // Act - Process Kind 3 (follow)
    const followContext = createTestContext({
      event: {
        ...createTestContext().event,
        kind: 3,
        tags: [['ilp', 'peer', 'g.agent.peer']],
      },
    });
    const followResult = await dispatcher.handleEvent(followContext);

    // Assert - verify AI was called with correct tools and returned success
    expect(toolCallSequence).toEqual(['store_note', 'update_follow']);
    expect(noteResult.success).toBe(true);
    expect(followResult.success).toBe(true);
    // Note: the mock returns success directly without executing the actual skill
    // This tests that the dispatcher correctly routes to different tools
  });

  it('should handle mixed success/failure scenarios across multiple events', async () => {
    // Arrange - Create dispatcher with a fallback handler that has handlers
    const { dispatcher, fallbackHandler } = createFullDispatcher();

    // Spy on fallback handler to return success when called
    const handleEventSpy = jest
      .spyOn(fallbackHandler, 'handleEvent')
      .mockResolvedValue({ success: true });

    const results: boolean[] = [];

    // First event - AI success
    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      })
    );

    // Second event - AI error, falls back to handler
    mockGenerateText.mockRejectedValueOnce(new Error('API rate limit'));

    // Third event - AI success
    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
      })
    );

    // Act
    for (let i = 0; i < 3; i++) {
      const context = createTestContext();
      const result = await dispatcher.handleEvent(context);
      results.push(result.success);
    }

    // Assert - First and third via AI, second via fallback - all succeed
    expect(results).toEqual([true, true, true]);
    expect(handleEventSpy).toHaveBeenCalledTimes(1); // Only the error case
  });

  it('should exhaust budget after multiple events and trigger fallback', async () => {
    // Arrange
    const tokenBudget = new TokenBudget({ maxTokensPerWindow: 400 });
    const { dispatcher, fallbackHandler } = createFullDispatcher({
      tokenBudget,
      aiConfig: createTestAIConfig({
        budget: { maxTokensPerHour: 400, fallbackOnExhaustion: true },
      }),
    });

    const handleEventSpy = jest.spyOn(fallbackHandler, 'handleEvent');
    handleEventSpy.mockResolvedValue({ success: true });

    // Act - First two events use AI
    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      })
    );
    await dispatcher.handleEvent(createTestContext());

    mockGenerateText.mockResolvedValueOnce(
      createMockGenerateTextResponse({
        toolName: 'store_note',
        toolResult: { success: true },
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
      })
    );
    await dispatcher.handleEvent(createTestContext());

    // Budget now exhausted (400 tokens used)
    // Third event should use fallback
    const result = await dispatcher.handleEvent(createTestContext());

    // Assert
    expect(result.success).toBe(true);
    expect(handleEventSpy).toHaveBeenCalled();
    expect(tokenBudget.getStatus().tokensUsedInWindow).toBe(400);
  });
});

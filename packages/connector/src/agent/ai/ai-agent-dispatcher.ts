/**
 * AI Agent Dispatcher
 *
 * Core AI agent that uses Vercel AI SDK's generateText() with registered
 * skills to intelligently handle incoming Nostr events. Falls back to
 * direct handler dispatch when AI is unavailable, budget is exhausted,
 * or AI is disabled.
 *
 * @packageDocumentation
 */

import { generateText, type LanguageModelV1 } from 'ai';
import type { Logger } from 'pino';
import type { EventHandlerContext, EventHandlerResult, AgentEventHandler } from '../event-handler';
import type { AIAgentConfig } from './ai-agent-config';
import { SkillRegistry, type SkillExecuteContext } from './skill-registry';
import { SystemPromptBuilder, type PromptContext } from './system-prompt';
import { TokenBudget, type TokenBudgetStatus } from './token-budget';

/** Default timeout for AI requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 10000;

/** Maximum number of tool (skill) steps per event */
const MAX_SKILL_STEPS = 5;

/**
 * Configuration for the AI Agent Dispatcher.
 */
export interface AIAgentDispatcherConfig {
  /** AI configuration */
  aiConfig: AIAgentConfig;
  /** AI SDK language model instance */
  model: LanguageModelV1;
  /** Skill registry with registered skills */
  skillRegistry: SkillRegistry;
  /** System prompt builder */
  systemPromptBuilder: SystemPromptBuilder;
  /** Token budget tracker */
  tokenBudget: TokenBudget;
  /** Direct dispatch fallback handler */
  fallbackHandler: AgentEventHandler;
  /** Logger instance */
  logger?: Logger;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * AI Agent Dispatcher — the core AI-powered event handler.
 *
 * Implements the same interface as AgentEventHandler.handleEvent()
 * but uses AI to decide which skills to invoke. Falls back to
 * direct dispatch on error, budget exhaustion, or when AI is disabled.
 */
export class AIAgentDispatcher {
  private readonly _config: AIAgentConfig;
  private readonly _model: LanguageModelV1;
  private readonly _skillRegistry: SkillRegistry;
  private readonly _promptBuilder: SystemPromptBuilder;
  private readonly _tokenBudget: TokenBudget;
  private readonly _fallbackHandler: AgentEventHandler;
  private readonly _logger: Logger;
  private readonly _timeoutMs: number;

  constructor(config: AIAgentDispatcherConfig) {
    this._config = config.aiConfig;
    this._model = config.model;
    this._skillRegistry = config.skillRegistry;
    this._promptBuilder = config.systemPromptBuilder;
    this._tokenBudget = config.tokenBudget;
    this._fallbackHandler = config.fallbackHandler;
    this._timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (config.logger) {
      this._logger = config.logger.child({ component: 'AIAgentDispatcher' });
    } else {
      this._logger = {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        child: function () {
          return this;
        },
      } as unknown as Logger;
    }
  }

  /**
   * Handle an incoming event using the AI agent.
   *
   * The AI agent:
   * 1. Checks if AI dispatch is enabled and budget is available
   * 2. Builds the system prompt with event context
   * 3. Calls generateText() with registered skills as tools
   * 4. Extracts skill results into EventHandlerResult
   * 5. Falls back to direct dispatch on any failure
   *
   * @param context - Event handler context
   * @returns Handler result
   */
  async handleEvent(context: EventHandlerContext): Promise<EventHandlerResult> {
    // Check if AI is enabled
    if (!this._config.enabled) {
      this._logger.debug('AI dispatch disabled, using direct handler');
      return this._fallbackHandler.handleEvent(context);
    }

    // Check budget
    if (!this._tokenBudget.canSpend()) {
      if (this._config.budget.fallbackOnExhaustion) {
        this._logger.info('AI budget exhausted, falling back to direct handler');
        return this._fallbackHandler.handleEvent(context);
      }
      return {
        success: false,
        error: {
          code: 'T03',
          message: 'AI agent budget exhausted',
        },
      };
    }

    // Attempt AI dispatch
    try {
      return await this._dispatchWithAI(context);
    } catch (error) {
      this._logger.error({ err: error }, 'AI dispatch failed, falling back to direct handler');
      // Fall back to direct handler dispatch
      return this._fallbackHandler.handleEvent(context);
    }
  }

  /**
   * Get the current AI budget status.
   */
  getBudgetStatus(): TokenBudgetStatus {
    return this._tokenBudget.getStatus();
  }

  /**
   * Check if AI dispatch is enabled.
   */
  get isEnabled(): boolean {
    return this._config.enabled;
  }

  /**
   * Get the skill registry.
   */
  get skillRegistry(): SkillRegistry {
    return this._skillRegistry;
  }

  private async _dispatchWithAI(context: EventHandlerContext): Promise<EventHandlerResult> {
    // Build system prompt with event context
    const promptContext: PromptContext = {
      event: context.event,
      source: context.source,
      amount: context.amount,
      destination: context.packet.destination,
    };

    const systemPrompt = this._promptBuilder.build(promptContext);

    // Build skill context
    const skillContext: SkillExecuteContext = {
      ...context,
    };

    // Convert skills to AI SDK tools
    const tools = this._skillRegistry.toTools(skillContext);

    // Call AI with timeout
    const result = await Promise.race([this._callAI(systemPrompt, tools), this._createTimeout()]);

    return result;
  }

  private async _callAI(
    systemPrompt: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: Record<string, any>
  ): Promise<EventHandlerResult> {
    const response = await generateText({
      model: this._model,
      system: systemPrompt,
      prompt:
        'Process the incoming event described in the system prompt. Decide which skill to invoke and execute it.',
      tools,
      maxSteps: MAX_SKILL_STEPS,
      maxTokens: this._config.maxTokensPerRequest,
    });

    // Record token usage
    if (response.usage) {
      this._tokenBudget.recordUsage({
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        totalTokens: response.usage.totalTokens,
      });
    }

    this._logger.info(
      {
        steps: response.steps?.length ?? 0,
        toolCalls: response.toolCalls?.length ?? 0,
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
      },
      'AI dispatch completed'
    );

    // Extract result from tool calls
    return this._extractResult(response);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _extractResult(response: any): EventHandlerResult {
    // Check if any tools were called via toolResults
    const toolResults = response.toolResults;

    if (Array.isArray(toolResults) && toolResults.length > 0) {
      // Use the last tool result as the primary result
      const lastResult = toolResults[toolResults.length - 1] as unknown as EventHandlerResult;
      if (lastResult && typeof lastResult.success === 'boolean') {
        return lastResult;
      }
    }

    // Check steps for tool results
    const steps = response.steps;
    if (Array.isArray(steps)) {
      for (let i = steps.length - 1; i >= 0; i--) {
        const step = steps[i];
        if (step && Array.isArray(step.toolResults) && step.toolResults.length > 0) {
          const result = step.toolResults[step.toolResults.length - 1] as unknown as {
            result: EventHandlerResult;
          };
          if (result?.result && typeof result.result.success === 'boolean') {
            return result.result;
          }
        }
      }
    }

    // No tool was called — AI chose not to handle the event
    // This is a reasoned rejection
    const reason = response.text || 'No matching skill for this event kind';
    this._logger.info({ reason }, 'AI rejected event without calling any skill');

    return {
      success: false,
      error: {
        code: 'F99',
        message: reason,
      },
    };
  }

  private _createTimeout(): Promise<EventHandlerResult> {
    return new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`AI dispatch timed out after ${this._timeoutMs}ms`));
      }, this._timeoutMs);
    });
  }
}

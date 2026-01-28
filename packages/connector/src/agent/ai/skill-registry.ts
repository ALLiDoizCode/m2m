/**
 * Agent Skill Registry
 *
 * Manages agent skills — modular AI capabilities mapped to Nostr event kinds.
 * Each skill wraps an existing handler as an AI SDK tool() with a description,
 * Zod schema, and execute function.
 *
 * @packageDocumentation
 */

import { tool, type CoreTool } from 'ai';
import type { z } from 'zod';
import type { EventHandlerContext, EventHandlerResult } from '../event-handler';

/**
 * Context passed to skill execute functions.
 * Extends EventHandlerContext with AI-specific metadata.
 */
export interface SkillExecuteContext extends EventHandlerContext {
  /** The AI agent's reasoning for invoking this skill (from generateText) */
  reasoning?: string;
}

/**
 * Summary of a skill for system prompt generation.
 */
export interface SkillSummary {
  /** Skill name */
  name: string;
  /** AI-readable description */
  description: string;
  /** Associated Nostr event kinds */
  eventKinds?: number[];
}

/**
 * Definition of an agent skill.
 *
 * Skills are the AI agent's capabilities. Each skill wraps handler logic
 * as an AI SDK tool with:
 * - A description telling the AI when to use it
 * - A Zod schema validating inputs
 * - An execute function that performs the actual work
 */
export interface AgentSkill<T extends z.ZodTypeAny = z.ZodTypeAny> {
  /** Unique skill name (e.g., "store_note", "query_events") */
  name: string;
  /** Description for the AI — explains when and why to use this skill */
  description: string;
  /** Zod schema for skill parameters */
  parameters: T;
  /** Execute function — performs the skill's action */
  execute: (params: z.infer<T>, context: SkillExecuteContext) => Promise<EventHandlerResult>;
  /** Associated Nostr event kind(s), if any */
  eventKinds?: number[];
}

/**
 * Registry for managing agent skills.
 *
 * Skills are registered by name and can be converted to AI SDK tools
 * for use with generateText(). The registry supports dynamic registration
 * for extensibility — future NIPs can add new skills at runtime.
 */
export class SkillRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly _skills: Map<string, AgentSkill<any>> = new Map();

  /**
   * Register a skill.
   *
   * @param skill - The skill to register
   * @throws Error if a skill with the same name is already registered
   */
  register<T extends z.ZodTypeAny>(skill: AgentSkill<T>): void {
    if (this._skills.has(skill.name)) {
      throw new Error(`Skill already registered: ${skill.name}`);
    }
    this._skills.set(skill.name, skill);
  }

  /**
   * Unregister a skill by name.
   *
   * @param name - Skill name to remove
   * @returns true if skill was removed
   */
  unregister(name: string): boolean {
    return this._skills.delete(name);
  }

  /**
   * Get a skill by name.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  get(name: string): AgentSkill<any> | undefined {
    return this._skills.get(name);
  }

  /**
   * Check if a skill is registered.
   */
  has(name: string): boolean {
    return this._skills.has(name);
  }

  /**
   * Get all registered skill names.
   */
  getSkillNames(): string[] {
    return Array.from(this._skills.keys());
  }

  /**
   * Get the number of registered skills.
   */
  get size(): number {
    return this._skills.size;
  }

  /**
   * Convert all registered skills to AI SDK tools.
   *
   * Creates a tools record suitable for passing to generateText().
   * Each tool's execute function is bound to the provided context,
   * so the AI can invoke skills that access the event database,
   * follow graph, etc.
   *
   * @param context - The current event handling context
   * @returns Record of AI SDK tools keyed by skill name
   */
  toTools(context: SkillExecuteContext): Record<string, CoreTool> {
    const tools: Record<string, CoreTool> = {};

    for (const [name, skill] of this._skills) {
      tools[name] = tool({
        description: skill.description,
        parameters: skill.parameters,
        execute: async (params) => {
          const result = await skill.execute(params, context);
          return result;
        },
      });
    }

    return tools;
  }

  /**
   * Get skills associated with a specific Nostr event kind.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSkillsForKind(kind: number): AgentSkill<any>[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const skills: AgentSkill<any>[] = [];
    for (const skill of this._skills.values()) {
      if (skill.eventKinds?.includes(kind)) {
        skills.push(skill);
      }
    }
    return skills;
  }

  /**
   * Get a summary of all skills for system prompt generation.
   */
  getSkillSummary(): SkillSummary[] {
    return Array.from(this._skills.values()).map((skill) => ({
      name: skill.name,
      description: skill.description,
      eventKinds: skill.eventKinds,
    }));
  }
}

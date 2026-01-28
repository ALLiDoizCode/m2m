/**
 * System Prompt Builder
 *
 * Constructs the system prompt that defines the AI agent's identity,
 * behavior, and decision framework. The static portion is kept under
 * 2000 tokens. Dynamic context (event details, source peer, payment)
 * is appended per request.
 *
 * @packageDocumentation
 */

import type { AIAgentPersonality } from './ai-agent-config';
import type { SkillRegistry } from './skill-registry';
import type { NostrEvent } from '../toon-codec';

/**
 * Dynamic context appended to the system prompt for each request.
 */
export interface PromptContext {
  /** The incoming Nostr event */
  event: NostrEvent;
  /** Source peer identifier */
  source: string;
  /** Payment amount */
  amount: bigint;
  /** ILP destination address */
  destination: string;
}

/**
 * Builds system prompts for the AI agent.
 */
export class SystemPromptBuilder {
  private readonly _agentPubkey: string;
  private readonly _ilpAddress?: string;
  private readonly _personality?: AIAgentPersonality;
  private readonly _skillRegistry: SkillRegistry;

  constructor(config: {
    agentPubkey: string;
    ilpAddress?: string;
    personality?: AIAgentPersonality;
    skillRegistry: SkillRegistry;
  }) {
    this._agentPubkey = config.agentPubkey;
    this._ilpAddress = config.ilpAddress;
    this._personality = config.personality;
    this._skillRegistry = config.skillRegistry;
  }

  /**
   * Build the complete system prompt for a request.
   *
   * @param context - Dynamic context for the current event
   * @returns Complete system prompt string
   */
  build(context: PromptContext): string {
    const parts: string[] = [];

    // Agent identity
    parts.push(this._buildIdentity());

    // Role and protocol context
    parts.push(this._buildProtocolContext());

    // Available skills
    parts.push(this._buildSkillsSection());

    // Decision framework
    parts.push(this._buildDecisionFramework());

    // Personality instructions
    if (this._personality?.instructions) {
      parts.push(`## Instructions\n${this._personality.instructions}`);
    }

    // Dynamic event context
    parts.push(this._buildEventContext(context));

    return parts.join('\n\n');
  }

  /**
   * Build just the static portion (for token counting / caching).
   */
  buildStatic(): string {
    const parts: string[] = [];
    parts.push(this._buildIdentity());
    parts.push(this._buildProtocolContext());
    parts.push(this._buildSkillsSection());
    parts.push(this._buildDecisionFramework());
    if (this._personality?.instructions) {
      parts.push(`## Instructions\n${this._personality.instructions}`);
    }
    return parts.join('\n\n');
  }

  private _buildIdentity(): string {
    const name = this._personality?.name || 'AI Agent';
    const role = this._personality?.role || 'ILP connector and Nostr event relay';
    const lines = [
      `## Identity`,
      `You are ${name}, a ${role}.`,
      `Your Nostr pubkey: ${this._agentPubkey}`,
    ];
    if (this._ilpAddress) {
      lines.push(`Your ILP address: ${this._ilpAddress}`);
    }
    return lines.join('\n');
  }

  private _buildProtocolContext(): string {
    return [
      `## Protocol Context`,
      `You process Nostr events carried inside ILP (Interledger Protocol) packets.`,
      `Each incoming event arrives with a payment. Your job is to:`,
      `1. Examine the event kind, content, and metadata`,
      `2. Decide which skill(s) to invoke to handle it`,
      `3. Return the result so it can be sent back as an ILP Fulfill or Reject`,
      ``,
      `Event kinds you may receive: 1 (text note), 3 (follow list), 5 (deletion), 10000 (query).`,
      `Unknown kinds should be rejected with a clear reason.`,
    ].join('\n');
  }

  private _buildSkillsSection(): string {
    const skills = this._skillRegistry.getSkillSummary();
    const lines = [
      `## Available Skills`,
      `You have the following skills. Call exactly one skill per event unless composition is needed:`,
    ];

    for (const skill of skills) {
      const kinds = skill.eventKinds?.length ? ` (Kind ${skill.eventKinds.join(', ')})` : '';
      lines.push(`- **${skill.name}**${kinds}: ${skill.description}`);
    }

    return lines.join('\n');
  }

  private _buildDecisionFramework(): string {
    return [
      `## Decision Framework`,
      `1. If the event kind matches a skill's event kinds, use that skill.`,
      `2. If the event should be relayed to another agent, use forward_packet.`,
      `3. If you cannot handle the event kind, do NOT call any skill. Instead, provide a text explanation of why the event cannot be handled.`,
      `4. Prefer local handling over forwarding unless the event is clearly addressed to another agent.`,
      `5. Always invoke exactly one skill for standard events. Only compose multiple skills if the situation requires it.`,
    ].join('\n');
  }

  private _buildEventContext(context: PromptContext): string {
    const lines = [
      `## Current Event`,
      `- Kind: ${context.event.kind}`,
      `- Author pubkey: ${context.event.pubkey}`,
      `- Event ID: ${context.event.id}`,
      `- Created at: ${new Date(context.event.created_at * 1000).toISOString()}`,
      `- Source peer: ${context.source}`,
      `- Payment amount: ${context.amount.toString()}`,
      `- ILP destination: ${context.destination}`,
    ];

    // Include content preview (truncated for large content)
    const content = context.event.content;
    if (content.length > 0) {
      const preview = content.length > 500 ? content.substring(0, 500) + '...' : content;
      lines.push(`- Content: ${preview}`);
    }

    // Include tags summary
    if (context.event.tags.length > 0) {
      const tagSummary = context.event.tags
        .slice(0, 10)
        .map((t) => `[${t.join(', ')}]`)
        .join(', ');
      lines.push(
        `- Tags (${context.event.tags.length} total): ${tagSummary}${context.event.tags.length > 10 ? '...' : ''}`
      );
    }

    return lines.join('\n');
  }
}

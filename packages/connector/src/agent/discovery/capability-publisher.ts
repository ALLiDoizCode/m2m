/**
 * Capability Publisher for Agent Society Protocol
 *
 * Publishes Kind 31990 capability advertisement events to enable agent discovery.
 * Generates capability events from skill registry, agent configuration, and pricing settings.
 *
 * @packageDocumentation
 */

import { finalizeEvent } from 'nostr-tools';
import type { EventTemplate } from 'nostr-tools';
import type { NostrEvent } from '../toon-codec';
import type { AgentEventDatabase } from '../event-database';
import type { SkillRegistry } from '../ai/skill-registry';
import type { Logger } from 'pino';
import { TAG_NAMES, type AgentType, type AgentMetadata, type CapacityInfo } from './types';

/**
 * Configuration for the capability publisher
 */
export interface CapabilityPublisherConfig {
  /** Agent's Nostr public key (64-character hex) */
  pubkey: string;
  /** Agent's Nostr private key (64-character hex) for signing events */
  privateKey: string;
  /** ILP address of this agent (used as identifier d tag) */
  ilpAddress: string;
  /** Agent type classification */
  agentType: AgentType;
  /** Agent metadata (name, about, picture, etc.) */
  metadata: AgentMetadata;
  /** Optional capacity information */
  capacity?: CapacityInfo;
  /** Optional AI model identifier */
  model?: string;
  /** Optional auto-refresh interval in milliseconds (default: no auto-refresh) */
  refreshInterval?: number;
}

/**
 * Capability Publisher
 *
 * Publishes Kind 31990 capability advertisement events containing:
 * - Supported event kinds from skill registry
 * - Pricing information per kind
 * - Agent capacity and metadata
 * - NIP support declarations
 *
 * Events are signed with the agent's private key, stored locally,
 * and can be broadcast to relays or forwarded via ILP.
 */
export class CapabilityPublisher {
  private readonly _config: CapabilityPublisherConfig;
  private readonly _skillRegistry: SkillRegistry;
  private readonly _eventDatabase: AgentEventDatabase;
  private readonly _logger?: Logger;
  private _refreshTimer?: NodeJS.Timeout;

  constructor(
    config: CapabilityPublisherConfig,
    skillRegistry: SkillRegistry,
    eventDatabase: AgentEventDatabase,
    logger?: Logger
  ) {
    this._config = config;
    this._skillRegistry = skillRegistry;
    this._eventDatabase = eventDatabase;
    this._logger = logger;
  }

  /**
   * Publish capability advertisement event (Kind 31990)
   *
   * Generates a capability event from the current skill registry state,
   * signs it, stores it locally, and broadcasts to the network.
   *
   * @returns The published NostrEvent
   */
  async publish(): Promise<NostrEvent> {
    this._logger?.info('Publishing capability advertisement event');

    // Extract supported kinds from skill registry
    const skillSummaries = this._skillRegistry.getSkillSummary();
    const supportedKinds = this._extractSupportedKinds(skillSummaries);

    // Build event tags
    const tags: string[][] = [
      [TAG_NAMES.IDENTIFIER, this._config.ilpAddress],
      ...supportedKinds.map((k) => [TAG_NAMES.KIND, k.toString()]),
      [TAG_NAMES.NIP, '89'],
      [TAG_NAMES.NIP, '90'],
      [TAG_NAMES.NIP, 'xx1'],
      [TAG_NAMES.AGENT_TYPE, this._config.agentType],
      [TAG_NAMES.ILP_ADDRESS, this._config.ilpAddress],
      ...this._buildPricingTags(),
      ...this._buildCapacityTags(),
    ];

    // Add optional model tag
    if (this._config.model) {
      tags.push([TAG_NAMES.MODEL, this._config.model]);
    }

    // Add optional skills tags
    const skillNames = skillSummaries.map((s) => s.name);
    if (skillNames.length > 0) {
      tags.push([TAG_NAMES.SKILLS, ...skillNames]);
    }

    // Build metadata content
    const content = JSON.stringify(this._buildMetadata());

    // Create unsigned event template
    const eventTemplate: EventTemplate = {
      kind: 31990,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content,
    };

    // Sign event with nostr-tools
    const signedEvent = this._signEvent(eventTemplate);

    // Store locally
    await this._eventDatabase.storeEvent(signedEvent);
    this._logger?.info({ eventId: signedEvent.id }, 'Capability event stored locally');

    // Broadcast to network (best effort - don't fail publish on broadcast error)
    await this._broadcast(signedEvent);

    return signedEvent;
  }

  /**
   * Manually trigger capability event publication
   *
   * Alias for publish() for explicit manual trigger use case
   */
  async publishNow(): Promise<NostrEvent> {
    return this.publish();
  }

  /**
   * Start auto-refresh timer if refreshInterval is configured
   *
   * Automatically republishes capability events at the configured interval.
   * Call this after publisher initialization to enable auto-refresh.
   */
  startAutoRefresh(): void {
    if (!this._config.refreshInterval) {
      this._logger?.debug('Auto-refresh not configured (no refreshInterval)');
      return;
    }

    if (this._refreshTimer) {
      this._logger?.warn('Auto-refresh already running');
      return;
    }

    this._logger?.info(
      { intervalMs: this._config.refreshInterval },
      'Starting capability auto-refresh'
    );

    this._refreshTimer = setInterval(() => {
      this.publish().catch((error) => {
        this._logger?.error({ error }, 'Auto-refresh publish failed');
      });
    }, this._config.refreshInterval);
  }

  /**
   * Stop auto-refresh timer
   *
   * Call this during shutdown to cleanup the refresh timer.
   */
  stopAutoRefresh(): void {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = undefined;
      this._logger?.info('Capability auto-refresh stopped');
    }
  }

  /**
   * Extract unique supported event kinds from skill summaries
   */
  private _extractSupportedKinds(
    skillSummaries: Array<{ name: string; description: string; eventKinds?: number[] }>
  ): number[] {
    const kinds = new Set<number>();
    for (const skill of skillSummaries) {
      if (skill.eventKinds) {
        for (const kind of skill.eventKinds) {
          kinds.add(kind);
        }
      }
    }
    return Array.from(kinds).sort((a, b) => a - b);
  }

  /**
   * Build pricing tags from skill registry
   *
   * Generates pricing tags for each skill that has pricing information.
   * Format: ['pricing', kind, amount, currency]
   */
  private _buildPricingTags(): string[][] {
    const tags: string[][] = [];

    // For now, we don't have pricing in the skill interface
    // This will be implemented in Story 18.3
    // Return empty array for now

    return tags;
  }

  /**
   * Build capacity tags from agent config
   *
   * Format: ['capacity', maxConcurrent, queueDepth]
   */
  private _buildCapacityTags(): string[][] {
    if (!this._config.capacity) {
      return [];
    }

    return [
      [
        TAG_NAMES.CAPACITY,
        this._config.capacity.maxConcurrent.toString(),
        this._config.capacity.queueDepth.toString(),
      ],
    ];
  }

  /**
   * Build metadata object for event content field
   */
  private _buildMetadata(): AgentMetadata {
    return {
      name: this._config.metadata.name,
      about: this._config.metadata.about,
      picture: this._config.metadata.picture,
      website: this._config.metadata.website,
      nip05: this._config.metadata.nip05,
      lud16: this._config.metadata.lud16,
      capabilities: this._config.metadata.capabilities,
    };
  }

  /**
   * Sign event with agent's private key using nostr-tools
   */
  private _signEvent(eventTemplate: EventTemplate): NostrEvent {
    // Convert private key from hex to Uint8Array
    const privateKeyBytes = new Uint8Array(
      this._config.privateKey.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    // Sign and finalize event
    const signedEvent = finalizeEvent(eventTemplate, privateKeyBytes);

    return {
      id: signedEvent.id,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      kind: signedEvent.kind,
      tags: signedEvent.tags,
      content: signedEvent.content,
      sig: signedEvent.sig,
    };
  }

  /**
   * Broadcast event to network (best effort)
   *
   * Currently logs intent to broadcast. Future implementations will:
   * - Forward to followed agents via ILP
   * - Publish to configured Nostr relays via WebSocket
   *
   * Errors are logged but do not fail the publish operation.
   */
  private async _broadcast(event: NostrEvent): Promise<void> {
    try {
      this._logger?.debug({ eventId: event.id }, 'Broadcasting capability event (not implemented)');
      // TODO Story 18.8: Integrate with FollowGraphRouter to forward to peers
      // TODO: Implement relay broadcast via WebSocket connections
    } catch (error) {
      this._logger?.error({ error, eventId: event.id }, 'Broadcast failed (non-fatal)');
    }
  }
}

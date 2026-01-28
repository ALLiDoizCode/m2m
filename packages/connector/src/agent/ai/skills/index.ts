/**
 * Built-in Agent Skills
 *
 * Registers all built-in skills with the SkillRegistry.
 * Each skill wraps an existing event handler as an AI SDK tool.
 */

import type { SkillRegistry } from '../skill-registry';
import type { FollowGraphRouter } from '../../follow-graph-router';
import { createStoreNoteSkill } from './store-note-skill';
import { createUpdateFollowSkill } from './update-follow-skill';
import { createDeleteEventsSkill } from './delete-events-skill';
import { createQueryEventsSkill } from './query-events-skill';
import { createForwardPacketSkill } from './forward-packet-skill';
import { createGetAgentInfoSkill } from './get-agent-info-skill';

export interface RegisterSkillsConfig {
  followGraphRouter: FollowGraphRouter;
  registeredKinds: () => number[];
  queryMaxResults?: number;
}

/**
 * Register all built-in agent skills with the skill registry.
 *
 * @param registry - SkillRegistry to register skills with
 * @param config - Configuration providing dependencies for skills
 */
export function registerBuiltInSkills(registry: SkillRegistry, config: RegisterSkillsConfig): void {
  registry.register(createStoreNoteSkill());
  registry.register(createUpdateFollowSkill(config.followGraphRouter));
  registry.register(createDeleteEventsSkill());
  registry.register(createQueryEventsSkill(config.queryMaxResults));
  registry.register(createForwardPacketSkill(config.followGraphRouter));
  registry.register(createGetAgentInfoSkill(config.followGraphRouter, config.registeredKinds));
}

// Re-export individual skill creators for custom registration
export { createStoreNoteSkill } from './store-note-skill';
export { createUpdateFollowSkill } from './update-follow-skill';
export { createDeleteEventsSkill } from './delete-events-skill';
export { createQueryEventsSkill } from './query-events-skill';
export { createForwardPacketSkill } from './forward-packet-skill';
export { createGetAgentInfoSkill } from './get-agent-info-skill';

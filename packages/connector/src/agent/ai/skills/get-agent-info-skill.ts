/**
 * Get Agent Info Skill
 *
 * Returns information about this agent's capabilities, identity,
 * and connected peers. Used for agent introspection.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import type { FollowGraphRouter } from '../../follow-graph-router';

const GetAgentInfoParams = z.object({
  reason: z.string().describe('Brief reason for requesting agent info'),
});

export function createGetAgentInfoSkill(
  followGraphRouter: FollowGraphRouter,
  registeredKinds: () => number[]
): AgentSkill<typeof GetAgentInfoParams> {
  return {
    name: 'get_agent_info',
    description:
      'Get information about this agent including its identity, ' +
      'supported event kinds, connected peers, and capabilities. ' +
      'Use this when you need to understand what this agent can do ' +
      'or check connectivity status.',
    parameters: GetAgentInfoParams,
    execute: async (
      _params: z.infer<typeof GetAgentInfoParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      const follows = followGraphRouter.getAllFollows();
      const kinds = registeredKinds();

      const info = {
        agentPubkey: context.agentPubkey,
        supportedKinds: kinds,
        followCount: follows.length,
        peers: follows.map((f) => ({
          pubkey: f.pubkey,
          ilpAddress: f.ilpAddress,
          petname: f.petname,
        })),
      };

      // Return info as a response event
      const responseEvent = {
        id: '0'.repeat(64),
        pubkey: context.agentPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 10001,
        tags: [],
        content: JSON.stringify(info),
        sig: '0'.repeat(128),
      };

      return {
        success: true,
        responseEvent,
      };
    },
  };
}

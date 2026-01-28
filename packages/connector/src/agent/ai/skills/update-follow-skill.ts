/**
 * Update Follow Skill (Kind 3)
 *
 * Updates the agent's follow graph and routing table from Kind 3 follow list events.
 * Wraps the existing Kind 3 follow handler logic.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import type { FollowGraphRouter } from '../../follow-graph-router';

const UpdateFollowParams = z.object({
  reason: z.string().describe('Brief reason for processing this follow update'),
});

export function createUpdateFollowSkill(
  followGraphRouter: FollowGraphRouter
): AgentSkill<typeof UpdateFollowParams> {
  return {
    name: 'update_follow',
    description:
      'Process a Kind 3 follow list event to update the routing table. ' +
      "This updates the agent's social graph and ILP routing based on the follow list. " +
      'Use this when receiving a valid Kind 3 Nostr event.',
    parameters: UpdateFollowParams,
    eventKinds: [3],
    execute: async (
      _params: z.infer<typeof UpdateFollowParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      if (context.event.kind !== 3) {
        return {
          success: false,
          error: {
            code: 'F99',
            message: `Expected Kind 3 event, got Kind ${context.event.kind}`,
          },
        };
      }

      followGraphRouter.updateFromFollowEvent(context.event);
      await context.database.storeEvent(context.event);

      return { success: true };
    },
  };
}

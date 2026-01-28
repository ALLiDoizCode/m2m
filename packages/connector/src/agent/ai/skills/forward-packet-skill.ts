/**
 * Forward Packet Skill
 *
 * Forwards an ILP packet to a peer via the follow graph router.
 * Used when the AI agent decides the event should be relayed to
 * another agent rather than handled locally.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import type { FollowGraphRouter } from '../../follow-graph-router';

const ForwardPacketParams = z.object({
  destinationPubkey: z
    .string()
    .describe('The Nostr pubkey of the target agent to forward to, or "auto" to use routing table'),
  reason: z.string().describe('Brief reason for forwarding this event'),
});

export function createForwardPacketSkill(
  followGraphRouter: FollowGraphRouter
): AgentSkill<typeof ForwardPacketParams> {
  return {
    name: 'forward_packet',
    description:
      'Forward the incoming event to another agent via the follow graph routing table. ' +
      'Use this when the event is not meant for local handling and should be relayed ' +
      'to a peer. Set destinationPubkey to the target agent\'s Nostr pubkey, or "auto" ' +
      'to let the routing table decide based on the ILP destination address.',
    parameters: ForwardPacketParams,
    execute: async (
      params: z.infer<typeof ForwardPacketParams>,
      _context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      // Look up the next hop for forwarding
      let nextHop;
      if (params.destinationPubkey === 'auto') {
        // Use ILP destination from packet for routing
        nextHop = followGraphRouter.getNextHop(_context.packet.destination);
      } else {
        // Look up by pubkey
        nextHop = followGraphRouter.getFollowByPubkey(params.destinationPubkey);
      }

      if (!nextHop) {
        return {
          success: false,
          error: {
            code: 'F02',
            message: `No route found for forwarding${params.destinationPubkey !== 'auto' ? ` to ${params.destinationPubkey}` : ''}`,
          },
        };
      }

      // In MVP, forwarding is informational — the connector routing layer
      // handles actual packet forwarding. This skill signals intent.
      return {
        success: true,
      };
    },
  };
}

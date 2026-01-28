/**
 * Delete Events Skill (Kind 5)
 *
 * Deletes events from the database following NIP-09 deletion requests.
 * Verifies authorship before deletion. Wraps the existing Kind 5 handler logic.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';

const DeleteEventsParams = z.object({
  reason: z.string().describe('Brief reason for processing this deletion request'),
});

export function createDeleteEventsSkill(): AgentSkill<typeof DeleteEventsParams> {
  return {
    name: 'delete_events',
    description:
      'Process a Kind 5 deletion request event (NIP-09). ' +
      'Removes events from the database if the requester is the original author. ' +
      'Event IDs to delete are extracted from "e" tags in the incoming event. ' +
      'Use this when receiving a valid Kind 5 Nostr event.',
    parameters: DeleteEventsParams,
    eventKinds: [5],
    execute: async (
      _params: z.infer<typeof DeleteEventsParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      if (context.event.kind !== 5) {
        return {
          success: false,
          error: {
            code: 'F99',
            message: `Expected Kind 5 event, got Kind ${context.event.kind}`,
          },
        };
      }

      // Extract event IDs from 'e' tags per NIP-09
      const eventIds = context.event.tags
        .filter(
          (tag): tag is [string, string, ...string[]] =>
            Array.isArray(tag) && tag[0] === 'e' && tag.length >= 2 && typeof tag[1] === 'string'
        )
        .map((tag) => tag[1]);

      if (eventIds.length === 0) {
        return { success: true };
      }

      // Query for original events to verify authorship
      const originalEvents = await context.database.queryEvents({ ids: eventIds });

      // Only delete events authored by the requester
      const requesterPubkey = context.event.pubkey;
      const authorizedIds = originalEvents
        .filter((event) => event.pubkey === requesterPubkey)
        .map((event) => event.id);

      if (authorizedIds.length > 0) {
        await context.database.deleteEvents(authorizedIds);
      }

      return { success: true };
    },
  };
}

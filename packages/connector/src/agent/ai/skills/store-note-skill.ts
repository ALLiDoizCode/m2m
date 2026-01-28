/**
 * Store Note Skill (Kind 1)
 *
 * Stores incoming text note events in the agent's event database.
 * Wraps the existing Kind 1 note handler logic.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import { DatabaseSizeExceededError } from '../../event-database';

const StoreNoteParams = z.object({
  reason: z
    .string()
    .describe('Brief reason for storing this note (e.g., "valid text note from known peer")'),
});

export function createStoreNoteSkill(): AgentSkill<typeof StoreNoteParams> {
  return {
    name: 'store_note',
    description:
      'Store a Kind 1 text note event in the local event database. ' +
      'Use this skill when receiving a valid Kind 1 Nostr event that should be persisted. ' +
      'The note content and metadata are taken from the incoming event context.',
    parameters: StoreNoteParams,
    eventKinds: [1],
    execute: async (
      _params: z.infer<typeof StoreNoteParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      try {
        await context.database.storeEvent(context.event);
        return { success: true };
      } catch (error) {
        if (error instanceof DatabaseSizeExceededError) {
          return {
            success: false,
            error: {
              code: 'T00',
              message: 'Storage limit exceeded',
            },
          };
        }
        throw error;
      }
    },
  };
}

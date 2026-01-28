/**
 * Query Events Skill (Kind 10000)
 *
 * Queries the event database using NIP-01 compatible filters.
 * Wraps the existing Kind 10000 query handler logic.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import type { NostrFilter } from '../../event-database';

const DEFAULT_MAX_RESULTS = 100;

const QueryEventsParams = z.object({
  reason: z.string().describe('Brief reason for querying events'),
});

export function createQueryEventsSkill(
  maxResults: number = DEFAULT_MAX_RESULTS
): AgentSkill<typeof QueryEventsParams> {
  return {
    name: 'query_events',
    description:
      'Query the local event database using NIP-01 compatible filters. ' +
      "The filter is parsed from the incoming Kind 10000 event's content field (JSON). " +
      'Returns matching events as response events. ' +
      'Use this when receiving a Kind 10000 query event.',
    parameters: QueryEventsParams,
    eventKinds: [10000],
    execute: async (
      _params: z.infer<typeof QueryEventsParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      if (context.event.kind !== 10000) {
        return {
          success: false,
          error: {
            code: 'F99',
            message: `Expected Kind 10000 event, got Kind ${context.event.kind}`,
          },
        };
      }

      // Parse filter from event content
      let filter: NostrFilter;
      try {
        filter = JSON.parse(context.event.content) as NostrFilter;
      } catch {
        return {
          success: false,
          error: {
            code: 'F01',
            message: 'Malformed query filter',
          },
        };
      }

      if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
        return {
          success: false,
          error: {
            code: 'F01',
            message: 'Malformed query filter',
          },
        };
      }

      // Apply max results limit
      filter.limit = Math.min(filter.limit ?? DEFAULT_MAX_RESULTS, maxResults);

      const events = await context.database.queryEvents(filter);

      return {
        success: true,
        responseEvents: events,
      };
    },
  };
}

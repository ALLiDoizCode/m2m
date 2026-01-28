/**
 * DVM Query Skill (Kind 5000)
 *
 * Queries the event database using NIP-90 DVM job requests with parameters
 * extracted from param tags. Returns results as Kind 6000 DVM job results.
 *
 * This is the DVM-compatible version of the Kind 10000 query handler.
 */

import { z } from 'zod';
import type { AgentSkill, SkillExecuteContext } from '../skill-registry';
import type { EventHandlerResult } from '../../event-handler';
import type { NostrFilter } from '../../event-database';
import { parseDVMJobRequest } from '../../dvm/dvm-job-parser';
import { formatDVMJobResult, formatDVMErrorResult } from '../../dvm/dvm-result-formatter';
import { resolveJobDependencies } from '../../dvm/job-resolver';

const DEFAULT_MAX_RESULTS = 100;

const DVMQueryParams = z.object({
  reason: z.string().describe('Brief reason for querying events'),
});

/**
 * Extract NostrFilter from DVM param tags.
 *
 * Supported param tags:
 * - kinds: JSON array of kind numbers
 * - authors: JSON array of author pubkeys
 * - limit: number
 * - since: Unix timestamp
 * - until: Unix timestamp
 *
 * @param params - Map of param tag key-value pairs
 * @param maxResults - Maximum results limit to enforce
 * @returns NostrFilter object
 */
function extractFilterFromParams(params: Map<string, string>, maxResults: number): NostrFilter {
  const filter: NostrFilter = {};

  if (params.has('kinds')) {
    try {
      filter.kinds = JSON.parse(params.get('kinds')!);
    } catch {
      // Invalid JSON - skip this param
    }
  }

  if (params.has('authors')) {
    try {
      filter.authors = JSON.parse(params.get('authors')!);
    } catch {
      // Invalid JSON - skip this param
    }
  }

  if (params.has('limit')) {
    const limit = parseInt(params.get('limit')!, 10);
    if (!isNaN(limit)) {
      filter.limit = Math.min(limit, maxResults);
    }
  } else {
    // Default limit if not specified
    filter.limit = maxResults;
  }

  if (params.has('since')) {
    const since = parseInt(params.get('since')!, 10);
    if (!isNaN(since)) {
      filter.since = since;
    }
  }

  if (params.has('until')) {
    const until = parseInt(params.get('until')!, 10);
    if (!isNaN(until)) {
      filter.until = until;
    }
  }

  // Support for tag filters (#e, #p, etc.)
  if (params.has('#e')) {
    try {
      filter['#e'] = JSON.parse(params.get('#e')!);
    } catch {
      // Invalid JSON - skip this param
    }
  }

  if (params.has('#p')) {
    try {
      filter['#p'] = JSON.parse(params.get('#p')!);
    } catch {
      // Invalid JSON - skip this param
    }
  }

  return filter;
}

/**
 * Creates a DVM query skill for Kind 5000 job requests.
 *
 * Handles NIP-90 DVM query jobs with parameters extracted from param tags.
 * Returns query results as Kind 6000 job results.
 *
 * @param maxResults - Maximum number of results to return (default: 100)
 * @returns AgentSkill for Kind 5000 DVM query jobs
 *
 * @example
 * ```typescript
 * const dvmQuerySkill = createDVMQuerySkill(50);
 * skillRegistry.register(dvmQuerySkill);
 * ```
 */
export function createDVMQuerySkill(
  maxResults: number = DEFAULT_MAX_RESULTS
): AgentSkill<typeof DVMQueryParams> {
  return {
    name: 'dvm_query',
    description:
      'Query event database using NIP-90 DVM Kind 5000 job requests. ' +
      'Extracts query parameters from param tags and returns matching events as Kind 6000 job result. ' +
      'Supported params: kinds, authors, limit, since, until, #e, #p',
    parameters: DVMQueryParams,
    eventKinds: [5000],
    execute: async (
      _params: z.infer<typeof DVMQueryParams>,
      context: SkillExecuteContext
    ): Promise<EventHandlerResult> => {
      // Validate event kind
      if (context.event.kind !== 5000) {
        return {
          success: false,
          error: {
            code: 'F99',
            message: `Expected Kind 5000 event, got Kind ${context.event.kind}`,
          },
        };
      }

      // Parse DVM job request
      let jobRequest;
      try {
        jobRequest = parseDVMJobRequest(context.event);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown parsing error';
        const errorResult = formatDVMErrorResult(
          context.event,
          'PARSE_ERROR',
          errorMessage,
          context.amount
        );
        return {
          success: false,
          responseEvents: [errorResult],
          error: {
            code: 'F99',
            message: `Failed to parse DVM job request: ${errorMessage}`,
          },
        };
      }

      // Resolve job dependencies if present (job chaining support)
      // Note: Dependencies are validated but not yet used in query execution.
      // Future enhancement: merge dependency content with query filter or pass as context.
      if (jobRequest.dependencies.length > 0) {
        try {
          await resolveJobDependencies(jobRequest, context.database);
        } catch (error) {
          // Get error code from DVMParseError if available
          const errorCode =
            error && typeof error === 'object' && 'code' in error
              ? (error.code as string)
              : 'DEPENDENCY_ERROR';
          const errorMessage =
            error instanceof Error ? error.message : 'Failed to resolve job dependencies';
          const errorResult = formatDVMErrorResult(
            context.event,
            errorCode,
            errorMessage,
            context.amount
          );
          return {
            success: false,
            responseEvents: [errorResult],
            error: {
              code: 'F99',
              message: `Dependency resolution failed: ${errorMessage}`,
            },
          };
        }
      }

      // Extract filter from param tags
      const filter = extractFilterFromParams(jobRequest.params, maxResults);

      // Query event database
      let events;
      try {
        events = await context.database.queryEvents(filter);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Database query failed';
        const errorResult = formatDVMErrorResult(
          context.event,
          'QUERY_ERROR',
          errorMessage,
          context.amount
        );
        return {
          success: false,
          responseEvents: [errorResult],
          error: {
            code: 'F99',
            message: `Database query failed: ${errorMessage}`,
          },
        };
      }

      // Format DVM job result
      const result = formatDVMJobResult({
        requestEvent: context.event,
        content: events, // Will be JSON stringified by formatter
        amount: context.amount,
        status: 'success',
      });

      return {
        success: true,
        responseEvents: [result],
      };
    },
  };
}

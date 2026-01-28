import type { NostrEvent } from '../toon-codec';
import type { AgentEventDatabase } from '../event-database';
import type { DVMJobRequest, ResolvedDependencies, DVMResultStatus } from './types';
import { DVMParseError, DVM_ERROR_CODES, DVM_RESULT_KIND_OFFSET } from './types';

/**
 * Maximum depth for job dependency chains to prevent infinite recursion.
 */
const MAX_DEPENDENCY_DEPTH = 10;

/**
 * Resolves job dependencies by looking up previous job results from the event database.
 *
 * This function implements NIP-90 job chaining where one DVM job can depend on the
 * results of previous jobs. Dependencies are specified via 'e' tags with 'dependency' marker.
 *
 * @param jobRequest - The DVM job request containing dependency references
 * @param database - Event database to query for dependency results
 * @param currentDepth - Current depth in dependency chain (for recursion tracking)
 * @param visitedIds - Set of visited event IDs (for circular dependency detection)
 * @returns Map of dependency event IDs to their resolved results
 * @throws DVMParseError with appropriate error code if resolution fails
 *
 * @example
 * ```typescript
 * const resolved = await resolveJobDependencies(jobRequest, database);
 * // resolved = {
 * //   "translation-job-id": {
 * //     kind: 6100,
 * //     content: "Translated text",
 * //     status: "success",
 * //     created_at: 1234567890
 * //   }
 * // }
 * ```
 */
export async function resolveJobDependencies(
  jobRequest: DVMJobRequest,
  database: AgentEventDatabase,
  currentDepth: number = 0,
  visitedIds: Set<string> = new Set()
): Promise<ResolvedDependencies> {
  // Check max depth to prevent infinite recursion
  if (currentDepth > MAX_DEPENDENCY_DEPTH) {
    throw new DVMParseError(
      DVM_ERROR_CODES.MAX_DEPTH_EXCEEDED,
      `Job dependency chain exceeds maximum depth of ${MAX_DEPENDENCY_DEPTH}`
    );
  }

  // If no dependencies, return empty map
  if (!jobRequest.dependencies || jobRequest.dependencies.length === 0) {
    return {};
  }

  // Check for circular dependencies
  const currentJobId = jobRequest.event.id;
  if (visitedIds.has(currentJobId)) {
    throw new DVMParseError(
      DVM_ERROR_CODES.CIRCULAR_DEPENDENCY,
      `Circular dependency detected: job ${currentJobId} already in dependency chain`
    );
  }

  // Add current job to visited set for circular detection
  const newVisitedIds = new Set(visitedIds);
  newVisitedIds.add(currentJobId);

  const resolved: ResolvedDependencies = {};

  // Resolve each dependency
  for (const depId of jobRequest.dependencies) {
    // Check if already resolved (could happen in complex chains)
    if (resolved[depId]) {
      continue;
    }

    // Look up dependency event in database
    const depEvents = await database.queryEvents({
      ids: [depId],
      limit: 1,
    });

    // Verify dependency exists
    if (depEvents.length === 0 || !depEvents[0]) {
      throw new DVMParseError(
        DVM_ERROR_CODES.MISSING_DEPENDENCY,
        `Required job dependency ${depId} not found in event database`
      );
    }

    const depEvent = depEvents[0];

    // Validate dependency is a result event (Kind 6XXX)
    if (depEvent.kind < 6000 || depEvent.kind > 6999) {
      throw new DVMParseError(
        DVM_ERROR_CODES.MISSING_DEPENDENCY,
        `Dependency ${depId} is not a valid DVM result event (kind ${depEvent.kind}, expected 6000-6999)`
      );
    }

    // Validate timestamp ordering: dependency must be older than current job
    if (depEvent.created_at >= jobRequest.event.created_at) {
      throw new DVMParseError(
        DVM_ERROR_CODES.INVALID_DEPENDENCY_TIMESTAMP,
        `Dependency ${depId} has invalid timestamp: ${depEvent.created_at} >= ${jobRequest.event.created_at} (dependency must be older than current job)`
      );
    }

    // Extract status from dependency result
    const status = extractResultStatus(depEvent);

    // Create resolved dependency
    resolved[depId] = {
      kind: depEvent.kind,
      content: depEvent.content,
      status,
      created_at: depEvent.created_at,
    };

    // Recursively resolve nested dependencies if the dependency itself was a job request
    // Look for corresponding job request (Kind 5XXX) to check for transitive dependencies
    const requestKind = depEvent.kind - DVM_RESULT_KIND_OFFSET;
    const requestEvents = await database.queryEvents({
      kinds: [requestKind],
      '#e': [depEvent.id], // Find requests that reference this result
      limit: 1,
    });

    if (requestEvents.length > 0 && requestEvents[0]) {
      const requestEvent = requestEvents[0];

      // Extract dependencies from the nested request
      const nestedDeps = extractDependenciesFromEvent(requestEvent);

      if (nestedDeps.length > 0) {
        // Create a job request object for recursive resolution
        const nestedJobRequest: DVMJobRequest = {
          kind: requestEvent.kind,
          inputs: [],
          params: new Map(),
          relays: [],
          event: requestEvent,
          dependencies: nestedDeps,
        };

        // Recursively resolve nested dependencies
        const nestedResolved = await resolveJobDependencies(
          nestedJobRequest,
          database,
          currentDepth + 1,
          newVisitedIds
        );

        // Merge nested resolved dependencies
        Object.assign(resolved, nestedResolved);
      }
    }
  }

  return resolved;
}

/**
 * Extracts result status from a DVM result event's tags.
 *
 * @param event - DVM result event (Kind 6XXX)
 * @returns Result status ('success', 'error', or 'partial')
 */
function extractResultStatus(event: NostrEvent): DVMResultStatus {
  const statusTag = event.tags.find((tag) => tag[0] === 'status');

  if (!statusTag || statusTag.length < 2) {
    // Default to 'success' if no status tag present (per NIP-90)
    return 'success';
  }

  const status = statusTag[1];

  // Validate status value
  if (status !== 'success' && status !== 'error' && status !== 'partial') {
    return 'success'; // Default to success for unrecognized status
  }

  return status as DVMResultStatus;
}

/**
 * Extracts dependency event IDs from 'e' tags with 'dependency' marker.
 *
 * @param event - Nostr event to extract dependencies from
 * @returns Array of dependency event IDs
 */
function extractDependenciesFromEvent(event: NostrEvent): string[] {
  const dependencies: string[] = [];

  for (const tag of event.tags) {
    // 'e' tag format: ["e", "<event-id>", "<relay-url>", "<marker>"]
    if (tag[0] === 'e' && tag.length >= 2 && tag[1]) {
      // Check for 'dependency' marker (4th element, index 3)
      const marker = tag[3];
      if (marker === 'dependency') {
        dependencies.push(tag[1]);
      }
    }
  }

  return dependencies;
}

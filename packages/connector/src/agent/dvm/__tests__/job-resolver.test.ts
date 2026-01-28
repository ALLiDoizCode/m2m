import type { NostrEvent } from '../../toon-codec';
import type { AgentEventDatabase } from '../../event-database';
import type { DVMJobRequest } from '../types';
import { resolveJobDependencies } from '../job-resolver';
import { DVMParseError, DVM_ERROR_CODES } from '../types';

/**
 * Creates a mock AgentEventDatabase for testing.
 */
function createMockDatabase(events: NostrEvent[]): AgentEventDatabase {
  return {
    queryEvents: jest.fn(async (filter) => {
      if (filter.ids) {
        return events.filter((e) => filter.ids!.includes(e.id));
      }
      if (filter.kinds) {
        return events.filter((e) => filter.kinds!.includes(e.kind));
      }
      if (filter['#e']) {
        return events.filter((e) =>
          e.tags.some((t) => t[0] === 'e' && filter['#e']!.includes(t[1]))
        );
      }
      return events;
    }),
  } as unknown as AgentEventDatabase;
}

/**
 * Creates a test DVM result event.
 */
function createResultEvent(
  id: string,
  kind: number,
  content: string,
  createdAt: number,
  status: string = 'success'
): NostrEvent {
  return {
    id,
    pubkey: 'b'.repeat(64),
    kind,
    created_at: createdAt,
    content,
    tags: [
      ['status', status],
      ['amount', '1000'],
    ],
    sig: 'c'.repeat(128),
  };
}

/**
 * Creates a test DVM job request.
 */
function createJobRequest(
  eventId: string,
  dependencies: string[],
  createdAt: number
): DVMJobRequest {
  return {
    kind: 5000,
    inputs: [],
    params: new Map(),
    relays: [],
    dependencies,
    event: {
      id: eventId,
      pubkey: 'a'.repeat(64),
      kind: 5000,
      created_at: createdAt,
      content: '',
      tags: dependencies.map((depId) => ['e', depId, '', 'dependency']),
      sig: 'd'.repeat(128),
    },
  };
}

describe('resolveJobDependencies', () => {
  describe('no dependencies', () => {
    it('should return empty object when no dependencies', async () => {
      // Arrange
      const jobRequest = createJobRequest('job1', [], 1000);
      const database = createMockDatabase([]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result).toEqual({});
    });

    it('should return empty object when dependencies array is empty', async () => {
      // Arrange
      const jobRequest = createJobRequest('job1', [], 1000);
      const database = createMockDatabase([]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result).toEqual({});
    });
  });

  describe('single dependency', () => {
    it('should resolve single dependency successfully', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result).toHaveProperty(depId);
      expect(result[depId]).toEqual({
        kind: 6000,
        content: 'Result data',
        status: 'success',
        created_at: 900,
      });
    });

    it('should resolve dependency with error status', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Error occurred', 900, 'error');
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.status).toBe('error');
      expect(result[depId]!.content).toBe('Error occurred');
    });

    it('should resolve dependency with partial status', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Partial result', 900, 'partial');
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.status).toBe('partial');
    });

    it('should default to success status when status tag missing', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent: NostrEvent = {
        id: depId,
        pubkey: 'b'.repeat(64),
        kind: 6000,
        created_at: 900,
        content: 'Result data',
        tags: [], // No status tag
        sig: 'c'.repeat(128),
      };
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.status).toBe('success');
    });
  });

  describe('multiple dependencies', () => {
    it('should resolve multiple dependencies successfully', async () => {
      // Arrange
      const dep1 = createResultEvent('dep1', 6000, 'Result 1', 800);
      const dep2 = createResultEvent('dep2', 6100, 'Result 2', 850);
      const dep3 = createResultEvent('dep3', 6200, 'Result 3', 900);
      const jobRequest = createJobRequest('job1', ['dep1', 'dep2', 'dep3'], 1000);
      const database = createMockDatabase([dep1, dep2, dep3]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(Object.keys(result)).toHaveLength(3);
      expect(result['dep1']).toBeDefined();
      expect(result['dep1']!.content).toBe('Result 1');
      expect(result['dep2']).toBeDefined();
      expect(result['dep2']!.content).toBe('Result 2');
      expect(result['dep3']).toBeDefined();
      expect(result['dep3']!.content).toBe('Result 3');
    });

    it('should handle different result kinds', async () => {
      // Arrange
      const dep1 = createResultEvent('dep1', 6000, 'Query result', 900);
      const dep2 = createResultEvent('dep2', 6100, 'Translation result', 900);
      const dep3 = createResultEvent('dep3', 6900, 'Task result', 900);
      const jobRequest = createJobRequest('job1', ['dep1', 'dep2', 'dep3'], 1000);
      const database = createMockDatabase([dep1, dep2, dep3]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result['dep1']).toBeDefined();
      expect(result['dep1']!.kind).toBe(6000);
      expect(result['dep2']).toBeDefined();
      expect(result['dep2']!.kind).toBe(6100);
      expect(result['dep3']).toBeDefined();
      expect(result['dep3']!.kind).toBe(6900);
    });
  });

  describe('error handling - missing dependency', () => {
    it('should throw MISSING_DEPENDENCY when dependency not found', async () => {
      // Arrange
      const depId = 'missing-dep';
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([]); // Empty database

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.MISSING_DEPENDENCY);
        expect((error as DVMParseError).message).toContain(depId);
      }
    });

    it('should throw MISSING_DEPENDENCY when dependency is not a result event', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent: NostrEvent = {
        id: depId,
        pubkey: 'b'.repeat(64),
        kind: 5000, // Request kind, not result kind
        created_at: 900,
        content: '',
        tags: [],
        sig: 'c'.repeat(128),
      };
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.MISSING_DEPENDENCY);
        expect((error as DVMParseError).message).toContain('not a valid DVM result event');
      }
    });

    it('should throw when partial dependencies missing', async () => {
      // Arrange
      const dep1 = createResultEvent('dep1', 6000, 'Result 1', 900);
      // dep2 is missing
      const jobRequest = createJobRequest('job1', ['dep1', 'dep2'], 1000);
      const database = createMockDatabase([dep1]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
    });
  });

  describe('error handling - timestamp validation', () => {
    it('should throw INVALID_DEPENDENCY_TIMESTAMP when dependency is newer than job', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 1100); // Newer than job
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_DEPENDENCY_TIMESTAMP);
        expect((error as DVMParseError).message).toContain('invalid timestamp');
      }
    });

    it('should throw when dependency has same timestamp as job', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 1000); // Same timestamp
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database);
      } catch (error) {
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.INVALID_DEPENDENCY_TIMESTAMP);
      }
    });

    it('should succeed when dependency is older than job', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 900); // Older
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
    });
  });

  describe('error handling - circular dependency', () => {
    it('should throw CIRCULAR_DEPENDENCY when job references itself', async () => {
      // Arrange
      const jobId = 'job1';
      const jobRequest = createJobRequest(jobId, [jobId], 1000); // Self-reference
      const database = createMockDatabase([]);

      // Act & Assert
      await expect(
        resolveJobDependencies(jobRequest, database, 0, new Set([jobId]))
      ).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database, 0, new Set([jobId]));
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.CIRCULAR_DEPENDENCY);
        expect((error as DVMParseError).message).toContain('Circular dependency');
      }
    });
  });

  describe('error handling - max depth', () => {
    it('should throw MAX_DEPTH_EXCEEDED when depth exceeds limit', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert - Start at depth 11 (exceeds max of 10)
      await expect(resolveJobDependencies(jobRequest, database, 11)).rejects.toThrow(DVMParseError);
      try {
        await resolveJobDependencies(jobRequest, database, 11);
      } catch (error) {
        expect(error).toBeInstanceOf(DVMParseError);
        expect((error as DVMParseError).code).toBe(DVM_ERROR_CODES.MAX_DEPTH_EXCEEDED);
        expect((error as DVMParseError).message).toContain('exceeds maximum depth');
      }
    });

    it('should succeed at depth 10 (max allowed)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act - Depth 10 should succeed
      const result = await resolveJobDependencies(jobRequest, database, 10);

      // Assert
      expect(result[depId]).toBeDefined();
    });

    it('should fail at depth 11 (exceeds max)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result data', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database, 11)).rejects.toThrow(DVMParseError);
    });
  });

  describe('edge cases', () => {
    it('should handle dependency with empty content', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, '', 900); // Empty content
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.content).toBe('');
    });

    it('should handle dependency with JSON content', async () => {
      // Arrange
      const depId = 'dep1';
      const jsonContent = JSON.stringify({ key: 'value', array: [1, 2, 3] });
      const depEvent = createResultEvent(depId, 6000, jsonContent, 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.content).toBe(jsonContent);
    });

    it('should handle dependency with large content', async () => {
      // Arrange
      const depId = 'dep1';
      const largeContent = 'x'.repeat(100000); // 100KB of text
      const depEvent = createResultEvent(depId, 6000, largeContent, 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.content).toBe(largeContent);
    });

    it('should handle dependency at kind 6000 (minimum result kind)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6000, 'Result', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.kind).toBe(6000);
    });

    it('should handle dependency at kind 6999 (maximum result kind)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 6999, 'Result', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act
      const result = await resolveJobDependencies(jobRequest, database);

      // Assert
      expect(result[depId]).toBeDefined();
      expect(result[depId]!.kind).toBe(6999);
    });

    it('should reject dependency at kind 5999 (below result range)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 5999, 'Not a result', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
    });

    it('should reject dependency at kind 7000 (above result range)', async () => {
      // Arrange
      const depId = 'dep1';
      const depEvent = createResultEvent(depId, 7000, 'Not a result', 900);
      const jobRequest = createJobRequest('job1', [depId], 1000);
      const database = createMockDatabase([depEvent]);

      // Act & Assert
      await expect(resolveJobDependencies(jobRequest, database)).rejects.toThrow(DVMParseError);
    });
  });
});

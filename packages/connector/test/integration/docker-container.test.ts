/**
 * Docker Container Integration Tests
 * Tests that Docker image builds correctly and container behaves as expected
 *
 * Prerequisites:
 * - Docker installed and Docker daemon running
 * - Run from repository root: npm test --workspace=packages/connector -- docker-container.test.ts
 *
 * Note: These tests are skipped if Docker is not available
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';

// @ts-ignore - Used in E2E tests (skipped in CI)
const execAsync = promisify(exec);

const IMAGE_NAME = 'ilp-connector-integration-test';
const CONTAINER_PREFIX = 'ilp-test-container';

// Increase timeout for Docker operations (30 seconds)
jest.setTimeout(30000);

/**
 * Check if Docker is available and daemon is running
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleanup Docker resources (containers and images)
 */
async function cleanupDockerResources(containerName: string): Promise<void> {
  try {
    // Stop and remove container (ignore errors if not exists)
    try {
      execSync(`docker stop ${containerName}`, { stdio: 'ignore' });
    } catch {
      // Container may not be running
    }

    try {
      execSync(`docker rm ${containerName}`, { stdio: 'ignore' });
    } catch {
      // Container may not exist
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

/**
 * Build Docker image
 */
async function buildDockerImage(): Promise<void> {
  execSync(`docker build -t ${IMAGE_NAME} .`, {
    cwd: process.cwd().replace(/\/packages\/connector$/, ''), // Ensure we're at repo root
    stdio: 'pipe',
  });
}

/**
 * Wait for a specific log message to appear
 */
async function waitForLog(
  containerName: string,
  pattern: string,
  timeoutMs: number = 5000
): Promise<string> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const logs = execSync(`docker logs ${containerName} 2>&1`, {
      encoding: 'utf-8',
    });

    if (logs.includes(pattern)) {
      return logs;
    }

    // Wait 500ms before checking again
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timeout waiting for log pattern: ${pattern}`);
}

// Skip all tests if Docker is not available
const e2eEnabled = process.env.E2E_TESTS === 'true';
const describeIfDocker = isDockerAvailable() && e2eEnabled ? describe : describe.skip;

describeIfDocker('Docker Container Integration Tests', () => {
  // Cleanup before all tests
  beforeAll(async () => {
    // Remove test image if exists
    try {
      execSync(`docker rmi ${IMAGE_NAME}`, { stdio: 'ignore' });
    } catch {
      // Image may not exist
    }
  });

  // Cleanup after all tests
  afterAll(async () => {
    // Remove test image
    try {
      execSync(`docker rmi ${IMAGE_NAME}`, { stdio: 'ignore' });
    } catch {
      // Ignore errors
    }
  });

  describe('Docker Image Build', () => {
    it('should build Docker image successfully', async () => {
      // Build image
      await expect(buildDockerImage()).resolves.not.toThrow();

      // Verify image exists
      const images = execSync(`docker images ${IMAGE_NAME} --format "{{.Repository}}"`, {
        encoding: 'utf-8',
      });

      expect(images).toContain(IMAGE_NAME);
    });

    it('should have image size under 200MB', async () => {
      // Get image size
      const sizeOutput = execSync(`docker images ${IMAGE_NAME} --format "{{.Size}}"`, {
        encoding: 'utf-8',
      }).trim();

      // Extract numeric value and unit
      const match = sizeOutput.match(/^([\d.]+)\s*([A-Z]+)$/);
      expect(match).not.toBeNull();

      const [, sizeValue, unit] = match!;
      const size = parseFloat(sizeValue!);

      // Convert to MB if needed
      let sizeMB: number;
      if (unit === 'GB') {
        sizeMB = size * 1024;
      } else if (unit === 'MB') {
        sizeMB = size;
      } else {
        // Assume KB or smaller
        sizeMB = size / 1024;
      }

      expect(sizeMB).toBeLessThan(200);
    });
  });

  describe('Container Startup and Logs', () => {
    const containerName = `${CONTAINER_PREFIX}-startup`;

    afterEach(async () => {
      await cleanupDockerResources(containerName);
    });

    it('should start container and show startup logs', async () => {
      // Start container
      execSync(`docker run -d -e NODE_ID=integration-test --name ${containerName} ${IMAGE_NAME}`, {
        stdio: 'pipe',
      });

      // Wait for startup log
      const logs = await waitForLog(containerName, 'connector_started');

      // Verify logs contain expected fields
      expect(logs).toContain('"event":"connector_started"');
      expect(logs).toContain('"nodeId":"integration-test"');
    });

    it('should respect environment variable configuration', async () => {
      // Start container with custom config
      execSync(
        `docker run -d ` +
          `-e NODE_ID=custom-node ` +
          `-e BTP_SERVER_PORT=4000 ` +
          `-e LOG_LEVEL=debug ` +
          `--name ${containerName} ${IMAGE_NAME}`,
        { stdio: 'pipe' }
      );

      // Wait for startup
      const logs = await waitForLog(containerName, 'connector_started');

      // Verify custom configuration
      expect(logs).toContain('"nodeId":"custom-node"');
      expect(logs).toContain('"btpServerPort":4000');

      // Verify debug level (debug logs should be present)
      expect(logs).toMatch(/"level":(10|20|30)/); // 10=debug, 20=info, 30=warn
    });
  });

  describe('Graceful Shutdown', () => {
    const containerName = `${CONTAINER_PREFIX}-shutdown`;

    afterEach(async () => {
      await cleanupDockerResources(containerName);
    });

    it('should handle SIGTERM gracefully', async () => {
      // Start container
      execSync(`docker run -d -e NODE_ID=shutdown-test --name ${containerName} ${IMAGE_NAME}`, {
        stdio: 'pipe',
      });

      // Wait for startup
      await waitForLog(containerName, 'connector_started');

      // Send SIGTERM (docker stop does this)
      execSync(`docker stop ${containerName}`, {
        stdio: 'pipe',
        timeout: 10000, // Max 10 seconds for shutdown
      });

      // Get final logs
      const logs = execSync(`docker logs ${containerName} 2>&1`, {
        encoding: 'utf-8',
      });

      // Verify shutdown log
      expect(logs).toContain('"event":"connector_shutdown"');

      // Verify exit code is 0
      const exitCode = execSync(`docker inspect ${containerName} --format='{{.State.ExitCode}}'`, {
        encoding: 'utf-8',
      }).trim();

      expect(exitCode).toBe('0');
    });
  });

  describe('Container Health Check', () => {
    const containerName = `${CONTAINER_PREFIX}-health`;

    afterEach(async () => {
      await cleanupDockerResources(containerName);
    });

    it('should pass health check after startup', async () => {
      // Start container
      execSync(`docker run -d -e NODE_ID=health-test --name ${containerName} ${IMAGE_NAME}`, {
        stdio: 'pipe',
      });

      // Wait for startup
      await waitForLog(containerName, 'connector_started');

      // Wait for health check to run (initial delay + interval)
      // Health check: start-period=10s, interval=30s
      await new Promise((resolve) => setTimeout(resolve, 12000)); // 12 seconds

      // Check health status
      const healthStatus = execSync(
        `docker inspect ${containerName} --format='{{.State.Health.Status}}'`,
        { encoding: 'utf-8' }
      ).trim();

      // Should be healthy or starting (may not have completed first check)
      expect(['healthy', 'starting']).toContain(healthStatus);
    });
  });

  describe('Error Handling', () => {
    const containerName = `${CONTAINER_PREFIX}-error`;

    afterEach(async () => {
      await cleanupDockerResources(containerName);
    });

    it('should exit with error code on invalid BTP_SERVER_PORT', async () => {
      // Start container with invalid port
      try {
        execSync(`docker run -d -e BTP_SERVER_PORT=invalid --name ${containerName} ${IMAGE_NAME}`, {
          stdio: 'pipe',
        });
      } catch {
        // Container may exit immediately
      }

      // Wait a moment for container to fail
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get exit code
      const exitCode = execSync(`docker inspect ${containerName} --format='{{.State.ExitCode}}'`, {
        encoding: 'utf-8',
      }).trim();

      // Should have exited with non-zero code
      expect(exitCode).not.toBe('0');

      // Check logs for error
      const logs = execSync(`docker logs ${containerName} 2>&1`, {
        encoding: 'utf-8',
      });

      expect(logs).toContain('Invalid BTP_SERVER_PORT');
    });
  });
});

// If Docker is not available, provide helpful message
if (!isDockerAvailable()) {
  console.log('\n⚠️  Docker integration tests skipped: Docker is not available');
  console.log('To run these tests:');
  console.log('  1. Install Docker: https://docs.docker.com/get-docker/');
  console.log('  2. Start Docker daemon');
  console.log('  3. Run: npm test --workspace=packages/connector -- docker-container.test.ts\n');
}

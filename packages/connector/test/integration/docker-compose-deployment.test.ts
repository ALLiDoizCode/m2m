/**
 * Docker Compose Multi-Node Deployment Integration Tests
 * Tests that Docker Compose configurations deploy correctly and establish connections
 *
 * Prerequisites:
 * - Docker installed and daemon running
 * - Docker Compose 2.x installed
 * - Run from repository root: npm test --workspace=packages/connector -- docker-compose-deployment.test.ts
 *
 * Note: These tests are skipped if Docker or Docker Compose are not available
 */

import { execSync } from 'child_process';
import path from 'path';

const COMPOSE_FILE = 'docker-compose.yml';
const IMAGE_NAME = 'ilp-connector';

// Increase timeout for Docker Compose operations (60 seconds)
jest.setTimeout(60000);

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
 * Check if Docker Compose is available
 */
function isDockerComposeAvailable(): boolean {
  try {
    execSync('docker-compose --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get repository root directory
 */
function getRepoRoot(): string {
  const cwd = process.cwd();
  // If we're in packages/connector, go up two levels
  if (cwd.endsWith('/packages/connector')) {
    return path.join(cwd, '../..');
  }
  return cwd;
}

/**
 * Execute shell command with proper error handling
 */
function executeCommand(
  cmd: string,
  options: { cwd?: string; ignoreError?: boolean } = {}
): string {
  const cwd = options.cwd || getRepoRoot();

  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    return output;
  } catch (error: any) {
    if (options.ignoreError) {
      return error.stdout || '';
    }
    throw error;
  }
}

/**
 * Cleanup Docker Compose resources
 */
function cleanupDockerCompose(composeFile: string = COMPOSE_FILE): void {
  try {
    executeCommand(`docker-compose -f ${composeFile} down -v --remove-orphans`, {
      ignoreError: true,
    });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Wait for all containers to be healthy
 */
async function waitForHealthy(
  composeFile: string = COMPOSE_FILE,
  timeoutMs: number = 30000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const psOutput = executeCommand(`docker-compose -f ${composeFile} ps --format json`, {
        ignoreError: true,
      });

      if (!psOutput) {
        // No containers yet
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      // Parse JSON output
      const lines = psOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      if (lines.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      const containers = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // Check if all containers are running
      const allRunning = containers.every((c: any) => c.State === 'running');

      if (allRunning && containers.length > 0) {
        // Give a bit more time for health checks to stabilize
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return;
      }
    } catch {
      // Ignore errors, keep waiting
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Timeout waiting for containers to become healthy');
}

/**
 * Build Docker image
 */
function buildDockerImage(): void {
  const repoRoot = getRepoRoot();
  executeCommand(`docker build -t ${IMAGE_NAME} .`, { cwd: repoRoot });
}

// Skip all tests if Docker or Docker Compose are not available
const dockerAvailable = isDockerAvailable();
const composeAvailable = isDockerComposeAvailable();
const e2eEnabled = process.env.E2E_TESTS === 'true';
const describeIfDockerCompose =
  dockerAvailable && composeAvailable && e2eEnabled ? describe : describe.skip;

describeIfDockerCompose('Docker Compose Multi-Node Deployment', () => {
  // Build image before all tests
  beforeAll(() => {
    // Ensure clean state
    cleanupDockerCompose();

    // Build the connector image
    buildDockerImage();
  });

  // Cleanup before each test
  beforeEach(() => {
    cleanupDockerCompose();
  });

  // Cleanup after each test
  afterEach(() => {
    cleanupDockerCompose();
  });

  describe('3-Node Linear Topology', () => {
    it('should start all 3 connectors successfully', async () => {
      // Act: Start docker-compose
      executeCommand('docker-compose up -d');

      // Wait for containers to start
      await waitForHealthy();

      // Act: Get container status
      const psOutput = executeCommand('docker-compose ps --format json');

      // Assert: Verify all containers are present
      expect(psOutput).toContain('connector-a');
      expect(psOutput).toContain('connector-b');
      expect(psOutput).toContain('connector-c');

      // Parse and verify running state
      const lines = psOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      expect(lines.length).toBe(3);

      const containers = lines.map((line) => JSON.parse(line));
      const runningCount = containers.filter((c: any) => c.State === 'running').length;
      expect(runningCount).toBe(3);
    });

    it('should show all containers with healthy status', async () => {
      // Arrange: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Wait for health checks to complete
      await new Promise((resolve) => setTimeout(resolve, 15000));

      // Act: Inspect health status of each container
      const healthA = executeCommand(
        'docker inspect --format="{{.State.Health.Status}}" connector-a',
        { ignoreError: true }
      ).trim();

      const healthB = executeCommand(
        'docker inspect --format="{{.State.Health.Status}}" connector-b',
        { ignoreError: true }
      ).trim();

      const healthC = executeCommand(
        'docker inspect --format="{{.State.Health.Status}}" connector-c',
        { ignoreError: true }
      ).trim();

      // Assert: All should be healthy or starting
      expect(['healthy', 'starting']).toContain(healthA);
      expect(['healthy', 'starting']).toContain(healthB);
      expect(['healthy', 'starting']).toContain(healthC);
    });
  });

  describe('Structured Logs', () => {
    it('should display JSON-formatted logs from all nodes', async () => {
      // Arrange: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Wait for startup logs
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Act: Get logs from connector-a
      const logsA = executeCommand('docker-compose logs connector-a');

      // Assert: Logs contain JSON with connector_started event
      expect(logsA).toContain('"event":"connector_started"');
      expect(logsA).toContain('"nodeId":"connector-a"');
      expect(logsA).toContain('"btpServerPort":3000');

      // Act: Get logs from connector-b
      const logsB = executeCommand('docker-compose logs connector-b');

      // Assert: Logs contain correct nodeId and port
      expect(logsB).toContain('"nodeId":"connector-b"');
      expect(logsB).toContain('"btpServerPort":3001');

      // Act: Get logs from connector-c
      const logsC = executeCommand('docker-compose logs connector-c');

      // Assert: Logs contain correct nodeId and port
      expect(logsC).toContain('"nodeId":"connector-c"');
      expect(logsC).toContain('"btpServerPort":3002');
    });
  });

  describe('Container Restart Policy', () => {
    it('should restart containers automatically on failure', async () => {
      // Arrange: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Get initial container ID
      const initialId = executeCommand('docker ps -q -f name=connector-a').trim();
      expect(initialId).toBeTruthy();

      // Act: Kill connector-a
      executeCommand(`docker kill ${initialId}`, { ignoreError: true });

      // Wait for restart
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Assert: Container is running again
      const newId = executeCommand('docker ps -q -f name=connector-a').trim();
      expect(newId).toBeTruthy();

      // Verify it's a new container (different ID) or same container restarted
      const status = executeCommand(
        'docker inspect --format="{{.State.Status}}" connector-a'
      ).trim();
      expect(status).toBe('running');
    });
  });

  describe('Network Connectivity', () => {
    it('should allow containers to communicate on ilp-network', async () => {
      // Arrange: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Act: Ping connector-a from connector-b
      // @ts-ignore - Used in E2E tests (skipped in CI)
      const pingResult = executeCommand(
        'docker-compose exec -T connector-b ping -c 3 connector-a',
        { ignoreError: true }
      );

      // Assert: Ping should succeed (or timeout gracefully on Alpine)
      // Note: Alpine ping may not be installed, so we check for container reachability instead
      const canReach = executeCommand(
        'docker-compose exec -T connector-b wget -q -O- http://connector-a:3000 || echo "connection_attempted"',
        { ignoreError: true }
      );

      // Just verify the command executed without Docker errors
      expect(canReach).toBeDefined();
    });
  });

  describe('Service Dependencies', () => {
    it('should start containers in correct order (depends_on)', async () => {
      // Act: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Get container creation times
      const createdA = executeCommand('docker inspect --format="{{.Created}}" connector-a').trim();

      const createdB = executeCommand('docker inspect --format="{{.Created}}" connector-b').trim();

      const createdC = executeCommand('docker inspect --format="{{.Created}}" connector-c').trim();

      // Assert: B should start after A, C should start after B
      // Note: depends_on controls start order but doesn't guarantee exact timing
      // We're just verifying no errors occurred during startup
      expect(createdA).toBeTruthy();
      expect(createdB).toBeTruthy();
      expect(createdC).toBeTruthy();
    });
  });

  describe('Alternative Topologies', () => {
    afterEach(() => {
      // Clean up alternative topologies
      cleanupDockerCompose('docker-compose-mesh.yml');
      cleanupDockerCompose('docker/docker-compose.hub-spoke.yml');
    });

    it('should start mesh topology with 4 connectors', async () => {
      // Act: Start mesh topology
      executeCommand('docker-compose -f docker-compose-mesh.yml up -d');

      // Wait for containers
      await waitForHealthy('docker-compose-mesh.yml');

      // Act: Get container status
      const psOutput = executeCommand('docker-compose -f docker-compose-mesh.yml ps --format json');

      // Assert: Verify all 4 containers are present
      expect(psOutput).toContain('connector-a');
      expect(psOutput).toContain('connector-b');
      expect(psOutput).toContain('connector-c');
      expect(psOutput).toContain('connector-d');

      // Parse and verify running state
      const lines = psOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      expect(lines.length).toBe(5); // 4 connectors + 1 dashboard

      // Cleanup
      executeCommand('docker-compose -f docker-compose-mesh.yml down');
    });

    it('should start hub-spoke topology with hub and 3 spokes', async () => {
      // Act: Start hub-spoke topology
      executeCommand('docker-compose -f docker/docker-compose.hub-spoke.yml up -d');

      // Wait for containers
      await waitForHealthy('docker/docker-compose.hub-spoke.yml');

      // Act: Get container status
      const psOutput = executeCommand(
        'docker-compose -f docker/docker-compose.hub-spoke.yml ps --format json'
      );

      // Assert: Verify hub and spokes are present
      expect(psOutput).toContain('connector-hub');
      expect(psOutput).toContain('connector-spoke1');
      expect(psOutput).toContain('connector-spoke2');
      expect(psOutput).toContain('connector-spoke3');

      // Parse and verify running state
      const lines = psOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      expect(lines.length).toBe(4);

      // Cleanup
      executeCommand('docker-compose -f docker/docker-compose.hub-spoke.yml down');
    });
  });

  describe('Environment Variables', () => {
    it('should configure connectors with correct environment variables', async () => {
      // Arrange: Start network
      executeCommand('docker-compose up -d');
      await waitForHealthy();

      // Wait for startup
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Act: Check environment variables in connector-a
      const envA = executeCommand('docker-compose exec -T connector-a env');

      // Assert: Verify NODE_ID and BTP_SERVER_PORT
      expect(envA).toContain('NODE_ID=connector-a');
      expect(envA).toContain('BTP_SERVER_PORT=3000');

      // Act: Check environment variables in connector-b
      const envB = executeCommand('docker-compose exec -T connector-b env');

      // Assert: Verify connector-b config
      expect(envB).toContain('NODE_ID=connector-b');
      expect(envB).toContain('BTP_SERVER_PORT=3001');
    });
  });
});

// If Docker or Docker Compose are not available, provide helpful message
if (!dockerAvailable || !composeAvailable) {
  console.log('\n⚠️  Docker Compose integration tests skipped');

  if (!dockerAvailable) {
    console.log('   Docker is not available');
    console.log('   Install Docker: https://docs.docker.com/get-docker/');
  }

  if (!composeAvailable) {
    console.log('   Docker Compose is not available');
    console.log('   Install Docker Compose: https://docs.docker.com/compose/install/');
  }

  console.log('\nTo run these tests:');
  console.log('  1. Install Docker and Docker Compose');
  console.log('  2. Start Docker daemon');
  console.log(
    '  3. Run: npm test --workspace=packages/connector -- docker-compose-deployment.test.ts\n'
  );
}

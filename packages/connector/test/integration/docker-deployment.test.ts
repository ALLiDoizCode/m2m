/* eslint-disable no-console */
/**
 * Docker Deployment Integration Tests
 *
 * These tests validate the production Docker Compose deployment.
 * They require Docker and docker-compose to be installed and running.
 *
 * Run with: INTEGRATION_TESTS=true npm test -- --testPathPattern=docker-deployment
 *
 * Prerequisites:
 * 1. Docker and docker-compose installed
 * 2. TigerBeetle initialized (see docker-compose-production.yml comments)
 * 3. Connector image built: docker build -t m2m/connector:latest .
 */

import { execSync, exec as execCallback } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCallback);

// Skip tests if INTEGRATION_TESTS is not set
const SKIP_INTEGRATION_TESTS = process.env.INTEGRATION_TESTS !== 'true';

// Timeout for service startup (60 seconds)
const SERVICE_STARTUP_TIMEOUT = 60000;

// Timeout for health check attempts
const HEALTH_CHECK_TIMEOUT = 5000;

// Retry delay for health checks
const HEALTH_CHECK_RETRY_DELAY = 2000;

/**
 * Wait for a service to become healthy
 */
async function waitForHealth(
  url: string,
  maxAttempts: number = 30
): Promise<{ status: string; statusCode: number }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
      });

      const data = (await response.json().catch(() => ({}))) as { status?: string };

      if (response.ok || response.status === 503) {
        return {
          status: data.status || (response.ok ? 'healthy' : 'unhealthy'),
          statusCode: response.status,
        };
      }
    } catch {
      // Service not ready yet, continue
    }

    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_RETRY_DELAY));
    }
  }

  throw new Error(`Service at ${url} did not become healthy within timeout`);
}

/**
 * Check if Docker is available
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
 * Check if docker-compose file exists and is valid
 */
function isComposeFileValid(): boolean {
  try {
    execSync('docker compose -f docker-compose-production.yml config --quiet', {
      stdio: 'ignore',
      cwd: process.cwd().replace(/packages\/connector.*$/, ''),
    });
    return true;
  } catch {
    return false;
  }
}

// Conditional describe based on INTEGRATION_TESTS environment variable
const describeOrSkip = SKIP_INTEGRATION_TESTS ? describe.skip : describe;

describeOrSkip('Docker Production Deployment', () => {
  const projectRoot = process.cwd().replace(/packages\/connector.*$/, '');

  beforeAll(() => {
    if (!isDockerAvailable()) {
      throw new Error('Docker is not available. Please install Docker to run integration tests.');
    }

    if (!isComposeFileValid()) {
      throw new Error('docker-compose-production.yml is invalid or missing.');
    }
  }, 30000);

  describe('Docker Compose Configuration', () => {
    it('should have valid docker-compose-production.yml', () => {
      expect(isComposeFileValid()).toBe(true);
    });

    it('should define required services', async () => {
      const { stdout } = await exec(
        'docker compose -f docker-compose-production.yml config --services',
        { cwd: projectRoot }
      );

      const services = stdout.trim().split('\n');

      // Required services
      expect(services).toContain('connector');
      expect(services).toContain('tigerbeetle');
      expect(services).toContain('prometheus');
      expect(services).toContain('grafana');
    });

    it('should define required volumes', async () => {
      const { stdout } = await exec(
        'docker compose -f docker-compose-production.yml config --volumes',
        { cwd: projectRoot }
      );

      const volumes = stdout.trim().split('\n');

      // Required volumes
      expect(volumes).toContain('tigerbeetle-data');
      expect(volumes).toContain('connector-data');
      expect(volumes).toContain('prometheus-data');
      expect(volumes).toContain('grafana-data');
    });

    it('should define network configuration', async () => {
      const { stdout } = await exec('docker compose -f docker-compose-production.yml config', {
        cwd: projectRoot,
      });

      expect(stdout).toContain('ilp-production-network');
    });
  });

  // These tests require a running Docker stack
  // They are marked as skip by default to avoid long CI times
  describe.skip('Service Health (requires running stack)', () => {
    beforeAll(async () => {
      // Start the stack
      console.log('Starting Docker Compose stack...');
      await exec('docker compose -f docker-compose-production.yml up -d', {
        cwd: projectRoot,
      });
    }, 120000);

    afterAll(async () => {
      // Stop the stack
      console.log('Stopping Docker Compose stack...');
      await exec('docker compose -f docker-compose-production.yml down', {
        cwd: projectRoot,
      });
    }, 60000);

    it(
      'should have healthy connector service',
      async () => {
        const result = await waitForHealth('http://localhost:8080/health');
        expect(['healthy', 'degraded']).toContain(result.status);
      },
      SERVICE_STARTUP_TIMEOUT
    );

    it(
      'should expose metrics endpoint',
      async () => {
        const response = await fetch('http://localhost:8080/metrics', {
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
        });

        expect(response.ok).toBe(true);
        const text = await response.text();
        expect(text).toContain('ilp_');
      },
      SERVICE_STARTUP_TIMEOUT
    );

    it(
      'should have healthy Prometheus service',
      async () => {
        const result = await waitForHealth('http://localhost:9090/-/healthy');
        expect(result.statusCode).toBe(200);
      },
      SERVICE_STARTUP_TIMEOUT
    );

    it(
      'should have healthy Grafana service',
      async () => {
        const result = await waitForHealth('http://localhost:3001/api/health');
        expect(result.statusCode).toBe(200);
      },
      SERVICE_STARTUP_TIMEOUT
    );
  });
});

// Note: This test file will be skipped by default unless INTEGRATION_TESTS=true is set.
// This is intentional to avoid long CI times and Docker dependencies in unit test runs.
//
// To run integration tests manually:
// 1. Ensure Docker is running
// 2. Initialize TigerBeetle:
//    docker run --rm -v tigerbeetle-data:/data tigerbeetle/tigerbeetle \
//      format --cluster=0 --replica=0 --replica-count=1 /data/0_0.tigerbeetle
// 3. Build the connector image: docker build -t m2m/connector:latest .
// 4. Run tests: INTEGRATION_TESTS=true npm test -- --testPathPattern=docker-deployment

/**
 * Unit Tests for Mesh Topology Configuration Validation
 *
 * Tests mesh-specific requirements:
 * - All 4 mesh configuration files load successfully
 * - Each connector has exactly 3 peers (full mesh)
 * - Routing tables include all other connectors
 * - Shared secrets are consistent across bidirectional pairs
 * - No self-routes exist
 * - ILP address prefixes follow correct format
 */

import * as path from 'path';
import { ConfigLoader } from '../../src/config/config-loader';
import { ConnectorConfig } from '../../src/config/types';

// Path to mesh configuration files
const MESH_CONFIGS_DIR = path.join(__dirname, '../../../..', 'examples');

// Mesh configuration file names
const MESH_CONFIG_FILES = {
  a: 'mesh-4-nodes-a.yaml',
  b: 'mesh-4-nodes-b.yaml',
  c: 'mesh-4-nodes-c.yaml',
  d: 'mesh-4-nodes-d.yaml',
};

describe('Mesh Configuration Files', () => {
  // Set EXPLORER_PORT to avoid conflict with btpServerPort 3001 (connector-b default)
  const originalExplorerPort = process.env.EXPLORER_PORT;
  beforeAll(() => {
    process.env.EXPLORER_PORT = '9100';
  });
  afterAll(() => {
    if (originalExplorerPort === undefined) {
      delete process.env.EXPLORER_PORT;
    } else {
      process.env.EXPLORER_PORT = originalExplorerPort;
    }
  });

  describe('Load All Mesh Configurations', () => {
    it('Test 1: should load mesh-4-nodes-a.yaml successfully', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config).toBeDefined();
      expect(config.nodeId).toBe('connector-a');
      expect(config.btpServerPort).toBe(3000);
      expect(config.healthCheckPort).toBe(8080);
      expect(config.logLevel).toBe('info');
    });

    it('Test 2: should load mesh-4-nodes-b.yaml successfully', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config).toBeDefined();
      expect(config.nodeId).toBe('connector-b');
      expect(config.btpServerPort).toBe(3001);
      expect(config.healthCheckPort).toBe(8080);
      expect(config.logLevel).toBe('info');
    });

    it('Test 3: should load mesh-4-nodes-c.yaml successfully', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config).toBeDefined();
      expect(config.nodeId).toBe('connector-c');
      expect(config.btpServerPort).toBe(3002);
      expect(config.healthCheckPort).toBe(8080);
      expect(config.logLevel).toBe('info');
    });

    it('Test 4: should load mesh-4-nodes-d.yaml successfully', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config).toBeDefined();
      expect(config.nodeId).toBe('connector-d');
      expect(config.btpServerPort).toBe(3003);
      expect(config.healthCheckPort).toBe(8080);
      expect(config.logLevel).toBe('info');
    });
  });

  describe('Mesh Routing Tables', () => {
    it('Test 5: mesh-4-nodes-a should have exactly 3 routes (to B, C, D)', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.routes).toHaveLength(3);

      // Verify prefixes
      const prefixes = config.routes.map((r) => r.prefix);
      expect(prefixes).toContain('g.connectorb');
      expect(prefixes).toContain('g.connectorc');
      expect(prefixes).toContain('g.connectord');

      // Verify nextHop values match peer IDs
      const nextHops = config.routes.map((r) => r.nextHop);
      expect(nextHops).toContain('connector-b');
      expect(nextHops).toContain('connector-c');
      expect(nextHops).toContain('connector-d');

      // Verify priorities
      config.routes.forEach((route) => {
        expect(route.priority).toBe(0);
      });
    });

    it('Test 6: mesh-4-nodes-b should have exactly 3 routes (to A, C, D)', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.routes).toHaveLength(3);

      const prefixes = config.routes.map((r) => r.prefix);
      expect(prefixes).toContain('g.connectora');
      expect(prefixes).toContain('g.connectorc');
      expect(prefixes).toContain('g.connectord');
    });

    it('Test 7: mesh-4-nodes-c should have exactly 3 routes (to A, B, D)', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.routes).toHaveLength(3);

      const prefixes = config.routes.map((r) => r.prefix);
      expect(prefixes).toContain('g.connectora');
      expect(prefixes).toContain('g.connectorb');
      expect(prefixes).toContain('g.connectord');
    });

    it('Test 8: mesh-4-nodes-d should have exactly 3 routes (to A, B, C)', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.routes).toHaveLength(3);

      const prefixes = config.routes.map((r) => r.prefix);
      expect(prefixes).toContain('g.connectora');
      expect(prefixes).toContain('g.connectorb');
      expect(prefixes).toContain('g.connectorc');
    });

    it('Test 9: no connector should have a route to itself (no self-routes)', () => {
      // Arrange & Act
      const configs = [
        { file: MESH_CONFIG_FILES.a, nodeId: 'connector-a', ownPrefix: 'g.connectora' },
        { file: MESH_CONFIG_FILES.b, nodeId: 'connector-b', ownPrefix: 'g.connectorb' },
        { file: MESH_CONFIG_FILES.c, nodeId: 'connector-c', ownPrefix: 'g.connectorc' },
        { file: MESH_CONFIG_FILES.d, nodeId: 'connector-d', ownPrefix: 'g.connectord' },
      ];

      configs.forEach(({ file, ownPrefix }) => {
        const configPath = path.join(MESH_CONFIGS_DIR, file);
        const config = ConfigLoader.loadConfig(configPath);

        // Assert: No route to self
        const prefixes = config.routes.map((r) => r.prefix);
        expect(prefixes).not.toContain(ownPrefix);
      });
    });
  });

  describe('Mesh Peer Connections', () => {
    it('Test 10: mesh-4-nodes-a should have exactly 3 peers (B, C, D)', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.peers).toHaveLength(3);

      const peerIds = config.peers.map((p) => p.id);
      expect(peerIds).toContain('connector-b');
      expect(peerIds).toContain('connector-c');
      expect(peerIds).toContain('connector-d');

      // Verify peer URLs
      const peerUrls = config.peers.map((p) => p.url);
      expect(peerUrls).toContain('ws://connector-b:3001');
      expect(peerUrls).toContain('ws://connector-c:3002');
      expect(peerUrls).toContain('ws://connector-d:3003');
    });

    it('Test 11: all mesh connectors should have exactly 3 peers (full mesh)', () => {
      // Arrange & Act
      const configFiles = Object.values(MESH_CONFIG_FILES);

      configFiles.forEach((file) => {
        const configPath = path.join(MESH_CONFIGS_DIR, file);
        const config = ConfigLoader.loadConfig(configPath);

        // Assert: Each connector has exactly 3 peers
        expect(config.peers).toHaveLength(3);
      });
    });
  });

  describe('Bidirectional Shared Secrets', () => {
    it('Test 12: A→B and B→A should use same shared secret (secret-a-to-b)', () => {
      // Arrange
      const configA = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a));
      const configB = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b));

      // Act: Extract authTokens for A→B and B→A
      const peerBFromA = configA.peers.find((p) => p.id === 'connector-b');
      const peerAFromB = configB.peers.find((p) => p.id === 'connector-a');

      // Assert: Both should use the same secret
      expect(peerBFromA).toBeDefined();
      expect(peerAFromB).toBeDefined();
      expect(peerBFromA!.authToken).toBe('secret-a-to-b');
      expect(peerAFromB!.authToken).toBe('secret-a-to-b');
    });

    it('Test 13: A→C and C→A should use same shared secret (secret-a-to-c)', () => {
      // Arrange
      const configA = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a));
      const configC = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c));

      // Act
      const peerCFromA = configA.peers.find((p) => p.id === 'connector-c');
      const peerAFromC = configC.peers.find((p) => p.id === 'connector-a');

      // Assert
      expect(peerCFromA!.authToken).toBe('secret-a-to-c');
      expect(peerAFromC!.authToken).toBe('secret-a-to-c');
    });

    it('Test 14: A→D and D→A should use same shared secret (secret-a-to-d)', () => {
      // Arrange
      const configA = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a));
      const configD = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d));

      // Act
      const peerDFromA = configA.peers.find((p) => p.id === 'connector-d');
      const peerAFromD = configD.peers.find((p) => p.id === 'connector-a');

      // Assert
      expect(peerDFromA!.authToken).toBe('secret-a-to-d');
      expect(peerAFromD!.authToken).toBe('secret-a-to-d');
    });

    it('Test 15: B→C and C→B should use same shared secret (secret-b-to-c)', () => {
      // Arrange
      const configB = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b));
      const configC = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c));

      // Act
      const peerCFromB = configB.peers.find((p) => p.id === 'connector-c');
      const peerBFromC = configC.peers.find((p) => p.id === 'connector-b');

      // Assert
      expect(peerCFromB!.authToken).toBe('secret-b-to-c');
      expect(peerBFromC!.authToken).toBe('secret-b-to-c');
    });

    it('Test 16: B→D and D→B should use same shared secret (secret-b-to-d)', () => {
      // Arrange
      const configB = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b));
      const configD = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d));

      // Act
      const peerDFromB = configB.peers.find((p) => p.id === 'connector-d');
      const peerBFromD = configD.peers.find((p) => p.id === 'connector-b');

      // Assert
      expect(peerDFromB!.authToken).toBe('secret-b-to-d');
      expect(peerBFromD!.authToken).toBe('secret-b-to-d');
    });

    it('Test 17: C→D and D→C should use same shared secret (secret-c-to-d)', () => {
      // Arrange
      const configC = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c));
      const configD = ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d));

      // Act
      const peerDFromC = configC.peers.find((p) => p.id === 'connector-d');
      const peerCFromD = configD.peers.find((p) => p.id === 'connector-c');

      // Assert
      expect(peerDFromC!.authToken).toBe('secret-c-to-d');
      expect(peerCFromD!.authToken).toBe('secret-c-to-d');
    });
  });

  describe('Full Mesh Topology Structure', () => {
    it('Test 18: all mesh connections should be bidirectional (6 total pairs)', () => {
      // Arrange: Load all configs
      const configs = {
        a: ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a)),
        b: ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.b)),
        c: ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.c)),
        d: ConfigLoader.loadConfig(path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.d)),
      };

      // Act: Build connection map
      const connections = new Set<string>();

      Object.entries(configs).forEach(([, config]) => {
        config.peers.forEach((peer) => {
          // Create sorted pair to ensure bidirectionality check
          const pair = [config.nodeId, peer.id].sort().join('↔');
          connections.add(pair);
        });
      });

      // Assert: Should have exactly 6 bidirectional pairs
      // n*(n-1)/2 = 4*3/2 = 6 for a 4-node mesh
      expect(connections.size).toBe(6);

      // Verify all expected pairs exist
      expect(connections).toContain('connector-a↔connector-b');
      expect(connections).toContain('connector-a↔connector-c');
      expect(connections).toContain('connector-a↔connector-d');
      expect(connections).toContain('connector-b↔connector-c');
      expect(connections).toContain('connector-b↔connector-d');
      expect(connections).toContain('connector-c↔connector-d');
    });

    it('Test 19: routing table nextHop should match existing peer connections', () => {
      // Arrange & Act
      const configFiles = Object.values(MESH_CONFIG_FILES);

      configFiles.forEach((file) => {
        const configPath = path.join(MESH_CONFIGS_DIR, file);
        const config = ConfigLoader.loadConfig(configPath);

        const peerIds = config.peers.map((p) => p.id);
        const nextHops = config.routes.map((r) => r.nextHop);

        // Assert: Every nextHop should reference an existing peer
        nextHops.forEach((nextHop) => {
          expect(peerIds).toContain(nextHop);
        });
      });
    });

    it('Test 20: ILP address prefixes should follow g.{nodeid} format', () => {
      // Arrange
      const configPath = path.join(MESH_CONFIGS_DIR, MESH_CONFIG_FILES.a);

      // Act
      const config: ConnectorConfig = ConfigLoader.loadConfig(configPath);

      // Assert: All prefixes should match g.{nodeid} pattern
      config.routes.forEach((route) => {
        expect(route.prefix).toMatch(/^g\.[a-z0-9-]+$/);
      });

      // Verify specific prefixes
      const prefixes = config.routes.map((r) => r.prefix);
      expect(prefixes).toEqual(
        expect.arrayContaining(['g.connectorb', 'g.connectorc', 'g.connectord'])
      );
    });
  });
});

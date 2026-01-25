/**
 * Unit Tests for Explorer Configuration
 *
 * Tests explorer environment variable parsing and validation including:
 * - Default values when no environment variables set
 * - EXPLORER_ENABLED parsing (true/false)
 * - EXPLORER_PORT validation (1-65535)
 * - EXPLORER_RETENTION_DAYS validation (1-365)
 * - EXPLORER_MAX_EVENTS validation (1000-10000000)
 * - Port conflict detection with BTP and health ports
 */

import * as path from 'path';
import { ConfigLoader, ConfigurationError } from '../../../src/config/config-loader';

// Test fixture directory path
const FIXTURES_DIR = path.join(__dirname, '../../fixtures/configs');

describe('Explorer Configuration', () => {
  // Store original environment variables
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset environment variables before each test
    delete process.env.EXPLORER_ENABLED;
    delete process.env.EXPLORER_PORT;
    delete process.env.EXPLORER_RETENTION_DAYS;
    delete process.env.EXPLORER_MAX_EVENTS;
  });

  afterEach(() => {
    // Restore original environment variables after each test
    process.env = { ...originalEnv };
  });

  describe('Default Values', () => {
    it('should use default values when no explorer environment variables are set', () => {
      // Arrange
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer).toBeDefined();
      expect(config.explorer?.enabled).toBe(true);
      expect(config.explorer?.port).toBe(3001);
      expect(config.explorer?.retentionDays).toBe(7);
      expect(config.explorer?.maxEvents).toBe(1000000);
    });
  });

  describe('EXPLORER_ENABLED', () => {
    it('should set enabled=true when EXPLORER_ENABLED is not set', () => {
      // Arrange
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.enabled).toBe(true);
    });

    it('should set enabled=true when EXPLORER_ENABLED=true', () => {
      // Arrange
      process.env.EXPLORER_ENABLED = 'true';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.enabled).toBe(true);
    });

    it('should set enabled=false when EXPLORER_ENABLED=false', () => {
      // Arrange
      process.env.EXPLORER_ENABLED = 'false';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.enabled).toBe(false);
    });
  });

  describe('EXPLORER_PORT', () => {
    it('should use default port 3001 when EXPLORER_PORT is not set', () => {
      // Arrange
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.port).toBe(3001);
    });

    it('should parse valid EXPLORER_PORT value', () => {
      // Arrange
      process.env.EXPLORER_PORT = '3005';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.port).toBe(3005);
    });

    it('should throw ConfigurationError for invalid EXPLORER_PORT (non-numeric)', () => {
      // Arrange
      process.env.EXPLORER_PORT = 'invalid';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_PORT must be a valid port number/
      );
    });

    it('should throw ConfigurationError for EXPLORER_PORT=0', () => {
      // Arrange
      process.env.EXPLORER_PORT = '0';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_PORT must be a valid port number/
      );
    });

    it('should throw ConfigurationError for EXPLORER_PORT > 65535', () => {
      // Arrange
      process.env.EXPLORER_PORT = '65536';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_PORT must be a valid port number/
      );
    });

    it('should throw ConfigurationError when EXPLORER_PORT conflicts with btpServerPort', () => {
      // Arrange
      process.env.EXPLORER_PORT = '3000'; // Same as btpServerPort in valid-config.yaml
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(/conflicts with btpServerPort/);
    });

    it('should throw ConfigurationError when EXPLORER_PORT conflicts with healthCheckPort', () => {
      // Arrange
      process.env.EXPLORER_PORT = '8080'; // Same as healthCheckPort in valid-config.yaml
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(/conflicts with healthCheckPort/);
    });
  });

  describe('EXPLORER_RETENTION_DAYS', () => {
    it('should use default retention 7 days when EXPLORER_RETENTION_DAYS is not set', () => {
      // Arrange
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.retentionDays).toBe(7);
    });

    it('should parse valid EXPLORER_RETENTION_DAYS value', () => {
      // Arrange
      process.env.EXPLORER_RETENTION_DAYS = '30';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.retentionDays).toBe(30);
    });

    it('should throw ConfigurationError for EXPLORER_RETENTION_DAYS=0', () => {
      // Arrange
      process.env.EXPLORER_RETENTION_DAYS = '0';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_RETENTION_DAYS must be between 1-365/
      );
    });

    it('should throw ConfigurationError for EXPLORER_RETENTION_DAYS > 365', () => {
      // Arrange
      process.env.EXPLORER_RETENTION_DAYS = '366';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_RETENTION_DAYS must be between 1-365/
      );
    });

    it('should throw ConfigurationError for invalid EXPLORER_RETENTION_DAYS (non-numeric)', () => {
      // Arrange
      process.env.EXPLORER_RETENTION_DAYS = 'invalid';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_RETENTION_DAYS must be between 1-365/
      );
    });
  });

  describe('EXPLORER_MAX_EVENTS', () => {
    it('should use default max events 1000000 when EXPLORER_MAX_EVENTS is not set', () => {
      // Arrange
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.maxEvents).toBe(1000000);
    });

    it('should parse valid EXPLORER_MAX_EVENTS value', () => {
      // Arrange
      process.env.EXPLORER_MAX_EVENTS = '500000';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer?.maxEvents).toBe(500000);
    });

    it('should throw ConfigurationError for EXPLORER_MAX_EVENTS < 1000', () => {
      // Arrange
      process.env.EXPLORER_MAX_EVENTS = '999';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_MAX_EVENTS must be between 1000-10000000/
      );
    });

    it('should throw ConfigurationError for EXPLORER_MAX_EVENTS > 10000000', () => {
      // Arrange
      process.env.EXPLORER_MAX_EVENTS = '10000001';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_MAX_EVENTS must be between 1000-10000000/
      );
    });

    it('should throw ConfigurationError for negative EXPLORER_MAX_EVENTS', () => {
      // Arrange
      process.env.EXPLORER_MAX_EVENTS = '-1';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_MAX_EVENTS must be between 1000-10000000/
      );
    });

    it('should throw ConfigurationError for invalid EXPLORER_MAX_EVENTS (non-numeric)', () => {
      // Arrange
      process.env.EXPLORER_MAX_EVENTS = 'invalid';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act & Assert
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(ConfigurationError);
      expect(() => ConfigLoader.loadConfig(configPath)).toThrow(
        /EXPLORER_MAX_EVENTS must be between 1000-10000000/
      );
    });
  });

  describe('Combined Configuration', () => {
    it('should parse all explorer environment variables together', () => {
      // Arrange
      process.env.EXPLORER_ENABLED = 'true';
      process.env.EXPLORER_PORT = '3005';
      process.env.EXPLORER_RETENTION_DAYS = '14';
      process.env.EXPLORER_MAX_EVENTS = '500000';
      const configPath = path.join(FIXTURES_DIR, 'valid-config.yaml');

      // Act
      const config = ConfigLoader.loadConfig(configPath);

      // Assert
      expect(config.explorer).toEqual({
        enabled: true,
        port: 3005,
        retentionDays: 14,
        maxEvents: 500000,
      });
    });
  });
});

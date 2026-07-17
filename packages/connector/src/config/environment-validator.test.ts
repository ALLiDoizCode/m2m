/**
 * Unit Tests for Environment Validator
 *
 * Tests:
 * - Admin API Security (API key and IP allowlist requirements)
 * - Deployment Mode Validation (embedded vs standalone)
 * - IP Allowlist Validation (format, CIDR, production requirements)
 *
 * @module config/environment-validator.test
 */

import { validateEnvironment } from './environment-validator';
import { ConnectorConfig } from './types';

/** Minimal valid ConnectorConfig for testing */
const baseConfig: ConnectorConfig = {
  nodeId: 'test-node',
  btpServerPort: 3000,
  peers: [],
  routes: [],
  environment: 'production',
};

describe('Environment Validator — Admin API Security', () => {
  describe('production environment', () => {
    it('should throw when admin API is enabled without apiKey in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          // No apiKey
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'Admin API is enabled in production without authentication'
      );
    });

    it('should not throw when admin API is enabled with apiKey in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          apiKey: 'my-secret-key',
        },
      };

      // Should not throw (other production validations may throw for blockchain,
      // but the admin API check specifically should pass)
      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should not throw when admin API is disabled in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: false,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should not throw when admin API config is absent in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        // No adminApi at all
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('development environment', () => {
    it('should not throw when admin API is enabled without apiKey in development', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          // No apiKey — this is fine in development
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('staging environment', () => {
    it('should not throw when admin API is enabled without apiKey in staging', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'staging',
        adminApi: {
          enabled: true,
          port: 8081,
          // No apiKey — staging only warns, doesn't error for admin API
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });
});

describe('Environment Validator — Deployment Mode Validation', () => {
  describe('embedded mode validation', () => {
    it('should throw when deploymentMode is embedded with localDelivery.enabled=true', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'deploymentMode is set to "embedded" but localDelivery.enabled is true'
      );
    });

    it('should NOT throw when deploymentMode is embedded with localDelivery.enabled=false', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        localDelivery: {
          enabled: false,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should NOT throw when deploymentMode is embedded with no localDelivery config', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        // No localDelivery
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should warn (not throw) when deploymentMode is embedded with adminApi.enabled=true', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        adminApi: {
          enabled: true,
          port: 8081,
        },
      };

      // Warning is logged but no error is thrown
      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should NOT warn when deploymentMode is embedded with adminApi.enabled=false', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        adminApi: {
          enabled: false,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('standalone mode validation', () => {
    it('should throw when standalone mode has localDelivery.enabled=true but no handlerUrl', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'standalone',
        localDelivery: {
          enabled: true,
          // No handlerUrl
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'deploymentMode is set to "standalone" with localDelivery.enabled=true ' +
          'but localDelivery.handlerUrl is missing'
      );
    });

    it('should NOT throw when standalone mode has localDelivery with handlerUrl', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'standalone',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
        adminApi: {
          enabled: true,
          port: 8081,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should warn (not throw) when standalone mode has adminApi.enabled=false', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'standalone',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
        adminApi: {
          enabled: false,
        },
      };

      // Warning is logged but no error is thrown
      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should warn (not throw) when standalone mode has localDelivery.enabled=false', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'standalone',
        localDelivery: {
          enabled: false,
        },
        adminApi: {
          enabled: true,
          port: 8081,
        },
      };

      // Warning is logged but no error is thrown
      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('no deployment mode specified (backward compatible)', () => {
    it('should NOT validate when deploymentMode is omitted', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        // No deploymentMode specified
        localDelivery: {
          enabled: true,
          // Even missing handlerUrl is OK when deploymentMode is not set
        },
        adminApi: {
          enabled: false,
        },
      };

      // No validation errors — mode is inferred, not validated
      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should allow any flag combination when deploymentMode is omitted', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        // Unusual combination but valid when deploymentMode is not set
        localDelivery: {
          enabled: false,
        },
        adminApi: {
          enabled: true,
          port: 8081,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('deployment mode applies to all environments', () => {
    it('should validate deployment mode in development environment', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        deploymentMode: 'embedded',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'deploymentMode is set to "embedded" but localDelivery.enabled is true'
      );
    });

    it('should validate deployment mode in staging environment', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'staging',
        deploymentMode: 'embedded',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'deploymentMode is set to "embedded" but localDelivery.enabled is true'
      );
    });

    it('should validate deployment mode in production environment', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        deploymentMode: 'embedded',
        localDelivery: {
          enabled: true,
          handlerUrl: 'http://app:8080',
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'deploymentMode is set to "embedded" but localDelivery.enabled is true'
      );
    });
  });
});

describe('Environment Validator — IP Allowlist Validation', () => {
  describe('production environment - IP allowlist as authentication', () => {
    it('should allow IP allowlist instead of API key in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['127.0.0.1', '::1'],
          // No apiKey — IP allowlist is sufficient
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should allow both API key AND IP allowlist in production (defense in depth)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          apiKey: 'secure-key',
          allowedIPs: ['127.0.0.1'],
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should throw when admin API is enabled without EITHER apiKey OR allowedIPs in production', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          // No apiKey AND no allowedIPs
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'Admin API is enabled in production without authentication'
      );
    });

    it('should throw when allowedIPs is empty array in production (no auth)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'production',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: [], // Empty array = no restriction
          // No apiKey either
        },
      };

      expect(() => validateEnvironment(config)).toThrow(
        'Admin API is enabled in production without authentication'
      );
    });
  });

  describe('IP allowlist format validation', () => {
    it('should accept valid IPv4 addresses', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['127.0.0.1', '192.168.1.1', '10.0.0.1'],
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should accept valid IPv6 addresses', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['::1', '2001:db8::1', 'fe80::1'],
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should accept valid CIDR notation (IPv4)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.0/24', '10.0.0.0/8', '172.16.0.0/16'],
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should accept valid CIDR notation (IPv6)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['2001:db8::/32', 'fe80::/10'],
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should throw on invalid IPv4 address (octet > 255)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.256'], // 256 > 255
        },
      };

      expect(() => validateEnvironment(config)).toThrow('Invalid IPv4 address');
    });

    it('should throw on invalid IP address format', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['not-an-ip'],
        },
      };

      expect(() => validateEnvironment(config)).toThrow('Invalid IP address');
    });

    it('should throw on invalid CIDR notation (multiple slashes)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.0/24/32'],
        },
      };

      expect(() => validateEnvironment(config)).toThrow('Invalid CIDR notation');
    });

    it('should throw on invalid CIDR prefix (> 128)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.0/129'],
        },
      };

      expect(() => validateEnvironment(config)).toThrow('CIDR prefix must be 0-128');
    });

    it('should throw on invalid CIDR prefix (negative)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.0/-1'],
        },
      };

      expect(() => validateEnvironment(config)).toThrow('CIDR prefix must be 0-128');
    });

    it('should throw on empty string in allowedIPs', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['127.0.0.1', '', '192.168.1.1'],
        },
      };

      expect(() => validateEnvironment(config)).toThrow('Invalid IP allowlist entry');
    });
  });

  describe('trustProxy validation', () => {
    it('should accept trustProxy: true with allowedIPs', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['203.0.113.5'],
          trustProxy: true,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should accept trustProxy: false with allowedIPs', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['127.0.0.1'],
          trustProxy: false,
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should not throw when trustProxy is set without allowedIPs (warning logged)', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          apiKey: 'test-key',
          trustProxy: true, // No allowedIPs
        },
      };

      // Warning is logged but no error is thrown
      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });

  describe('IP allowlist in non-production environments', () => {
    it('should allow IP allowlist in development without API key', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'development',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['127.0.0.1'],
          // No apiKey required in dev
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });

    it('should allow IP allowlist in staging without API key', () => {
      const config: ConnectorConfig = {
        ...baseConfig,
        environment: 'staging',
        adminApi: {
          enabled: true,
          port: 8081,
          allowedIPs: ['192.168.1.0/24'],
          // No apiKey required in staging
        },
      };

      expect(() => validateEnvironment(config)).not.toThrow();
    });
  });
});

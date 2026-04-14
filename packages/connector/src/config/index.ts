/**
 * Configuration Module Exports
 *
 * Re-exports configuration loading utilities for ILP connector.
 *
 * @packageDocumentation
 */

// Connector Configuration
export { ConfigLoader, ConfigurationError } from './config-loader';

// Transport configuration type (Epic 35 / Story 35.3)
export type { TransportConfig } from './types';

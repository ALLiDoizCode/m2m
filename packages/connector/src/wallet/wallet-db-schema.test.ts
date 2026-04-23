/**
 * Unit tests for wallet database schema definitions
 */

describe('Wallet DB Schema', () => {
  it('should export agent_wallets table schema', () => {
    const { AGENT_WALLETS_TABLE_SCHEMA } = require('./wallet-db-schema');
    expect(AGENT_WALLETS_TABLE_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS agent_wallets');
    expect(AGENT_WALLETS_TABLE_SCHEMA).toContain('agent_id TEXT PRIMARY KEY');
    expect(AGENT_WALLETS_TABLE_SCHEMA).toContain('derivation_index INTEGER UNIQUE NOT NULL');
    expect(AGENT_WALLETS_TABLE_SCHEMA).toContain('evm_address TEXT NOT NULL');
  });

  it('should export agent_wallets indexes', () => {
    const { AGENT_WALLETS_INDEXES } = require('./wallet-db-schema');
    expect(AGENT_WALLETS_INDEXES).toHaveLength(2);
    expect(AGENT_WALLETS_INDEXES[0]).toContain('idx_derivation_index');
    expect(AGENT_WALLETS_INDEXES[1]).toContain('idx_evm_address');
  });

  it('should export agent_balances table schema', () => {
    const { AGENT_BALANCES_TABLE_SCHEMA } = require('./wallet-db-schema');
    expect(AGENT_BALANCES_TABLE_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS agent_balances');
    expect(AGENT_BALANCES_TABLE_SCHEMA).toContain('balance TEXT NOT NULL');
  });

  it('should export wallet_lifecycle table schema', () => {
    const { WALLET_LIFECYCLE_TABLE_SCHEMA } = require('./wallet-db-schema');
    expect(WALLET_LIFECYCLE_TABLE_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS wallet_lifecycle');
    expect(WALLET_LIFECYCLE_TABLE_SCHEMA).toContain('state TEXT NOT NULL');
  });

  it('should export wallet_lifecycle indexes', () => {
    const { WALLET_LIFECYCLE_INDEXES } = require('./wallet-db-schema');
    expect(WALLET_LIFECYCLE_INDEXES.length).toBeGreaterThanOrEqual(1);
    expect(WALLET_LIFECYCLE_INDEXES[0]).toContain('idx_lifecycle_state');
  });
});

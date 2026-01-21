-- Migration: create_xrp_claims_table.sql
-- Purpose: Store signed claims for dispute resolution and replay protection
-- Epic: 9 - XRP Ledger Payment Channels
-- Story: 9.3 - XRP Payment Channel Claim Signing and Verification

CREATE TABLE IF NOT EXISTS xrp_claims (
  claim_id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,              -- References xrp_channels.channel_id
  amount TEXT NOT NULL,                  -- XRP in drops (string for bigint)
  signature TEXT NOT NULL,               -- Hex-encoded ed25519 signature
  public_key TEXT NOT NULL,              -- ed25519 public key (66 hex chars)
  created_at INTEGER NOT NULL,           -- Unix timestamp
  FOREIGN KEY (channel_id) REFERENCES xrp_channels(channel_id)
);

-- Index for channel lookup (get latest claim for channel)
CREATE INDEX IF NOT EXISTS idx_xrp_claims_channel
  ON xrp_claims(channel_id, created_at DESC);

-- Unique constraint: prevent duplicate claims with same amount
CREATE UNIQUE INDEX IF NOT EXISTS idx_xrp_claims_unique
  ON xrp_claims(channel_id, amount);

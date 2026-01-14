-- Migration: create_xrp_channels_table.sql
-- Purpose: Store XRP payment channel metadata for local state tracking
-- Story 9.2: XRP Payment Channel Creation and Funding

CREATE TABLE IF NOT EXISTS xrp_channels (
  channel_id TEXT PRIMARY KEY,              -- Transaction hash (channel ID)
  account TEXT NOT NULL,                    -- Source account (us)
  destination TEXT NOT NULL,                -- Destination account (peer)
  amount TEXT NOT NULL,                     -- Total XRP in channel (drops, string for bigint)
  balance TEXT NOT NULL DEFAULT '0',       -- XRP claimed (drops, string for bigint)
  settle_delay INTEGER NOT NULL,            -- Settlement delay in seconds
  public_key TEXT NOT NULL,                 -- ed25519 public key for claim verification
  cancel_after INTEGER,                     -- Optional: auto-expiration timestamp
  expiration INTEGER,                       -- Optional: close request timestamp
  status TEXT NOT NULL DEFAULT 'open',      -- Channel status: open, closing, closed
  created_at INTEGER NOT NULL,              -- Unix timestamp
  updated_at INTEGER NOT NULL DEFAULT 0     -- Unix timestamp
);

-- Index for peer lookup
CREATE INDEX IF NOT EXISTS idx_xrp_channels_destination
  ON xrp_channels(destination);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_xrp_channels_status
  ON xrp_channels(status);

CREATE TABLE IF NOT EXISTS nostr_events (
  id         TEXT    PRIMARY KEY,
  pubkey     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  kind       INTEGER NOT NULL,
  tags       TEXT    NOT NULL,  -- JSON array of tag arrays
  content    TEXT    NOT NULL,
  sig        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ne_pubkey     ON nostr_events (pubkey);
CREATE INDEX IF NOT EXISTS idx_ne_kind       ON nostr_events (kind);
CREATE INDEX IF NOT EXISTS idx_ne_created_at ON nostr_events (created_at);
CREATE INDEX IF NOT EXISTS idx_ne_kind_pk    ON nostr_events (kind, pubkey);

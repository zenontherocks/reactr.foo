CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  emoji TEXT NOT NULL,
  npub TEXT NOT NULL,
  note_id TEXT NOT NULL,
  relay TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('relays', '["wss://relay.damus.io","wss://relay.nostr.band","wss://nos.lol"]'),
  ('preferred_emojis', '["👍","😂","🤙","❤️","🔥"]');

-- layToRest()'s retention prune filters nostr_events by kind AND created_at
-- together; the existing idx_ne_kind and idx_ne_created_at are each
-- single-column, so SQLite can only use one and must filter the rest.
-- This composite index lets both DELETEs do a fully indexed range scan.
CREATE INDEX IF NOT EXISTS idx_ne_kind_created_at ON nostr_events (kind, created_at);

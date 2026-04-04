-- Denormalized index of kind-7 reaction targets.
-- Pre-extracts note_id and emoji so /api/reactions/by-note avoids json_each.
CREATE TABLE IF NOT EXISTS reaction_notes (
  event_id TEXT PRIMARY KEY,
  note_id  TEXT NOT NULL,
  emoji    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rn_note_id ON reaction_notes (note_id);

-- Back-fill from existing kind-7 events (runs once at migration time)
INSERT OR IGNORE INTO reaction_notes (event_id, note_id, emoji)
SELECT
  ne.id,
  json_extract(t.value, '$[1]'),
  ne.content
FROM nostr_events ne, json_each(ne.tags) AS t
WHERE ne.kind = 7
  AND json_extract(t.value, '$[0]') = 'e'
  AND json_extract(t.value, '$[1]') IS NOT NULL;

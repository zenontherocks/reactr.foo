/// <reference types="@cloudflare/workers-types" />
import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import type { Event, Filter } from "nostr-tools";

export interface Env {
  DB: D1Database;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ── Nostr helpers ─────────────────────────────────────────────────────────────

/**
 * Fetch events matching `filter` from `relays`, resolving when all relays
 * send EOSE or when `timeoutMs` elapses — whichever comes first.
 */
function fetchEventsUntilEOSE(
  relays: string[],
  filter: Filter,
  timeoutMs: number
): Promise<Event[]> {
  return new Promise((resolve) => {
    const pool = new SimplePool();
    const events: Event[] = [];
    let eoseCount = 0;

    const finish = () => {
      clearTimeout(timer);
      sub.close();
      pool.close(relays);
      resolve(events);
    };

    const timer = setTimeout(finish, timeoutMs);

    const sub = pool.subscribeMany(relays, [filter], {
      onevent(event: Event) {
        events.push(event);
      },
      oneose() {
        eoseCount++;
        if (eoseCount >= relays.length) finish();
      },
    });
  });
}

/** Fetch a single kind-1 note by ID from relays, with timeout. */
async function fetchNoteFromRelays(
  noteId: string,
  relays: string[],
  timeoutMs = 8000
): Promise<Event | null> {
  const pool = new SimplePool();
  try {
    return await Promise.race([
      pool.get(relays, { ids: [noteId], kinds: [1] }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } finally {
    pool.close(relays);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getConfigFromDB(
  env: Env
): Promise<{ relays: string[]; preferred_emojis: string[] }> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM config"
  ).all<{ key: string; value: string }>();
  const out: Record<string, unknown> = {};
  for (const row of results) out[row.key] = JSON.parse(row.value);
  return {
    relays: (out.relays as string[]) ?? [],
    preferred_emojis: (out.preferred_emojis as string[]) ?? [],
  };
}

// ── Scheduled poll ────────────────────────────────────────────────────────────

async function pollNostr(env: Env): Promise<void> {
  const config = await getConfigFromDB(env);
  if (config.relays.length === 0) return;

  // Use the most recent stored reaction's timestamp as `since`, default 24 h ago
  const lastRow = await env.DB.prepare(
    "SELECT MAX(created_at) as last FROM reactions"
  ).first<{ last: number | null }>();
  const since = lastRow?.last ?? Math.floor(Date.now() / 1000) - 86400;

  // Fetch new kind-7 (reaction) events from all relays
  const reactionEvents = await fetchEventsUntilEOSE(
    config.relays,
    { kinds: [7], since },
    25000
  );

  if (reactionEvents.length === 0) return;

  // Insert reactions and collect note IDs we see
  const reactionStmt = env.DB.prepare(
    "INSERT OR IGNORE INTO reactions (id, emoji, npub, note_id, relay, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const newNoteIds = new Set<string>();

  for (const event of reactionEvents) {
    const eTag = event.tags.find((t) => t[0] === "e");
    if (!eTag || !eTag[1]) continue;

    const noteId = eTag[1];
    const emoji = event.content.trim() || "+";
    let npub: string;
    try {
      npub = npubEncode(event.pubkey);
    } catch {
      npub = event.pubkey;
    }

    await reactionStmt
      .bind(event.id, emoji, npub, noteId, config.relays[0], event.created_at)
      .run();
    newNoteIds.add(noteId);
  }

  if (newNoteIds.size === 0) return;

  // Determine which note IDs are missing from the notes table
  const placeholders = [...newNoteIds].map(() => "?").join(",");
  const { results: existing } = await env.DB.prepare(
    `SELECT id FROM notes WHERE id IN (${placeholders})`
  )
    .bind(...newNoteIds)
    .all<{ id: string }>();

  const existingSet = new Set(existing.map((r) => r.id));
  const missingIds = [...newNoteIds].filter((id) => !existingSet.has(id));

  // Fetch and store missing note content
  const noteStmt = env.DB.prepare(
    "INSERT OR IGNORE INTO notes (id, pubkey, content, created_at) VALUES (?, ?, ?, ?)"
  );
  for (const noteId of missingIds) {
    const note = await fetchNoteFromRelays(noteId, config.relays);
    if (note) {
      await noteStmt
        .bind(note.id, note.pubkey, note.content, note.created_at)
        .run();
    }
  }
}

// ── Request router ────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const { pathname } = new URL(request.url);

    if (!pathname.startsWith("/api/")) {
      return new Response("Not Found", { status: 404 });
    }

    try {
      return await route(pathname, request.method, request, env);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(pollNostr(env));
  },
} satisfies ExportedHandler<Env>;

async function route(
  path: string,
  method: string,
  req: Request,
  env: Env
): Promise<Response> {
  // GET /api/config
  if (path === "/api/config" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM config"
    ).all<{ key: string; value: string }>();
    const out: Record<string, unknown> = {};
    for (const row of results) out[row.key] = JSON.parse(row.value);
    return json(out);
  }

  // POST /api/config
  if (path === "/api/config" && method === "POST") {
    const body = (await req.json()) as Record<string, unknown>;
    const stmt = env.DB.prepare(
      "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)"
    );
    for (const [key, value] of Object.entries(body)) {
      await stmt.bind(key, JSON.stringify(value)).run();
    }
    return json({ ok: true });
  }

  // GET /api/reactions/by-note  — aggregated counts per note+emoji
  if (path === "/api/reactions/by-note" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT note_id, emoji, COUNT(*) as count
       FROM reactions
       GROUP BY note_id, emoji
       ORDER BY note_id, count DESC`
    ).all();
    return json(results);
  }

  // GET /api/notes  — notes with aggregated reaction counts, sorted by recency
  if (path === "/api/notes" && method === "GET") {
    // Fetch stored notes
    const { results: notes } = await env.DB.prepare(
      "SELECT id, pubkey, content, created_at FROM notes ORDER BY created_at DESC LIMIT 1000"
    ).all<{ id: string; pubkey: string; content: string; created_at: number }>();

    // Also include note IDs referenced by reactions but not yet fetched
    const { results: reactionOnlyIds } = await env.DB.prepare(
      `SELECT DISTINCT note_id as id FROM reactions
       WHERE note_id NOT IN (SELECT id FROM notes)
       LIMIT 500`
    ).all<{ id: string }>();

    // Build reaction counts map
    const { results: reactionRows } = await env.DB.prepare(
      `SELECT note_id, emoji, COUNT(*) as count
       FROM reactions
       GROUP BY note_id, emoji`
    ).all<{ note_id: string; emoji: string; count: number }>();

    const reactionMap = new Map<string, Record<string, number>>();
    for (const r of reactionRows) {
      const counts = reactionMap.get(r.note_id) ?? {};
      counts[r.emoji] = r.count;
      reactionMap.set(r.note_id, counts);
    }

    const result = [
      ...notes.map((n) => ({
        id: n.id,
        pubkey: n.pubkey,
        content: n.content,
        created_at: n.created_at,
        reactions: reactionMap.get(n.id) ?? {},
      })),
      ...reactionOnlyIds.map((r) => ({
        id: r.id,
        pubkey: "",
        content: "",
        created_at: 0,
        reactions: reactionMap.get(r.id) ?? {},
      })),
    ];

    return json(result);
  }

  // POST /api/poll  — manually trigger a Nostr poll (admin/debug use)
  if (path === "/api/poll" && method === "POST") {
    await pollNostr(env);
    return json({ ok: true });
  }

  return json({ error: "Not Found" }, 404);
}

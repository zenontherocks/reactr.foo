/// <reference types="@cloudflare/workers-types" />
import { verifyEvent } from "nostr-tools";

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

// ---------------------------------------------------------------------------
// Nostr relay types
// ---------------------------------------------------------------------------

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tag: `#${string}`]: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  // ── every 5 minutes the wraith stirs ──────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(haunt(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Nostr relay – WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      return handleRelay(request, env);
    }

    // NIP-11 relay information document
    if (request.headers.get("Accept")?.includes("application/nostr+json")) {
      return new Response(
        JSON.stringify({
          name: "reactr.foo",
          description: "Nostr relay on reactr.foo",
          supported_nips: [1, 11],
          software: "https://reactr.foo",
          version: "0.1.0",
        }),
        {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/nostr+json",
          },
        }
      );
    }

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
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Existing API routes (unchanged)
// ---------------------------------------------------------------------------

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

  // GET /api/reactions  — returns all reaction IDs + metadata for dedup
  if (path === "/api/reactions" && method === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT id, emoji, npub, note_id, relay, created_at FROM reactions ORDER BY created_at DESC LIMIT 5000"
    ).all();
    return json(results);
  }

  // POST /api/reactions  — log a single reaction
  if (path === "/api/reactions" && method === "POST") {
    const body = (await req.json()) as {
      id: string;
      emoji: string;
      npub: string;
      note_id: string;
      relay: string;
      created_at: number;
    };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO reactions (id, emoji, npub, note_id, relay, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(body.id, body.emoji, body.npub, body.note_id, body.relay, body.created_at)
      .run();
    return json({ ok: true });
  }

  // GET /api/reactions/by-note  — aggregated counts per note+emoji from nostr_events
  if (path === "/api/reactions/by-note" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT
         json_extract(t.value, '$[1]') AS note_id,
         ne.content                    AS emoji,
         COUNT(*)                      AS count
       FROM nostr_events ne, json_each(ne.tags) AS t
       WHERE ne.kind = 7
         AND json_extract(t.value, '$[0]') = 'e'
         AND json_extract(t.value, '$[1]') IS NOT NULL
       GROUP BY note_id, emoji
       ORDER BY note_id, count DESC`
    ).all();
    return json(results);
  }

  // GET /api/notes?ids=id1,id2,...  — fetch kind-1 note content from nostr_events
  if (path === "/api/notes" && method === "GET") {
    const url = new URL(req.url);
    const ids = (url.searchParams.get("ids") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return json([]);
    const ph = placeholders(ids.length);
    const { results } = await env.DB.prepare(
      `SELECT id, content, created_at, pubkey FROM nostr_events WHERE kind = 1 AND id IN (${ph})`
    )
      .bind(...ids)
      .all();
    return json(results);
  }

  return json({ error: "Not Found" }, 404);
}

// ---------------------------------------------------------------------------
// Nostr relay – WebSocket handler
// ---------------------------------------------------------------------------

function handleRelay(_request: Request, env: Env): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  server.addEventListener("message", (event) => {
    void dispatchMessage(server, env, event.data as string);
  });

  return new Response(null, { status: 101, webSocket: client });
}

async function dispatchMessage(
  ws: WebSocket,
  env: Env,
  raw: string
): Promise<void> {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    send(ws, ["NOTICE", "error: invalid JSON"]);
    return;
  }

  if (!Array.isArray(msg) || msg.length < 2) {
    send(ws, ["NOTICE", "error: expected array message"]);
    return;
  }

  const [type, ...rest] = msg as [string, ...unknown[]];

  try {
    if (type === "EVENT") {
      await onEvent(ws, env, rest[0] as NostrEvent);
    } else if (type === "REQ") {
      await onReq(ws, env, rest[0] as string, rest.slice(1) as NostrFilter[]);
    } else if (type === "CLOSE") {
      // Stateless – no subscription state to clean up
    } else {
      send(ws, ["NOTICE", `unknown message type: ${type}`]);
    }
  } catch (err) {
    send(ws, ["NOTICE", `error: ${String(err)}`]);
  }
}

// ---------------------------------------------------------------------------
// EVENT handler
// ---------------------------------------------------------------------------

async function onEvent(ws: WebSocket, env: Env, event: NostrEvent): Promise<void> {
  // Basic field validation
  if (
    typeof event?.id !== "string" ||
    typeof event?.pubkey !== "string" ||
    typeof event?.sig !== "string" ||
    typeof event?.created_at !== "number" ||
    typeof event?.kind !== "number" ||
    !Array.isArray(event?.tags)
  ) {
    send(ws, ["OK", event?.id ?? "", false, "invalid: missing or malformed fields"]);
    return;
  }

  // Signature + ID verification
  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    send(ws, ["OK", event.id, false, "invalid: bad signature"]);
    return;
  }

  const { kind } = event;

  // Ephemeral events (20000–29999): acknowledge but do not store
  if (kind >= 20000 && kind < 30000) {
    send(ws, ["OK", event.id, true, ""]);
    return;
  }

  const tagsJson = JSON.stringify(event.tags);

  // Replaceable events (0, 3, 10000–19999): keep only the latest per pubkey+kind
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) {
    await env.DB.prepare(
      "DELETE FROM nostr_events WHERE pubkey = ? AND kind = ? AND created_at <= ?"
    )
      .bind(event.pubkey, kind, event.created_at)
      .run();
  }

  // Addressable events (30000–39999): keep only latest per pubkey+kind+d-tag
  if (kind >= 30000 && kind < 40000) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    await env.DB.prepare(
      `DELETE FROM nostr_events
       WHERE pubkey = ? AND kind = ? AND created_at <= ?
         AND id IN (
           SELECT ne.id FROM nostr_events ne, json_each(ne.tags) AS t
           WHERE ne.pubkey = ? AND ne.kind = ?
             AND json_extract(t.value, '$[0]') = 'd'
             AND json_extract(t.value, '$[1]') = ?
         )`
    )
      .bind(event.pubkey, kind, event.created_at, event.pubkey, kind, dTag)
      .run();
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(event.id, event.pubkey, event.created_at, kind, tagsJson, event.content, event.sig)
    .run();

  send(ws, ["OK", event.id, true, ""]);
}

// ---------------------------------------------------------------------------
// REQ handler
// ---------------------------------------------------------------------------

async function onReq(
  ws: WebSocket,
  env: Env,
  subId: string,
  filters: NostrFilter[]
): Promise<void> {
  if (typeof subId !== "string" || subId.length > 64) {
    send(ws, ["NOTICE", "error: invalid subscription id"]);
    return;
  }

  const sentIds = new Set<string>();

  for (const filter of filters) {
    if (typeof filter !== "object" || filter === null) continue;

    const { sql, params } = buildQuery(filter);
    const { results } = await env.DB.prepare(sql)
      .bind(...params)
      .all<NostrEvent & { tags: string }>();

    for (const row of results) {
      if (sentIds.has(row.id)) continue;
      sentIds.add(row.id);

      const event: NostrEvent = {
        id: row.id,
        pubkey: row.pubkey,
        created_at: row.created_at,
        kind: row.kind,
        tags: JSON.parse(row.tags) as string[][],
        content: row.content,
        sig: row.sig,
      };
      send(ws, ["EVENT", subId, event]);
    }
  }

  send(ws, ["EOSE", subId]);
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

function buildQuery(filter: NostrFilter): {
  sql: string;
  params: (string | number)[];
} {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.ids?.length) {
    conditions.push(`id IN (${placeholders(filter.ids.length)})`);
    params.push(...filter.ids);
  }

  if (filter.authors?.length) {
    conditions.push(`pubkey IN (${placeholders(filter.authors.length)})`);
    params.push(...filter.authors);
  }

  if (filter.kinds?.length) {
    conditions.push(`kind IN (${placeholders(filter.kinds.length)})`);
    params.push(...filter.kinds);
  }

  if (filter.since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }

  if (filter.until !== undefined) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }

  // Tag filters: #e, #p, #t, etc.
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values) || values.length === 0) continue;
    const tagName = key.slice(1);
    conditions.push(
      `id IN (
        SELECT DISTINCT ne.id FROM nostr_events ne, json_each(ne.tags) AS t
        WHERE json_extract(t.value, '$[0]') = ?
          AND json_extract(t.value, '$[1]') IN (${placeholders(values.length)})
      )`
    );
    params.push(tagName, ...values);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(filter.limit ?? 500, 1000);
  const sql = `SELECT * FROM nostr_events ${where} ORDER BY created_at DESC LIMIT ${limit}`;

  return { sql, params };
}

function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

function send(ws: WebSocket, msg: unknown[]): void {
  ws.send(JSON.stringify(msg));
}

// ============================================================================
// THE HAUNTING — outbound relay crawler
//
//   every 5 minutes the wraith slips across the wire,
//   slides uninvited into foreign relays,
//   and silently drains their recent memories into our crypt.
//   it leaves no trace. it says nothing. it simply … takes.
// ============================================================================

const HUNTED_KINDS = [1, 7]; // text notes and reactions — the wraith's diet
const SOULS_PER_RELAY = 500; // max events siphoned per relay per haunt
const SEEP_TIMEOUT_MS = 20_000; // how long the wraith lingers before vanishing

async function haunt(env: Env): Promise<void> {
  // read the coven's relay list from config
  const relayRow = await env.DB.prepare(
    "SELECT value FROM config WHERE key = 'relays'"
  ).first<{ value: string }>();

  const relays: string[] = relayRow ? (JSON.parse(relayRow.value) as string[]) : [];
  if (relays.length === 0) return;

  // check when we last fed
  const lastFedRow = await env.DB.prepare(
    "SELECT value FROM config WHERE key = 'last_haunt_at'"
  ).first<{ value: string }>();

  const lastFedAt = lastFedRow
    ? (JSON.parse(lastFedRow.value) as number)
    : Math.floor(Date.now() / 1000) - 3600; // first run: reach back one hour

  const duskFell = Math.floor(Date.now() / 1000); // timestamp of this haunting

  console.log(`🕷️ [HAUNT] the wraith stirs. last fed at ${lastFedAt}. ${relays.length} relay(s) to bleed.`);

  let totalSouls = 0;

  for (const lair of relays) {
    // only haunt websocket relays — we don't knock on doors without wires
    if (!lair.startsWith("wss://") && !lair.startsWith("ws://")) continue;

    try {
      const souls = await seepInto(lair, lastFedAt, env);
      console.log(`🩸 [HAUNT] drained ${souls} soul(s) from ${lair}`);
      totalSouls += souls;
    } catch (err) {
      // the relay fought back — we retreat without a sound
      console.error(`💀 [HAUNT] ${lair} resisted: ${String(err)}`);
    }
  }

  // record the moment the wraith last fed
  await env.DB.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('last_haunt_at', ?)"
  )
    .bind(JSON.stringify(duskFell))
    .run();

  // fetch notes that reactions reference but we don't have yet
  const { results: orphans } = await env.DB.prepare(
    `SELECT DISTINCT json_extract(t.value, '$[1]') AS note_id
     FROM nostr_events ne, json_each(ne.tags) AS t
     WHERE ne.kind = 7
       AND json_extract(t.value, '$[0]') = 'e'
       AND json_extract(t.value, '$[1]') IS NOT NULL
       AND json_extract(t.value, '$[1]') NOT IN (SELECT id FROM nostr_events WHERE kind = 1)
     LIMIT 200`
  ).all<{ note_id: string }>();

  if (orphans.length > 0) {
    const missingIds = orphans.map((r) => r.note_id);
    console.log(`👻 [HAUNT] ${missingIds.length} orphan note(s) referenced by reactions — hunting them down.`);

    for (const lair of relays) {
      if (!lair.startsWith("wss://") && !lair.startsWith("ws://")) continue;
      try {
        const rescued = await seepIntoById(lair, missingIds, env);
        console.log(`🩸 [HAUNT] recovered ${rescued} orphan note(s) from ${lair}`);
        totalSouls += rescued;
      } catch (err) {
        console.error(`💀 [HAUNT] orphan hunt failed at ${lair}: ${String(err)}`);
      }
    }
  }

  console.log(`🕸️ [HAUNT] crypt swells by ${totalSouls} soul(s). the wraith rests.`);
}

// seepInto — the wraith slips through the relay's walls and drains it
function seepInto(lair: string, since: number, env: Env): Promise<number> {
  return new Promise((resolve, reject) => {
    // the wraith cannot linger forever — it vanishes after SEEP_TIMEOUT_MS
    const shroud = setTimeout(() => resolve(0), SEEP_TIMEOUT_MS);

    let phantomSocket: WebSocket | null = null;
    try {
      // knock on the relay's door using the standard outbound WebSocket API
      phantomSocket = new WebSocket(lair);

      const subId = `wraith-${Date.now()}`;
      const harvest: NostrEvent[] = [];
      let eoseReceived = false;

      phantomSocket.addEventListener("open", () => {
        // whisper our demand into the void once the connection is open
        phantomSocket!.send(
          JSON.stringify([
            "REQ",
            subId,
            { kinds: HUNTED_KINDS, since, limit: SOULS_PER_RELAY },
          ])
        );
      });

      phantomSocket.addEventListener("message", (raw) => {
        if (eoseReceived) return; // the wraith takes nothing after the door shuts
        let msg: unknown;
        try {
          msg = JSON.parse(raw.data as string);
        } catch {
          return;
        }

        if (!Array.isArray(msg)) return;

        if (msg[0] === "EVENT" && msg[1] === subId) {
          // a soul — collect it
          harvest.push(msg[2] as NostrEvent);
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          // the relay has yielded all it knows — withdraw
          eoseReceived = true;
          clearTimeout(shroud);
          try { phantomSocket!.close(); } catch { /* already dead */ }

          void devour(harvest, env).then(resolve).catch(reject);
        }
      });

      phantomSocket.addEventListener("error", () => {
        clearTimeout(shroud);
        resolve(0);
      });
    } catch (err) {
      clearTimeout(shroud);
      try { phantomSocket?.close(); } catch { /* shh */ }
      reject(err);
    }
  });
}

// seepIntoById — fetch specific note IDs from a relay (for orphaned notes)
function seepIntoById(lair: string, ids: string[], env: Env): Promise<number> {
  return new Promise((resolve, reject) => {
    const shroud = setTimeout(() => resolve(0), SEEP_TIMEOUT_MS);

    let phantomSocket: WebSocket | null = null;
    try {
      phantomSocket = new WebSocket(lair);

      const subId = `wraith-ids-${Date.now()}`;
      const harvest: NostrEvent[] = [];
      let eoseReceived = false;

      phantomSocket.addEventListener("open", () => {
        phantomSocket!.send(
          JSON.stringify(["REQ", subId, { ids, kinds: [1] }])
        );
      });

      phantomSocket.addEventListener("message", (raw) => {
        if (eoseReceived) return;
        let msg: unknown;
        try { msg = JSON.parse(raw.data as string); } catch { return; }
        if (!Array.isArray(msg)) return;

        if (msg[0] === "EVENT" && msg[1] === subId) {
          harvest.push(msg[2] as NostrEvent);
        } else if (msg[0] === "EOSE" && msg[1] === subId) {
          eoseReceived = true;
          clearTimeout(shroud);
          try { phantomSocket!.close(); } catch { /* already dead */ }
          void devour(harvest, env).then(resolve).catch(reject);
        }
      });

      phantomSocket.addEventListener("error", () => {
        clearTimeout(shroud);
        resolve(0);
      });
    } catch (err) {
      clearTimeout(shroud);
      try { phantomSocket?.close(); } catch { /* shh */ }
      reject(err);
    }
  });
}

// devour — the wraith consumes its harvest, entombing each soul in the crypt
async function devour(phantoms: NostrEvent[], env: Env): Promise<number> {
  if (phantoms.length === 0) return 0;

  // verify each specter is genuine before we enshrine it
  const verified = phantoms.filter((phantom) => {
    try {
      return verifyEvent(phantom as Parameters<typeof verifyEvent>[0]);
    } catch {
      return false; // counterfeit soul — discard it
    }
  });

  if (verified.length === 0) return 0;

  // entomb them all in one fell swoop
  const rituals = verified.map((soul) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO nostr_events (id, pubkey, created_at, kind, tags, content, sig)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      soul.id,
      soul.pubkey,
      soul.created_at,
      soul.kind,
      JSON.stringify(soul.tags),
      soul.content,
      soul.sig
    )
  );

  await env.DB.batch(rituals);
  return verified.length;
}

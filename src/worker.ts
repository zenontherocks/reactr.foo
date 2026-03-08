/// <reference types="@cloudflare/workers-types" />

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

  return json({ error: "Not Found" }, 404);
}

import { getPool, getRelays } from "./pool";
import type { Event } from "./pool";
import { nip19 } from "nostr-tools";

// ── NIP-50 Search ────────────────────────────────────────────────────────────

// Relays that support NIP-50 search
const SEARCH_RELAYS = ["wss://relay.nostr.band"];

/**
 * Search notes using NIP-50.
 */
export async function searchNotes(query: string, limit = 50): Promise<Event[]> {
  const pool = getPool();
  const relays = [...new Set([...SEARCH_RELAYS, ...getRelays().slice(0, 3)])];
  return pool.querySync(relays, {
    kinds: [1],
    search: query,
    limit,
  } as import("nostr-tools/filter").Filter & { search: string });
}

/**
 * Search profiles by NIP-50.
 */
export async function searchProfiles(query: string, limit = 20): Promise<Event[]> {
  const pool = getPool();
  return pool.querySync(SEARCH_RELAYS, {
    kinds: [0],
    search: query,
    limit,
  } as import("nostr-tools/filter").Filter & { search: string });
}

/**
 * Fetch notes by hashtag.
 */
export async function fetchByHashtag(tag: string, limit = 50): Promise<Event[]> {
  const pool = getPool();
  return pool.querySync(getRelays(), {
    kinds: [1],
    "#t": [tag.toLowerCase()],
    limit,
  });
}

/**
 * Resolve a NIP-05 identifier (user@domain) to a pubkey.
 */
export async function resolveNip05(identifier: string): Promise<string | null> {
  const [name, domain] = identifier.split("@");
  if (!name || !domain) return null;

  try {
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    const data = await res.json() as { names?: Record<string, string> };
    return data.names?.[name] ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse user input — could be npub, note, NIP-05, or search query.
 */
export function parseSearchInput(input: string): { type: "npub" | "note" | "nip05" | "query"; value: string } {
  const trimmed = input.trim();

  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub") return { type: "npub", value: decoded.data };
    } catch { /* not valid npub */ }
  }

  if (trimmed.startsWith("note1")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "note") return { type: "note", value: decoded.data };
    } catch { /* not valid note */ }
  }

  if (trimmed.includes("@") && !trimmed.includes(" ")) {
    return { type: "nip05", value: trimmed };
  }

  return { type: "query", value: trimmed };
}

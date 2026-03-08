import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import type { Event, Filter } from "nostr-tools";
import type { Reaction } from "./api";

export type { Event };

let pool: SimplePool | null = null;
let reactionSub: { close(): void } | null = null;
let activeRelays: string[] = [];

/**
 * Connect to the given relays and subscribe to kind-7 (reaction) events.
 * `onReaction` is called for every event received.
 */
export function connect(relays: string[], onReaction: (r: Reaction) => void): void {
  disconnect();
  if (relays.length === 0) return;

  pool = new SimplePool();
  activeRelays = relays;

  const filter: Filter = { kinds: [7] };

  reactionSub = pool.subscribeMany(relays, [filter], {
    onevent(event: Event) {
      // kind-7 tags: ["e", <note-id>] for the reacted-to note
      const eTag = event.tags.find((t) => t[0] === "e");
      if (!eTag || !eTag[1]) return;

      const noteId = eTag[1];
      // content is the emoji; "+" is the default reaction (like), "-" is dislike
      const emoji = event.content.trim() || "+";

      let npub: string;
      try {
        npub = npubEncode(event.pubkey);
      } catch {
        npub = event.pubkey;
      }

      onReaction({
        id: event.id,
        emoji,
        npub,
        note_id: noteId,
        relay: relays[0], // SimplePool doesn't expose per-event relay in the callback
        created_at: event.created_at,
      });
    },
  });
}

/** Close all relay connections. */
export function disconnect(): void {
  reactionSub?.close();
  reactionSub = null;
  if (pool) {
    pool.close(activeRelays);
    pool = null;
  }
  activeRelays = [];
}

/**
 * Fetch a single kind-1 (text note) event by ID from the relay pool.
 * Returns null if not found or pool is not connected.
 */
export async function fetchNote(noteId: string, relays: string[]): Promise<Event | null> {
  if (!pool || relays.length === 0) return null;
  try {
    return await pool.get(relays, { ids: [noteId], kinds: [1] });
  } catch {
    return null;
  }
}

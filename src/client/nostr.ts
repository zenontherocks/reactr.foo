import { SimplePool } from "nostr-tools/pool";
import { npubEncode } from "nostr-tools/nip19";
import type { Event, Filter } from "nostr-tools";
import type { Reaction } from "./api";

export type { Event };

// Always talk to our own relay — the crypt — not the upstream lairs directly.
const OWN_RELAY = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

let pool: SimplePool | null = null;
let reactionSub: { close(): void } | null = null;

export function connect(onReaction: (r: Reaction) => void): void {
  disconnect();

  pool = new SimplePool();

  const filter: Filter = { kinds: [7] };

  reactionSub = pool.subscribeMany([OWN_RELAY], [filter], {
    onevent(event: Event) {
      const eTag = event.tags.find((t) => t[0] === "e");
      if (!eTag || !eTag[1]) return;

      const noteId = eTag[1];
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
        relay: OWN_RELAY,
        created_at: event.created_at,
      });
    },
  });
}

export function disconnect(): void {
  reactionSub?.close();
  reactionSub = null;
  if (pool) {
    pool.close([OWN_RELAY]);
    pool = null;
  }
}

export async function fetchNote(noteId: string): Promise<Event | null> {
  if (!pool) return null;
  try {
    return await pool.get([OWN_RELAY], { ids: [noteId], kinds: [1] });
  } catch {
    return null;
  }
}

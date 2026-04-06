import { getAuth, signEvent } from "./auth";
import { publish } from "./pool";
import type { Event } from "./pool";

// ── Publish a new text note (kind 1) ─────────────────────────────────────────

export async function publishNote(content: string): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  const event = await signEvent({
    kind: 1,
    content,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
  });

  await Promise.allSettled(publish(event));
  return event;
}

// ── Reply to a note (kind 1 with NIP-10 threading tags) ──────────────────────

export async function publishReply(
  content: string,
  replyTo: Event,
  rootEvent?: Event,
): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  const tags: string[][] = [];

  // NIP-10 threading: root and reply markers
  const root = rootEvent ?? replyTo;
  if (root.id === replyTo.id) {
    // Replying to the root directly
    tags.push(["e", root.id, "", "root"]);
  } else {
    tags.push(["e", root.id, "", "root"]);
    tags.push(["e", replyTo.id, "", "reply"]);
  }

  // Tag the pubkeys we're replying to
  const pubkeys = new Set<string>();
  pubkeys.add(replyTo.pubkey);
  if (rootEvent) pubkeys.add(rootEvent.pubkey);
  // Include p-tags from the event we're replying to
  for (const t of replyTo.tags) {
    if (t[0] === "p" && t[1]) pubkeys.add(t[1]);
  }
  for (const pk of pubkeys) {
    tags.push(["p", pk]);
  }

  const event = await signEvent({
    kind: 1,
    content,
    created_at: Math.floor(Date.now() / 1000),
    tags,
  });

  await Promise.allSettled(publish(event));
  return event;
}

// ── React to a note (kind 7) ─────────────────────────────────────────────────

export async function publishReaction(
  emoji: string,
  targetEvent: Event,
): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  const event = await signEvent({
    kind: 7,
    content: emoji,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", targetEvent.id],
      ["p", targetEvent.pubkey],
    ],
  });

  await Promise.allSettled(publish(event));
  return event;
}

// ── Repost a note (kind 6) ───────────────────────────────────────────────────

export async function publishRepost(targetEvent: Event): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  const event = await signEvent({
    kind: 6,
    content: JSON.stringify(targetEvent),
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["e", targetEvent.id],
      ["p", targetEvent.pubkey],
    ],
  });

  await Promise.allSettled(publish(event));
  return event;
}

// ── Delete events (kind 5) ───────────────────────────────────────────────────

export async function publishDeletion(eventIds: string[], reason?: string): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  const tags = eventIds.map((id) => ["e", id]);

  const event = await signEvent({
    kind: 5,
    content: reason ?? "",
    created_at: Math.floor(Date.now() / 1000),
    tags,
  });

  await Promise.allSettled(publish(event));
  return event;
}

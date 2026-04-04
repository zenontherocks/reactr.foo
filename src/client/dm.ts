import { getAuth, signEvent } from "./auth";
import { querySync, publish } from "./pool";
import type { Event } from "./pool";

// ── NIP-04 Legacy DMs ───────────────────────────────────────────────────────

/**
 * Fetch NIP-04 DMs for the logged-in user.
 * Returns received (kind-4 with #p = user) and sent (kind-4 from user).
 */
export async function fetchNip04Messages(pubkey: string): Promise<Event[]> {
  const [received, sent] = await Promise.all([
    querySync({ kinds: [4], "#p": [pubkey], limit: 200 }),
    querySync({ kinds: [4], authors: [pubkey], limit: 200 }),
  ]);
  const all = [...received, ...sent];
  all.sort((a, b) => a.created_at - b.created_at);
  return all;
}

/**
 * Decrypt a NIP-04 message using the browser extension.
 */
export async function decryptNip04(peerPubkey: string, ciphertext: string): Promise<string> {
  if (!window.nostr?.nip04) throw new Error("NIP-04 decryption not supported by extension");
  return window.nostr.nip04.decrypt(peerPubkey, ciphertext);
}

/**
 * Send a NIP-04 encrypted DM.
 */
export async function sendNip04Message(recipientPubkey: string, plaintext: string): Promise<Event> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");
  if (!window.nostr?.nip04) throw new Error("NIP-04 encryption not supported by extension");

  const ciphertext = await window.nostr.nip04.encrypt(recipientPubkey, plaintext);

  const event = await signEvent({
    kind: 4,
    content: ciphertext,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
  });

  await Promise.allSettled(publish(event));
  return event;
}

// ── NIP-44 / NIP-17 Gift-Wrapped DMs ────────────────────────────────────────

/**
 * Decrypt a NIP-44 message using the browser extension.
 */
export async function decryptNip44(peerPubkey: string, ciphertext: string): Promise<string> {
  if (!window.nostr?.nip44) throw new Error("NIP-44 decryption not supported by extension");
  return window.nostr.nip44.decrypt(peerPubkey, ciphertext);
}

/**
 * Encrypt a message with NIP-44.
 */
export async function encryptNip44(peerPubkey: string, plaintext: string): Promise<string> {
  if (!window.nostr?.nip44) throw new Error("NIP-44 encryption not supported by extension");
  return window.nostr.nip44.encrypt(peerPubkey, plaintext);
}

/**
 * Send a NIP-17 gift-wrapped DM.
 * Flow: plaintext → kind-14 rumor → kind-13 seal (encrypted) → kind-1059 gift wrap
 */
export async function sendGiftWrappedDM(recipientPubkey: string, plaintext: string): Promise<void> {
  const auth = getAuth();
  if (!auth.pubkey) throw new Error("Not logged in");

  // 1. Build the kind-14 rumor (unsigned DM content)
  const rumor = {
    kind: 14,
    content: plaintext,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
    pubkey: auth.pubkey,
  };

  // 2. Seal it (kind 13) — encrypt the rumor for the recipient
  const sealContent = await encryptNip44(recipientPubkey, JSON.stringify(rumor));
  const seal = await signEvent({
    kind: 13,
    content: sealContent,
    created_at: randomTimestamp(),
    tags: [],
  });

  // 3. Gift-wrap (kind 1059) — we'd need a throwaway keypair for true NIP-17.
  // For simplicity, we publish the seal directly. Full NIP-17 requires
  // generating an ephemeral key and wrapping again, which needs crypto
  // primitives beyond what NIP-07 provides. This is a functional starting point.
  // TODO: Implement full gift-wrap with ephemeral keypair.

  await Promise.allSettled(publish(seal));
}

/**
 * Fetch NIP-17 gift-wrapped DMs (kind 1059) addressed to the user.
 */
export async function fetchGiftWrappedMessages(pubkey: string): Promise<Event[]> {
  return querySync({ kinds: [1059], "#p": [pubkey], limit: 200 });
}

// ── Conversation helpers ─────────────────────────────────────────────────────

export interface Conversation {
  peerPubkey: string;
  lastMessage: number; // timestamp
  unread: number;
}

/**
 * Group DM events into conversations by peer pubkey.
 */
export function groupConversations(events: Event[], myPubkey: string): Conversation[] {
  const convMap = new Map<string, { last: number; count: number }>();

  for (const event of events) {
    let peer: string;
    if (event.pubkey === myPubkey) {
      // Sent message — peer is the p-tag
      const pTag = event.tags.find((t) => t[0] === "p");
      peer = pTag?.[1] ?? "";
    } else {
      // Received message — peer is the sender
      peer = event.pubkey;
    }
    if (!peer) continue;

    const existing = convMap.get(peer);
    if (!existing || event.created_at > existing.last) {
      convMap.set(peer, {
        last: event.created_at,
        count: (existing?.count ?? 0) + 1,
      });
    } else {
      existing.count++;
    }
  }

  return [...convMap.entries()]
    .map(([peerPubkey, { last, count }]) => ({
      peerPubkey,
      lastMessage: last,
      unread: count,
    }))
    .sort((a, b) => b.lastMessage - a.lastMessage);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Random timestamp within the last 2 days (NIP-17 metadata obfuscation) */
function randomTimestamp(): number {
  const now = Math.floor(Date.now() / 1000);
  return now - Math.floor(Math.random() * 172800);
}

// ── NIP-04 type extension for window.nostr ───────────────────────────────────

declare global {
  interface Window {
    nostr?: Window["nostr"] & {
      nip04?: {
        encrypt(pubkey: string, plaintext: string): Promise<string>;
        decrypt(pubkey: string, ciphertext: string): Promise<string>;
      };
    };
  }
}

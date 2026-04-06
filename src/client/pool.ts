import { SimplePool } from "nostr-tools/pool";
import type { Event } from "nostr-tools/core";
import type { Filter } from "nostr-tools/filter";
import type { SubCloser } from "nostr-tools/pool";

// ── Default relays ───────────────────────────────────────────────────────────

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://purplepag.es",
  "wss://relay.primal.net",
  "wss://nostr.wine",
  "wss://nostr.mom",
];

// ── Pool singleton ───────────────────────────────────────────────────────────

let pool: SimplePool | null = null;
let relays: string[] = [...DEFAULT_RELAYS];

export function getPool(): SimplePool {
  if (!pool) {
    pool = new SimplePool();
  }
  return pool;
}

export function getRelays(): string[] {
  return relays;
}

export function setRelays(urls: string[]): void {
  relays = urls.length > 0 ? urls : [...DEFAULT_RELAYS];
}

// ── Convenience wrappers ─────────────────────────────────────────────────────

export function subscribe(
  filters: Filter,
  onEvent: (event: Event) => void,
  onEose?: () => void,
): SubCloser {
  const p = getPool();
  return p.subscribeMany(relays, filters, {
    onevent: onEvent,
    onclose: onEose ? () => onEose() : undefined,
  });
}

export async function querySync(filters: Filter): Promise<Event[]> {
  const p = getPool();
  return p.querySync(relays, filters);
}

export async function fetchOne(filters: Filter): Promise<Event | null> {
  const p = getPool();
  return p.get(relays, filters);
}

export function publish(event: Event): Promise<string>[] {
  const p = getPool();
  return p.publish(relays, event);
}

export function destroyPool(): void {
  if (pool) {
    pool.destroy();
    pool = null;
  }
}

export type { SubCloser, Event, Filter };

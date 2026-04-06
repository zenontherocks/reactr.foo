import { querySync } from "./pool";
import type { Event } from "./pool";

// ── Profile metadata (kind-0 content) ────────────────────────────────────────

export interface Profile {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
  lud06?: string;
  banner?: string;
  website?: string;
}

// ── In-memory cache ──────────────────────────────────────────────────────────

const cache = new Map<string, Profile>();
const pending = new Set<string>();
const CACHE_STORAGE_KEY = "reactr_profiles";
const MAX_CACHE = 500;

// Load from localStorage on init
try {
  const raw = localStorage.getItem(CACHE_STORAGE_KEY);
  if (raw) {
    const entries = JSON.parse(raw) as Array<[string, Profile]>;
    for (const [k, v] of entries) cache.set(k, v);
  }
} catch { /* ignore */ }

function persistCache(): void {
  try {
    const entries = [...cache.entries()].slice(-MAX_CACHE);
    localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(entries));
  } catch { /* quota exceeded, ignore */ }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getCachedProfile(pubkey: string): Profile | undefined {
  return cache.get(pubkey);
}

export async function fetchProfile(pubkey: string): Promise<Profile | undefined> {
  if (cache.has(pubkey)) return cache.get(pubkey);
  if (pending.has(pubkey)) return undefined;

  pending.add(pubkey);
  try {
    const events = await querySync({ kinds: [0], authors: [pubkey], limit: 1 });
    if (events.length > 0) {
      const profile = parseProfileEvent(events[0]);
      cache.set(pubkey, profile);
      persistCache();
      return profile;
    }
  } finally {
    pending.delete(pubkey);
  }
  return undefined;
}

export async function fetchProfiles(pubkeys: string[]): Promise<Map<string, Profile>> {
  const result = new Map<string, Profile>();
  const toFetch: string[] = [];

  for (const pk of pubkeys) {
    const cached = cache.get(pk);
    if (cached) {
      result.set(pk, cached);
    } else if (!pending.has(pk)) {
      toFetch.push(pk);
    }
  }

  if (toFetch.length === 0) return result;

  // Batch fetch in chunks of 50
  for (let i = 0; i < toFetch.length; i += 50) {
    const chunk = toFetch.slice(i, i + 50);
    for (const pk of chunk) pending.add(pk);

    try {
      const events = await querySync({ kinds: [0], authors: chunk, limit: chunk.length });
      for (const event of events) {
        const profile = parseProfileEvent(event);
        cache.set(profile.pubkey, profile);
        result.set(profile.pubkey, profile);
      }
    } finally {
      for (const pk of chunk) pending.delete(pk);
    }
  }

  persistCache();
  return result;
}

export function getDisplayName(profile: Profile | undefined, pubkey: string): string {
  if (profile?.display_name) return profile.display_name;
  if (profile?.name) return profile.name;
  return pubkey.slice(0, 12) + "...";
}

// ── Contact list (kind-3) ────────────────────────────────────────────────────

export async function fetchContactList(pubkey: string): Promise<string[]> {
  const events = await querySync({ kinds: [3], authors: [pubkey], limit: 1 });
  if (events.length === 0) return [];
  return events[0].tags
    .filter((t) => t[0] === "p" && t[1])
    .map((t) => t[1]);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseProfileEvent(event: Event): Profile {
  const profile: Profile = { pubkey: event.pubkey };
  try {
    const data = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof data.name === "string") profile.name = data.name;
    if (typeof data.display_name === "string") profile.display_name = data.display_name;
    if (typeof data.picture === "string") profile.picture = data.picture;
    if (typeof data.about === "string") profile.about = data.about;
    if (typeof data.nip05 === "string") profile.nip05 = data.nip05;
    if (typeof data.lud16 === "string") profile.lud16 = data.lud16;
    if (typeof data.lud06 === "string") profile.lud06 = data.lud06;
    if (typeof data.banner === "string") profile.banner = data.banner;
    if (typeof data.website === "string") profile.website = data.website;
  } catch { /* bad JSON, use defaults */ }
  return profile;
}

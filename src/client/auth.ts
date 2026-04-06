import { nip19 } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

// ── NIP-07 type declaration ──────────────────────────────────────────────────

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: Nip07;
  }
}

// ── State ────────────────────────────────────────────────────────────────────

type AuthMethod = "nip07" | "nsec";

interface AuthState {
  pubkey: string | null;
  npub: string | null;
  method: AuthMethod | null;
}

const STORAGE_KEY = "reactr_auth";

let state: AuthState = { pubkey: null, npub: null, method: null };
const listeners: Array<(s: AuthState) => void> = [];

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as AuthState;
      if (saved.pubkey) state = saved;
    }
  } catch { /* ignore corrupt storage */ }
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function notify(): void {
  for (const fn of listeners) fn(state);
}

// ── Private key holder (nsec login only, never persisted) ────────────────────

let _privkey: Uint8Array | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function getAuth(): Readonly<AuthState> {
  return state;
}

export function onAuthChange(fn: (s: AuthState) => void): () => void {
  listeners.push(fn);
  return () => {
    const idx = listeners.indexOf(fn);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

export function hasNip07(): boolean {
  return typeof window.nostr !== "undefined";
}

export async function loginNip07(): Promise<void> {
  if (!window.nostr) throw new Error("No NIP-07 extension found. Install Alby or nos2x.");
  const pubkey = await window.nostr.getPublicKey();
  state = { pubkey, npub: nip19.npubEncode(pubkey), method: "nip07" };
  _privkey = null;
  persist();
  notify();
}

export async function loginNsec(nsecOrHex: string): Promise<void> {
  let keyBytes: Uint8Array;
  if (nsecOrHex.startsWith("nsec1")) {
    const decoded = nip19.decode(nsecOrHex);
    if (decoded.type !== "nsec") throw new Error("Invalid nsec");
    keyBytes = decoded.data;
  } else {
    if (!/^[0-9a-f]{64}$/i.test(nsecOrHex)) throw new Error("Invalid private key");
    keyBytes = hexToBytes(nsecOrHex);
  }

  const { getPublicKey } = await import("nostr-tools/pure");
  const pubkey = getPublicKey(keyBytes);

  _privkey = keyBytes;
  state = { pubkey, npub: nip19.npubEncode(pubkey), method: "nsec" };
  persist();
  notify();
}

export function logout(): void {
  state = { pubkey: null, npub: null, method: null };
  _privkey = null;
  localStorage.removeItem(STORAGE_KEY);
  notify();
}

export async function signEvent(template: EventTemplate): Promise<VerifiedEvent> {
  if (state.method === "nip07" && window.nostr) {
    return window.nostr.signEvent(template);
  }
  if (state.method === "nsec" && _privkey) {
    const { finalizeEvent } = await import("nostr-tools/pure");
    return finalizeEvent(template, _privkey);
  }
  throw new Error("Not logged in");
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ── Initialize ───────────────────────────────────────────────────────────────

load();

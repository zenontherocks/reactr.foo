import { nip19 } from "nostr-tools";
import type { EventTemplate, VerifiedEvent } from "nostr-tools/core";

// ── NIP-07 type declaration ──────────────────────────────────────────────────

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip04?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
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

// ── Types ────────────────────────────────────────────────────────────────────

export type AuthMethod = "nip07" | "nsec";

export interface Account {
  id: string; // = pubkey (hex)
  pubkey: string;
  npub: string;
  method: AuthMethod;
  privkeyHex?: string; // only for "nsec" accounts; plaintext, client-only
  label?: string;
  createdAt: number;
}

export interface AuthState {
  pubkey: string | null;
  npub: string | null;
  method: AuthMethod | null;
}

interface AccountsState {
  accounts: Account[];
  activeId: string | null;
}

const STORAGE_KEY = "reactr_accounts";

let accountsState: AccountsState = { accounts: [], activeId: null };
const listeners: Array<(s: AuthState) => void> = [];

function activeAccount(): Account | null {
  return accountsState.accounts.find((a) => a.id === accountsState.activeId) ?? null;
}

function toAuthState(): AuthState {
  const acc = activeAccount();
  if (!acc) return { pubkey: null, npub: null, method: null };
  return { pubkey: acc.pubkey, npub: acc.npub, method: acc.method };
}

function persist(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(accountsState));
}

function notify(): void {
  const s = toAuthState();
  for (const fn of listeners) fn(s);
}

function makeAccount(
  pubkey: string,
  method: AuthMethod,
  opts: { privkeyHex?: string; label?: string } = {}
): Account {
  return {
    id: pubkey,
    pubkey,
    npub: nip19.npubEncode(pubkey),
    method,
    privkeyHex: opts.privkeyHex,
    label: opts.label,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

async function freshPseudonymousAccount(): Promise<Account> {
  const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  return makeAccount(pubkey, "nsec", {
    privkeyHex: bytesToHex(secretKey),
    label: "Anonymous",
  });
}

function load(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as AccountsState;
      if (Array.isArray(saved.accounts) && saved.accounts.length > 0) {
        accountsState = saved;
        return;
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  // No accounts yet (or corrupt storage) — resolved by ensureBootstrapped().
}

let bootstrapped: Promise<void> | null = null;

/** Ensures at least one account exists, auto-generating a pseudonymous one on first visit. */
export function ensureBootstrapped(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      if (accountsState.accounts.length === 0) {
        const acc = await freshPseudonymousAccount();
        accountsState = { accounts: [acc], activeId: acc.id };
        persist();
      }
    })();
  }
  return bootstrapped;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getAuth(): Readonly<AuthState> {
  return toAuthState();
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

export function getAccounts(): Array<Omit<Account, "privkeyHex">> {
  return accountsState.accounts.map(({ privkeyHex: _privkeyHex, ...rest }) => rest);
}

export function getActiveAccountId(): string | null {
  return accountsState.activeId;
}

export function switchAccount(id: string): void {
  if (!accountsState.accounts.some((a) => a.id === id)) {
    throw new Error("Unknown account");
  }
  accountsState.activeId = id;
  persist();
  notify();
}

function addOrSwitch(account: Account): void {
  const existing = accountsState.accounts.find((a) => a.id === account.id);
  if (existing) {
    accountsState.activeId = existing.id;
  } else {
    accountsState.accounts = [...accountsState.accounts, account];
    accountsState.activeId = account.id;
  }
  persist();
  notify();
}

export async function generateAccount(label?: string): Promise<void> {
  const acc = await freshPseudonymousAccount();
  if (label) acc.label = label;
  addOrSwitch(acc);
}

export async function importNsec(nsecOrHex: string, label?: string): Promise<void> {
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
  const acc = makeAccount(pubkey, "nsec", { privkeyHex: bytesToHex(keyBytes), label });
  addOrSwitch(acc);
}

export async function connectNip07(): Promise<void> {
  if (!window.nostr) throw new Error("No NIP-07 extension found. Install Alby or nos2x.");
  const pubkey = await window.nostr.getPublicKey();
  const acc = makeAccount(pubkey, "nip07");
  addOrSwitch(acc);
}

/** Removes an account. If it was active, switches to another one, generating a fresh
 *  pseudonymous account if none remain — there's always an active identity. */
export async function removeAccount(id: string): Promise<void> {
  const wasActive = accountsState.activeId === id;
  accountsState.accounts = accountsState.accounts.filter((a) => a.id !== id);

  if (accountsState.accounts.length === 0) {
    const acc = await freshPseudonymousAccount();
    accountsState = { accounts: [acc], activeId: acc.id };
  } else if (wasActive) {
    accountsState.activeId = accountsState.accounts[0].id;
  }

  persist();
  notify();
}

export function exportNsec(id: string): string {
  const acc = accountsState.accounts.find((a) => a.id === id);
  if (!acc) throw new Error("Unknown account");
  if (acc.method !== "nsec" || !acc.privkeyHex) {
    throw new Error("This account is backed by a browser extension — there is no nsec to export.");
  }
  return nip19.nsecEncode(hexToBytes(acc.privkeyHex));
}

export async function signEvent(template: EventTemplate): Promise<VerifiedEvent> {
  const acc = activeAccount();
  if (!acc) throw new Error("No active account");
  if (acc.method === "nip07" && window.nostr) {
    return window.nostr.signEvent(template);
  }
  if (acc.method === "nsec" && acc.privkeyHex) {
    const { finalizeEvent } = await import("nostr-tools/pure");
    return finalizeEvent(template, hexToBytes(acc.privkeyHex));
  }
  throw new Error("Not logged in");
}

/** Returns the active account's hex private key, for modules (e.g. NIP-04) that need
 *  to do their own crypto with raw-nsec accounts. Throws for nip07 accounts. */
export function getActivePrivkeyHex(): string {
  const acc = activeAccount();
  if (!acc || acc.method !== "nsec" || !acc.privkeyHex) {
    throw new Error("Active account has no local private key");
  }
  return acc.privkeyHex;
}

export function getActiveMethod(): AuthMethod | null {
  return activeAccount()?.method ?? null;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Initialize ───────────────────────────────────────────────────────────────

load();

import { getConfig, saveConfig, getReactionsByNote, getNotes } from "./api";
import type { AppConfig, Note } from "./api";
import { renderNotes, renderConfig } from "./ui";
import { getAuth, onAuthChange, loginNip07, loginNsec, logout, hasNip07 } from "./auth";
import { querySync, subscribe, destroyPool } from "./pool";
import type { SubCloser, Event } from "./pool";
import { addRoute, startRouter, onNavigate, currentPath } from "./router";
import { nip19 } from "nostr-tools";

// ── State ─────────────────────────────────────────────────────────────────────

let config: AppConfig = { emoji_weights: [] };
const notesMap = new Map<string, Note>();
const reactionsByNote = new Map<string, Record<string, number>>();
let currentPage = 0;
let feedSub: SubCloser | null = null;
let globalSub: SubCloser | null = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const notesEl = document.getElementById("notes")!;
const statusEl = document.getElementById("status")!;
const loginBtn = document.getElementById("login-btn")!;
const loginModal = document.getElementById("login-modal")!;

function setStatus(el: HTMLElement, msg: string): void {
  el.textContent = msg;
}

// ── Views ─────────────────────────────────────────────────────────────────────

const views: Record<string, HTMLElement> = {};
document.querySelectorAll<HTMLElement>(".view").forEach((el) => {
  views[el.id] = el;
});

function showView(id: string): void {
  for (const [key, el] of Object.entries(views)) {
    el.classList.toggle("hidden", key !== id);
  }
}

function updateNavActive(path: string): void {
  document.querySelectorAll<HTMLElement>(".nav-link").forEach((link) => {
    const route = link.dataset.route ?? "/";
    link.classList.toggle("active", route === path);
  });
}

// ── Reactions view (existing, default) ────────────────────────────────────────

async function loadReactionsData(): Promise<void> {
  const byNote = await getReactionsByNote();

  reactionsByNote.clear();
  for (const row of byNote) {
    const counts = reactionsByNote.get(row.note_id) ?? {};
    counts[row.emoji] = row.count;
    reactionsByNote.set(row.note_id, counts);
  }

  const missingIds = [...reactionsByNote.keys()].filter((id) => !notesMap.has(id));
  if (missingIds.length > 0) {
    const notes = await getNotes(missingIds);
    for (const note of notes) notesMap.set(note.id, note);
  }

  currentPage = 0;
  renderNotes(notesEl, notesMap, reactionsByNote, config.emoji_weights, currentPage);
  setStatus(statusEl, `${reactionsByNote.size} note(s) — last updated ${new Date().toLocaleTimeString()}`);
}

// ── Feed view (Following) ─────────────────────────────────────────────────────

const feedNotes: Event[] = [];

function renderFeedNotes(container: HTMLElement, notes: Event[]): void {
  container.innerHTML = "";
  if (notes.length === 0) {
    container.innerHTML = '<p class="empty">No notes yet. Follow some people to see their posts here.</p>';
    return;
  }
  for (const event of notes) {
    const el = document.createElement("article");
    el.className = "feed-note";

    const npub = nip19.npubEncode(event.pubkey);
    const time = new Date(event.created_at * 1000).toLocaleString();
    const noteId = nip19.noteEncode(event.id);

    el.innerHTML = `
      <div class="feed-note-author">
        <span class="author-name">${esc(npub.slice(0, 16))}...</span>
        <span class="author-time">${time}</span>
      </div>
      <a href="https://iris.to/${noteId}" target="_blank" rel="noopener noreferrer" class="note-link">
        <p class="note-content">${renderContent(event.content)}</p>
      </a>
    `;
    container.appendChild(el);
  }
}

function startFeedSubscription(): void {
  stopFeedSubscription();
  const auth = getAuth();
  if (!auth.pubkey) return;

  const feedContainer = document.getElementById("feed-notes")!;
  const feedStatus = document.getElementById("feed-status")!;
  setStatus(feedStatus, "Loading following feed...");
  feedNotes.length = 0;

  // First fetch contact list (kind 3)
  querySync({ kinds: [3], authors: [auth.pubkey], limit: 1 }).then((events) => {
    if (events.length === 0) {
      setStatus(feedStatus, "No contacts found. Follow people to see their notes.");
      return;
    }

    // Parse followed pubkeys from kind-3 tags
    const contacts = events[0].tags
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => t[1]);

    if (contacts.length === 0) {
      setStatus(feedStatus, "Contact list is empty.");
      return;
    }

    setStatus(feedStatus, `Loading notes from ${contacts.length} contacts...`);

    // Subscribe to notes from contacts
    feedSub = subscribe(
      { kinds: [1], authors: contacts, limit: 100 },
      (event) => {
        feedNotes.push(event);
        feedNotes.sort((a, b) => b.created_at - a.created_at);
        if (feedNotes.length > 200) feedNotes.length = 200;
        renderFeedNotes(feedContainer, feedNotes);
        setStatus(feedStatus, `${feedNotes.length} note(s) from ${contacts.length} contacts`);
      },
    );
  });
}

function stopFeedSubscription(): void {
  if (feedSub) { feedSub.close(); feedSub = null; }
}

// ── Global view ───────────────────────────────────────────────────────────────

const globalNotes: Event[] = [];

function startGlobalSubscription(): void {
  stopGlobalSubscription();
  const container = document.getElementById("global-notes")!;
  const globalStatus = document.getElementById("global-status")!;
  setStatus(globalStatus, "Loading global feed...");
  globalNotes.length = 0;

  globalSub = subscribe(
    { kinds: [1], limit: 100 },
    (event) => {
      globalNotes.push(event);
      globalNotes.sort((a, b) => b.created_at - a.created_at);
      if (globalNotes.length > 200) globalNotes.length = 200;
      renderFeedNotes(container, globalNotes);
      setStatus(globalStatus, `${globalNotes.length} note(s)`);
    },
  );
}

function stopGlobalSubscription(): void {
  if (globalSub) { globalSub.close(); globalSub = null; }
}

// ── Auth UI ───────────────────────────────────────────────────────────────────

function updateAuthUI(): void {
  const auth = getAuth();
  if (auth.pubkey) {
    loginBtn.textContent = "Log out";
    loginBtn.classList.remove("primary");
  } else {
    loginBtn.textContent = "Log in";
    loginBtn.classList.add("primary");
  }
}

function setupAuthHandlers(): void {
  loginBtn.addEventListener("click", () => {
    const auth = getAuth();
    if (auth.pubkey) {
      logout();
      stopFeedSubscription();
      stopGlobalSubscription();
      destroyPool();
    } else {
      loginModal.classList.remove("hidden");
      // Auto-disable NIP-07 button if no extension
      const nip07Btn = document.getElementById("login-nip07") as HTMLButtonElement;
      nip07Btn.disabled = !hasNip07();
      if (!hasNip07()) {
        nip07Btn.textContent = "No extension detected";
      } else {
        nip07Btn.textContent = "Use browser extension (NIP-07)";
      }
    }
  });

  document.getElementById("login-nip07")!.addEventListener("click", async () => {
    try {
      await loginNip07();
      loginModal.classList.add("hidden");
    } catch (err) {
      alert((err as Error).message);
    }
  });

  document.getElementById("login-nsec")!.addEventListener("click", async () => {
    const input = document.getElementById("nsec-input") as HTMLInputElement;
    try {
      await loginNsec(input.value.trim());
      input.value = "";
      loginModal.classList.add("hidden");
    } catch (err) {
      alert((err as Error).message);
    }
  });

  document.getElementById("login-cancel")!.addEventListener("click", () => {
    loginModal.classList.add("hidden");
  });

  document.querySelector(".modal-backdrop")!.addEventListener("click", () => {
    loginModal.classList.add("hidden");
  });

  onAuthChange(updateAuthUI);
}

// ── Config UI wiring ──────────────────────────────────────────────────────────

function setupConfigHandlers(): void {
  document.getElementById("settings-toggle")!.addEventListener("click", () => {
    document.getElementById("settings")!.classList.toggle("hidden");
  });

  document.getElementById("add-emoji")!.addEventListener("click", () => {
    const input = document.getElementById("emoji-input") as HTMLInputElement;
    const emoji = input.value.trim();
    if (emoji && !config.emoji_weights.some((e) => e.emoji === emoji)) {
      config.emoji_weights = [...config.emoji_weights, { emoji, weight: 50 }];
      renderConfig(config);
      input.value = "";
    }
  });

  document.getElementById("save-config")!.addEventListener("click", async () => {
    setStatus(statusEl, "Saving...");
    await saveConfig(config);
    await loadReactionsData();
  });

  document.getElementById("emoji-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.getElementById("add-emoji")!.click();
    }
  });
}

// ── Routing ───────────────────────────────────────────────────────────────────

function setupRoutes(): void {
  addRoute("/", () => {
    showView("view-reactions");
    loadReactionsData();
  });

  addRoute("/feed", () => {
    showView("view-feed");
    const auth = getAuth();
    if (auth.pubkey) {
      startFeedSubscription();
    } else {
      const container = document.getElementById("feed-notes")!;
      container.innerHTML = '<p class="empty">Log in to see your following feed.</p>';
    }
  });

  addRoute("/global", () => {
    showView("view-global");
    startGlobalSubscription();
  });

  addRoute("/notifications", () => {
    showView("view-notifications");
  });

  addRoute("/messages", () => {
    showView("view-messages");
  });

  addRoute("/search", () => {
    showView("view-search");
  });

  addRoute("/note/:id", (params) => {
    showView("view-note");
    const container = document.getElementById("note-thread")!;
    container.innerHTML = `<p class="status">Loading note ${params.id?.slice(0, 16)}...</p>`;
  });

  addRoute("/profile/:npub", (params) => {
    showView("view-profile");
    const container = document.getElementById("profile-header")!;
    container.innerHTML = `<p class="status">Loading profile ${params.npub?.slice(0, 16)}...</p>`;
  });

  // Update nav active state on route change
  onNavigate((path) => {
    // Clean up subscriptions when leaving views
    const simplePath = "/" + (path.split("/")[1] || "");
    updateNavActive(simplePath === "/" ? "/" : simplePath);

    if (simplePath !== "/feed") stopFeedSubscription();
    if (simplePath !== "/global") stopGlobalSubscription();
  });
}

// ── Content rendering helpers (shared with feed views) ────────────────────────

function renderContent(content: string): string {
  const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?[^\s]*)?$/i;
  const parts = content.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      if (IMAGE_EXT.test(part)) {
        return `<img class="note-image" src="${esc(part)}" alt="image" loading="lazy">`;
      }
      return esc(part);
    }
    return esc(part);
  }).join("");
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  setStatus(statusEl, "Loading...");
  config = await getConfig();
  renderConfig(config);
  setupConfigHandlers();
  setupAuthHandlers();
  updateAuthUI();

  notesEl.addEventListener("paginate", (e) => {
    currentPage = (e as CustomEvent<{ page: number }>).detail.page;
    renderNotes(notesEl, notesMap, reactionsByNote, config.emoji_weights, currentPage);
  });

  setupRoutes();
  startRouter();

  // Poll reactions data every 60s (only updates when reactions view is active)
  setInterval(() => {
    if (currentPath() === "/") loadReactionsData();
  }, 60_000);
}

init().catch((err) => {
  setStatus(statusEl, `Error: ${err}`);
  console.error(err);
});

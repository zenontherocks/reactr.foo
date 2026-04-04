import { getConfig, saveConfig, getReactionsByNote, getNotes } from "./api";
import type { AppConfig, Note } from "./api";
import { renderNotes, renderConfig } from "./ui";
import { getAuth, onAuthChange, loginNip07, loginNsec, logout, hasNip07 } from "./auth";
import { querySync, subscribe, destroyPool } from "./pool";
import type { SubCloser, Event } from "./pool";
import { addRoute, startRouter, onNavigate, navigate, currentPath } from "./router";
import { nip19 } from "nostr-tools";
import { fetchProfiles, getDisplayName, getCachedProfile, fetchContactList } from "./profile";
import { publishNote, publishReply, publishReaction, publishRepost } from "./compose";
import { createZap, payWithWebLN } from "./zap";
import { searchNotes, searchProfiles, parseSearchInput, resolveNip05, fetchByHashtag } from "./search";
import {
  startNotificationSubscription,
  stopNotificationSubscription,
  onNotifications,
  getUnreadCount,
  markAllRead,
} from "./notifications";
import { fetchNip04Messages, groupConversations, decryptNip04, sendNip04Message } from "./dm";
import type { Profile } from "./profile";

// ── State ─────────────────────────────────────────────────────────────────────

let config: AppConfig = { emoji_weights: [] };
const notesMap = new Map<string, Note>();
const reactionsByNote = new Map<string, Record<string, number>>();
let currentPage = 0;
let feedSub: SubCloser | null = null;
let globalSub: SubCloser | null = null;
let contacts: string[] = [];

// ── DOM refs ──────────────────────────────────────────────────────────────────

const notesEl = document.getElementById("notes")!;
const statusEl = document.getElementById("status")!;
const loginBtn = document.getElementById("login-btn")!;
const loginModal = document.getElementById("login-modal")!;
const notifNav = document.querySelector('.nav-link[data-route="/notifications"]')!;

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

// ── Shared rendering helpers ──────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(content: string): string {
  const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?[^\s]*)?$/i;
  const VIDEO_EXT = /\.(mp4|webm|mov)(\?[^\s]*)?$/i;
  const parts = content.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      if (IMAGE_EXT.test(part)) {
        return `<img class="note-image" src="${esc(part)}" alt="image" loading="lazy">`;
      }
      if (VIDEO_EXT.test(part)) {
        return `<video class="note-image" src="${esc(part)}" controls preload="metadata"></video>`;
      }
      return `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`;
    }
    return esc(part);
  }).join("");
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000) - timestamp;
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ── Feed note rendering (shared by Following, Global, Profile, Search) ───────

function renderFeedNote(event: Event, profile?: Profile): HTMLElement {
  const el = document.createElement("article");
  el.className = "feed-note";
  el.dataset.eventId = event.id;

  const name = getDisplayName(profile, event.pubkey);
  const avatar = profile?.picture
    ? `<img src="${esc(profile.picture)}" alt="" loading="lazy">`
    : `<span class="avatar-placeholder">${name.slice(0, 1).toUpperCase()}</span>`;
  const npub = nip19.npubEncode(event.pubkey);

  el.innerHTML = `
    <div class="feed-note-author">
      <a href="#/profile/${npub}" class="author-avatar">${avatar}</a>
      <a href="#/profile/${npub}" class="author-name">${esc(name)}</a>
      <span class="author-time">${timeAgo(event.created_at)}</span>
    </div>
    <div class="note-content">${renderContent(event.content)}</div>
    <div class="note-actions">
      <button class="action-btn reply-btn" title="Reply">Reply</button>
      <button class="action-btn react-btn" title="React">+</button>
      <button class="action-btn repost-btn" title="Repost">Repost</button>
      <button class="action-btn zap-btn" title="Zap">Zap</button>
    </div>
  `;

  // Wire action buttons
  wireNoteActions(el, event);

  return el;
}

function wireNoteActions(el: HTMLElement, event: Event): void {
  const auth = getAuth();

  el.querySelector(".reply-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!auth.pubkey) { alert("Log in to reply"); return; }
    const text = prompt("Reply:");
    if (text?.trim()) {
      publishReply(text.trim(), event).then(() => {
        alert("Reply published!");
      }).catch((err) => alert(String(err)));
    }
  });

  el.querySelector(".react-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!auth.pubkey) { alert("Log in to react"); return; }
    const emojis = config.emoji_weights.map((w) => w.emoji);
    const emoji = prompt(`React with emoji:\n${emojis.join("  ")}`, emojis[0] ?? "+");
    if (emoji?.trim()) {
      publishReaction(emoji.trim(), event).catch((err) => alert(String(err)));
    }
  });

  el.querySelector(".repost-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!auth.pubkey) { alert("Log in to repost"); return; }
    if (confirm("Repost this note?")) {
      publishRepost(event).catch((err) => alert(String(err)));
    }
  });

  el.querySelector(".zap-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!auth.pubkey) { alert("Log in to zap"); return; }
    const amount = prompt("Zap amount in sats:", "21");
    if (amount) {
      const sats = parseInt(amount, 10);
      if (isNaN(sats) || sats <= 0) { alert("Invalid amount"); return; }
      createZap({ targetEvent: event, amountSats: sats }).then(async (invoice) => {
        const paid = await payWithWebLN(invoice);
        if (!paid) {
          // Show invoice for manual payment
          prompt("Copy this Lightning invoice to pay:", invoice);
        }
      }).catch((err) => alert(String(err)));
    }
  });
}

async function renderFeedList(container: HTMLElement, events: Event[]): Promise<void> {
  // Batch-fetch profiles for all pubkeys
  const pubkeys = [...new Set(events.map((e) => e.pubkey))];
  const profiles = await fetchProfiles(pubkeys);

  container.innerHTML = "";
  if (events.length === 0) {
    container.innerHTML = '<p class="empty">No notes yet.</p>';
    return;
  }
  for (const event of events) {
    container.appendChild(renderFeedNote(event, profiles.get(event.pubkey)));
  }
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

function startFeedSubscription(): void {
  stopFeedSubscription();
  const auth = getAuth();
  if (!auth.pubkey) return;

  const feedContainer = document.getElementById("feed-notes")!;
  const feedStatus = document.getElementById("feed-status")!;
  setStatus(feedStatus, "Loading following feed...");
  feedNotes.length = 0;

  if (contacts.length === 0) {
    setStatus(feedStatus, "No contacts found. Follow people to see their notes.");
    return;
  }

  setStatus(feedStatus, `Loading notes from ${contacts.length} contacts...`);

  feedSub = subscribe(
    { kinds: [1], authors: contacts, limit: 100 },
    (event) => {
      feedNotes.push(event);
      feedNotes.sort((a, b) => b.created_at - a.created_at);
      if (feedNotes.length > 200) feedNotes.length = 200;
      renderFeedList(feedContainer, feedNotes);
      setStatus(feedStatus, `${feedNotes.length} note(s) from ${contacts.length} contacts`);
    },
  );
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
      renderFeedList(container, globalNotes);
      setStatus(globalStatus, `${globalNotes.length} note(s)`);
    },
  );
}

function stopGlobalSubscription(): void {
  if (globalSub) { globalSub.close(); globalSub = null; }
}

// ── Note thread view ──────────────────────────────────────────────────────────

async function loadNoteThread(noteId: string): Promise<void> {
  const container = document.getElementById("note-thread")!;
  container.innerHTML = '<p class="status">Loading thread...</p>';

  // Fetch the note and its replies
  const [noteEvents, replyEvents] = await Promise.all([
    querySync({ ids: [noteId], limit: 1 }),
    querySync({ kinds: [1], "#e": [noteId], limit: 50 }),
  ]);

  if (noteEvents.length === 0) {
    container.innerHTML = '<p class="empty">Note not found.</p>';
    return;
  }

  const allEvents = [...noteEvents, ...replyEvents];
  allEvents.sort((a, b) => a.created_at - b.created_at);
  await renderFeedList(container, allEvents);
}

// ── Profile view ──────────────────────────────────────────────────────────────

async function loadProfileView(npubOrPubkey: string): Promise<void> {
  const headerEl = document.getElementById("profile-header")!;
  const notesEl = document.getElementById("profile-notes")!;
  headerEl.innerHTML = '<p class="status">Loading profile...</p>';
  notesEl.innerHTML = "";

  let pubkey: string;
  try {
    if (npubOrPubkey.startsWith("npub1")) {
      const decoded = nip19.decode(npubOrPubkey);
      pubkey = decoded.data as string;
    } else {
      pubkey = npubOrPubkey;
    }
  } catch {
    headerEl.innerHTML = '<p class="empty">Invalid profile identifier.</p>';
    return;
  }

  const profiles = await fetchProfiles([pubkey]);
  const profile = profiles.get(pubkey);
  const name = getDisplayName(profile, pubkey);
  const npub = nip19.npubEncode(pubkey);

  headerEl.innerHTML = `
    <div class="profile-card">
      ${profile?.banner ? `<div class="profile-banner"><img src="${esc(profile.banner)}" alt=""></div>` : ""}
      <div class="profile-info">
        ${profile?.picture ? `<img class="profile-avatar" src="${esc(profile.picture)}" alt="">` : ""}
        <h2>${esc(name)}</h2>
        ${profile?.nip05 ? `<p class="profile-nip05">${esc(profile.nip05)}</p>` : ""}
        <p class="profile-npub">${esc(npub)}</p>
        ${profile?.about ? `<p class="profile-about">${renderContent(profile.about)}</p>` : ""}
        ${profile?.website ? `<p class="profile-website"><a href="${esc(profile.website)}" target="_blank" rel="noopener">${esc(profile.website)}</a></p>` : ""}
        ${profile?.lud16 ? `<p class="profile-ln">Lightning: ${esc(profile.lud16)}</p>` : ""}
      </div>
    </div>
  `;

  // Fetch their notes
  const notes = await querySync({ kinds: [1], authors: [pubkey], limit: 50 });
  notes.sort((a, b) => b.created_at - a.created_at);
  await renderFeedList(notesEl, notes);
}

// ── Search view ───────────────────────────────────────────────────────────────

function setupSearchHandlers(): void {
  const searchInput = document.getElementById("search-input") as HTMLInputElement;
  const searchBtn = document.getElementById("search-btn")!;
  const resultsEl = document.getElementById("search-results")!;

  async function doSearch(): Promise<void> {
    const query = searchInput.value.trim();
    if (!query) return;

    resultsEl.innerHTML = '<p class="status">Searching...</p>';

    const parsed = parseSearchInput(query);

    if (parsed.type === "npub") {
      navigate(`/profile/${nip19.npubEncode(parsed.value)}`);
      return;
    }

    if (parsed.type === "note") {
      navigate(`/note/${parsed.value}`);
      return;
    }

    if (parsed.type === "nip05") {
      const pubkey = await resolveNip05(parsed.value);
      if (pubkey) {
        navigate(`/profile/${nip19.npubEncode(pubkey)}`);
      } else {
        resultsEl.innerHTML = '<p class="empty">NIP-05 not found.</p>';
      }
      return;
    }

    // Handle hashtag queries
    if (query.startsWith("#")) {
      const events = await fetchByHashtag(query.slice(1));
      events.sort((a, b) => b.created_at - a.created_at);
      await renderFeedList(resultsEl, events);
      return;
    }

    // Full text search
    const [notes, profiles] = await Promise.all([
      searchNotes(query),
      searchProfiles(query),
    ]);

    if (profiles.length > 0) {
      const profilesSection = document.createElement("div");
      profilesSection.innerHTML = `<h3 style="color: var(--muted); margin-bottom: 0.5rem;">Profiles</h3>`;
      for (const p of profiles.slice(0, 5)) {
        try {
          const data = JSON.parse(p.content) as Record<string, string>;
          const npub = nip19.npubEncode(p.pubkey);
          const item = document.createElement("a");
          item.href = `#/profile/${npub}`;
          item.className = "feed-note";
          item.style.display = "block";
          item.style.textDecoration = "none";
          item.style.color = "inherit";
          item.innerHTML = `
            <div class="feed-note-author">
              ${data.picture ? `<img src="${esc(data.picture)}" alt="">` : ""}
              <span class="author-name">${esc(data.display_name || data.name || npub.slice(0, 16))}</span>
              ${data.nip05 ? `<span class="author-time">${esc(data.nip05)}</span>` : ""}
            </div>
            ${data.about ? `<p class="note-content" style="font-size:0.85rem;color:var(--muted)">${esc(data.about.slice(0, 120))}</p>` : ""}
          `;
          profilesSection.appendChild(item);
        } catch { /* bad profile JSON */ }
      }
      resultsEl.innerHTML = "";
      resultsEl.appendChild(profilesSection);
    } else {
      resultsEl.innerHTML = "";
    }

    if (notes.length > 0) {
      const notesSection = document.createElement("div");
      notesSection.innerHTML = `<h3 style="color: var(--muted); margin: 1rem 0 0.5rem;">Notes</h3>`;
      const notesContainer = document.createElement("div");
      notesSection.appendChild(notesContainer);
      resultsEl.appendChild(notesSection);
      await renderFeedList(notesContainer, notes);
    } else if (profiles.length === 0) {
      resultsEl.innerHTML = '<p class="empty">No results found.</p>';
    }
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

// ── Notifications view ────────────────────────────────────────────────────────

function setupNotificationsView(): void {
  onNotifications((notifs) => {
    const count = getUnreadCount();
    notifNav.textContent = count > 0 ? `Notifications (${count})` : "Notifications";
  });
}

function renderNotificationsView(): void {
  const container = document.querySelector("#view-notifications")!;
  const auth = getAuth();
  if (!auth.pubkey) {
    container.innerHTML = '<p class="status">Log in to see notifications.</p>';
    return;
  }

  const { getNotifications } = require("./notifications") as typeof import("./notifications");
  const notifs = getNotifications();

  if (notifs.length === 0) {
    container.innerHTML = '<p class="empty">No notifications yet.</p>';
    return;
  }

  markAllRead();

  container.innerHTML = "";
  for (const notif of notifs.slice(0, 100)) {
    const el = document.createElement("div");
    el.className = "feed-note";
    const typeLabel = { mention: "mentioned you", reaction: "reacted", repost: "reposted", zap: "zapped you" }[notif.type];
    const npub = nip19.npubEncode(notif.event.pubkey);
    const profile = getCachedProfile(notif.event.pubkey);
    const name = getDisplayName(profile, notif.event.pubkey);

    el.innerHTML = `
      <div class="feed-note-author">
        <a href="#/profile/${npub}" class="author-name">${esc(name)}</a>
        <span class="author-time">${esc(typeLabel)} — ${timeAgo(notif.timestamp)}</span>
      </div>
      <p class="note-content" style="font-size:0.85rem">${renderContent(notif.event.content.slice(0, 280))}</p>
    `;
    container.appendChild(el);
  }
}

// ── Messages view ─────────────────────────────────────────────────────────────

async function renderMessagesView(): Promise<void> {
  const container = document.querySelector("#view-messages")!;
  const auth = getAuth();
  if (!auth.pubkey) {
    container.innerHTML = '<p class="status">Log in to see messages.</p>';
    return;
  }

  container.innerHTML = '<p class="status">Loading messages...</p>';

  try {
    const messages = await fetchNip04Messages(auth.pubkey);
    const conversations = groupConversations(messages, auth.pubkey);

    if (conversations.length === 0) {
      container.innerHTML = `
        <div class="compose-area" style="margin-bottom:1rem">
          <div class="input-row">
            <input id="dm-recipient" type="text" placeholder="npub or hex pubkey..." />
            <button id="dm-new-btn">New message</button>
          </div>
        </div>
        <p class="empty">No conversations yet.</p>
      `;
      setupNewDmHandler();
      return;
    }

    const pubkeys = conversations.map((c) => c.peerPubkey);
    const profiles = await fetchProfiles(pubkeys);

    container.innerHTML = `
      <div class="compose-area" style="margin-bottom:1rem">
        <div class="input-row">
          <input id="dm-recipient" type="text" placeholder="npub or hex pubkey..." />
          <button id="dm-new-btn">New message</button>
        </div>
      </div>
    `;
    setupNewDmHandler();

    for (const conv of conversations) {
      const profile = profiles.get(conv.peerPubkey);
      const name = getDisplayName(profile, conv.peerPubkey);
      const npub = nip19.npubEncode(conv.peerPubkey);

      const el = document.createElement("div");
      el.className = "feed-note";
      el.style.cursor = "pointer";
      el.innerHTML = `
        <div class="feed-note-author">
          ${profile?.picture ? `<img src="${esc(profile.picture)}" alt="">` : `<span class="avatar-placeholder">${name.slice(0, 1).toUpperCase()}</span>`}
          <span class="author-name">${esc(name)}</span>
          <span class="author-time">${timeAgo(conv.lastMessage)}</span>
        </div>
      `;
      el.addEventListener("click", () => openConversation(conv.peerPubkey, messages, auth.pubkey!));
      container.appendChild(el);
    }
  } catch (err) {
    container.innerHTML = `<p class="status">Error loading messages: ${esc(String(err))}</p>`;
  }
}

function setupNewDmHandler(): void {
  document.getElementById("dm-new-btn")?.addEventListener("click", () => {
    const input = document.getElementById("dm-recipient") as HTMLInputElement;
    let pubkey = input.value.trim();
    if (pubkey.startsWith("npub1")) {
      try {
        const decoded = nip19.decode(pubkey);
        pubkey = decoded.data as string;
      } catch { alert("Invalid npub"); return; }
    }
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) { alert("Invalid pubkey"); return; }
    openConversation(pubkey, [], getAuth().pubkey!);
  });
}

async function openConversation(peerPubkey: string, allMessages: Event[], myPubkey: string): Promise<void> {
  const container = document.querySelector("#view-messages")!;
  const profile = getCachedProfile(peerPubkey) ?? (await fetchProfiles([peerPubkey])).get(peerPubkey);
  const name = getDisplayName(profile, peerPubkey);

  // Filter messages for this conversation
  const msgs = allMessages.filter((m) => {
    if (m.pubkey === peerPubkey) return true;
    const pTag = m.tags.find((t) => t[0] === "p");
    return pTag?.[1] === peerPubkey;
  });

  container.innerHTML = `
    <div style="margin-bottom:1rem">
      <button id="dm-back">Back</button>
      <strong style="margin-left:0.5rem">${esc(name)}</strong>
    </div>
    <div id="dm-messages" style="max-height:60vh;overflow-y:auto;margin-bottom:1rem"></div>
    <div class="input-row">
      <input id="dm-input" type="text" placeholder="Type a message..." />
      <button id="dm-send" class="primary">Send</button>
    </div>
  `;

  document.getElementById("dm-back")!.addEventListener("click", () => renderMessagesView());

  const msgsEl = document.getElementById("dm-messages")!;
  for (const msg of msgs) {
    const isMine = msg.pubkey === myPubkey;
    const bubble = document.createElement("div");
    bubble.className = "feed-note";
    bubble.style.borderColor = isMine ? "var(--accent)" : "var(--border)";
    try {
      const peer = isMine ? peerPubkey : msg.pubkey;
      const decrypted = await decryptNip04(peer, msg.content);
      bubble.innerHTML = `
        <div class="feed-note-author">
          <span class="author-name">${isMine ? "You" : esc(name)}</span>
          <span class="author-time">${timeAgo(msg.created_at)}</span>
        </div>
        <p class="note-content" style="font-size:0.9rem">${esc(decrypted)}</p>
      `;
    } catch {
      bubble.innerHTML = `<p class="note-content note-loading">Could not decrypt message</p>`;
    }
    msgsEl.appendChild(bubble);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;

  document.getElementById("dm-send")!.addEventListener("click", async () => {
    const input = document.getElementById("dm-input") as HTMLInputElement;
    const text = input.value.trim();
    if (!text) return;
    try {
      await sendNip04Message(peerPubkey, text);
      input.value = "";
      // Refresh conversation
      const freshMsgs = await fetchNip04Messages(myPubkey);
      openConversation(peerPubkey, freshMsgs, myPubkey);
    } catch (err) {
      alert(String(err));
    }
  });

  document.getElementById("dm-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("dm-send")!.click();
  });
}

// ── Compose box ───────────────────────────────────────────────────────────────

function renderComposeBox(container: HTMLElement): void {
  const auth = getAuth();
  if (!auth.pubkey) return;

  const box = document.createElement("div");
  box.className = "compose-area";
  box.innerHTML = `
    <textarea id="compose-input" placeholder="What's on your mind?" rows="3"></textarea>
    <div style="display:flex;justify-content:flex-end;margin-top:0.5rem">
      <button id="compose-submit" class="primary">Post</button>
    </div>
  `;
  container.prepend(box);

  document.getElementById("compose-submit")!.addEventListener("click", async () => {
    const input = document.getElementById("compose-input") as HTMLTextAreaElement;
    const text = input.value.trim();
    if (!text) return;
    try {
      await publishNote(text);
      input.value = "";
    } catch (err) {
      alert(String(err));
    }
  });
}

// ── Auth UI ───────────────────────────────────────────────────────────────────

function updateAuthUI(): void {
  const auth = getAuth();
  if (auth.pubkey) {
    loginBtn.textContent = "Log out";
    loginBtn.classList.remove("primary");
    // Start notifications
    startNotificationSubscription(auth.pubkey);
    // Fetch contacts
    fetchContactList(auth.pubkey).then((c) => { contacts = c; });
  } else {
    loginBtn.textContent = "Log in";
    loginBtn.classList.add("primary");
    stopNotificationSubscription();
    contacts = [];
  }
}

function setupAuthHandlers(): void {
  loginBtn.addEventListener("click", () => {
    const auth = getAuth();
    if (auth.pubkey) {
      logout();
      stopFeedSubscription();
      stopGlobalSubscription();
      stopNotificationSubscription();
      destroyPool();
    } else {
      loginModal.classList.remove("hidden");
      const nip07Btn = document.getElementById("login-nip07") as HTMLButtonElement;
      nip07Btn.disabled = !hasNip07();
      nip07Btn.textContent = hasNip07() ? "Use browser extension (NIP-07)" : "No extension detected";
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
    const feedContainer = document.getElementById("feed-notes")!;
    if (auth.pubkey) {
      renderComposeBox(document.getElementById("view-feed")!);
      startFeedSubscription();
    } else {
      feedContainer.innerHTML = '<p class="empty">Log in to see your following feed.</p>';
    }
  });

  addRoute("/global", () => {
    showView("view-global");
    const auth = getAuth();
    if (auth.pubkey) {
      renderComposeBox(document.getElementById("view-global")!);
    }
    startGlobalSubscription();
  });

  addRoute("/notifications", () => {
    showView("view-notifications");
    renderNotificationsView();
  });

  addRoute("/messages", () => {
    showView("view-messages");
    renderMessagesView();
  });

  addRoute("/search", () => {
    showView("view-search");
  });

  addRoute("/note/:id", (params) => {
    showView("view-note");
    loadNoteThread(params.id);
  });

  addRoute("/profile/:npub", (params) => {
    showView("view-profile");
    loadProfileView(params.npub);
  });

  onNavigate((path) => {
    const simplePath = "/" + (path.split("/")[1] || "");
    updateNavActive(simplePath === "/" ? "/" : simplePath);
    if (simplePath !== "/feed") stopFeedSubscription();
    if (simplePath !== "/global") stopGlobalSubscription();
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  setStatus(statusEl, "Loading...");
  config = await getConfig();
  renderConfig(config);
  setupConfigHandlers();
  setupAuthHandlers();
  setupSearchHandlers();
  setupNotificationsView();
  updateAuthUI();

  notesEl.addEventListener("paginate", (e) => {
    currentPage = (e as CustomEvent<{ page: number }>).detail.page;
    renderNotes(notesEl, notesMap, reactionsByNote, config.emoji_weights, currentPage);
  });

  setupRoutes();
  startRouter();

  setInterval(() => {
    if (currentPath() === "/") loadReactionsData();
  }, 60_000);
}

init().catch((err) => {
  setStatus(statusEl, `Error: ${err}`);
  console.error(err);
});

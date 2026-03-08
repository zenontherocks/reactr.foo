import {
  getConfig,
  saveConfig,
  getReactions,
  logReaction,
  getReactionsByNote,
} from "./api";
import type { AppConfig, Reaction } from "./api";
import { connect, disconnect, fetchNote } from "./nostr";
import type { Event } from "./nostr";
import { renderNotes, renderConfig } from "./ui";

// ── State ────────────────────────────────────────────────────────────────────

let config: AppConfig = { relays: [], preferred_emojis: [] };
const notesMap = new Map<string, Event>();               // noteId → Event
const reactionsByNote = new Map<string, Record<string, number>>(); // noteId → {emoji: count}
const seenIds = new Set<string>();                        // dedup live events vs DB

// ── DOM refs ──────────────────────────────────────────────────────────────────

const notesEl = document.getElementById("notes")!;
const statusEl = document.getElementById("status")!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

let renderTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderNotes(notesEl, notesMap, reactionsByNote, config.preferred_emojis);
    renderTimer = null;
  }, 150);
}

// ── Reaction handler ──────────────────────────────────────────────────────────

async function handleReaction(reaction: Reaction): Promise<void> {
  // Skip if we've already counted this event (dedup against DB load)
  if (seenIds.has(reaction.id)) return;
  seenIds.add(reaction.id);

  // Persist to D1 (fire-and-forget; failures are logged but don't block rendering)
  logReaction(reaction).catch((err) =>
    console.error("Failed to log reaction:", err)
  );

  // Update local aggregated counts
  const counts = reactionsByNote.get(reaction.note_id) ?? {};
  counts[reaction.emoji] = (counts[reaction.emoji] ?? 0) + 1;
  reactionsByNote.set(reaction.note_id, counts);

  // Fetch the referenced note content if we don't have it yet
  if (!notesMap.has(reaction.note_id)) {
    const event = await fetchNote(reaction.note_id, config.relays);
    if (event) notesMap.set(reaction.note_id, event);
  }

  scheduleRender();
}

// ── Startup data load ─────────────────────────────────────────────────────────

async function loadExistingData(): Promise<void> {
  setStatus("Loading saved reactions…");

  // Fetch both in parallel
  const [reactions, byNote] = await Promise.all([
    getReactions(),
    getReactionsByNote(),
  ]);

  // Mark all DB reaction IDs as seen so live subscription doesn't double-count
  for (const r of reactions) seenIds.add(r.id);

  // Populate aggregated counts from the DB view
  for (const row of byNote) {
    const counts = reactionsByNote.get(row.note_id) ?? {};
    counts[row.emoji] = row.count;
    reactionsByNote.set(row.note_id, counts);
  }

  // Fetch note content for every known note ID (batched)
  const noteIds = [...reactionsByNote.keys()].filter((id) => !notesMap.has(id));
  if (noteIds.length > 0) {
    setStatus(`Fetching ${noteIds.length} notes from relays…`);
    const BATCH = 10;
    for (let i = 0; i < noteIds.length; i += BATCH) {
      await Promise.all(
        noteIds.slice(i, i + BATCH).map(async (id) => {
          const event = await fetchNote(id, config.relays);
          if (event) notesMap.set(id, event);
        })
      );
    }
  }

  renderNotes(notesEl, notesMap, reactionsByNote, config.preferred_emojis);
  setStatus(
    config.relays.length
      ? `Listening on ${config.relays.length} relay(s)…`
      : "No relays configured — open Settings to add one."
  );
}

// ── Connect / reconnect ───────────────────────────────────────────────────────

async function startSubscription(): Promise<void> {
  disconnect();
  if (config.relays.length === 0) {
    setStatus("No relays configured — open Settings to add one.");
    return;
  }
  setStatus("Connecting…");
  connect(config.relays, handleReaction);
  await loadExistingData();
}

async function saveAndReconnect(): Promise<void> {
  setStatus("Saving config…");
  await saveConfig(config);
  // Clear state so we reload fresh from DB after reconnect
  seenIds.clear();
  reactionsByNote.clear();
  notesMap.clear();
  await startSubscription();
}

// ── Config UI wiring ──────────────────────────────────────────────────────────

function setupConfigHandlers(): void {
  document.getElementById("settings-toggle")!.addEventListener("click", () => {
    document.getElementById("settings")!.classList.toggle("hidden");
  });

  document.getElementById("add-relay")!.addEventListener("click", () => {
    const input = document.getElementById("relay-input") as HTMLInputElement;
    const url = input.value.trim();
    if (url && !config.relays.includes(url)) {
      config.relays = [...config.relays, url];
      renderConfig(config);
      input.value = "";
    }
  });

  document.getElementById("add-emoji")!.addEventListener("click", () => {
    const input = document.getElementById("emoji-input") as HTMLInputElement;
    const emoji = input.value.trim();
    if (emoji && !config.preferred_emojis.includes(emoji)) {
      config.preferred_emojis = [...config.preferred_emojis, emoji];
      renderConfig(config);
      input.value = "";
    }
  });

  document.getElementById("save-config")!.addEventListener("click", () => {
    saveAndReconnect();
  });

  // Enter key shortcuts
  (["relay-input", "emoji-input"] as const).forEach((id) => {
    document.getElementById(id)!.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document
          .getElementById(id === "relay-input" ? "add-relay" : "add-emoji")!
          .click();
      }
    });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  setStatus("Loading…");
  config = await getConfig();
  renderConfig(config);
  setupConfigHandlers();
  await startSubscription();
}

init().catch((err) => {
  setStatus(`Error: ${err}`);
  console.error(err);
});

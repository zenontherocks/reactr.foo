import { getConfig, saveConfig, getReactionsByNote, getNotes } from "./api";
import type { AppConfig, Note } from "./api";
import { renderNotes, renderConfig } from "./ui";

// ── State ─────────────────────────────────────────────────────────────────────

let config: AppConfig = { emoji_weights: [] };
const notesMap = new Map<string, Note>();
const reactionsByNote = new Map<string, Record<string, number>>();
let currentPage = 0;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const notesEl = document.getElementById("notes")!;
const statusEl = document.getElementById("status")!;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadData(): Promise<void> {
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
  setStatus(`${reactionsByNote.size} note(s) — last updated ${new Date().toLocaleTimeString()}`);
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
    saveConfig(config);
    await loadData();
  });

  document.getElementById("emoji-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      document.getElementById("add-emoji")!.click();
    }
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  setStatus("Loading…");
  config = getConfig();
  renderConfig(config);
  setupConfigHandlers();
  notesEl.addEventListener("paginate", (e) => {
    currentPage = (e as CustomEvent<{ page: number }>).detail.page;
    renderNotes(notesEl, notesMap, reactionsByNote, config.emoji_weights, currentPage);
  });
  await loadData();
  // Poll every 60s — the cron crawler feeds the DB, we just read it
  setInterval(loadData, 60_000);
}

init().catch((err) => {
  setStatus(`Error: ${err}`);
  console.error(err);
});

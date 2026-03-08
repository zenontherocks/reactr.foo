import { getConfig, saveConfig, getNotes } from "./api";
import type { AppConfig } from "./api";
import { renderNotes, renderConfig } from "./ui";

// ── State ────────────────────────────────────────────────────────────────────

let config: AppConfig = { relays: [], preferred_emojis: [] };

// ── DOM refs ──────────────────────────────────────────────────────────────────

const notesEl = document.getElementById("notes")!;
const statusEl = document.getElementById("status")!;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

// ── Data load ─────────────────────────────────────────────────────────────────

async function loadNotes(): Promise<void> {
  setStatus("Loading…");
  const notes = await getNotes();
  renderNotes(notesEl, notes, config.preferred_emojis);
  setStatus(
    notes.length > 0
      ? `Showing ${notes.length} note(s) — refreshed every 30 minutes by the backend.`
      : "No data yet — the backend polls Nostr every 30 minutes."
  );
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

  document.getElementById("save-config")!.addEventListener("click", async () => {
    setStatus("Saving config…");
    await saveConfig(config);
    setStatus("Config saved.");
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
  await loadNotes();
}

init().catch((err) => {
  setStatus(`Error: ${err}`);
  console.error(err);
});

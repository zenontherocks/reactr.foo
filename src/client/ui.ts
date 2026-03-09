import type { Note, AppConfig } from "./api";

interface NoteDisplay {
  noteId: string;
  content: string;
  created_at: number;
  reactions: Record<string, number>;
  score: number;
}

/**
 * Compute a preference score for a note's reactions.
 * Each preferred emoji at index i contributes count * (n - i) to the score,
 * so emojis listed first have higher weight.
 */
export function computeScore(
  reactions: Record<string, number>,
  preferred: string[]
): number {
  const n = preferred.length;
  return preferred.reduce(
    (sum, emoji, i) => sum + (reactions[emoji] ?? 0) * (n - i),
    0
  );
}

/**
 * Re-render the notes list, sorted by preference score descending.
 * Notes with reactions but no fetched content are shown with a placeholder.
 */
export function renderNotes(
  container: HTMLElement,
  notesMap: Map<string, Note>,
  reactionsByNote: Map<string, Record<string, number>>,
  preferred: string[]
): void {
  const notes: NoteDisplay[] = [];

  // Notes we have content for
  for (const [noteId, event] of notesMap) {
    const reactions = reactionsByNote.get(noteId) ?? {};
    notes.push({
      noteId,
      content: event.content,
      created_at: event.created_at,
      reactions,
      score: computeScore(reactions, preferred),
    });
  }

  // Notes with reactions but content not yet fetched
  for (const [noteId, reactions] of reactionsByNote) {
    if (!notesMap.has(noteId)) {
      notes.push({
        noteId,
        content: "",
        created_at: 0,
        reactions,
        score: computeScore(reactions, preferred),
      });
    }
  }

  notes.sort((a, b) => b.score - a.score || b.created_at - a.created_at);

  container.innerHTML = "";
  if (notes.length === 0) {
    container.innerHTML = '<p class="empty">Waiting for reactions…</p>';
    return;
  }

  for (const note of notes) {
    const el = document.createElement("article");
    el.className = "note";

    const reactionHtml = Object.entries(note.reactions)
      .sort((a, b) => b[1] - a[1])
      .map(([emoji, count]) => `<span class="emoji-count">${esc(emoji)} <b>${count}</b></span>`)
      .join("");

    const contentHtml = note.content
      ? `<p class="note-content">${esc(note.content)}</p>`
      : `<p class="note-content note-loading">Fetching note content…</p>`;

    const timeHtml = note.created_at
      ? `<span class="note-time">${new Date(note.created_at * 1000).toLocaleString()}</span>`
      : "";

    el.innerHTML = `
      <div class="note-meta">
        <span class="note-score" title="preference score">★ ${note.score}</span>
        ${timeHtml}
        <span class="note-id" title="${esc(note.noteId)}">${esc(note.noteId.slice(0, 16))}…</span>
      </div>
      ${contentHtml}
      <div class="note-reactions">${reactionHtml || "—"}</div>
    `;
    container.appendChild(el);
  }
}

/**
 * Render the config panel (relay list + emoji preference list).
 * Mutates `config` in place when items are removed; call again to re-render.
 */
export function renderConfig(config: AppConfig): void {
  renderRelays(config);
  renderEmojis(config);
}

function renderRelays(config: AppConfig): void {
  const list = document.getElementById("relay-list")!;
  list.innerHTML = "";
  for (const relay of config.relays) {
    const item = document.createElement("div");
    item.className = "config-item";
    item.innerHTML = `
      <span class="config-label">${esc(relay)}</span>
      <button data-remove-relay="${esc(relay)}">✕</button>
    `;
    list.appendChild(item);
  }
  list.querySelectorAll<HTMLElement>("[data-remove-relay]").forEach((btn) => {
    btn.addEventListener("click", () => {
      config.relays = config.relays.filter((r) => r !== btn.dataset.removeRelay);
      renderRelays(config);
    });
  });
}

function renderEmojis(config: AppConfig): void {
  const list = document.getElementById("emoji-list")!;
  list.innerHTML = "";
  config.preferred_emojis.forEach((emoji, i) => {
    const item = document.createElement("div");
    item.className = "config-item";
    item.innerHTML = `
      <span class="emoji-priority">#${i + 1}</span>
      <span>${esc(emoji)}</span>
      <button data-remove-emoji="${esc(emoji)}">✕</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll<HTMLElement>("[data-remove-emoji]").forEach((btn) => {
    btn.addEventListener("click", () => {
      config.preferred_emojis = config.preferred_emojis.filter(
        (e) => e !== btn.dataset.removeEmoji
      );
      renderEmojis(config);
    });
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

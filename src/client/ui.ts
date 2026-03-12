import { nip19 } from "nostr-tools";
import type { Note, AppConfig, EmojiWeight } from "./api";

interface NoteDisplay {
  noteId: string;
  content: string;
  created_at: number;
  reactions: Record<string, number>;
  score: number;
}

/**
 * Compute a preference score for a note's reactions.
 * Each emoji contributes count * weight, where weight is in [-100, 100].
 */
export function computeScore(
  reactions: Record<string, number>,
  weights: EmojiWeight[]
): number {
  return weights.reduce(
    (sum, { emoji, weight }) => sum + (reactions[emoji] ?? 0) * weight,
    0
  );
}

/**
 * Re-render the notes list, sorted by preference score descending.
 * Notes with reactions but no fetched content are shown with a placeholder.
 * Returns the total number of pages.
 */
export function renderNotes(
  container: HTMLElement,
  notesMap: Map<string, Note>,
  reactionsByNote: Map<string, Record<string, number>>,
  preferred: EmojiWeight[],
  page: number = 0,
  pageSize: number = 50
): number {
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

  const totalPages = Math.max(1, Math.ceil(notes.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const pageNotes = notes.slice(safePage * pageSize, (safePage + 1) * pageSize);

  container.innerHTML = "";
  if (notes.length === 0) {
    container.innerHTML = '<p class="empty">Waiting for reactions…</p>';
    return totalPages;
  }

  for (const note of pageNotes) {
    const link = document.createElement("a");
    link.href = `https://iris.to/${nip19.noteEncode(note.noteId)}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "note-link";

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
    link.appendChild(el);
    container.appendChild(link);
  }

  if (totalPages > 1) {
    const nav = document.createElement("div");
    nav.className = "pagination";

    const prev = document.createElement("button");
    prev.textContent = "← Prev";
    prev.disabled = safePage === 0;
    prev.addEventListener("click", () =>
      container.dispatchEvent(new CustomEvent("paginate", { detail: { page: safePage - 1 } }))
    );

    const label = document.createElement("span");
    label.className = "pagination-label";
    label.textContent = `Page ${safePage + 1} of ${totalPages}`;

    const next = document.createElement("button");
    next.textContent = "Next →";
    next.disabled = safePage === totalPages - 1;
    next.addEventListener("click", () =>
      container.dispatchEvent(new CustomEvent("paginate", { detail: { page: safePage + 1 } }))
    );

    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
    container.appendChild(nav);
  }

  return totalPages;
}

/**
 * Render the config panel (relay list + emoji preference list).
 * Mutates `config` in place when items are removed; call again to re-render.
 */
export function renderConfig(config: AppConfig): void {
  renderEmojis(config);
}

function renderEmojis(config: AppConfig): void {
  const list = document.getElementById("emoji-list")!;
  list.innerHTML = "";
  config.emoji_weights.forEach(({ emoji, weight }, i) => {
    const item = document.createElement("div");
    item.className = "config-item emoji-slider-row";
    item.innerHTML = `
      <span class="emoji-label">${esc(emoji)}</span>
      <input
        type="range"
        class="emoji-slider"
        min="-100"
        max="100"
        value="${weight}"
        data-emoji-index="${i}"
      />
      <span class="emoji-weight-value">${weight}</span>
      <button data-remove-emoji="${esc(emoji)}">✕</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll<HTMLInputElement>(".emoji-slider").forEach((slider) => {
    slider.addEventListener("input", () => {
      const idx = Number(slider.dataset.emojiIndex);
      const val = Number(slider.value);
      config.emoji_weights[idx].weight = val;
      slider.nextElementSibling!.textContent = String(val);
    });
  });
  list.querySelectorAll<HTMLElement>("[data-remove-emoji]").forEach((btn) => {
    btn.addEventListener("click", () => {
      config.emoji_weights = config.emoji_weights.filter(
        (e) => e.emoji !== btn.dataset.removeEmoji
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

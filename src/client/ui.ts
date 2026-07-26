import { nip19 } from "nostr-tools";
import type { AppConfig, EmojiWeight } from "./api";
import type { Event } from "./pool";

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
 * Re-render the notes list, sorted by preference score descending, showing
 * the top `visibleCount` notes. Notes with reactions but no fetched content
 * are shown with a placeholder. A "Show more" button appears at the end if
 * there are more notes beyond `visibleCount`.
 *
 * Notes already on screen are reconciled in place rather than torn down and
 * rebuilt: their score/reactions/content are updated, but their DOM node and
 * position never change. This keeps the browser's scroll anchoring intact
 * (and the reader's position stable) across the frequent re-renders driven
 * by live reaction updates and by "Show more" pulling in additional notes.
 */
export function renderNotes(
  container: HTMLElement,
  notesMap: Map<string, Event>,
  reactionsByNote: Map<string, Record<string, number>>,
  preferred: EmojiWeight[],
  visibleCount: number = 50
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

  if (notes.length === 0) {
    container.innerHTML = '<p class="empty">Waiting for reactions…</p>';
    return;
  }
  if (container.querySelector(".empty")) container.innerHTML = "";

  const byId = new Map(notes.map((n) => [n.noteId, n]));

  // Notes already rendered keep their existing DOM position — update their
  // fields in place, never reorder or recreate them.
  const existingLinks = [...container.querySelectorAll<HTMLAnchorElement>(".note-link[data-note-id]")];
  const existingIds = new Set<string>();
  for (const link of existingLinks) {
    const id = link.dataset.noteId!;
    existingIds.add(id);
    const note = byId.get(id);
    if (note) updateNoteEl(link, note);
  }

  // Fill any remaining capacity with newly-qualifying notes, score-sorted,
  // appended below what's already shown.
  const capacity = Math.max(0, visibleCount - existingLinks.length);
  const newOnes = notes.filter((n) => !existingIds.has(n.noteId)).slice(0, capacity);

  const nav = container.querySelector(".pagination");
  for (const note of newOnes) {
    const link = buildNoteEl(note);
    if (nav) container.insertBefore(link, nav);
    else container.appendChild(link);
  }

  const totalShown = existingLinks.length + newOnes.length;
  nav?.remove();
  if (notes.length > totalShown) {
    const bar = document.createElement("div");
    bar.className = "pagination";

    const showMore = document.createElement("button");
    showMore.textContent = "Show more";
    showMore.addEventListener("click", () =>
      container.dispatchEvent(new CustomEvent("showmore"))
    );

    bar.appendChild(showMore);
    container.appendChild(bar);
  }
}

function reactionsHtml(reactions: Record<string, number>): string {
  return Object.entries(reactions)
    .sort((a, b) => b[1] - a[1])
    .map(([emoji, count]) => `<span class="emoji-count">${esc(emoji)} <b>${count}</b></span>`)
    .join("");
}

function buildNoteEl(note: NoteDisplay): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = `https://iris.to/${nip19.noteEncode(note.noteId)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "note-link";
  link.dataset.noteId = note.noteId;

  const el = document.createElement("article");
  el.className = "note";

  const contentHtml = note.content
    ? `<p class="note-content">${renderContent(note.content)}</p>`
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
    <div class="note-reactions">${reactionsHtml(note.reactions) || "—"}</div>
    ${contentHtml}
  `;
  link.appendChild(el);
  return link;
}

function updateNoteEl(link: HTMLAnchorElement, note: NoteDisplay): void {
  const el = link.querySelector<HTMLElement>(".note");
  if (!el) return;

  const scoreEl = el.querySelector<HTMLElement>(".note-score");
  if (scoreEl) scoreEl.textContent = `★ ${note.score}`;

  if (note.created_at && !el.querySelector(".note-time")) {
    const timeEl = document.createElement("span");
    timeEl.className = "note-time";
    timeEl.textContent = new Date(note.created_at * 1000).toLocaleString();
    scoreEl?.insertAdjacentElement("afterend", timeEl);
  }

  const reactionsEl = el.querySelector<HTMLElement>(".note-reactions");
  if (reactionsEl) reactionsEl.innerHTML = reactionsHtml(note.reactions) || "—";

  const contentEl = el.querySelector<HTMLElement>(".note-content");
  if (contentEl?.classList.contains("note-loading") && note.content) {
    contentEl.classList.remove("note-loading");
    contentEl.innerHTML = renderContent(note.content);
  }
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
      <input
        type="number"
        class="emoji-weight-value"
        min="-100"
        max="100"
        value="${weight}"
        data-emoji-index="${i}"
      />
      <button data-remove-emoji="${esc(emoji)}">✕</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll<HTMLInputElement>(".emoji-slider").forEach((slider) => {
    slider.addEventListener("input", () => {
      const idx = Number(slider.dataset.emojiIndex);
      const val = Number(slider.value);
      config.emoji_weights[idx].weight = val;
      const numInput = list.querySelector<HTMLInputElement>(
        `.emoji-weight-value[data-emoji-index="${idx}"]`
      )!;
      numInput.value = String(val);
    });
  });
  list.querySelectorAll<HTMLInputElement>(".emoji-weight-value").forEach((numInput) => {
    numInput.addEventListener("input", () => {
      const idx = Number(numInput.dataset.emojiIndex);
      const val = Math.max(-100, Math.min(100, Number(numInput.value)));
      config.emoji_weights[idx].weight = val;
      const slider = list.querySelector<HTMLInputElement>(
        `.emoji-slider[data-emoji-index="${idx}"]`
      )!;
      slider.value = String(val);
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

function renderContent(content: string): string {
  const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif)(\?[^\s]*)?$/i;
  const parts = content.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      // Odd indices are captured URL groups
      if (IMAGE_EXT.test(part)) {
        return `<img class="note-image" src="${esc(part)}" alt="image">`;
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

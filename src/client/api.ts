export interface Note {
  id: string;
  content: string;
  created_at: number;
  pubkey: string;
}

export interface ReactionByNote {
  note_id: string;
  emoji: string;
  count: number;
}

export interface EmojiWeight {
  emoji: string;
  weight: number;
}

export interface AppConfig {
  emoji_weights: EmojiWeight[];
}

const LS_KEY = "reactr.config";

const DEFAULT_CONFIG: AppConfig = {
  emoji_weights: [
    { emoji: "👍", weight: 50 },
    { emoji: "😂", weight: 50 },
    { emoji: "🤙", weight: 50 },
    { emoji: "❤️", weight: 50 },
    { emoji: "🔥", weight: 50 },
  ],
};

export function getConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return structuredClone(DEFAULT_CONFIG);
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    if (!Array.isArray(parsed.emoji_weights)) return structuredClone(DEFAULT_CONFIG);
    return parsed as AppConfig;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(config: Partial<AppConfig>): void {
  try {
    const current = getConfig();
    localStorage.setItem(LS_KEY, JSON.stringify({ ...current, ...config }));
  } catch {
    // localStorage unavailable — in-memory state still works
  }
}

export async function getReactionsByNote(): Promise<ReactionByNote[]> {
  const res = await fetch("/api/reactions/by-note");
  return res.json();
}

export async function getNotes(ids: string[]): Promise<Note[]> {
  if (ids.length === 0) return [];
  const BATCH = 90;
  const notes: Note[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const res = await fetch(`/api/notes?ids=${chunk.join(",")}`);
    if (!res.ok) continue;
    const data: unknown = await res.json();
    if (Array.isArray(data)) notes.push(...(data as Note[]));
  }
  return notes;
}

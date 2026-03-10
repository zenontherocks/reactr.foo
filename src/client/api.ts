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
  relays: string[];
  emoji_weights: EmojiWeight[];
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  const raw = await res.json() as Record<string, unknown>;
  // Backward compatibility: convert old preferred_emojis array to emoji_weights
  if (!raw.emoji_weights && Array.isArray(raw.preferred_emojis)) {
    raw.emoji_weights = (raw.preferred_emojis as string[]).map((emoji) => ({
      emoji,
      weight: 50,
    }));
  }
  return raw as unknown as AppConfig;
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
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

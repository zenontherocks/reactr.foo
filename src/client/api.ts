export interface Reaction {
  id: string;
  emoji: string;
  npub: string;
  note_id: string;
  relay: string;
  created_at: number;
}

export interface ReactionByNote {
  note_id: string;
  emoji: string;
  count: number;
}

export interface AppConfig {
  relays: string[];
  preferred_emojis: string[];
}

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  return res.json();
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
}

export async function getReactions(): Promise<Reaction[]> {
  const res = await fetch("/api/reactions");
  return res.json();
}

export async function logReaction(reaction: Reaction): Promise<void> {
  await fetch("/api/reactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reaction),
  });
}

export async function getReactionsByNote(): Promise<ReactionByNote[]> {
  const res = await fetch("/api/reactions/by-note");
  return res.json();
}

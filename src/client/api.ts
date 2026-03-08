export interface Reaction {
  id: string;
  emoji: string;
  npub: string;
  note_id: string;
  relay: string;
  created_at: number;
}

export interface NoteWithReactions {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  reactions: Record<string, number>;
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

export async function getNotes(): Promise<NoteWithReactions[]> {
  const res = await fetch("/api/notes");
  return res.json();
}

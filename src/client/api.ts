export interface EmojiWeight {
  emoji: string;
  weight: number;
}

export interface AppConfig {
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

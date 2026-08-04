// clients/ui — T-529 / DS-11 local-cache policy model.
// UI restates the core string contract to keep the screens package core-free.
export type CacheRetentionMode = "forever" | "30d" | "7d" | "24h";
export type ChatCacheMode = "inherit" | CacheRetentionMode | "cloud_only";

export const CACHE_RETENTION_OPTIONS: readonly CacheRetentionMode[] = ["forever", "30d", "7d", "24h"];
export const CHAT_CACHE_OPTIONS: readonly ChatCacheMode[] = ["inherit", "forever", "30d", "7d", "24h", "cloud_only"];

export function normalizeCacheRetention(value: unknown): CacheRetentionMode {
  return typeof value === "string" && (CACHE_RETENTION_OPTIONS as readonly string[]).includes(value)
    ? value as CacheRetentionMode
    : "forever";
}

export function normalizeChatCacheMode(value: unknown): ChatCacheMode {
  return typeof value === "string" && (CHAT_CACHE_OPTIONS as readonly string[]).includes(value)
    ? value as ChatCacheMode
    : "inherit";
}

// Loaded by the shell before its data plane starts. Getters are synchronous so a media request can make
// a fail-closed disk decision without racing an async settings fetch.
export interface CachePolicyPort {
  getGlobal(): CacheRetentionMode;
  setGlobal(mode: CacheRetentionMode): Promise<void>;
  getChat(chatId: number): ChatCacheMode;
  setChat(chatId: number, mode: ChatCacheMode): Promise<void>;
  shouldPersist(chatId: number): boolean;

  recordMedia(chatId: number, fileId: number): Promise<void>;

  subscribe(handler: () => void): () => void;
}

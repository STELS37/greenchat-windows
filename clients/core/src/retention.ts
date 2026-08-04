// clients/core — T-529 / DS-11: local-cache retention and cloud-only chat policy.
//
// The server remains the source of truth. This controller owns only the encrypted local preference and
// bounded cache pruning. Before load() succeeds it fails closed: chat data must not be persisted. That
// matters on a COLD app-lock transition where the encrypted policy cannot be read until K_db exists.
import type { ClientStore, StoreKey, WriteOp } from "./store.ts";

export type CacheRetentionMode = "forever" | "30d" | "7d" | "24h";
export type ChatCacheMode = "inherit" | CacheRetentionMode | "cloud_only";
export type EffectiveCacheMode = CacheRetentionMode | "cloud_only";

export interface CachePolicyReader {
  shouldPersistChat(chatId: number): boolean;
  cutoffSec(chatId: number): number | null;
}

export interface LocalCachePolicyOptions {
  store: ClientStore;
  nowSec?: () => number;
}

interface PolicySnapshotV1 {
  magic: "gc-local-cache-policy";
  version: 1;
  global: CacheRetentionMode;
  chats: Record<string, Exclude<ChatCacheMode, "inherit">>;
  // Encrypted ownership index; never stored in the media record where chat ids would leak as metadata.
  media: Record<string, number[]>;
}

interface MetaRow {
  id: string;
  value: PolicySnapshotV1;
}

interface CacheRow extends Record<string, unknown> {
  id?: number;
  chat_id?: number;
  created_at?: number;
  updated_at?: number;
  __gc_cached_at?: number;
}

const POLICY_KEY = "local_cache_policy_v1";
const DAY = 24 * 60 * 60;
const RETENTION_SECONDS: Record<Exclude<CacheRetentionMode, "forever">, number> = {
  "30d": 30 * DAY,
  "7d": 7 * DAY,
  "24h": DAY,
};

const DEFAULT_SNAPSHOT: PolicySnapshotV1 = {
  magic: "gc-local-cache-policy",
  version: 1,
  global: "forever",
  chats: {},
  media: {},
};

function cloneSnapshot(value: PolicySnapshotV1): PolicySnapshotV1 {
  return {
    ...value,
    chats: { ...value.chats },
    media: Object.fromEntries(Object.entries(value.media).map(([id, owners]) => [id, [...owners]])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCacheRetentionMode(value: unknown): value is CacheRetentionMode {
  return value === "forever" || value === "30d" || value === "7d" || value === "24h";
}

export function isChatCacheMode(value: unknown): value is ChatCacheMode {
  return value === "inherit" || value === "cloud_only" || isCacheRetentionMode(value);
}

export function normalizePolicySnapshot(value: unknown): PolicySnapshotV1 {
  const candidate = isRecord(value) && isRecord(value.value) ? value.value : value;
  if (!isRecord(candidate)) return cloneSnapshot(DEFAULT_SNAPSHOT);
  const global = isCacheRetentionMode(candidate.global) ? candidate.global : "forever";
  const chats: PolicySnapshotV1["chats"] = {};
  if (isRecord(candidate.chats)) {
    for (const [rawId, rawMode] of Object.entries(candidate.chats)) {
      const id = Number(rawId);
      if (!Number.isSafeInteger(id) || id <= 0 || !isChatCacheMode(rawMode) || rawMode === "inherit") continue;
      chats[String(id)] = rawMode;
    }
  }
  const media: PolicySnapshotV1["media"] = {};
  if (isRecord(candidate.media)) {
    for (const [rawFileId, rawOwners] of Object.entries(candidate.media)) {
      const fileId = Number(rawFileId);
      if (!Number.isSafeInteger(fileId) || fileId <= 0 || !Array.isArray(rawOwners)) continue;
      const owners = [...new Set(rawOwners.filter((owner): owner is number =>
        typeof owner === "number" && Number.isSafeInteger(owner) && owner > 0))].sort((a, b) => a - b);
      if (owners.length > 0) media[String(fileId)] = owners;
    }
  }
  return { magic: "gc-local-cache-policy", version: 1, global, chats, media };
}

function rowChatId(value: unknown, key?: StoreKey): number | null {
  if (isRecord(value) && typeof value.chat_id === "number" && Number.isSafeInteger(value.chat_id)) {
    return value.chat_id;
  }
  if (typeof key === "number" && Number.isSafeInteger(key)) return key;
  if (isRecord(value) && typeof value.id === "number" && Number.isSafeInteger(value.id)) return value.id;
  return null;
}

function rowTimestamp(value: unknown): number {
  if (!isRecord(value)) return 0;
  for (const key of ["created_at", "updated_at", "__gc_cached_at"] as const) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function chatActivityTimestamp(value: unknown): number {
  if (!isRecord(value)) return 0;
  const updatedAt = value.updated_at;
  if (typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0) return updatedAt;
  const lastMessageAt = rowTimestamp(value.last_message);
  if (lastMessageAt > 0) return lastMessageAt;
  for (const key of ["created_at", "__gc_cached_at"] as const) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return 0;
}

function collectFileIds(value: unknown, target: Set<number>): void {
  if (!isRecord(value)) return;
  for (const key of ["file_id", "photo_file_id", "avatar_file_id"] as const) {
    const id = value[key];
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) target.add(id);
  }
  const file = value.file;
  if (isRecord(file) && typeof file.id === "number" && Number.isSafeInteger(file.id) && file.id > 0) {
    target.add(file.id);
  }
  for (const key of ["files", "attachments"] as const) {
    const rows = value[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) collectFileIds(row, target);
  }
  if (isRecord(value.last_message)) collectFileIds(value.last_message, target);
}

function newestMessage(rows: CacheRow[]): CacheRow | null {
  let newest: CacheRow | null = null;
  for (const row of rows) {
    if (typeof row.id !== "number") continue;
    if (!newest || typeof newest.id !== "number" || row.id > newest.id) newest = row;
  }
  return newest;
}

export class LocalCachePolicy implements CachePolicyReader {
  private readonly store: ClientStore;
  private readonly nowSec: () => number;
  private snapshot = cloneSnapshot(DEFAULT_SNAPSHOT);
  private loaded = false;
  private loading: Promise<void> | null = null;

  // Invalidates async work from the previous account / device-lock epoch. Without this guard, a slow
  // IndexedDB read can complete after logout and restore the previous user's policy into memory.
  private generation = 0;
  // Store writes that have already crossed the generation check cannot be cancelled by IndexedDB.
  // resetBarrier waits for them, performs a second bounded cleanup, and gates the next account's load.
  private readonly activeMutations = new Set<Promise<unknown>>();
  private resetBarrier: Promise<void> = Promise.resolve();
  private resetFailure: unknown = null;
  private readonly listeners = new Set<() => void>();

  constructor(opts: LocalCachePolicyOptions) {
    this.store = opts.store;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe(handler: () => void): () => void {
    this.listeners.add(handler);
    return () => { this.listeners.delete(handler); };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  // Account switches wipe the backing store. Forget the previous user's modes immediately, then wait
  // for any IndexedDB write which was already in flight and erase the retention-owned rows once more.
  // New-account load() is gated by this cleanup, so its sync plane cannot race a late old-account commit.
  resetMemory(): void {
    this.generation += 1;
    const resetGeneration = this.generation;
    const previousBarrier = this.resetBarrier;
    const pendingMutations = [...this.activeMutations];
    this.snapshot = cloneSnapshot(DEFAULT_SNAPSHOT);
    this.loaded = false;
    this.loading = null;
    this.resetFailure = null;
    this.resetBarrier = (async () => {
      await previousBarrier;
      await Promise.allSettled(pendingMutations);
      if (resetGeneration !== this.generation) return;
      try {
        await this.clearRetentionRows(resetGeneration);
      } catch (error) {
        if (resetGeneration === this.generation) this.resetFailure = error;
      }
    })();
    this.emit();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    const generation = this.generation;
    let task!: Promise<void>;
    task = (async () => {
      try {
        await this.resetBarrier;
        if (generation !== this.generation) return;
        if (this.resetFailure !== null) throw this.resetFailure;
        const row = await this.store.get<MetaRow | PolicySnapshotV1>("meta", POLICY_KEY);
        if (generation !== this.generation) return;
        this.snapshot = normalizePolicySnapshot(row);
        // prune() is intentionally allowed only after the encrypted snapshot has been accepted. If it
        // fails, the catch below revokes loaded state again so callers stay fail-closed and can retry.
        this.loaded = true;
        await this.prune(undefined, true, generation);
        if (generation !== this.generation) return;
        this.emit();
      } catch (error) {
        if (generation === this.generation) {
          this.snapshot = cloneSnapshot(DEFAULT_SNAPSHOT);
          this.loaded = false;
        }
        throw error;
      } finally {
        // resetMemory() may already have started a newer load. An old completion must not clear it.
        if (this.loading === task) this.loading = null;
      }
    })();
    this.loading = task;
    return task;
  }

  globalMode(): CacheRetentionMode {
    return this.snapshot.global;
  }

  chatMode(chatId: number): ChatCacheMode {
    return this.snapshot.chats[String(chatId)] ?? "inherit";
  }

  effectiveMode(chatId: number): EffectiveCacheMode {
    const override = this.snapshot.chats[String(chatId)];
    return override ?? this.snapshot.global;
  }

  // Fail closed until the encrypted policy has loaded after COLD unlock.
  shouldPersistChat(chatId: number): boolean {
    return this.loaded && this.effectiveMode(chatId) !== "cloud_only";
  }

  cutoffSec(chatId: number): number | null {
    if (!this.loaded) return this.nowSec() + 1;
    const mode = this.effectiveMode(chatId);
    if (mode === "cloud_only") return this.nowSec() + 1;
    if (mode === "forever") return null;
    return this.nowSec() - RETENTION_SECONDS[mode];
  }

  async recordMedia(chatId: number, fileId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("cache policy: invalid chat id");
    if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error("cache policy: invalid file id");
    await this.load();
    if (!this.loaded || !this.shouldPersistChat(chatId)) return;
    const generation = this.generation;
    const key = String(fileId);
    const owners = new Set(this.snapshot.media[key] ?? []);
    if (owners.has(chatId)) return;
    owners.add(chatId);
    this.snapshot = {
      ...this.snapshot,
      media: { ...this.snapshot.media, [key]: [...owners].sort((a, b) => a - b) },
    };
    await this.persist(generation);
  }

  async setGlobal(mode: CacheRetentionMode): Promise<void> {
    if (!isCacheRetentionMode(mode)) throw new Error("cache policy: invalid global mode");
    await this.load();
    if (!this.loaded) return;
    const generation = this.generation;
    const previous = cloneSnapshot(this.snapshot);
    this.snapshot = { ...this.snapshot, global: mode, chats: { ...this.snapshot.chats } };
    try {
      // Minimize first, then commit policy. A crash may over-delete local cache, never retain past policy.
      await this.prune(undefined, false, generation);
      if (generation !== this.generation) return;
      await this.persist(generation);
    } catch (error) {
      if (generation === this.generation) this.snapshot = previous;
      throw error;
    }
  }

  async setChat(chatId: number, mode: ChatCacheMode): Promise<void> {
    if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error("cache policy: invalid chat id");
    if (!isChatCacheMode(mode)) throw new Error("cache policy: invalid chat mode");
    await this.load();
    if (!this.loaded) return;
    const generation = this.generation;
    const previous = cloneSnapshot(this.snapshot);
    const chats = { ...this.snapshot.chats };
    if (mode === "inherit") delete chats[String(chatId)];
    else chats[String(chatId)] = mode;
    this.snapshot = { ...this.snapshot, chats };
    try {
      // Cache erasure precedes the durable policy commit. Server history is the lossless source of truth.
      await this.prune(chatId, false, generation);
      if (generation !== this.generation) return;
      await this.persist(generation);
    } catch (error) {
      if (generation === this.generation) this.snapshot = previous;
      throw error;
    }
  }

  async prune(
    onlyChatId?: number,
    persistSnapshot = true,
    expectedGeneration = this.generation,
  ): Promise<void> {
    if (!this.loaded || expectedGeneration !== this.generation) return;
    const now = this.nowSec();
    const [messages, chats, mediaRows] = await Promise.all([
      this.store.entries<CacheRow>("messages"),
      this.store.entries<CacheRow>("chats"),
      this.store.entries<CacheRow>("media"),
    ]);
    if (expectedGeneration !== this.generation) return;
    const ops: WriteOp[] = [];
    const remainingByChat = new Map<number, CacheRow[]>();
    const removedFiles = new Set<number>();
    const retainedFiles = new Set<number>();
    const removedMessageIds = new Set<number>();
    const media = Object.fromEntries(
      Object.entries(this.snapshot.media).map(([id, owners]) => [id, [...owners]]),
    );
    let mediaChanged = false;

    const keepsAt = (chatId: number, timestampSec: number): boolean => {
      const mode = this.effectiveMode(chatId);
      if (mode === "cloud_only") return false;
      if (mode === "forever") return true;
      return timestampSec >= now - RETENTION_SECONDS[mode];
    };

    for (const entry of messages) {
      const chatId = rowChatId(entry.value);
      if (chatId === null) continue;
      if (onlyChatId !== undefined && chatId !== onlyChatId) {
        collectFileIds(entry.value, retainedFiles);
        continue;
      }
      const mode = this.effectiveMode(chatId);
      const cutoff = mode === "forever" ? null : mode === "cloud_only" ? now + 1 : now - RETENTION_SECONDS[mode];
      const expired = cutoff !== null && rowTimestamp(entry.value) < cutoff;
      if (mode === "cloud_only" || expired) {
        ops.push({ op: "delete", collection: "messages", key: entry.key });
        if (typeof entry.key === "number") removedMessageIds.add(entry.key);
        collectFileIds(entry.value, removedFiles);
      } else {
        const rows = remainingByChat.get(chatId) ?? [];
        rows.push(entry.value);
        remainingByChat.set(chatId, rows);
        collectFileIds(entry.value, retainedFiles);
      }
    }

    for (const entry of chats) {
      const chatId = rowChatId(entry.value, entry.key);
      if (chatId === null || (onlyChatId !== undefined && chatId !== onlyChatId)) {
        collectFileIds(entry.value, retainedFiles);
        continue;
      }
      const mode = this.effectiveMode(chatId);
      if (mode === "cloud_only") {
        ops.push({ op: "delete", collection: "chats", key: entry.key });
        collectFileIds(entry.value, removedFiles);
        continue;
      }
      const cutoff = mode === "forever" ? null : now - RETENTION_SECONDS[mode];
      const remaining = remainingByChat.get(chatId) ?? [];
      const rowIsExpired = cutoff !== null && chatActivityTimestamp(entry.value) < cutoff;
      if (rowIsExpired && remaining.length === 0) {
        ops.push({ op: "delete", collection: "chats", key: entry.key });
        collectFileIds(entry.value, removedFiles);
        continue;
      }
      const lastId = typeof entry.value.last_message_id === "number" ? entry.value.last_message_id : null;
      if (lastId !== null && removedMessageIds.has(lastId)) {
        const next = { ...entry.value };
        const newest = newestMessage(remaining);
        if (newest && typeof newest.id === "number") {
          next.last_message_id = newest.id;
          next.last_message = newest;
          next.updated_at = rowTimestamp(newest);
        } else {
          delete next.last_message_id;
          delete next.last_message;
        }
        if (rowIsExpired) next.draft = null;
        ops.push({ op: "put", collection: "chats", key: entry.key, value: next });
        collectFileIds(next, retainedFiles);
      } else {
        collectFileIds(entry.value, retainedFiles);
      }
    }

    const mediaKeys = new Set<string>();
    for (const entry of mediaRows) {
      if (typeof entry.key !== "number" || !Number.isSafeInteger(entry.key) || entry.key <= 0) continue;
      const fileId = entry.key;
      const key = String(fileId);
      mediaKeys.add(key);
      const owners = media[key] ?? [];
      const at = isRecord(entry.value) && typeof entry.value.at === "number" && Number.isFinite(entry.value.at)
        ? Math.floor(entry.value.at / 1000)
        : rowTimestamp(entry.value);

      if (onlyChatId !== undefined) {
        const targetMode = this.effectiveMode(onlyChatId);
        if (owners.length === 0) {
          // Legacy media predates the encrypted ownership index. Cloud-only is strict: flush unknown
          // blobs rather than risk retaining this chat's attachment. Other chats transparently re-download.
          if (targetMode === "cloud_only") removedFiles.add(fileId);
          continue;
        }
        if (!owners.includes(onlyChatId)) {
          retainedFiles.add(fileId);
          continue;
        }
        if (keepsAt(onlyChatId, at)) {
          retainedFiles.add(fileId);
          continue;
        }
        const nextOwners = owners.filter((owner) => owner !== onlyChatId);
        mediaChanged = true;
        if (nextOwners.length > 0) {
          media[key] = nextOwners;
          retainedFiles.add(fileId);
        } else {
          delete media[key];
          removedFiles.add(fileId);
        }
        continue;
      }

      if (owners.length === 0) {
        const global = this.snapshot.global;
        if (global !== "forever" && at < now - RETENTION_SECONDS[global]) removedFiles.add(fileId);
        else retainedFiles.add(fileId);
        continue;
      }
      const nextOwners = owners.filter((owner) => keepsAt(owner, at));
      if (nextOwners.length !== owners.length) {
        mediaChanged = true;
        if (nextOwners.length > 0) media[key] = nextOwners;
        else delete media[key];
      }
      if (nextOwners.length > 0) retainedFiles.add(fileId);
      else removedFiles.add(fileId);
    }

    // Failed/interrupted downloads may leave an ownership claim without a blob; remove that stale index.
    for (const key of Object.keys(media)) {
      if (mediaKeys.has(key)) continue;
      delete media[key];
      mediaChanged = true;
    }

    for (const fileId of removedFiles) {
      if (retainedFiles.has(fileId)) continue;
      ops.push({ op: "delete", collection: "files", key: fileId });
      ops.push({ op: "delete", collection: "media", key: fileId });
      if (media[String(fileId)] !== undefined) {
        delete media[String(fileId)];
        mediaChanged = true;
      }
    }
    if (expectedGeneration !== this.generation) return;
    if (ops.length > 0) await this.trackMutation(this.store.batch(ops));
    if (expectedGeneration !== this.generation) return;
    if (mediaChanged) {
      this.snapshot = { ...this.snapshot, media };
      if (persistSnapshot) await this.persist(expectedGeneration);
    }
  }

  private async persist(expectedGeneration = this.generation): Promise<void> {
    if (expectedGeneration !== this.generation) return;
    const value = cloneSnapshot(this.snapshot);
    await this.trackMutation(
      this.store.put("meta", POLICY_KEY, { id: POLICY_KEY, value } satisfies MetaRow),
    );
  }

  private trackMutation<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => { this.activeMutations.delete(tracked); });
    this.activeMutations.add(tracked);
    return tracked;
  }

  private async clearRetentionRows(expectedGeneration: number): Promise<void> {
    let firstError: unknown = null;
    for (const collection of ["messages", "chats", "files", "media"] as const) {
      if (expectedGeneration !== this.generation) return;
      try {
        await this.store.clear(collection);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (expectedGeneration !== this.generation) return;
    try {
      await this.store.delete("meta", POLICY_KEY);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== null) throw firstError;
  }
}

// clients/core — CacheSync: bind the durable event stream to the local store (T-403, CLIENTS.md §5.2).
//
// This is the glue that realises "instant render from cache → delta by seq → live" (the cold-start
// budget). Wire it into a SyncEngine at construction:
//
//   const cache = new CacheSync({ store });
//   const sync = new SyncEngine({
//     api, baseUrl,
//     onEvent:  (e) => { void cache.apply(e); render(e); },
//     onCursor: (s) => { void cache.setCursor(s); },
//   });
//   sync.setCursor(await cache.getCursor());  // resume from the persisted cursor
//   sync.start();
//
// On boot the app paints cachedChats()/cachedMessages() immediately, then SyncEngine replays only the
// delta since the persisted last_seq and CacheSync folds each event into the store. applies are
// serialized through one promise chain so concurrent events can't lose a read-modify-write on a chat
// row (the SyncEngine fires onEvent synchronously as `void cache.apply(e)`).
import type { ClientStore } from "./store.ts";
import type { SyncEvent } from "./types.ts";

import type { CachePolicyReader } from "./retention.ts";

const CURSOR_KEY = "last_seq";

interface CachedMessage {
  id: number;
  chat_id: number;
  created_at?: number;
  deleted?: boolean;

  __gc_cached_at?: number;
  [k: string]: unknown;
}

interface CachedChat {
  id: number;
  last_message_id?: number;
  last_message?: unknown;
  updated_at?: number;
  draft?: unknown;

  __gc_cached_at?: number;
  [k: string]: unknown;
}

export interface CacheSyncOptions {
  store: ClientStore;
  // T-529: one loaded policy shared by CacheSync/Outbox/MediaCache. Absent preserves legacy behaviour.
  policy?: CachePolicyReader;
  nowSec?: () => number;
}

export class CacheSync {
  private readonly store: ClientStore;
  private readonly policy: CachePolicyReader | undefined;
  private readonly nowSec: () => number;
  private chain: Promise<void> = Promise.resolve();
  // If a durable event fails to reach the cache, do not acknowledge that seq (or anything after it)
  // on disk. A restart will resume from the last good cursor and replay the failed event.
  private blockedCursorAt: number | null = null;
  private resetEpoch = 0;
  private resetFailure: unknown = null;

  constructor(opts: CacheSyncOptions) {
    this.store = opts.store;
    this.policy = opts.policy;
    this.nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
  }

  // Fold one normalized event into the cache. Safe to call fire-and-forget: failures are remembered
  // for cursor safety, while the returned promise preserves the historical best-effort contract.
  apply(evt: SyncEvent): Promise<void> {
    const operation = this.enqueue(async () => {
      try {
        await this.applyNow(evt);
      } catch (error) {
        if (evt.seq !== null && Number.isSafeInteger(evt.seq) && evt.seq >= 0) {
          this.blockedCursorAt = this.blockedCursorAt === null
            ? evt.seq
            : Math.min(this.blockedCursorAt, evt.seq);
        }
        throw error;
      }
    });
    return operation.catch(() => undefined);
  }

  // Await everything queued so far (test/render synchronization point).
  settled(): Promise<void> {
    return this.chain;
  }

  // Drain every old-account cache mutation, then repeat the bounded physical cleanup. The session-level
  // wipe may complete before an already-open IndexedDB transaction, so one post-drain pass is required.
  // Operations for the next account queue behind this barrier.
  reset(): Promise<void> {
    const epoch = ++this.resetEpoch;
    this.resetFailure = null;
    const operation = this.chain.then(async () => {
      let firstError: unknown = null;
      for (const collection of ["messages", "chats"] as const) {
        try {
          await this.store.clear(collection);
        } catch (error) {
          firstError ??= error;
        }
      }
      try {
        await this.store.delete("meta", CURSOR_KEY);
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== null) throw firstError;
      if (epoch === this.resetEpoch) this.blockedCursorAt = null;
    });
    this.chain = operation.catch((error: unknown) => {
      if (epoch === this.resetEpoch) this.resetFailure = error;
    });
    return operation;
  }

  private async applyNow(evt: SyncEvent): Promise<void> {
    switch (evt.type) {
      case "message.new":
      case "message.edit": {
        const msg = this.messageOf(evt);
        if (!msg) return;
        if (!this.cacheable(msg.chat_id, msg.created_at)) {
          await this.store.delete("messages", msg.id);
          if (this.policy && !this.policy.shouldPersistChat(msg.chat_id)) await this.store.delete("chats", msg.chat_id);
          return;
        }
        await this.upsertMessage(msg);
        return;
      }
      case "message.delete": {
        const p = evt.payload as { chat_id?: number; message_id?: number };
        if (typeof p.message_id !== "number") return;
        const chatId = typeof p.chat_id === "number" ? p.chat_id : 0;
        if (chatId > 0 && this.policy && !this.policy.shouldPersistChat(chatId)) {
          await this.store.batch([
            { op: "delete", collection: "messages", key: p.message_id },
            { op: "delete", collection: "chats", key: chatId },
          ]);
          return;
        }
        await this.store.put("messages", p.message_id, {
          id: p.message_id,
          chat_id: chatId,
          deleted: true,
          __gc_cached_at: this.nowSec(),
        });
        return;
      }
      case "chat.update": {
        const p = evt.payload as { chat_id?: number } & Record<string, unknown>;
        if (typeof p.chat_id !== "number") return;
        if (this.policy && !this.policy.shouldPersistChat(p.chat_id)) {
          await this.store.delete("chats", p.chat_id);
          return;
        }
        await this.mergeChat(p.chat_id, p);
        return;
      }
      case "draft.update": {
        const p = evt.payload as { chat_id?: number; draft?: unknown };
        if (typeof p.chat_id !== "number") return;
        if (this.policy && !this.policy.shouldPersistChat(p.chat_id)) {
          await this.store.delete("chats", p.chat_id);
          return;
        }
        await this.mergeChat(p.chat_id, { draft: p.draft ?? null });
        return;
      }
      default:
        // Volatile / not-yet-cached events (typing, presence, reactions, receipts) — ignored safely;
        // the UI layers consume them live. The cursor still advances via setCursor().
        return;
    }
  }

  private cacheable(chatId: number, createdAt?: number): boolean {
    if (!this.policy) return true;
    if (!this.policy.shouldPersistChat(chatId)) return false;
    const cutoff = this.policy.cutoffSec(chatId);
    if (cutoff === null) return true;
    const timestamp = typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : this.nowSec();
    return timestamp >= cutoff;
  }

  private messageOf(evt: SyncEvent): CachedMessage | null {
    const p = evt.payload as { message?: CachedMessage };
    const m = p.message;
    if (m && typeof m.id === "number" && typeof m.chat_id === "number") return m;
    return null;
  }

  // Store the message and bump its chat's last-message pointer (monotonic — a late-arriving edit of an
  // older message never rewinds the chat's ordering).
  private async upsertMessage(msg: CachedMessage): Promise<void> {
    const cachedAt = this.nowSec();
    const storedMessage: CachedMessage = { ...msg, __gc_cached_at: cachedAt };
    const chat = (await this.store.get<CachedChat>("chats", msg.chat_id)) ?? { id: msg.chat_id };
    const prevId = typeof chat.last_message_id === "number" ? chat.last_message_id : 0;
    const isNewest = msg.id >= prevId;
    const nextChat: CachedChat = {
      ...chat,
      id: msg.chat_id,
      __gc_cached_at: cachedAt,
      ...(isNewest
        ? {
            last_message_id: msg.id,
            last_message: storedMessage,
            updated_at: typeof msg.created_at === "number" ? msg.created_at : chat.updated_at ?? cachedAt,
          }
        : {}),
    };
    await this.store.batch([
      { op: "put", collection: "messages", key: msg.id, value: storedMessage },
      { op: "put", collection: "chats", key: msg.chat_id, value: nextChat },
    ]);
  }

  private async mergeChat(chatId: number, patch: Record<string, unknown>): Promise<void> {
    const chat = (await this.store.get<CachedChat>("chats", chatId)) ?? { id: chatId };
    await this.store.put("chats", chatId, { ...chat, ...patch, id: chatId, __gc_cached_at: this.nowSec() });
  }

  // ---- cursor persistence ----

  setCursor(lastSeq: number): Promise<void> {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) return;
      if (this.blockedCursorAt !== null && lastSeq >= this.blockedCursorAt) return;
      const cur = await this.readCursorNow();
      if (lastSeq > cur) await this.store.put("meta", CURSOR_KEY, { id: CURSOR_KEY, value: lastSeq });
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const operation = this.chain.then(async () => {
      if (this.resetFailure !== null) throw this.resetFailure;
      await task();
    });
    // Keep the queue usable after a failure; the caller still receives `operation` and cursor safety is
    // enforced by blockedCursorAt/resetFailure.
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  private async ready(): Promise<void> {
    await this.chain;
    if (this.resetFailure !== null) throw this.resetFailure;
  }

  private async readCursorNow(): Promise<number> {
    const row = await this.store.get<{ value?: number }>("meta", CURSOR_KEY);
    return typeof row?.value === "number" ? row.value : 0;
  }

  async getCursor(): Promise<number> {
    await this.ready();
    return this.readCursorNow();
  }

  // ---- instant-render reads ----

  // Cached chats, most-recently-active first (by last message / update time).
  async cachedChats(): Promise<CachedChat[]> {
    await this.ready();
    const all = await this.store.scan<CachedChat>("chats");
    return all
      .filter((chat) => this.cacheable(chat.id, chat.updated_at ?? chat.__gc_cached_at))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }

  // Cached messages for a chat, oldest→newest (numeric id order). `limit` keeps the tail.
  async cachedMessages(chatId: number, limit?: number): Promise<CachedMessage[]> {
    await this.ready();
    if (this.policy && !this.policy.shouldPersistChat(chatId)) return [];
    const rows = await this.store.scan<CachedMessage>("messages", { index: "chat_id", value: chatId });
    const ordered = rows
      .filter((m) => !m.deleted && this.cacheable(chatId, m.created_at ?? m.__gc_cached_at))
      .sort((a, b) => a.id - b.id);
    if (limit !== undefined && ordered.length > limit) return ordered.slice(ordered.length - limit);
    return ordered;
  }
}

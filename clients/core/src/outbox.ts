// clients/core — Outbox: the offline send queue (T-403, CLIENTS.md §5.2, PRODUCT_UX §4).
//
// Every outgoing mutation (a new message, an edit, a delete) is written to the ClientStore FIRST,
// then sent. That gives three guarantees the UI depends on:
//   - Optimistic + durable: the bubble shows instantly (status "queued") and survives a reload/crash
//     because it lives in the store, not just memory.
//   - Exactly-once: a message send carries `client_msg_id`; the server dedupes on it (T-013), so a
//     retry after an ambiguous network failure can never double-post. ApiClient already treats such
//     a body as idempotent and retries transient failures with backoff.
//   - Ordered: FIFO per chat via a per-chat promise chain — message N+1 never overtakes message N,
//     even across retries. Different chats send in parallel.
//
// Telegram-like delivery: a new message/edit leaves the local queue immediately. The optimistic
// bubble carries the transient clock/check/failure state inside itself; no separate "Sending…" surface
// and no artificial five-second latency. Destructive deletion keeps a short undo hold so a mistaken
// delete can still be cancelled before it reaches the wire.
import type { ApiClient, HttpMethod } from "./api.ts";
import { ApiError } from "./errors.ts";
import type { ClientStore } from "./store.ts";

export type OutboxKind = "message" | "edit" | "delete";
export type OutboxStatus = "queued" | "sending" | "sent" | "failed";

export interface OutboxItem {
  id: string; // queue key: client_msg_id for a message; synthetic for edit/delete
  chat_id: number;
  kind: OutboxKind;
  method: HttpMethod;
  path: string;
  body?: Record<string, unknown>;
  status: OutboxStatus;
  created_at: number; // ms — FIFO ordering + undo-window arithmetic
  attempts: number;
  error?: { code: string; message: string };
  result?: unknown; // the server's message payload once sent
}

export interface OutboxChange {
  item: OutboxItem;
  // true when the item just left the queue (undo-cancelled, or successfully sent and reconciled).
  removed?: boolean;
}

export type OutboxExclusive = (key: string, task: () => Promise<void>) => Promise<void>;

export interface OutboxOptions {
  api: ApiClient;
  store: ClientStore;
  // Backward-compatible global hold override. When omitted, messages/edits send immediately.
  // Tests or specialised shells may still set a non-zero value for every mutation.
  undoMs?: number;
  // Destructive delete-only undo hold. Default 5000 ms. An explicit undoMs remains a global override
  // unless this more specific value is supplied.
  deleteUndoMs?: number;
  onChange?: (change: OutboxChange) => void;
  now?: () => number;
  // T-529: cloud-only chats keep pending mutations in RAM only. Absent preserves durable legacy mode.
  persistForChat?: (chatId: number) => boolean;
  // Cross-context lease. Web uses navigator.locks so two tabs cannot send the same durable row at
  // once. Holding the lease through the HTTP request is intentional: if the owner tab dies, the
  // browser releases it and the waiter safely re-reads the current durable/RAM row.
  runExclusive?: OutboxExclusive;
}

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_MUTATION_UNDO_MS = 0;
const DEFAULT_DELETE_UNDO_MS = 5000;

function newId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class Outbox {
  private readonly api: ApiClient;
  private readonly store: ClientStore;
  private readonly mutationUndoMs: number;
  private readonly deleteUndoMs: number;
  private readonly onChange: ((change: OutboxChange) => void) | undefined;
  private readonly now: () => number;
  private readonly runExclusive: OutboxExclusive;

  private readonly persistForChat: (chatId: number) => boolean;
  // Plaintext is permitted only while UNLOCKED. pause() clears this map before the lock screen mounts.
  private readonly volatile = new Map<string, OutboxItem>();

  // Per-chat serial send chain (FIFO). Different chats run concurrently.
  private readonly chains = new Map<number, Promise<void>>();
  // Undo timers keyed by item id; cleared on cancel or when the item is promoted to sending.
  private readonly undoTimers = new Map<string, Timer>();
  // T-523: LOCKED must stop every future send and abort current fetches. The generation invalidates
  // already-enqueued promise-chain closures. T-529 may use a deliberate RAM-only queue for cloud-only
  // chats while UNLOCKED; pause() zeroizes that map synchronously before the lock screen mounts.
  private paused = false;
  private generation = 0;
  private readonly active = new Map<string, AbortController>();

  constructor(opts: OutboxOptions) {
    this.api = opts.api;
    this.store = opts.store;
    this.mutationUndoMs = opts.undoMs ?? DEFAULT_MUTATION_UNDO_MS;
    this.deleteUndoMs = opts.deleteUndoMs ?? opts.undoMs ?? DEFAULT_DELETE_UNDO_MS;
    this.onChange = opts.onChange;
    this.now = opts.now ?? Date.now;
    this.persistForChat = opts.persistForChat ?? (() => true);
    this.runExclusive = opts.runExclusive ?? (async (_key, task) => task());
  }

  // ---- public queueing API ----

  /**
   * Stop the data plane synchronously for application LOCKED/COLD. Persisted queue rows remain encrypted
   * in ClientStore; undo timers and active HTTP calls are cancelled, and stale chain closures are invalidated.
   */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.generation += 1;
    for (const timer of this.undoTimers.values()) clearTimeout(timer);
    this.undoTimers.clear();
    for (const controller of this.active.values()) controller.abort(new Error("outbox paused"));
    this.active.clear();
    this.chains.clear();
    // T-529 cloud-only queue rows are intentionally RAM-only; LOCKED must retain no plaintext.
    this.volatile.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Reconcile pending rows after a T-529 policy change without dropping an operation. */
  async applyPersistencePolicy(chatId?: number, persistOverride?: boolean): Promise<void> {
    const shouldPersist = (item: OutboxItem): boolean =>
      persistOverride ?? this.persistForChat(item.chat_id);
    const persisted = await this.store.scan<OutboxItem>("outbox");
    for (const item of persisted) {
      if (chatId !== undefined && item.chat_id !== chatId) continue;
      if (shouldPersist(item)) continue;
      this.volatile.set(item.id, structuredClone(item));
      await this.store.delete("outbox", item.id);
    }
    for (const [id, item] of [...this.volatile.entries()]) {
      if (chatId !== undefined && item.chat_id !== chatId) continue;
      if (!shouldPersist(item)) continue;
      await this.store.put("outbox", id, structuredClone(item));
      this.volatile.delete(id);
    }
  }

  private async readItem(id: string): Promise<OutboxItem | undefined> {
    const volatile = this.volatile.get(id);
    if (volatile) return structuredClone(volatile);
    return this.store.get<OutboxItem>("outbox", id);
  }

  private async writeItem(item: OutboxItem): Promise<void> {
    if (this.persistForChat(item.chat_id)) {
      this.volatile.delete(item.id);
      await this.store.put("outbox", item.id, structuredClone(item));
    } else {
      this.volatile.set(item.id, structuredClone(item));
      await this.store.delete("outbox", item.id);
    }
  }

  private async deleteItem(id: string): Promise<void> {
    this.volatile.delete(id);
    await this.store.delete("outbox", id);
  }

  // Queue a new chat message. `body` must carry `client_msg_id` (generated if absent) and the usual
  // send fields (text / kind / file_id / reply_to_id). Returns the client_msg_id (the queue id).
  async enqueueMessage(chatId: number, body: Record<string, unknown>): Promise<string> {
    const cmid = typeof body.client_msg_id === "string" ? body.client_msg_id : newId();
    const full = { ...body, client_msg_id: cmid };
    await this.add({
      id: cmid,
      chat_id: chatId,
      kind: "message",
      method: "POST",
      path: `/v1/chats/${chatId}/messages`,
      body: full,
    });
    return cmid;
  }

  // Queue an edit of an existing message (PATCH /v1/messages/:id {text}).
  async enqueueEdit(chatId: number, messageId: number, text: string): Promise<string> {
    const id = `edit-${messageId}-${newId()}`;
    await this.add({
      id,
      chat_id: chatId,
      kind: "edit",
      method: "PATCH",
      path: `/v1/messages/${messageId}`,
      body: { text },
    });
    return id;
  }

  // Queue a delete (DELETE /v1/messages/:id).
  async enqueueDelete(chatId: number, messageId: number): Promise<string> {
    const id = `del-${messageId}-${newId()}`;
    await this.add({
      id,
      chat_id: chatId,
      kind: "delete",
      method: "DELETE",
      path: `/v1/messages/${messageId}`,
    });
    return id;
  }

  // Undo a still-queued item (within the undo window). Returns true if it was removed before sending.
  async cancel(id: string): Promise<boolean> {
    const item = await this.readItem(id);
    if (!item || item.status !== "queued") return false;
    this.clearUndo(id);
    await this.deleteItem(id);
    this.emit({ item: { ...item }, removed: true });
    return true;
  }

  // Re-send a failed item. Puts it back to queued and schedules an immediate send (no undo delay).
  async retry(id: string): Promise<void> {
    if (this.paused) throw new Error("outbox: paused");
    const item = await this.readItem(id);
    if (!item || item.status === "sending") return;
    item.status = "queued";
    delete item.error;
    await this.writeItem(item);
    this.emit({ item: { ...item } });
    this.scheduleSend(item.chat_id, id);
  }

  // List every pending item (optionally for one chat), oldest first — the source of truth the UI
  // renders optimistic bubbles + status ticks from.
  async list(chatId?: number): Promise<OutboxItem[]> {
    await this.applyPersistencePolicy(chatId);
    const durable = await this.store.scan<OutboxItem>("outbox");
    const merged = new Map<string, OutboxItem>();
    for (const item of durable) merged.set(item.id, item);
    for (const item of this.volatile.values()) merged.set(item.id, structuredClone(item));
    const all = [...merged.values()];
    const items = chatId === undefined ? all : all.filter((i) => i.chat_id === chatId);
    return items.sort((a, b) => a.created_at - b.created_at);
  }

  // Reschedule persisted items after a cold start or reconnect: queued items finish any configured
  // per-kind hold; sending/failed items (a crash mid-flight, or an earlier failure) are re-sent. Order
  // is preserved because items enter the per-chat chain sorted by created_at.
  async resume(): Promise<void> {
    this.paused = false;
    const items = await this.list();
    for (const item of items) {
      if (item.status === "queued") {
        const elapsed = this.now() - item.created_at;
        const remaining = Math.max(0, this.undoDelayFor(item) - elapsed);
        this.scheduleUndo(item.chat_id, item.id, remaining);
      } else if (item.status === "sending" || item.status === "failed") {
        // A "sending" item means we crashed mid-send; re-send is safe (idempotent for messages).
        this.scheduleSend(item.chat_id, item.id);
      }
    }
  }

  // Re-drive only the items that already gave up. V124, measured on the signed artifact
  // (var/ux-audit/v124-offline): send with the network cut and the bubble walks queued → sending →
  // failed in ~6 s, honestly, with «Повторить» and a ⚠ tick. Then the network comes back, the strip
  // itself announces «Соединение восстановлено» — and the message stays ⚠ until the user taps
  // Повторить by hand, because nothing re-drives the queue. The app knew, and told no one who could
  // act on it.
  //
  // Deliberately narrower than the two methods that already exist:
  //   flush()  also clears delete-undo timers, so a reconnect would rob the user of the short
  //            recovery window on a destructive action — and a reconnect is not their decision.
  //   resume() sets paused = false, which would silently re-arm a data plane the app lock stopped
  //            on purpose (stopDataPlane() pauses the Outbox while K_db is unavailable).
  // Returns how many items were re-driven, so callers can measure instead of assume.
  async retryFailed(): Promise<number> {
    if (this.paused) return 0;
    const items = await this.list();
    let restarted = 0;
    for (const item of items) {
      if (item.status !== "failed") continue;
      this.scheduleSend(item.chat_id, item.id);
      restarted += 1;
    }
    return restarted;
  }

  // Force an immediate flush of everything still pending (e.g. right after the socket reconnects).
  async flush(): Promise<void> {
    if (this.paused) return;
    const items = await this.list();
    for (const item of items) {
      if (item.status === "queued") {
        this.clearUndo(item.id);
        this.scheduleSend(item.chat_id, item.id);
      } else if (item.status === "failed") {
        this.scheduleSend(item.chat_id, item.id);
      }
    }
  }

  // ---- internals ----

  private async add(spec: Omit<OutboxItem, "status" | "created_at" | "attempts">): Promise<void> {
    if (this.paused) throw new Error("outbox: paused");
    const item: OutboxItem = {
      ...spec,
      status: "queued",
      created_at: this.now(),
      attempts: 0,
    };
    await this.writeItem(item);
    this.emit({ item: { ...item } });
    this.scheduleUndo(item.chat_id, item.id, this.undoDelayFor(item));
  }

  private undoDelayFor(item: Pick<OutboxItem, "kind">): number {
    return item.kind === "delete" ? this.deleteUndoMs : this.mutationUndoMs;
  }

  // Hold only operations configured with an undo delay; ordinary messages and edits pass through.
  private scheduleUndo(chatId: number, id: string, delayMs: number): void {
    this.clearUndo(id);
    if (this.paused) return;
    if (delayMs <= 0) {
      this.scheduleSend(chatId, id);
      return;
    }
    const t = setTimeout(() => {
      this.undoTimers.delete(id);
      this.scheduleSend(chatId, id);
    }, delayMs);
    this.undoTimers.set(id, t);
  }

  private clearUndo(id: string): void {
    const t = this.undoTimers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      this.undoTimers.delete(id);
    }
  }

  // Append the send to this chat's FIFO chain. The chain guarantees message N is fully resolved
  // (sent or failed) before N+1 touches the wire.
  private scheduleSend(chatId: number, id: string): void {
    if (this.paused) return;
    const generation = this.generation;
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.send(id, generation));
    this.chains.set(
      chatId,
      run.catch(() => undefined),
    );
  }

  private async send(id: string, generation: number): Promise<void> {
    if (this.paused || generation !== this.generation) return;
    await this.runExclusive(`greenchat.outbox.${id}`, () => this.sendClaimed(id, generation));
  }

  private async sendClaimed(id: string, generation: number): Promise<void> {
    if (this.paused || generation !== this.generation) return;
    const item = await this.readItem(id);
    if (this.paused || generation !== this.generation || !item || item.status === "sent") return;
    // A cancel() may have removed it while it waited in the chain.
    if (item.status === "queued" && this.undoTimers.has(id)) return;

    item.status = "sending";
    item.attempts += 1;
    delete item.error;
    await this.writeItem(item);
    if (this.paused || generation !== this.generation) return;
    this.emit({ item: { ...item } });

    const abort = new AbortController();
    this.active.set(id, abort);
    try {
      const result = await this.api.request<unknown>(
        item.method,
        item.path,
        item.body !== undefined ? { body: item.body, signal: abort.signal } : { signal: abort.signal },
      );
      if (this.paused || generation !== this.generation) return;
      // Success: drop from the queue. The authoritative message also arrives via SyncEngine
      // (message.new/edit/delete); `removed` lets the UI reconcile the optimistic bubble.
      await this.deleteItem(id);
      this.emit({ item: { ...item, status: "sent", result }, removed: true });
    } catch (err) {
      // pause() is not a delivery failure. Leave the durable row as `sending`; resume() treats it as an
      // ambiguous in-flight operation and safely replays it (messages are deduped by client_msg_id).
      if (this.paused || generation !== this.generation || abort.signal.aborted) return;
      const code = err instanceof ApiError ? err.code : "NETWORK_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      const failed = await this.readItem(id);
      if (!failed) return; // cancelled concurrently
      failed.status = "failed";
      failed.error = { code, message };
      await this.writeItem(failed);
      this.emit({ item: { ...failed } });
    } finally {
      if (this.active.get(id) === abort) this.active.delete(id);
    }
  }

  private emit(change: OutboxChange): void {
    this.onChange?.(change);
  }
}

// clients/core — ClientStore: the local cache / offline substrate (T-403, CLIENTS.md §5.2).
//
// One tiny key/value-with-collections abstraction backs BOTH runtime targets with identical
// semantics:
//   - MemoryStore    — Node and `node --test` (and a safe fallback when IndexedDB is unavailable).
//   - IndexedDbStore — the browser and every WebView shell (they share one engine; §5.2 forbids a
//                      separate SQLite until a measured need).
//
// The store is deliberately dumb: opaque records keyed by an out-of-line key, with an optional
// secondary-field filter on scan(). All values are structured-cloned on the way in AND out, so a
// caller can never mutate what the store holds by reference (this mirrors IndexedDB's own value
// semantics, keeping the two backends interchangeable). Higher layers — Outbox, MediaCache,
// CacheSync — build every offline feature on top of just get/put/delete/scan/batch.

// Primary keys are message/chat/user/file numeric ids, or string ids (client_msg_id, meta names).
export type StoreKey = string | number;


export interface StoreEntry<T = unknown> {
  key: StoreKey;
  value: T;
}

// The fixed set of collections the SDK persists. A plain string-union (erasable TS: no enums).
export type Collection =
  | "meta" // key/value bag: last_seq, install_id, schema markers…
  | "chats" // key = chat id
  | "messages" // key = message id; carries chat_id for the per-chat scan
  | "contacts" // key = user id
  | "files" // key = file id (attachment metadata)
  | "outbox" // key = client_msg_id; carries chat_id + status
  | "media"; // key = file id (LRU blob cache); carries byte length + last-access

export const COLLECTIONS: readonly Collection[] = [
  "meta",
  "chats",
  "messages",
  "contacts",
  "files",
  "outbox",
  "media",
];

// A scan reads a whole collection in key order, optionally narrowed to records whose `index` field
// equals `value` (e.g. messages where chat_id === 42). Keeps the interface trivial while covering
// the only query the cache actually needs.
export interface ScanQuery {
  index?: string;
  value?: StoreKey;
  limit?: number;
  reverse?: boolean; // descending key order (newest-first when keys are monotonic ids)
}

// A single atomic mutation for batch(): put (value required) or delete.
export interface WriteOp {
  op: "put" | "delete";
  collection: Collection;
  key: StoreKey;
  value?: unknown;
}

export interface ClientStore {
  get<T = unknown>(collection: Collection, key: StoreKey): Promise<T | undefined>;
  put(collection: Collection, key: StoreKey, value: unknown): Promise<void>;
  delete(collection: Collection, key: StoreKey): Promise<void>;
  scan<T = unknown>(collection: Collection, query?: ScanQuery): Promise<T[]>;

  // Raw key+value enumeration in key order. Required by the one-time plaintext→encrypted migration:
  // values alone are insufficient because meta/outbox keys are not guaranteed to be embedded in rows.
  entries<T = unknown>(collection: Collection): Promise<Array<StoreEntry<T>>>;
  // Apply every op atomically (all-or-nothing). The offline invariant: a message and the chat row it
  // bumps land together, or not at all.
  batch(ops: WriteOp[]): Promise<void>;
  clear(collection: Collection): Promise<void>;
  close(): Promise<void>;
}

// Deep-copy a value crossing the store boundary. structuredClone is global in Node 18+ and every
// modern browser/WebView, and it round-trips the types the cache stores (plain objects, arrays,
// Uint8Array/ArrayBuffer media blobs) — the same value graph IndexedDB itself can persist.
function clone<T>(v: T): T {
  return v === undefined ? v : (structuredClone(v) as T);
}

// Order two keys: numeric when both numbers (so message id 2 < 10), else lexicographic.
function cmpKey(a: StoreKey, b: StoreKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// In-memory ClientStore. Synchronous underneath (a Map of Maps) so batch() is trivially atomic;
// the async surface just matches the interface. Used by tests and as the universal fallback.
export class MemoryStore implements ClientStore {
  private readonly data = new Map<Collection, Map<StoreKey, unknown>>();

  private col(c: Collection): Map<StoreKey, unknown> {
    let m = this.data.get(c);
    if (!m) {
      m = new Map<StoreKey, unknown>();
      this.data.set(c, m);
    }
    return m;
  }

  get<T = unknown>(collection: Collection, key: StoreKey): Promise<T | undefined> {
    const v = this.col(collection).get(key);
    return Promise.resolve(v === undefined ? undefined : (clone(v) as T));
  }

  put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    this.col(collection).set(key, clone(value));
    return Promise.resolve();
  }

  delete(collection: Collection, key: StoreKey): Promise<void> {
    this.col(collection).delete(key);
    return Promise.resolve();
  }

  entries<T = unknown>(collection: Collection): Promise<Array<StoreEntry<T>>> {
    const rows = [...this.col(collection).entries()]
      .sort((a, b) => cmpKey(a[0], b[0]))
      .map(([key, value]) => ({ key, value: clone(value) as T }));
    return Promise.resolve(rows);
  }

  scan<T = unknown>(collection: Collection, query: ScanQuery = {}): Promise<T[]> {
    const entries = [...this.col(collection).entries()].sort((x, y) => cmpKey(x[0], y[0]));
    if (query.reverse) entries.reverse();
    let vals = entries.map((e) => e[1]);
    if (query.index !== undefined && query.value !== undefined) {
      const idx = query.index;
      const want = query.value;
      vals = vals.filter((v) => isRecord(v) && v[idx] === want);
    }
    if (query.limit !== undefined) vals = vals.slice(0, query.limit);
    return Promise.resolve(vals.map((v) => clone(v)) as T[]);
  }

  async batch(ops: WriteOp[]): Promise<void> {
    // Copy-on-write keeps the advertised all-or-nothing contract even if structuredClone throws for
    // a later operation. This mirrors IndexedDB's transaction abort semantics used in production.
    const staged = new Map<Collection, Map<StoreKey, unknown>>();
    for (const op of ops) {
      if (!staged.has(op.collection)) staged.set(op.collection, new Map(this.col(op.collection)));
      const target = staged.get(op.collection)!;
      if (op.op === "put") target.set(op.key, clone(op.value));
      else target.delete(op.key);
    }
    for (const [collection, values] of staged) this.data.set(collection, values);
  }

  clear(collection: Collection): Promise<void> {
    this.col(collection).clear();
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

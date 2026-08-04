// clients/core — IndexedDbStore: the browser / WebView ClientStore (T-403, CLIENTS.md §5.2).
//
// The same tiny interface as MemoryStore, backed by one IndexedDB database of out-of-line-keyed
// object stores (one per Collection). Every shell (Tauri, Capacitor) runs a WebView, so this single
// implementation persists the cache on web AND native — no per-platform SQLite (§5.2 anti-complexity).
//
// IndexedDB does not exist in Node, so this module NEVER touches the global at import or construct
// time: `open()` (called lazily on first use) is where the environment is checked. In `node --test`
// the store therefore type-checks and constructs fine and fails only if actually opened without a
// factory — the real coverage runs in the browser e2e (T-410). A factory can be injected for tests.
import {
  COLLECTIONS,
  type ClientStore,
  type Collection,
  type ScanQuery,
  type StoreEntry,
  type StoreKey,
  type WriteOp,
} from "./store.ts";

export interface IndexedDbStoreOptions {
  name?: string;
  version?: number;
  // Inject an IDBFactory (e.g. a fake) for headless tests; defaults to globalThis.indexedDB.
  factory?: IDBFactory;
}

function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function cmpKey(a: StoreKey, b: StoreKey): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class IndexedDbStore implements ClientStore {
  private readonly name: string;
  private readonly version: number;
  private readonly factory: IDBFactory | undefined;
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;

  constructor(opts: IndexedDbStoreOptions = {}) {
    this.name = opts.name ?? "greenchat";
    this.version = opts.version ?? 1;
    this.factory = opts.factory;
  }

  // Open (and, on first run / version bump, create every object store). Idempotent.
  async open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    if (this.opening) {
      const db = await this.opening;
      return this.db === db ? db : this.open();
    }

    const factory =
      this.factory ?? (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (!factory) {
      throw new Error("IndexedDB is unavailable in this environment (browser/WebView only)");
    }

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(this.name, this.version);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const c of COLLECTIONS) {
          if (!db.objectStoreNames.contains(c)) db.createObjectStore(c);
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          // A deleteDatabase() or schema upgrade in another tab cannot finish while this
          // connection remains open. Close promptly and invalidate only this exact handle;
          // a newer connection may already have replaced it.
          db.onversionchange = null;
          db.close();
          if (this.db === db) this.db = null;
        };
        this.db = db;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });

    this.opening = opening;
    try {
      const db = await opening;
      // If versionchange invalidated the handle between onsuccess and this continuation,
      // transparently reopen instead of returning a closed connection to the caller.
      return this.db === db ? db : this.open();
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  private async store(collection: Collection, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.open();
    return db.transaction(collection, mode).objectStore(collection);
  }

  async get<T = unknown>(collection: Collection, key: StoreKey): Promise<T | undefined> {
    const os = await this.store(collection, "readonly");
    const v = await reqDone(os.get(key));
    return v === undefined ? undefined : (v as T);
  }

  async put(collection: Collection, key: StoreKey, value: unknown): Promise<void> {
    const os = await this.store(collection, "readwrite");
    os.put(value, key);
    await txDone(os.transaction);
  }

  async delete(collection: Collection, key: StoreKey): Promise<void> {
    const os = await this.store(collection, "readwrite");
    os.delete(key);
    await txDone(os.transaction);
  }

  async entries<T = unknown>(collection: Collection): Promise<Array<StoreEntry<T>>> {
    const os = await this.store(collection, "readonly");
    const pairs: Array<StoreEntry<T>> = [];
    await new Promise<void>((resolve, reject) => {
      const req = os.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        pairs.push({ key: cursor.key as StoreKey, value: cursor.value as T });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    pairs.sort((a, b) => cmpKey(a.key, b.key));
    return pairs;
  }

  async scan<T = unknown>(collection: Collection, query: ScanQuery = {}): Promise<T[]> {
    const os = await this.store(collection, "readonly");
    const pairs: { key: StoreKey; value: unknown }[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = os.openCursor(null, query.reverse ? "prev" : "next");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        pairs.push({ key: cursor.key as StoreKey, value: cursor.value });
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
    // openCursor already yields keys in order (respecting direction), but sort defensively so mixed
    // key types behave exactly like MemoryStore.
    pairs.sort((a, b) => (query.reverse ? cmpKey(b.key, a.key) : cmpKey(a.key, b.key)));
    let vals = pairs.map((p) => p.value);
    if (query.index !== undefined && query.value !== undefined) {
      const idx = query.index;
      const want = query.value;
      vals = vals.filter((v) => isRecord(v) && v[idx] === want);
    }
    if (query.limit !== undefined) vals = vals.slice(0, query.limit);
    return vals as T[];
  }

  async batch(ops: WriteOp[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.open();
    const cols = [...new Set(ops.map((o) => o.collection))];
    const tx = db.transaction(cols, "readwrite");
    for (const op of ops) {
      const os = tx.objectStore(op.collection);
      if (op.op === "put") os.put(op.value, op.key);
      else os.delete(op.key);
    }
    await txDone(tx);
  }

  async clear(collection: Collection): Promise<void> {
    const os = await this.store(collection, "readwrite");
    os.clear();
    await txDone(os.transaction);
  }

  close(): Promise<void> {
    if (this.db) {
      this.db.onversionchange = null;
      this.db.close();
      this.db = null;
    }
    return Promise.resolve();
  }
}

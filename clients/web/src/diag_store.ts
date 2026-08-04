// clients/web/src/diag_store.ts — IndexedDB-backed DiagStore for the web/PWA shell (T-418).
//
// Persists the opt-in consent, the per-install UUID, the local crash queue and the push-latency samples.
// The SERVICE WORKER (sw.js) writes samples too: a page can't observe a push while backgrounded, so the
// SW records {s: sent_at_seconds, r: received_ms} into the SHARED `samples` store on every push, and the
// page's Diagnostics controller drains them once a day. One database ("gc-diag") is shared by the page and
// the worker — the schema here MUST match the one sw.js opens (same name, version and object stores).
//
// Every method fails SAFE: an unavailable IndexedDB (private mode, disabled storage) yields consent=false
// and empty queues, so such a tab simply never collects or sends anything. Writes may reject; the core
// Diagnostics controller wraps every store call and routes failures to onError — telemetry never throws.
import type { DiagStore, QueuedCrash, LatencySample } from "../../core/src/index.ts";

const DB_NAME = "gc-diag";
const DB_VERSION = 1;
const KV = "kv";
const CRASHES = "crashes";
const SAMPLES = "samples";
const K_INSTALL = "install_id";
const K_CONSENT = "consent";
const K_LAST_DIAG = "last_diag_at";

// A raw latency row, written identically by this store and by sw.js: {s: sent_at seconds, r: received ms}.
interface SampleRow {
  s: number;
  r: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(e instanceof Error ? e : new Error("indexedDB.open failed"));
      return;
    }
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains(CRASHES)) db.createObjectStore(CRASHES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SAMPLES)) db.createObjectStore(SAMPLES, { autoIncrement: true });
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB open error"));
  });
}

// Run one request inside a transaction and resolve AFTER it commits (so writes are durable on resolve).
// The request's result is captured for reads.
function run<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result: T | undefined;
    const rq = fn(tx.objectStore(storeName));
    rq.onsuccess = (): void => {
      result = rq.result;
    };
    tx.oncomplete = (): void => resolve(result);
    tx.onerror = (): void => reject(tx.error ?? new Error("idb tx error"));
    tx.onabort = (): void => reject(tx.error ?? new Error("idb tx abort"));
  });
}

export function webDiagStore(): DiagStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = (): Promise<IDBDatabase> => {
    if (!dbp) dbp = openDb().catch((e) => { dbp = null; throw e; }); // let a transient failure retry next call
    return dbp;
  };
  let volatileId: string | null = null; // stable-per-session fallback id when IndexedDB is unavailable

  const newId = (): string => {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch { /* fall through to a manual id */ }
    return "inst-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  };

  return {
    async installId(): Promise<string> {
      try {
        const d = await db();
        const existing = await run<string>(d, KV, "readonly", (s) => s.get(K_INSTALL));
        if (typeof existing === "string" && existing) return existing;
        const id = newId();
        await run(d, KV, "readwrite", (s) => s.put(id, K_INSTALL));
        return id;
      } catch {
        // No IndexedDB → a stable per-session id so a crash can still be keyed. Nothing persists, and
        // without persisted consent nothing is ever sent anyway.
        if (!volatileId) volatileId = newId();
        return volatileId;
      }
    },
    async getConsent(): Promise<boolean> {
      try {
        const d = await db();
        const v = await run<unknown>(d, KV, "readonly", (s) => s.get(K_CONSENT));
        return v === true;
      } catch {
        return false; // fail-safe: no consent → no collection, no requests
      }
    },
    async setConsent(on: boolean): Promise<void> {
      const d = await db();
      await run(d, KV, "readwrite", (s) => s.put(on === true, K_CONSENT));
    },
    async pushCrash(c: QueuedCrash): Promise<void> {
      const d = await db();
      await run(d, CRASHES, "readwrite", (s) => s.put(c));
    },
    async listCrashes(): Promise<QueuedCrash[]> {
      try {
        const d = await db();
        const rows = (await run<QueuedCrash[]>(d, CRASHES, "readonly", (s) => s.getAll())) ?? [];
        return rows.filter((r) => r && typeof r.id === "string").sort((a, b) => a.at - b.at);
      } catch {
        return [];
      }
    },
    async dropCrash(id: string): Promise<void> {
      const d = await db();
      await run(d, CRASHES, "readwrite", (s) => s.delete(id));
    },
    async clearCrashes(): Promise<void> {
      const d = await db();
      await run(d, CRASHES, "readwrite", (s) => s.clear());
    },
    async addSample(sample: LatencySample): Promise<void> {
      const d = await db();
      const row: SampleRow = { s: sample.sentAtSec, r: sample.receivedAtMs };
      await run(d, SAMPLES, "readwrite", (st) => st.add(row));
    },
    async listSamples(): Promise<LatencySample[]> {
      try {
        const d = await db();
        const rows = (await run<SampleRow[]>(d, SAMPLES, "readonly", (st) => st.getAll())) ?? [];
        const out: LatencySample[] = [];
        for (const r of rows) {
          const sent = Number(r?.s);
          const recv = Number(r?.r);
          if (Number.isFinite(sent) && Number.isFinite(recv)) out.push({ sentAtSec: sent, receivedAtMs: recv });
        }
        return out;
      } catch {
        return [];
      }
    },
    async clearSamples(): Promise<void> {
      const d = await db();
      await run(d, SAMPLES, "readwrite", (st) => st.clear());
    },
    async lastDiagAt(): Promise<number> {
      try {
        const d = await db();
        const v = await run<unknown>(d, KV, "readonly", (s) => s.get(K_LAST_DIAG));
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      } catch {
        return 0;
      }
    },
    async setLastDiagAt(ms: number): Promise<void> {
      const d = await db();
      await run(d, KV, "readwrite", (s) => s.put(ms, K_LAST_DIAG));
    },
  };
}

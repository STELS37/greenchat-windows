// clients/web/src/notify_mode.ts — web NotifyModePort (T-531, DS-13): persists the notification
// display mode («full/name/generic») into the SHARED «gc-diag» IndexedDB kv store, the one place the
// service worker can read synchronously-with-push while every page is closed (sw.js readNotifyMode
// opens the same DB per push, exactly like the T-418 consent flag). The mode enum is NOT a secret —
// no chat plaintext lands on disk — and like the diag consent it survives logout deliberately: it is
// a device preference, not account data.
//
// Schema MUST stay in lockstep with clients/web/src/diag_store.ts and sw.js (same DB name, version and
// object stores — an IDB open with a mismatched version would stall the other party). The kv key and
// the value set mirror clients/core/src/notify_render.ts (NOTIFY_MODE_KV_KEY / normalizeNotifyMode).
//
// Wiring (deferred, see logs/w-t531.result.md): main.ts passes webNotifyModePort() as `notifyMode` to
// createApp, which threads it into the settings screen — both files belong to another lane's zone.
import type { NotifyModePort } from "../../ui/src/screens/settings_screen.ts";
import {
  NOTIFY_MODE_KV_KEY,
  NOTIFY_MODE_DEFAULT,
  normalizeNotifyMode,
} from "../../core/src/notify_render.ts";

const DB_NAME = "gc-diag";
const DB_VERSION = 1;
const KV = "kv";

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
      // Mirror of diag_store.ts/sw.js — whoever opens first creates the full shared schema.
      const db = req.result;
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
      if (!db.objectStoreNames.contains("crashes")) db.createObjectStore("crashes", { keyPath: "id" });
      if (!db.objectStoreNames.contains("samples")) db.createObjectStore("samples", { autoIncrement: true });
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error("indexedDB open error"));
  });
}

function kvOp<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const tx = db.transaction(KV, mode);
        let result: T | undefined;
        const rq = fn(tx.objectStore(KV));
        rq.onsuccess = (): void => { result = rq.result; };
        tx.oncomplete = (): void => { db.close(); resolve(result); };
        tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb tx error")); };
        tx.onabort = (): void => { db.close(); reject(tx.error ?? new Error("idb tx abort")); };
      }),
  );
}

export function webNotifyModePort(): NotifyModePort {

  let writeTail: Promise<void> = Promise.resolve();
  return {
    async get(): Promise<string> {
      try {
        return normalizeNotifyMode(await kvOp("readonly", (s) => s.get(NOTIFY_MODE_KV_KEY)));
      } catch {
        return NOTIFY_MODE_DEFAULT; // no IndexedDB (private mode) → the safe default, never an error
      }
    },
    set(mode: string): Promise<void> {
      // Open requests from two rapid settings changes may complete out of order. Serialize writes at
      // the port boundary so the durable SW-visible value always follows invocation order.
      const normalized = normalizeNotifyMode(mode);
      const operation = writeTail.then(async () => {
        await kvOp("readwrite", (s) => s.put(normalized, NOTIFY_MODE_KV_KEY));
      });
      // Surface this operation's failure to the Settings row, but keep an always-resolving internal tail
      // so a later user choice is never wedged behind an old IndexedDB error.
      writeTail = operation.catch(() => undefined);
      return operation;
    },
  };
}

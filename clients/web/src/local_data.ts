// clients/web/src/local_data.ts — the web shell's LocalData adapter (T-423, CLIENTS §10 privacy).
//
// Logout / account-switch must leave NOTHING readable behind on a shared computer. The token slice is
// handled by SessionStorage; this wipes the DURABLE cache that actually holds message text and media:
//   • the whole IndexedDB database ("greenchat": chats, messages, contacts, files, outbox, media blobs);
//   • the Service Worker media CacheStorage ("gc-media-v1").
// The cache owner (owner_user_id) is stamped in the store's own `meta` collection so a login by a
// different account is detected and the stale cache wiped BEFORE any screen warms from it.
//
// Every step is best-effort and guarded: a browser without CacheStorage, a blocked delete, or a
// privacy-mode tab must never trap the user signed-in or block a sign-in.
import type { ClientStore } from "../../core/src/index.ts";
import type { LocalData } from "../../ui/src/screens/index.ts";

const OWNER_KEY = "owner_user_id";
const OWNER_STORAGE_KEY = "gc.cache_owner.v1";
const DELETE_DATABASE_TIMEOUT_MS = 1_000;

export interface OwnerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebLocalDataDeps {
  store: ClientStore;
  dbName?: string; // the IndexedDB database name (default "greenchat")
  mediaCacheName?: string; // the SW media CacheStorage bucket (default "gc-media-v1")
  /**
   * Owner marker outside EncryptedStore. It contains only the numeric user id already present in the
   * persisted auth snapshot, but unlike encrypted `meta` it remains readable in COLD/LOCKED. This lets
   * Session detect an account switch BEFORE unlocking or warming any cache rows.
   */
  ownerStorage?: OwnerStorage;
  ownerStorageKey?: string;
  /** Maximum wait for a blocked IndexedDB delete before logout continues best-effort. */
  deleteDatabaseTimeoutMs?: number;
}

export function webLocalData(deps: WebLocalDataDeps): LocalData {
  const dbName = deps.dbName ?? "greenchat";
  const mediaCacheName = deps.mediaCacheName ?? "gc-media-v1";
  const store = deps.store;
  const ownerStorage = deps.ownerStorage ?? defaultOwnerStorage();
  const ownerStorageKey = deps.ownerStorageKey ?? OWNER_STORAGE_KEY;
  const deleteDatabaseTimeoutMs = Number.isFinite(deps.deleteDatabaseTimeoutMs)
    ? Math.max(0, Math.floor(deps.deleteDatabaseTimeoutMs ?? DELETE_DATABASE_TIMEOUT_MS))
    : DELETE_DATABASE_TIMEOUT_MS;

  return {
    async getOwner(): Promise<number | null> {
      // Primary source: a deliberately non-secret numeric marker that remains readable while K_db is absent.
      try {
        const raw = ownerStorage?.getItem(ownerStorageKey);
        if (raw !== null && raw !== undefined) {
          const parsed = Number(raw);
          if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
          ownerStorage?.removeItem(ownerStorageKey); // corrupt marker fails closed to the migration path
        }
      } catch {
        /* storage may be blocked; try the legacy encrypted-store marker below */
      }

      // One-time compatibility path for pre-T-523 databases. This succeeds only while passthrough/unlocked;
      // once found, promote it to the external marker so future COLD boots can still compare owners.
      try {
        const v = await store.get<number>("meta", OWNER_KEY);
        if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) {
          try { ownerStorage?.setItem(ownerStorageKey, String(v)); } catch { /* best-effort */ }
          return v;
        }
      } catch {
        /* locked/unavailable = unknown owner; Session must not read any user rows before unlock */
      }
      return null;
    },

    async setOwner(userId: number): Promise<void> {
      if (!Number.isSafeInteger(userId) || userId <= 0) return;
      try {
        ownerStorage?.setItem(ownerStorageKey, String(userId));
      } catch {
        /* best-effort; owner reconciliation must never block sign-in */
      }
      // Keep the old marker during the compatibility window. EncryptedStore protects it after lock enable.
      try { await store.put("meta", OWNER_KEY, userId); } catch { /* locked/unavailable */ }
    },

    async wipe(): Promise<void> {
      // 1) Empty every collection through the store first (works even if the DB delete below is blocked
      //    by another open connection), then close our handle so deleteDatabase can proceed.
      try {
        await store.clear("messages");
        await store.clear("chats");
        await store.clear("contacts");
        await store.clear("files");
        await store.clear("outbox");
        await store.clear("media");
        await store.clear("meta");
      } catch {
        /* fall through to the hard delete */
      }
      try {
        await store.close();
      } catch {
        /* ignore */
      }
      // 2) Drop the whole database (belt-and-suspenders; also removes schema/metadata).
      await deleteDatabase(dbName, deleteDatabaseTimeoutMs);
      // 3) Drop the SW media cache (blob bodies live here, outside IndexedDB).
      try {
        if (typeof caches !== "undefined") await caches.delete(mediaCacheName);
      } catch {
        /* ignore */
      }
      // 4) Forget ownership only after cache deletion was attempted. Session.reconcileOwner() stamps the
      // new owner immediately after a deliberate account switch.
      try { ownerStorage?.removeItem(ownerStorageKey); } catch { /* ignore */ }
    },
  };
}

function defaultOwnerStorage(): OwnerStorage | undefined {
  try { return typeof localStorage !== "undefined" ? localStorage : undefined; }
  catch { return undefined; }
}

// Promise wrapper over indexedDB.deleteDatabase. A transient blocked event is not completion: other
// Green Chat tabs receive versionchange and get a bounded chance to close their handles. The timeout
// preserves the original best-effort contract — an uncooperative foreign tab can never trap logout.
function deleteDatabase(name: string, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const done = (): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve();
    };

    try {
      if (typeof indexedDB === "undefined") {
        done();
        return;
      }
      const req = indexedDB.deleteDatabase(name);
      timer = setTimeout(done, timeoutMs);
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = () => {
        // Wait for success/error while cooperating tabs process versionchange; timeout is the fail-safe.
      };
    } catch {
      done();
    }
  });
}

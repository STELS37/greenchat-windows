// clients/web/src/session_storage.ts — the web shell's persisted-session adapter (T-405, CLIENTS §10).
// The refresh token + a tiny user snapshot live in localStorage: it survives reloads and is origin-
// scoped (the access token is NEVER persisted — it stays in the in-memory TokenStore). Desktop/mobile
// shells will swap this for the OS secure store behind the same SessionStorage interface. Every access
// is guarded so a privacy-mode / disabled-storage browser degrades to a non-persistent session.
import type { SessionStorage, PersistedSession } from "../../ui/src/screens/index.ts";

export interface WebSessionStorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type SessionPersistenceGlobal = typeof globalThis & {
  __gcFlushSessionStorage?: () => Promise<void>;
};

async function flushSessionStorage(): Promise<void> {
  const flush = (globalThis as SessionPersistenceGlobal).__gcFlushSessionStorage;
  if (typeof flush === "function") await flush();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse only the exact server-issued persisted slice. Invalid data must never create an optimistic session. */
export function parsePersistedSession(raw: string): PersistedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.refresh !== "string" || parsed.refresh.length === 0 || parsed.refresh.length > 4096) return null;
  const pendingRefresh = parsed.pendingRefresh;
  if (
    pendingRefresh !== undefined &&
    (typeof pendingRefresh !== "string" || !/^[0-9a-f]{96}$/.test(pendingRefresh) || pendingRefresh === parsed.refresh)
  ) return null;
  if (!isRecord(parsed.user)) return null;
  const { id, username, name } = parsed.user;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) return null;
  if (typeof username !== "string" || username.length === 0 || username.length > 128) return null;
  if (typeof name !== "string" || name.length > 512) return null;
  return {
    refresh: parsed.refresh,
    ...(typeof pendingRefresh === "string" ? { pendingRefresh } : {}),
    user: { id: Number(id), username, name },
  };
}

export function webSessionStorage(
  key = "gc.session",
  storageOverride?: WebSessionStorageArea,
): SessionStorage {
  const area = storageOverride ?? (() => {
    try { return typeof localStorage !== "undefined" ? localStorage : undefined; }
    catch { return undefined; }
  })();

  const removeCorrupt = (): void => {
    try { area?.removeItem(key); } catch { /* storage may be blocked */ }
  };

  return {
    load(): PersistedSession | null {
      if (!area) return null;
      try {
        const raw = area.getItem(key);
        if (!raw) return null;
        const parsed = parsePersistedSession(raw);
        if (parsed) return parsed;
        removeCorrupt();
        return null;
      } catch {
        return null;
      }
    },
    save(value: PersistedSession): void {
      if (!area) return;
      try { area.setItem(key, JSON.stringify(value)); } catch { /* quota / privacy mode */ }
    },
    clear(): void {
      if (!area) return;
      try { area.removeItem(key); } catch { /* ignore */ }
    },
    flush: flushSessionStorage,
  };
}

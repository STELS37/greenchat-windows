// SPDX-License-Identifier: AGPL-3.0-or-later
// Device-local decorative preferences only. No account data or OAuth credentials.
export const PREFERENCES_KEY = "gc.ui.effects.v1";
export const RIPPLE_COLORS = ["#32b88a", "#38bdf8", "#a78bfa", "#f472b6", "#fbbf24"] as const;
export interface Preferences {
  readonly version: 1;
  readonly rippleEnabled: boolean;
  readonly rippleColor: string;
  readonly reducedMotion: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  version: 1, rippleEnabled: false, rippleColor: RIPPLE_COLORS[0], reducedMotion: false,
});
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type PreferencePatch = Partial<Pick<Preferences, "rippleEnabled" | "rippleColor" | "reducedMotion">>;
/** Strict edit validator. Invalid edits are ignored, whereas corrupt stored values get a default. */
export function parseColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}
export function normalizeColor(value: unknown): string {
  return parseColor(value) ?? DEFAULT_PREFERENCES.rippleColor;
}
/** An older client may display defaults, but must never downgrade an explicitly different schema. */
function writableSnapshot(serialized: string | null): boolean {
  if (!serialized) return true;
  if (serialized.length > 1024) return false;
  try {
    const value: unknown = JSON.parse(serialized);
    return !value || typeof value !== "object" || Array.isArray(value) ||
      !("version" in value) || value.version === 1;
  } catch { return true; } // An explicit edit may repair a malformed legacy record.
}
export function decodePreferences(serialized: string | null): Preferences {
  if (!serialized || serialized.length > 1024) return DEFAULT_PREFERENCES;
  try {
    const v: unknown = JSON.parse(serialized);
    if (!v || typeof v !== "object" || Array.isArray(v)) return DEFAULT_PREFERENCES;
    const obj = v as Record<string, unknown>;
    if (obj.version !== 1) return DEFAULT_PREFERENCES;
    return Object.freeze({ version: 1, rippleEnabled: obj.rippleEnabled === true,
      rippleColor: normalizeColor(obj.rippleColor), reducedMotion: obj.reducedMotion === true });
  } catch { return DEFAULT_PREFERENCES; }
}
const same = (a: Preferences, b: Preferences): boolean =>
  a.rippleEnabled === b.rippleEnabled && a.rippleColor === b.rippleColor && a.reducedMotion === b.reducedMotion;
export type PersistenceIssue = "unavailable" | "incompatible" | null;
export interface PreferenceStore {
  get(): Preferences;
  /** Returns false if persistence failed. The preference still works for the current session. */
  update(patch: PreferencePatch): boolean;
  /** Reason for the last explicit save failure; never a claim of server synchronization. */
  persistenceIssue(): PersistenceIssue;
  /** Used for another window's storage event; MUST NOT write back and create an event loop. */
  receive(serialized: string | null): void;
  /** Re-read durable state on resume/storage events. Never writes; preserves unsaved local edits. */
  refreshFromStorage(): boolean;
  subscribe(listener: (value: Preferences) => void): () => void;
}
function applyPatch(base: Preferences, patch: PreferencePatch): Preferences {
  return Object.freeze({ version: 1 as const,
    rippleEnabled: typeof patch.rippleEnabled === "boolean" ? patch.rippleEnabled : base.rippleEnabled,
    rippleColor: patch.rippleColor === undefined ? base.rippleColor : normalizeColor(patch.rippleColor),
    reducedMotion: typeof patch.reducedMotion === "boolean" ? patch.reducedMotion : base.reducedMotion,
  });
}
function validPatch(patch: PreferencePatch): PreferencePatch {
  const color = parseColor(patch.rippleColor);
  return {
    ...(typeof patch.rippleEnabled === "boolean" ? { rippleEnabled: patch.rippleEnabled } : {}),
    ...(color === null ? {} : { rippleColor: color }),
    ...(typeof patch.reducedMotion === "boolean" ? { reducedMotion: patch.reducedMotion } : {}),
  };
}
export function createPreferenceStore(storage?: StoragePort): PreferenceStore {
  let value = DEFAULT_PREFERENCES;
  let persistenceIssue: PersistenceIssue = null;
  // Track intent by field, not as a complete stale snapshot: a quota error must not erase
  // the local color, nor should a color write turn off another window's accessibility setting.
  let pending: PreferencePatch = {};
  try { value = decodePreferences(storage?.getItem(PREFERENCES_KEY) ?? null); } catch { /* Storage may be denied. */ }
  const listeners = new Set<(v: Preferences) => void>();
  const commit = (next: Preferences): void => {
    if (same(value, next)) return;
    value = next;
    for (const listener of [...listeners]) {
      // A synchronous subscriber may make a newer edit; never publish the older snapshot after it.
      if (value !== next) break;
      if (listeners.has(listener)) listener(next);
    }
  };
  const receive = (raw: string | null): void => {
    // Keep the last usable view and unsaved edits when another client upgrades the format.
    if (writableSnapshot(raw)) commit(applyPatch(decodePreferences(raw), pending));
  };
  return {
    get: () => value,
    persistenceIssue: () => persistenceIssue,
    update(patch) {
      let base = value;
      let stored: string | null | undefined;
      try {
        if (storage) {
          stored = storage.getItem(PREFERENCES_KEY);
          if (writableSnapshot(stored)) base = decodePreferences(stored);
        }
      }
      catch { /* Without a readable baseline do not overwrite another window's durable choices. */ }
      pending = { ...pending, ...validPatch(patch) };
      const next = applyPatch(base, pending);
      let saved = false;
      persistenceIssue = stored !== undefined && !writableSnapshot(stored) ? "incompatible" : "unavailable";
      try {
        if (storage && stored !== undefined && writableSnapshot(stored)) {
          const serialized = JSON.stringify(next);
          if (stored !== serialized) storage.setItem(PREFERENCES_KEY, serialized);
          saved = true; pending = {}; persistenceIssue = null;
        }
      } catch { /* Retry only the unsaved fields on a later explicit update. */ }
      commit(next);
      return saved;
    },
    receive,
    refreshFromStorage() {
      if (!storage) return false;
      try { receive(storage.getItem(PREFERENCES_KEY)); return true; }
      catch { return false; }
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

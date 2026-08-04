// T-530 local screenshot/task-switcher preference. Only a native shell exposing the bridge receives
// the Settings row; PWA/desktop return null instead of presenting a control that cannot affect the OS.
import type { ScreenPrivacyPort } from "../../ui/src/screens/settings_screen.ts";

const STORAGE_KEY = "gc.screen_privacy.v1";

export interface NativeScreenPrivacyBridge {
  setSecureScreen(enabled: boolean): Promise<void>;
}

export interface ScreenPrivacyStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type PrivacyWindow = Window & { __gcScreenPrivacy?: NativeScreenPrivacyBridge };

function readPreference(storage: ScreenPrivacyStorage): boolean {
  try { return storage.getItem(STORAGE_KEY) === "1"; } catch { return false; }
}

function writePreference(storage: ScreenPrivacyStorage, enabled: boolean): void {
  if (enabled) storage.setItem(STORAGE_KEY, "1");
  else storage.removeItem(STORAGE_KEY);
}

export function createScreenPrivacyPort(
  native: NativeScreenPrivacyBridge,
  storage: ScreenPrivacyStorage,
): ScreenPrivacyPort {

  let transitionTail: Promise<void> = Promise.resolve();

  const apply = async (enabled: boolean): Promise<void> => {
    const previous = readPreference(storage);
    try {
      writePreference(storage, enabled);
      await native.setSecureScreen(enabled);
    } catch (error) {
      try { writePreference(storage, previous); } catch { /* preserve original failure */ }
      try { await native.setSecureScreen(previous); } catch { /* best-effort native rollback */ }
      throw error;
    }
  };
  return {
    async get(): Promise<boolean> {
      return readPreference(storage);
    },
    set(enabled: boolean): Promise<void> {
      const operation = transitionTail.then(() => apply(enabled));
      transitionTail = operation.catch(() => undefined);
      return operation;
    },
  };
}

export function webScreenPrivacyPort(): ScreenPrivacyPort | null {
  const native = (window as PrivacyWindow).__gcScreenPrivacy;
  if (!native) return null;
  let storage: ScreenPrivacyStorage;
  try { storage = localStorage; } catch { return null; }
  return createScreenPrivacyPort(native, storage);
}

import type { AutoDownloadPolicy } from "./media_model.ts";

export interface AccountMediaSettingsDeps {
  loadSettings(): Promise<Record<string, unknown>>;
  onCurrentSettled?(): void | Promise<void>;
}

export interface AccountMediaSettings {
  load(): Promise<void>;
  reset(): void;
  policy(): AutoDownloadPolicy;
}

export function createAccountMediaSettings(deps: AccountMediaSettingsDeps): AccountMediaSettings {
  let settings: Record<string, unknown> = {};
  let generation = 0;

  return {
    async load(): Promise<void> {
      const mine = ++generation;
      try {
        const loaded = await deps.loadSettings();
        if (mine !== generation) return;
        settings = loaded;
      } catch {
        if (mine !== generation) return;
        // Keep the last known/default policy for the current account.
      }
      if (mine === generation) await deps.onCurrentSettled?.();
    },
    reset(): void {
      generation += 1;
      settings = {};
    },
    policy(): AutoDownloadPolicy {
      const value = settings["autodownload"];
      return value === "all" || value === "none" || value === "wifi" ? value : "wifi";
    },
  };
}

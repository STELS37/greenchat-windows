// clients/ui/src/screens/settings_model.ts — the M0 user-settings keys, mirrored from the server (T-405).
// Source of truth: server/src/modules/users.ts SETTINGS_SPEC. GET /v1/users/me/settings returns
// {settings:{...}} (effective = stored ∪ defaults); PATCH merges per key (null deletes → default).
// DOM-free → unit-tested against the exact spec. UI is decoupled from the concrete server validators.
import type { SettingsMap } from "./types.ts";

export type SettingKind = "enum" | "bool";

export interface SettingItem {
  key: string;
  kind: SettingKind;
  def: string | boolean;
  options?: readonly string[];
}

// Order = how the screen lists them; options/def copied verbatim from SETTINGS_SPEC.
export const SETTINGS_ITEMS: SettingItem[] = [
  { key: "ui_theme", kind: "enum", options: ["system", "light", "dark"], def: "system" },
  { key: "autodownload", kind: "enum", options: ["all", "wifi", "none"], def: "wifi" },
  { key: "show_sensitive", kind: "enum", options: ["on", "off"], def: "off" },
  { key: "notify_reactions", kind: "enum", options: ["dialogs", "off"], def: "dialogs" },
  { key: "mention_breaks_mute", kind: "bool", def: true },
];

const BY_KEY = new Map(SETTINGS_ITEMS.map((i) => [i.key, i]));

export function settingDefault(key: string): string | boolean | undefined {
  return BY_KEY.get(key)?.def;
}

// Coerce the effective settings object into strongly-typed row values, falling back to each key's default
// when the server omitted it or sent an unexpected type (defensive — the effective map should be complete).
export function settingValue(map: SettingsMap, item: SettingItem): string | boolean {
  const v = map[item.key];
  if (item.kind === "bool") return typeof v === "boolean" ? v : (item.def as boolean);
  return typeof v === "string" ? v : (item.def as string);
}

// ---- T-531 (DS-13): notification display mode — CLIENT-LOCAL, deliberately NOT in SETTINGS_ITEMS ----
// «Что показывать в уведомлении»: full (как прислал сервер) / name (только имя) / generic (без имени и
// текста). This key never goes to the server (no SETTINGS_SPEC entry, no PATCH): the shell persists it
// where the SERVICE WORKER can read it with every page closed (web: gc-diag IndexedDB kv "notify_mode").
// Values/default MIRROR clients/core/src/notify_render.ts (ui does not import core — same convention as
// server_model.ts); the parity is pinned by ui/test/settings_model.test.ts.
export const NOTIFY_MODE_ITEM: SettingItem = {
  key: "notify_mode",
  kind: "enum",
  options: ["full", "name", "generic"],
  def: "full", // safe: without the server-side notify_preview opt-in no text arrives in pushes at all
};

export function normalizeNotifyModeValue(v: unknown): string {
  return typeof v === "string" && (NOTIFY_MODE_ITEM.options as readonly string[]).includes(v)
    ? v
    : (NOTIFY_MODE_ITEM.def as string);
}


// ---- V155: interface language — CLIENT-LOCAL, deliberately NOT in SETTINGS_ITEMS ----------------
// The language of the interface is the user's own choice and must be changeable ON THE DEVICE, by
// tapping — measured before this change (probes/hunt2.mjs, 390x844): 7 settings sections, 22 rows, zero
// of them about language; the one existing switch was a Ctrl+K palette command, i.e. keyboard-only.
// The key is NOT server-backed (no SETTINGS_SPEC entry, no PATCH): the interface has to be readable
// before the first request answers, on a fresh install and while offline, so the shell persists it
// locally (web: localStorage "gc.lang"). Values/default MIRROR clients/ui/src/lang.ts LANG_PREFS —
// the parity is pinned by ui/test/settings_model.test.ts.
export const UI_LANG_ITEM: SettingItem = {
  key: "ui_lang",
  kind: "enum",
  options: ["system", "ru", "en"],
  def: "system", // follow the platform languages until the user says otherwise
};

export function normalizeUiLangValue(v: unknown): string {
  return typeof v === "string" && (UI_LANG_ITEM.options as readonly string[]).includes(v)
    ? v
    : (UI_LANG_ITEM.def as string);
}


// ---- T-530 (DS-12): screenshot/task-switcher protection — CLIENT-LOCAL ---------------------------
// Default OFF for ordinary chats per DEVICE_SECURITY §13.2. Native shells may force the same platform
// control for future secret/hidden screens; this preference only controls the ordinary-screen baseline.
export const SCREEN_PRIVACY_ITEM: SettingItem = {
  key: "screen_privacy",
  kind: "bool",
  def: false,
};

export function normalizeScreenPrivacyValue(value: unknown): boolean {
  return value === true;
}

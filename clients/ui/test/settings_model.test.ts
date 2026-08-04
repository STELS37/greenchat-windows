import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_ITEMS,
  settingDefault,
  settingValue,
} from "../src/screens/settings_model.ts";

test("SETTINGS_ITEMS: covers exactly the 5 M0 keys", () => {
  const keys = SETTINGS_ITEMS.map((i) => i.key);
  assert.deepEqual([...keys].sort(), [
    "autodownload",
    "mention_breaks_mute",
    "notify_reactions",
    "show_sensitive",
    "ui_theme",
  ]);
});

test("settingDefault: mirrors the server spec", () => {
  assert.equal(settingDefault("ui_theme"), "system");
  assert.equal(settingDefault("autodownload"), "wifi");
  assert.equal(settingDefault("show_sensitive"), "off");
  assert.equal(settingDefault("notify_reactions"), "dialogs");
  assert.equal(settingDefault("mention_breaks_mute"), true);
  assert.equal(settingDefault("nope"), undefined);
});

test("settingValue: reads typed values, falls back to default on absence/wrong type", () => {
  const themeItem = SETTINGS_ITEMS.find((i) => i.key === "ui_theme")!;
  const boolItem = SETTINGS_ITEMS.find((i) => i.key === "mention_breaks_mute")!;
  assert.equal(settingValue({ ui_theme: "dark" }, themeItem), "dark");
  assert.equal(settingValue({}, themeItem), "system", "missing → default");
  assert.equal(settingValue({ ui_theme: 5 }, themeItem), "system", "wrong type → default");
  assert.equal(settingValue({ mention_breaks_mute: false }, boolItem), false);
  assert.equal(settingValue({}, boolItem), true, "missing bool → default");
});

// ---- T-531 (DS-13): the local notification display mode ------------------------------------------
// The ui model mirrors clients/core/src/notify_render.ts instead of importing it (ui src stays
// core-free, same convention as server_model.ts) — this parity test is what keeps the mirror honest.
import {
  NOTIFY_MODE_ITEM,
  normalizeNotifyModeValue,
  SCREEN_PRIVACY_ITEM,
  normalizeScreenPrivacyValue,
} from "../src/screens/settings_model.ts";
import { NOTIFY_MODES, NOTIFY_MODE_DEFAULT, normalizeNotifyMode } from "../../core/src/notify_render.ts";

test("notify_mode: CLIENT-LOCAL — never part of the server-mirrored SETTINGS_ITEMS", () => {
  assert.ok(!SETTINGS_ITEMS.some((i) => i.key === "notify_mode"), "notify_mode must not be PATCHed to the server");
  assert.equal(NOTIFY_MODE_ITEM.key, "notify_mode");
  assert.equal(NOTIFY_MODE_ITEM.kind, "enum");
});

test("notify_mode: options and default mirror core notify_render exactly", () => {
  assert.deepEqual(NOTIFY_MODE_ITEM.options, NOTIFY_MODES);
  assert.equal(NOTIFY_MODE_ITEM.def, NOTIFY_MODE_DEFAULT);
  for (const v of [...NOTIFY_MODES, "junk", "", undefined, null, 5]) {
    assert.equal(normalizeNotifyModeValue(v), normalizeNotifyMode(v), `normalize parity for ${String(v)}`);
  }
});


test("screen_privacy: CLIENT-LOCAL, absent from server settings, and OFF by default for ordinary chats", () => {
  assert.ok(!SETTINGS_ITEMS.some((i) => i.key === "screen_privacy"));
  assert.equal(SCREEN_PRIVACY_ITEM.key, "screen_privacy");
  assert.equal(SCREEN_PRIVACY_ITEM.kind, "bool");
  assert.equal(SCREEN_PRIVACY_ITEM.def, false);
  assert.equal(normalizeScreenPrivacyValue(true), true);
  for (const value of [false, "true", 1, null, undefined]) {
    assert.equal(normalizeScreenPrivacyValue(value), false);
  }
});

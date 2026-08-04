import test from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createSettingsScreen, type DesktopSystemPort } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class Api implements ApiLike {
  writes: string[] = [];
  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me") return Promise.resolve({ id: 1, username: "owner", name: "Owner" } as T);
    if (path === "/v1/users/me/settings") return Promise.resolve({ settings: {} } as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> { this.writes.push(`POST ${path}`); return Promise.resolve(null as T); }
  put<T>(path: string): Promise<T> { this.writes.push(`PUT ${path}`); return Promise.resolve(null as T); }
  patch<T>(path: string): Promise<T> { this.writes.push(`PATCH ${path}`); return Promise.resolve(null as T); }
  delete<T>(path: string): Promise<T> { this.writes.push(`DELETE ${path}`); return Promise.resolve(null as T); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function row(root: StubNode, label: string): StubNode {
  const found = root.find((node) => node.tag === "label" && node.textContent.includes(label));
  assert.ok(found, `row ${label} missing from ${root.textContent}`);
  return found;
}

test("desktop system rows are local-only and mutate the native port", async () => {
  const api = new Api();
  const mutations: Array<[string, boolean]> = [];
  const desktopSystem: DesktopSystemPort = {
    getNotifications: async () => false,
    setNotifications: async (enabled) => { mutations.push(["notifications", enabled]); },
    getAutostart: async () => false,
    setAutostart: async (enabled) => { mutations.push(["autostart", enabled]); },
  };
  const screen = createSettingsScreen({ api, i18n, onBack() {}, desktopSystem });
  const root = screen.root as unknown as StubNode;
  root.find((node) => node.attrs["data-tab"] === "settings")?.click();
  await settle();

  const notifications = row(root, en["settings.desktopNotifications"]);
  const notifySelect = notifications.find((node) => node.tag === "select");
  assert.ok(notifySelect);
  notifySelect.value = "true";
  notifySelect.dispatch("change");
  await settle();

  const autostart = row(root, en["settings.desktopAutostart"]);
  const autostartSelect = autostart.find((node) => node.tag === "select");
  assert.ok(autostartSelect);
  autostartSelect.value = "true";
  autostartSelect.dispatch("change");
  await settle();

  assert.deepEqual(mutations, [["notifications", true], ["autostart", true]]);
  assert.deepEqual(api.writes, [], "desktop toggles must never PATCH account settings");
  screen.destroy();
});

test("web/mobile Settings omits desktop operating-system controls", async () => {
  const api = new Api();
  const screen = createSettingsScreen({ api, i18n, onBack() {} });
  const root = screen.root as unknown as StubNode;
  root.find((node) => node.attrs["data-tab"] === "settings")?.click();
  await settle();
  assert.equal(root.textContent.includes(en["settings.desktopNotifications"]), false);
  assert.equal(root.textContent.includes(en["settings.desktopAutostart"]), false);
  screen.destroy();
});

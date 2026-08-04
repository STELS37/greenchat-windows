import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { deferred, installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class SettingsApi implements ApiLike {
  readonly profile = deferred<unknown>();
  readonly settings = deferred<unknown>();
  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me") return this.profile.promise as Promise<T>;
    if (path === "/v1/users/me/settings")
      return this.settings.promise as Promise<T>;
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected POST"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

test("settings ignores a profile response after the user switched tabs", async () => {
  const api = new SettingsApi();
  const view = createSettingsScreen({ api, i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  const settingsTab = root.find(
    (node) =>
      node.tag === "button" &&
      node.textContent === i18n.t("settings.tabSettings"),
  );
  assert.ok(settingsTab);
  settingsTab.dispatch("click");

  api.settings.resolve({ settings: {} });
  await settle();
  // The race is about the shared PANEL: both sections paint into the same node, so a late response
  // from the section the user already left must not overwrite the section they are looking at. The
  // index above the panel is a different surface — the account card there answers the same
  // /v1/users/me and is *supposed* to show the handle whichever section happens to be open — so the
  // assertion is scoped to the panel instead of to the whole screen.
  const panel = root.find((node) => node.className.includes("gc-settings-panel"));
  assert.ok(panel, "the settings panel must exist");
  const settingsText = panel.textContent;
  assert.ok(settingsText.includes(i18n.t("settings.key.autodownload")));

  api.profile.resolve({
    id: 1,
    username: "lateprofile",
    name: "Late Profile",
    bio: "stale response",
    display_currency: "USD",
  });
  await settle();

  assert.equal(
    panel.textContent.includes("@lateprofile"),
    false,
    "the old tab may not repaint the shared panel",
  );
  assert.equal(panel.textContent, settingsText);
  view.destroy();
});

test("re-entering Settings returns to the section index instead of a dead-end section", async () => {
  const api = new SettingsApi();
  const view = createSettingsScreen({ api, i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  const privacyTab = root.find(
    (node) => node.tag === "button" && node.textContent === i18n.t("settings.tabPrivacy"),
  );
  assert.ok(privacyTab, "the index must offer the privacy section");
  privacyTab.dispatch("click");

  const index = root.find((node) => node.className.includes("gc-settings-index"));
  assert.ok(index, "the section index must exist");
  const hidden = (node: StubNode): boolean => (node as unknown as { hidden?: boolean }).hidden === true;
  assert.equal(hidden(index), true, "opening a section hides the index");

  // Settings is a drill-down, and the shell never rebuilds a screen that is already mounted. Without
  // reset(), a user who left Settings inside a section (and then pressed the Settings tab again) came
  // back to that section with no way to see the other ones — the screen looked like it had lost its
  // navigation. Every mainstream messenger pops to the root when the active tab is pressed again.
  view.reset();
  assert.equal(hidden(index), false, "re-entering Settings shows the section index");

  const panel = root.find((node) => node.className.includes("gc-settings-panel"));
  assert.ok(panel);
  assert.equal(hidden(panel), true, "no section stays open behind the index");
  assert.equal(panel.textContent, "", "the closed section leaves no stale content");

  // Idempotent: pressing the tab while the index is already showing must not cost a repaint.
  view.reset();
  assert.equal(hidden(index), false);
  view.destroy();
});

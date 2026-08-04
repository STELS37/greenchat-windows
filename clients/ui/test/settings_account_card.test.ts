// The settings INDEX used to open on seven identical grey rows: "Профиль", "Настройки",
// "Приватность"… A messenger's settings screen belongs to a person, and every mainstream client
// states whose account it is at the top — picture, name, handle — before offering any section.
// Without it the screen reads as a table of contents belonging to nobody, which was the single most
// dated thing left on that route.
//
// Three properties are pinned here because each one is a way the card could quietly rot:
//   1. it states the identity (monogram + name + @handle) once /v1/users/me answers;
//   2. it is a shortcut into the section the first row already opens — not a new destination;
//   3. an unreachable /v1/users/me removes the card instead of turning a list of sections that all
//      work offline into an error screen.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const ME = {
  id: 7,
  username: "ann",
  name: "Анна Ветрова",
  bio: "",
  display_currency: "USD",
};

class MeApi implements ApiLike {
  // Written as an explicit field: node --test runs these files in strip-only TypeScript mode,
  // which rejects constructor parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly me: unknown;
  constructor(me: unknown) {
    this.me = me;
  }
  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me") {
      return this.me === null
        ? Promise.reject(new Error("offline"))
        : (Promise.resolve(this.me) as Promise<T>);
    }
    if (path === "/v1/users/me/settings") return Promise.resolve({ settings: {} } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const card = (root: StubNode): StubNode | null =>
  root.find((node) => node.className.includes("gc-account-card") && node.tag === "button");

test("the settings index names the account it belongs to", async () => {
  const view = createSettingsScreen({ api: new MeApi(ME), i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  await settle();

  const account = card(root);
  assert.ok(account, "the settings index must carry an account card");
  const text = account.textContent;
  assert.ok(text.includes("Анна Ветрова"), `name missing from the card: ${text}`);
  assert.ok(text.includes("@ann"), `handle missing from the card: ${text}`);
  // The monogram is the same deterministic one the chat list and the conversation header draw, so a
  // person looks identical wherever they appear.
  assert.ok(text.includes("АВ"), `monogram missing from the card: ${text}`);
  view.destroy();
});

test("the account card is a shortcut into the profile section, not a new screen", async () => {
  const view = createSettingsScreen({ api: new MeApi(ME), i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  await settle();

  const account = card(root);
  assert.ok(account);
  account.dispatch("click");
  await settle();

  // Opening a section hides the index and paints the panel — the same transition the "Profile" row
  // performs. The section title moves into the header.
  const header = root.find((node) => node.className.includes("gc-settings-title"));
  assert.ok(header);
  assert.equal(header.textContent, i18n.t("settings.tabProfile"));
  const panel = root.find((node) => node.className.includes("gc-settings-panel"));
  assert.ok(panel);
  assert.ok(panel.textContent.includes("@ann"), "the profile section itself must have rendered");
  view.destroy();
});

test("an unreachable profile endpoint drops the card and leaves the sections usable", async () => {
  const view = createSettingsScreen({ api: new MeApi(null), i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  await settle();

  assert.equal(card(root), null, "a failed identity probe must not leave a placeholder card");
  // The list is unaffected: every section is still one tap away.
  const sections = root.find((node) => node.className.includes("gc-settings-nav"));
  assert.ok(sections);
  assert.ok(sections.textContent.includes(i18n.t("settings.tabPrivacy")));
  assert.ok(sections.textContent.includes(i18n.t("settings.tabLicenses")));
  view.destroy();
});

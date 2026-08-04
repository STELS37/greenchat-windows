// V179: the profile @username used to be a selectable <div>. On Android a tap/hold opened the
// platform Copy / Share / Select-all toolbar, so the product made the user perform a text-selection
// gesture for an action that should take one tap. The handle is now one accessible button that copies
// exactly the visible @username and remains the only title when the account has no display name.
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

class ProfileApi implements ApiLike {
  private readonly name: string;
  constructor(name: string) { this.name = name; }

  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me") {
      return Promise.resolve({
        id: 7,
        username: "owner",
        name: this.name,
        bio: "",
        display_currency: "USD",
      } as T);
    }
    if (path === "/v1/users/me/settings") return Promise.resolve({ settings: {} } as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const openProfile = async (name: string, copied: string[]): Promise<{ view: ReturnType<typeof createSettingsScreen>; root: StubNode }> => {
  const view = createSettingsScreen({
    api: new ProfileApi(name),
    i18n,
    onBack() {},
    copyText: async (text) => { copied.push(text); },
  });
  const root = view.root as unknown as StubNode;
  await settle();
  const account = root.find((node) => node.tag === "button" && node.hasClass("gc-account-card"));
  assert.ok(account, "the account card must open Profile");
  account.dispatch("click");
  await settle();
  return { view, root };
};

test("one tap on the profile @username copies exactly the visible handle", async () => {
  const copied: string[] = [];
  const { view, root } = await openProfile("Admin", copied);

  const handle = root.find((node) => node.tag === "button" && node.hasClass("gc-profile-username"));
  assert.ok(handle, "the profile handle must be a button, not selectable text");
  assert.equal(handle.textContent, "@owner");
  assert.equal(handle.attrs["aria-label"], i18n.t("settings.copyUsername", { username: "@owner" }));

  handle.dispatch("click");
  await settle();
  assert.deepEqual(copied, ["@owner"]);
  const status = root.find((node) => node.tag === "p" && node.hasClass("gc-settings-status"));
  assert.ok(status?.textContent.includes(i18n.t("feed.copied")));
  view.destroy();
});

test("an account without a display name shows one copyable handle, not two duplicate lines", async () => {
  const copied: string[] = [];
  const { view, root } = await openProfile("", copied);
  const handles = root.findAll((node) => node.hasClass("gc-profile-username"));
  assert.equal(handles.length, 1);
  assert.equal(handles[0]?.tag, "button");
  assert.equal(handles[0]?.textContent, "@owner");
  assert.equal(handles[0]?.hasClass("gc-profile-heroname"), true, "the copy control becomes the hero title");
  view.destroy();
});

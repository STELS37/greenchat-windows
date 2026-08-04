// A tab destination has no "back".
//
// The shell paints a tab bar under every root screen — Чаты, Звонки, Кошелёк, Биржа, Ещё. Each of
// those screens also drew a back arrow in its own top-left corner, inherited from the days when they
// were pushed one on top of another. On a phone that arrow is worse than redundant: it points at
// nothing the user asked for (it silently jumped to the chat list), it steals the corner where a
// title belongs, and it is the single clearest "this app is a stack of web pages" signal left in the
// chrome. Measured on the running client (route probe, 2026-07-29): /calls and /wallet both exposed
// an aria-label="Back" control while their tab was the active one in the bar below.
//
// Settings is the one screen where the arrow keeps a job, because it is a drill-down: hidden on the
// section index, shown inside a section, where it means "up to the index".
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createCallsScreen } from "../src/screens/calls_screen.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class QuietApi implements ApiLike {
  get<T>(): Promise<T> {
    return Promise.reject(new Error("offline"));
  }
  post<T>(): Promise<T> {
    return Promise.reject(new Error("offline"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("offline"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("offline"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("offline"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

const backControls = (root: StubNode): StubNode[] =>
  root.findAll(
    (node) =>
      node.tag === "button" &&
      (node.attrs["aria-label"] === i18n.t("common.back") ||
        node.attrs.title === i18n.t("common.back")),
  );

test("Calls drops its back arrow when it is mounted as a shell tab", async () => {
  const pushed = createCallsScreen({
    api: new QuietApi(),
    i18n,
    onBack() {},
    onOpenChat() {},
  });
  await settle();
  assert.equal(
    backControls(pushed.root as unknown as StubNode).length,
    1,
    "a pushed Calls screen still needs a way back",
  );
  pushed.destroy();

  const rooted = createCallsScreen({
    api: new QuietApi(),
    i18n,
    atShellRoot: true,
    onBack() {},
    onOpenChat() {},
  });
  await settle();
  assert.equal(
    backControls(rooted.root as unknown as StubNode).length,
    0,
    "a tab destination must not offer a back arrow: the tab bar is the way out",
  );
  rooted.destroy();
});

test("Settings hides the arrow on its index and shows it inside a section", async () => {
  const view = createSettingsScreen({
    api: new QuietApi(),
    i18n,
    atShellRoot: true,
    onBack() {},
  });
  const root = view.root as unknown as StubNode;
  await settle();
  const back = backControls(root)[0];
  assert.ok(back, "the control exists; only its visibility changes");
  const hidden = (node: StubNode): boolean =>
    (node as unknown as { hidden?: boolean }).hidden === true;
  assert.equal(hidden(back), true, "the section index is a tab destination: no arrow");

  const privacy = root.find(
    (node) => node.tag === "button" && node.textContent === i18n.t("settings.tabPrivacy"),
  );
  assert.ok(privacy, "the index must offer the privacy section");
  privacy.dispatch("click");
  await settle();
  assert.equal(hidden(back), false, "inside a section the arrow is the only way up");

  view.reset();
  assert.equal(hidden(back), true, "returning to the index hides it again");
  view.destroy();
});

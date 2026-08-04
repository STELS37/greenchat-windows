// A chat list header is a name, not a toolbar.
//
// Before V6 the header of the chat list lined up five 44 px icon buttons next to the screen title:
// plus, help, lock, settings, logout. On a 360 px phone that is ~220 px of chrome fighting the title
// for the same row, and four of the five pointed at destinations the tab bar and Settings already
// own. It is also the loudest "this is a 2000s web toolbar" signal left in the app: no mainstream
// messenger puts logout one stray tap away from the conversation list.
//
// V6 keeps exactly one affordance in that corner — an overflow "⋮" menu holding the system actions —
// and promotes the single action a chat list exists for, "new chat", to a floating action button over
// the list, inside the thumb zone. This test locks both halves so the toolbar cannot creep back.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createChatListScreen } from "../src/screens/chat_list_screen.ts";
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

// An account that answers — and has nothing. This is the only state allowed to say «no chats yet».
class EmptyAccountApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/badge")) return Promise.resolve({ total_unread: 0 } as unknown as T);
    return Promise.resolve([] as unknown as T);
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function mount(extra: Partial<Parameters<typeof createChatListScreen>[0]> = {}) {
  return createChatListScreen({
    api: new QuietApi(),
    i18n,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 1, name: "Owner", username: "owner" },
    now: () => 1_700_000_000,
    ...extra,
  });
}

function all(root: StubNode, cls: string): StubNode[] {
  return root.findAll((node) => node.hasClass(cls));
}

test("the header keeps one action button and new chat is a floating button", async () => {
  const screen = mount({ onOpenSupport: () => {}, onLock: () => {} });
  await settle();
  const root = screen.root as unknown as StubNode;

  const actions = all(root, "gc-chats-actions");
  assert.equal(actions.length, 1, "the header still has its action slot");
  const buttons = actions[0]!.children;
  assert.equal(buttons.length, 1, "exactly one affordance in the header corner, not five");
  assert.equal(buttons[0]!.attrs["aria-haspopup"], "menu", "and it opens a menu");

  const fabs = all(root, "gc-fab");
  assert.equal(fabs.length, 1, "new chat is a floating action button");
  assert.equal(fabs[0]!.attrs["aria-label"], i18n.t("chatList.newChat"));
  screen.destroy();
});

test("the overflow menu carries logout even when help and lock are not wired", async () => {
  const screen = mount();
  await settle();
  const root = screen.root as unknown as StubNode;
  const trigger = all(root, "gc-chats-actions")[0]!.children[0]!;
  trigger.dispatch("click");
  await settle();

  // The menu mounts into the screen root (host: root), so its labels are reachable from here.
  const text = root.textContent;
  assert.ok(text.includes(i18n.t("auth.logout")), "logout stays reachable after the toolbar is gone");
  assert.ok(text.includes(i18n.t("common.settings")), "settings stays reachable");
  assert.ok(!text.includes(i18n.t("support.help")), "help is absent when the shell did not wire it");
  screen.destroy();
});

// The Telegram import (T-417) used to hang off the desktop-only placeholder panel and the command
// palette. A phone reached neither, so on the one device this app is actually installed on, the
// migration flow had no entry point at all. It belongs in the overflow menu, which every width has.
test("the overflow menu is where a phone reaches the Telegram import", async () => {
  const withImport = mount({ onOpenImport: () => {} });
  await settle();
  const root = withImport.root as unknown as StubNode;
  all(root, "gc-chats-actions")[0]!.children[0]!.dispatch("click");
  await settle();
  assert.ok(root.textContent.includes(i18n.t("shell.import")), "import is reachable from the list header");
  withImport.destroy();

  // …and it stays absent when the shell did not wire an importer, so the menu never advertises a
  // destination that cannot answer.
  const without = mount();
  await settle();
  const bare = without.root as unknown as StubNode;
  all(bare, "gc-chats-actions")[0]!.children[0]!.dispatch("click");
  await settle();
  assert.ok(!bare.textContent.includes(i18n.t("shell.import")), "no import entry without an importer");
  without.destroy();
});

// V187 adds two useful first-frame system destinations (Support and Bot Center) even when the server
// returns zero ordinary chats. That is a populated list, not an empty account screen: showing the old
// full-width «start first chat» invitation as well would lie about what is visible and duplicate the FAB.
test("a fresh account with system destinations shows the FAB, not a false empty-state CTA", async () => {
  const screen = mount({ api: new EmptyAccountApi() });
  await settle();
  const root = screen.root as unknown as StubNode;
  const fab = all(root, "gc-fab")[0]!;
  const empty = all(root, "gc-chats-empty")[0]!;

  assert.equal(empty.style.display, "none", "system destinations make the All list genuinely populated");
  assert.notEqual(fab.style.display, "none", "the one new-chat action remains the floating button");
  screen.destroy();
});

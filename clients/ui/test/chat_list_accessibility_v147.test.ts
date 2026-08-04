// V147 regression guard — the visible chat collection must announce the active filter.
//
// Device evidence (signed Android APK 1000015, redroid Android 15, ru-RU, system font 2.0,
// 320x640 CSS px, CDP Accessibility tree, 2026-08-03): after activating «Архив» the selected tab
// changed correctly, but `.gc-chat-list` remained `aria-label="Все"`. With an archived row present a
// screen-reader therefore announces the archived collection as the all-chats collection.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createChatListScreen } from "../src/screens/chat_list_screen.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const archived: ChatEntry = {
  id: 147,
  kind: "dialog",
  title: "Архивный диалог",
  username: "archive",
  photo_file_id: null,
  last_message: {
    id: 1,
    sender_id: 2,
    kind: "text",
    text: "Сохранённое сообщение",
    created_at: 1_700_000_000,
  },
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: true,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: 1_700_000_000,
};

class ArchivedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/badge")) {
      return Promise.resolve({ total_unread: 0, unread_chats: 0, mentions: 0 } as T);
    }
    return Promise.resolve([archived] as T);
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

test("V147: the chat list accessible name follows the selected tab", async () => {
  const screen = createChatListScreen({
    api: new ArchivedApi(),
    i18n,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 1, name: "Владелец", username: "owner" },
    now: () => 1_700_000_100,
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  const tabs = root.findAll((node) => node.hasClass("gc-tab"));
  const archiveTab = tabs.find((node) => node.textContent.includes(i18n.t("chat.tabArchived")));
  assert.ok(archiveTab, "the archive tab exists");
  archiveTab.dispatch("click");

  const list = root.findAll((node) => node.hasClass("gc-chat-list"))[0];
  assert.ok(list, "the archived collection is rendered");
  assert.equal(list.style.display, "block", "the fixture proves the list is exposed, not a hidden empty panel");
  assert.equal(list.attrs["aria-label"], i18n.t("chat.tabArchived"));
  screen.destroy();
});

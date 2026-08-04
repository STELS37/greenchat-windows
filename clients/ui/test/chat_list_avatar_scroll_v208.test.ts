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
const NOW = 1_700_000_000;
const VIEWPORT = 288;

const chats: ChatEntry[] = Array.from({ length: 24 }, (_value, index) => ({
  id: index + 1,
  kind: "dialog",
  title: index < 2 ? `Фото ${index + 1}` : `Контакт ${index + 1}`,
  username: `peer${index + 1}`,
  photo_file_id: index < 2 ? index + 101 : null,
  last_message: {
    id: 1000 + index,
    sender_id: index + 2,
    kind: "text",
    text: `Сообщение ${index + 1}`,
    created_at: NOW - index,
  },
  unread_count: 0,
  muted_until: 0,
  pinned: false,
  archived: false,
  my_role: "member",
  message_ttl_sec: 0,
  draft: null,
  updated_at: NOW - index,
}));

class AvatarApi implements ApiLike {
  signedCalls = 0;

  get<T>(path: string): Promise<T> {
    if (path === "/v1/chats?filter=all") return Promise.resolve(chats as T);
    if (path === "/v1/badge") {
      return Promise.resolve({ total_unread: 0, unread_chats: 0, mentions: 0 } as T);
    }
    const match = /^\/v1\/files\/(\d+)\/url$/.exec(path);
    if (match) {
      this.signedCalls += 1;
      return Promise.resolve({ url: `/avatar-${match[1]}.png`, expires_at: NOW + 300 } as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const frame = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

const findRow = (root: StubNode, title: string): StubNode => {
  const row = root.findAll((node) => node.hasClass("gc-chat-row"))
    .find((node) => node.textContent.includes(title));
  assert.ok(row, `row ${title} is rendered`);
  return row;
};

test("V208: chat avatars stay decoded when the virtual list scrolls away and back", async () => {
  const api = new AvatarApi();
  const screen = createChatListScreen({
    api,
    i18n,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 999, name: "Владелец", username: "owner" },
    now: () => NOW,
  });
  await settle();

  const root = screen.root as unknown as StubNode;
  const list = root.findAll((node) => node.hasClass("gc-chat-list"))[0]!;
  list.clientHeight = VIEWPORT;
  list.dispatch("scroll");
  await frame();
  await settle();

  const firstRow = findRow(root, "Фото 1");
  const firstImage = firstRow.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo"));
  assert.ok(firstImage, "the signed avatar request mounts its image");
  firstImage.dispatch("load");
  await settle();
  assert.equal(firstImage.hidden, false);
  assert.equal(api.signedCalls, 2, "only the two visible photo rows request signed URLs");

  list.scrollTop = 12 * 72;
  list.dispatch("scroll");
  await frame();
  assert.equal(root.findAll((node) => node.hasClass("gc-chat-row")).some((row) => row === firstRow), false);

  list.scrollTop = 0;
  list.dispatch("scroll");
  await frame();
  await settle();

  const restoredRow = findRow(root, "Фото 1");
  const restoredImage = restoredRow.find((node) => node.tag === "img" && node.hasClass("gc-avatar-photo"));
  assert.equal(restoredRow, firstRow, "the virtualiser reuses the exact row DOM");
  assert.equal(restoredImage, firstImage, "the decoded image is preserved instead of flashing initials");
  assert.equal(restoredImage?.hidden, false);
  assert.equal(api.signedCalls, 2, "scrolling back does not re-request signed avatar URLs");

  screen.destroy();
});

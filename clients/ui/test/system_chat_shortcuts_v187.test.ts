import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import {
  SYSTEM_BOT_CENTER_SHORTCUT_ID,
  SYSTEM_CHAT_SHORTCUT_KIND,
  SYSTEM_SUPPORT_SHORTCUT_ID,
  withSystemChatShortcuts,
} from "../src/screens/chat_list_screen.ts";

const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

function chat(over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 1,
    kind: "dialog",
    title: "Обычный чат",
    username: "ordinary",
    photo_file_id: null,
    peer_is_bot: false,
    last_message: { id: 10, sender_id: 2, kind: "text", text: "Привет", created_at: 100 },
    unread_count: 0,
    muted_until: 0,
    pinned: false,
    archived: false,
    my_role: "member",
    message_ttl_sec: 0,
    draft: null,
    updated_at: 100,
    ...over,
  };
}

test("V187: a new account sees Support and Bot Center before any real dialog exists", () => {
  const rows = withSystemChatShortcuts([], i18n);
  assert.deepEqual(rows.map((row) => row.id), [SYSTEM_SUPPORT_SHORTCUT_ID, SYSTEM_BOT_CENTER_SHORTCUT_ID]);
  assert.ok(rows.every((row) => row.kind === SYSTEM_CHAT_SHORTCUT_KIND));
  assert.equal(rows[0]!.username, "support");
  assert.equal(rows[0]!.peer_is_bot, false, "Support is a service conversation, not a callable contact bot");
  assert.equal(rows[1]!.username, "bot_center");
  assert.equal(rows[1]!.peer_is_bot, true, "Bot Center is visibly labelled as a bot destination");
});

test("V187: system destinations are appended without reordering or mutating real chats", () => {
  const real = [chat({ id: 11, title: "Новый", updated_at: 200 }), chat({ id: 12, title: "Старый", updated_at: 100 })];
  const snapshot = structuredClone(real);
  const rows = withSystemChatShortcuts(real, i18n);
  assert.deepEqual(rows.slice(0, 2).map((row) => row.id), [11, 12]);
  assert.deepEqual(real, snapshot, "helper must not mutate the server list");
});

test("V187: a real @support dialog replaces the virtual shortcut and therefore follows normal activity sorting", () => {
  const support = chat({ id: 77, title: "Green Chat Support", username: "SuPpOrT", updated_at: 900 });
  const rows = withSystemChatShortcuts([support], i18n);
  assert.equal(rows.filter((row) => row.username?.toLocaleLowerCase() === "support").length, 1);
  assert.equal(rows[0]!.id, 77);
  assert.ok(!rows.some((row) => row.id === SYSTEM_SUPPORT_SHORTCUT_ID));
});

test("V187: a future native BotFather dialog suppresses the Bot Center placeholder", () => {
  const botFather = chat({ id: 88, title: "BotFather", username: "greenchat_botfather", peer_is_bot: true });
  const rows = withSystemChatShortcuts([botFather], i18n);
  assert.ok(!rows.some((row) => row.id === SYSTEM_BOT_CENTER_SHORTCUT_ID));
  assert.ok(rows.some((row) => row.id === SYSTEM_SUPPORT_SHORTCUT_ID));
});

test("V187 wiring: shortcuts only live in All; Support opens topics and Bot Center opens creation", () => {
  const source = readFileSync(new URL("../src/screens/chat_list_screen.ts", import.meta.url), "utf8");
  assert.match(source, /tab === "all" \? withSystemChatShortcuts\(entries, i18n\) : entries/);
  assert.match(source, /if \(isBotCenter\) openBotCreateFlow\(\)/);
  assert.match(source, /else if \(isSupport\) openSupportTopics\(\)/);
  assert.match(source, /createSupportHelp\(\{/);
});

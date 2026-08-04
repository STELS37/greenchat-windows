// clients/ui/test/feed_service_v8.test.ts — V8 regression guards for three measured timeline defects.
//
// 1. Every count in the UI was a single template. "{count} участник" is correct for exactly one number
//    in Russian, so a group header would have read "5 участник" — the classic machine-translated look.
//    createI18n() now selects a CLDR plural category (Intl.PluralRules) when a call passes `count`.
// 2. Service rows were anonymous by design ("Участник присоединился"), even though the server stores the
//    actor in messages.sender_id and serialises it as `sender`. Every messenger names the person.
// 3. Creating a group posts one member_joined row per invitee, so opening a six-person group showed six
//    identical chips stacked above the first message. Identical consecutive events now fold into one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import type { Message } from "../src/screens/types.ts";
import { serviceText, serviceRunText, serviceFoldKey, serviceActorName, nameList } from "../src/screens/feed_model.ts";

const RU = () => createI18n({ locale: "ru", dicts: { ru, en } });
const EN = () => createI18n({ locale: "en", dicts: { ru, en } });

function svc(over: Partial<Message> = {}): Message {
  return { id: 1, chat_id: 10, kind: "service", created_at: 1_700_000_000, ...over };
}
function actor(id: number, name: string) {
  return { id, username: `u${id}`, name };
}

test("plural: Russian picks one/few/many, English picks one/other, unsuffixed keys unchanged", () => {
  const r = RU();
  assert.equal(r.t("chat.memberCount", { count: 1 }), "1 участник");
  assert.equal(r.t("chat.memberCount", { count: 2 }), "2 участника");
  assert.equal(r.t("chat.memberCount", { count: 5 }), "5 участников");
  assert.equal(r.t("chat.memberCount", { count: 21 }), "21 участник", "…21 takes the singular form");
  assert.equal(r.t("chat.memberCount", { count: 111 }), "111 участников");
  assert.equal(r.t("chat.subscriberCount", { count: 3 }), "3 подписчика");
  const e = EN();
  assert.equal(e.t("chat.memberCount", { count: 1 }), "1 member");
  assert.equal(e.t("chat.memberCount", { count: 4 }), "4 members");
  // A key with no plural variants must behave exactly as before, even when `count` is passed.
  assert.equal(r.t("chat.lastSeenMinutes", { count: 5 }), "был(а) 5 мин назад");
  assert.equal(r.t("no.such.key", { count: 5 }), "no.such.key");
});

test("serviceActorName: only a real named sender counts", () => {
  assert.equal(serviceActorName(svc({ sender: actor(2, "Анна") })), "Анна");
  assert.equal(serviceActorName(svc()), "", "unattributed row");
  // A live message.new frame emits the actor as a bare id (postService), never an object.
  assert.equal(serviceActorName(svc({ sender: 7 } as unknown as Partial<Message>)), "");
  assert.equal(serviceActorName(svc({ sender: { id: 9, deleted: true } })), "", "deleted-account tombstone");
  assert.equal(serviceActorName(svc({ sender: null })), "", "server-side service post carries no sender");
});

test("serviceText: names the actor in both locales, falls back when unattributed", () => {
  const r = RU();
  assert.equal(serviceText(svc({ service_event: "member_joined", sender: actor(2, "Анна") }), r), "Анна присоединился(ась) к чату");
  assert.equal(serviceText(svc({ service_event: "member_left", sender: actor(2, "Анна") }), r), "Анна покинул(а) чат");
  assert.equal(serviceText(svc({ service_event: "title_changed", sender: actor(3, "Пётр") }), r), "Пётр изменил(а) название чата");
  assert.equal(serviceText(svc({ service_event: "member_joined" }), r), "Участник присоединился");
  const e = EN();
  assert.equal(serviceText(svc({ service_event: "group_created", sender: actor(2, "Ann") }), e), "Ann created the group");
  // Events with their own card wording keep it even when attributed.
  assert.equal(serviceText(svc({ service_event: "call", sender: actor(2, "Ann") }), e), e.t("feed.svcCall"));
});

test("serviceFoldKey: only repeatable, attributed, live rows may fold", () => {
  assert.equal(serviceFoldKey(svc({ service_event: "member_joined", sender: actor(2, "Анна") })), "member_joined");
  assert.equal(serviceFoldKey(svc({ service_event: "member_left", sender: actor(2, "Анна") })), "member_left");
  assert.equal(serviceFoldKey(svc({ service_event: "member_joined" })), null, "no actor → no fold");
  assert.equal(serviceFoldKey(svc({ service_event: "title_changed", sender: actor(2, "Анна") })), null, "one-off event");
  assert.equal(serviceFoldKey(svc({ service_event: "member_joined", sender: actor(2, "Анна"), deleted: true })), null);
  assert.equal(serviceFoldKey(svc({ kind: "text", service_event: "member_joined", sender: actor(2, "Анна") })), null);
});

test("serviceRunText: one chip for a run, with a locale-correct name list and a plural tail", () => {
  const r = RU();
  const join = (id: number, name: string) => svc({ id, service_event: "member_joined", sender: actor(id, name) });
  assert.equal(serviceRunText([join(2, "Анна")], r), "Анна присоединился(ась) к чату", "a single row is the ordinary line");
  assert.equal(serviceRunText([join(2, "Анна"), join(3, "Пётр")], r), "Анна и Пётр присоединились к чату");
  assert.equal(
    serviceRunText([join(2, "Анна"), join(3, "Пётр"), join(4, "Мария")], r),
    "Анна, Пётр и Мария присоединились к чату",
  );
  // A long run stays one line: three names plus a counted tail.
  const run = [join(2, "Анна"), join(3, "Пётр"), join(4, "Мария"), join(5, "Илья"), join(6, "Ольга")];
  assert.equal(serviceRunText(run, r), "Анна, Пётр, Мария и ещё 2 присоединились к чату");
  const e = EN();
  const ejoin = (id: number, name: string) => svc({ id, service_event: "member_joined", sender: actor(id, name) });
  assert.equal(serviceRunText([ejoin(2, "Ann"), ejoin(3, "Bob")], e), "Ann and Bob joined the chat");
  assert.equal(
    serviceRunText([ejoin(2, "Ann"), ejoin(3, "Bob"), ejoin(4, "Cid"), ejoin(5, "Dan")], e),
    "Ann, Bob, Cid, and 1 other joined the chat",
  );
});

test("nameList: dedupes, keeps order, and never prints an empty slot", () => {
  const r = RU();
  assert.equal(nameList(["Анна", "Анна", "Пётр"], r), "Анна и Пётр");
  assert.equal(nameList(["Анна", "", "Пётр"], r), "Анна и Пётр");
  assert.equal(nameList([], r), "");
  assert.equal(nameList(["Анна"], r), "Анна");
});

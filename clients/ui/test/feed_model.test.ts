import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import type { Message, ChatMember } from "../src/screens/types.ts";
import {
  sortMessages, mergeMessages, upsertMessage, applyDelete, removeMessage,
  applyReactionUpdate, toggleReaction,
  historyPath, oldestId, newestId, trimWindow,
  tickFor, tickGlyph,
  isMine, senderName, messageBody, bubbleView, canEdit, isServiceMessage, serviceText,
  parseMention, filterMembers, applyMention,
  dayKey, dayLabel, needsDaySeparator,
} from "../src/screens/feed_model.ts";

const i18n = () => createI18n({ locale: "en", dicts: { ru, en } });

function msg(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    chat_id: 10,
    sender: { id: 2, username: "ann", name: "Ann" },
    kind: "text",
    text: "hi",
    created_at: 1_700_000_000,
    reactions: [],
    ...over,
  };
}

// ---- list algebra ----

test("mergeMessages: dedupes by id (incoming wins) and sorts ascending", () => {
  const a = [msg({ id: 3, text: "old3" }), msg({ id: 1, text: "one" })];
  const b = [msg({ id: 3, text: "new3" }), msg({ id: 2, text: "two" })];
  const out = mergeMessages(a, b);
  assert.deepEqual(out.map((m) => m.id), [1, 2, 3]);
  assert.equal(out.find((m) => m.id === 3)!.text, "new3");
});

test("sortMessages: ascending by id, pure (no mutation)", () => {
  const input = [msg({ id: 5 }), msg({ id: 2 })];
  const out = sortMessages(input);
  assert.deepEqual(out.map((m) => m.id), [2, 5]);
  assert.deepEqual(input.map((m) => m.id), [5, 2]);
});

test("upsertMessage: inserts a new id, replaces an existing one", () => {
  const list = [msg({ id: 1 })];
  assert.deepEqual(upsertMessage(list, msg({ id: 2 })).map((m) => m.id), [1, 2]);
  assert.equal(upsertMessage(list, msg({ id: 1, text: "edited" }))[0]!.text, "edited");
});

test("applyDelete: tombstones in place; removeMessage drops it", () => {
  const list = [msg({ id: 1 }), msg({ id: 2 })];
  const del = applyDelete(list, 1);
  assert.equal(del[0]!.deleted, true);
  assert.equal(del.length, 2);
  assert.deepEqual(removeMessage(list, 1).map((m) => m.id), [2]);
});

// ---- reactions ----

test("applyReactionUpdate: replaces counts, preserves my flags, drops zero, orders by count", () => {
  const list = [msg({ id: 1, reactions: [{ emoji: "👍", count: 1, me: true }, { emoji: "🔥", count: 5, me: false }] })];
  const out = applyReactionUpdate(list, 1, [{ emoji: "👍", count: 3 }, { emoji: "🔥", count: 0 }, { emoji: "❤", count: 2 }]);
  const r = out[0]!.reactions!;
  assert.deepEqual(r.map((x) => [x.emoji, x.count, x.me]), [["👍", 3, true], ["❤", 2, false]]);
});

test("toggleReaction: add, then un-toggle removes the bucket; increments a foreign bucket", () => {
  let r = toggleReaction([], "👍");
  assert.deepEqual(r, [{ emoji: "👍", count: 1, me: true }]);
  r = toggleReaction(r, "👍");
  assert.deepEqual(r, []);
  const foreign = toggleReaction([{ emoji: "🔥", count: 2, me: false }], "🔥");
  assert.deepEqual(foreign, [{ emoji: "🔥", count: 3, me: true }]);
});

// ---- pagination ----

test("historyPath: before_id OR after_id (never both) + limit", () => {
  assert.equal(historyPath(7, { limit: 40 }), "/v1/chats/7/messages?limit=40");
  assert.equal(historyPath(7, { before_id: 100, limit: 20 }), "/v1/chats/7/messages?before_id=100&limit=20");
  assert.equal(historyPath(7, { after_id: 5, limit: 20 }), "/v1/chats/7/messages?after_id=5&limit=20");
  // before wins if both are (defensively) present.
  assert.equal(historyPath(7, { before_id: 9, after_id: 3, limit: 10 }), "/v1/chats/7/messages?before_id=9&limit=10");
});

test("oldestId / newestId: window bounds, null when empty", () => {
  const list = [msg({ id: 2 }), msg({ id: 9 })];
  assert.equal(oldestId(list), 2);
  assert.equal(newestId(list), 9);
  assert.equal(oldestId([]), null);
  assert.equal(newestId([]), null);
});

test("trimWindow: keeps the newest tail or oldest head; no-op under max", () => {
  const list = [1, 2, 3, 4, 5].map((id) => msg({ id }));
  assert.deepEqual(trimWindow(list, 3, "bottom").map((m) => m.id), [3, 4, 5]);
  assert.deepEqual(trimWindow(list, 3, "top").map((m) => m.id), [1, 2, 3]);
  assert.deepEqual(trimWindow(list, 9, "bottom").map((m) => m.id), [1, 2, 3, 4, 5]);
});

// ---- ticks ----

test("tickFor / tickGlyph: queued+sending→clock, sent→check, failed→failed", () => {
  assert.equal(tickFor("queued"), "clock");
  assert.equal(tickFor("sending"), "clock");
  assert.equal(tickFor("sent"), "check");
  assert.equal(tickFor("failed"), "failed");
  assert.equal(tickGlyph("clock"), "🕓");
  assert.equal(tickGlyph("check"), "✓");
  assert.equal(tickGlyph("failed"), "⚠");
});

// ---- bubble view ----

test("isMine: only a real authored message by me", () => {
  assert.equal(isMine({ id: 2, username: "ann", name: "Ann" }, 2), true);
  assert.equal(isMine({ id: 2, username: "ann", name: "Ann" }, 3), false);
  assert.equal(isMine({ id: 2, deleted: true }, 2), false);
  assert.equal(isMine({ id: 2, anonymous: true }, 2), false);
  assert.equal(isMine(null, 2), false);
});

test("senderName: real name / deleted / anonymous / service", () => {
  const i = i18n();
  assert.equal(senderName({ id: 2, username: "ann", name: "Ann" }, i), "Ann");
  assert.equal(senderName({ id: 2, deleted: true }, i), i.t("feed.deletedAccount"));
  assert.equal(senderName({ id: 2, anonymous: true }, i), i.t("feed.anonymous"));
  assert.equal(senderName(null, i), "");
});

test("messageBody: tombstone, caption-first, media label, raw kind", () => {
  const i = i18n();
  assert.equal(messageBody(msg({ deleted: true }), i), i.t("feed.deleted"));
  assert.equal(messageBody(msg({ text: "caption", kind: "photo" }), i), "caption");
  assert.equal(messageBody(msg({ text: "", kind: "photo" }), i), i.t("chat.kindPhoto"));
  assert.equal(messageBody(msg({ text: "", kind: "text" }), i), "");
  assert.equal(messageBody(msg({ text: "", kind: "poll" }), i), "poll");
});

test("serviceText: localised event label, generic fallback, deleted tombstone", () => {
  const i = i18n();
  const svc = (over: Partial<Message> = {}) =>
    msg({ kind: "service", text: "", ...over });
  assert.equal(isServiceMessage(svc()), true);
  assert.equal(isServiceMessage(msg()), false);
  // V8: an attributed row names the actor ("Ann joined the chat"); the anonymous wording is the
  // fallback for a row the server could not attribute.
  assert.equal(serviceText(svc({ service_event: "member_joined" }), i), i.t("feed.svcMemberJoinedBy", { name: "Ann" }));
  assert.equal(serviceText(svc({ service_event: "member_joined", sender: null }), i), i.t("feed.svcMemberJoined"));
  assert.equal(serviceText(svc({ service_event: "call" }), i), i.t("feed.svcCall"));
  // Unknown/missing event must never leak the raw kind — always a readable label.
  assert.equal(serviceText(svc({ service_event: "future_event" }), i), i.t("feed.svcGeneric"));
  assert.equal(serviceText(svc(), i), i.t("feed.svcGeneric"));
  assert.equal(serviceText(svc({ deleted: true, service_event: "envelope" }), i), i.t("feed.deleted"));
});

test("bubbleView: assembles mine/edited/reply/forwarded", () => {
  const i = i18n();
  const v = bubbleView(
    msg({
      id: 9, sender: { id: 2, username: "ann", name: "Ann" }, text: "hey",
      edited_at: 1_700_000_100, reply_to: { id: 3, sender_id: 5, text: "orig" },
      forward_from_name: "Bob",
    }),
    2, i,
  );
  assert.equal(v.mine, true);
  assert.equal(v.edited, true);
  assert.deepEqual(v.reply, { id: 3, text: "orig" });
  assert.equal(v.forwarded, i.t("feed.forwardedFrom", { name: "Bob" }));
  assert.equal(v.body, "hey");
  assert.match(v.time, /\d{2}:\d{2}/);
});

test("bubbleView: a deleted row is never marked edited and blanks a hidden reply", () => {
  const i = i18n();
  const v = bubbleView(msg({ deleted: true, edited_at: 123, reply_to: { id: 3, sender_id: 5, text: "" } }), 2, i);
  assert.equal(v.deleted, true);
  assert.equal(v.edited, false);
  assert.equal(v.reply!.text, i.t("feed.replyUnavailable"));
});

// ---- edit window ----

test("canEdit: author within window only; never for others or deleted", () => {
  const now = 1_700_000_000;
  const mine = msg({ sender: { id: 2, username: "ann", name: "Ann" }, created_at: now - 10 });
  assert.equal(canEdit(mine, 2, now, 3600), true);
  assert.equal(canEdit(msg({ created_at: now - 7200 }), 2, now, 3600), false);
  assert.equal(canEdit(mine, 3, now, 3600), false);
  assert.equal(canEdit(msg({ deleted: true }), 2, now, 3600), false);
});

// ---- mentions ----

test("parseMention: active only for an @token at word start", () => {
  assert.deepEqual(parseMention("hi @an", 6), { active: true, query: "an", start: 3, end: 6 });
  assert.deepEqual(parseMention("@a", 2), { active: true, query: "a", start: 0, end: 2 });
  assert.equal(parseMention("email@x", 7).active, false); // '@' mid-word
  assert.equal(parseMention("plain", 5).active, false);
  assert.equal(parseMention("@bob typed", 10).active, false); // caret past the token
});

test("filterMembers: case-insensitive over username+name, capped", () => {
  const members: ChatMember[] = [
    { id: 1, username: "ann", name: "Ann Lee" },
    { id: 2, username: "bob", name: "Bob" },
    { id: 3, username: "annie", name: "Annie" },
  ];
  assert.deepEqual(filterMembers(members, "an", 10).map((m) => m.id), [1, 3]);
  assert.equal(filterMembers(members, "", 2).length, 2);
});

test("applyMention: replaces the token with '@username ' and moves the caret", () => {
  const out = applyMention("hi @an rest", { active: true, query: "an", start: 3, end: 6 }, "annie");
  assert.equal(out.text, "hi @annie  rest");
  assert.equal(out.caret, "hi @annie ".length);
});

// ---- day separators ----

test("dayKey groups by calendar day; dayLabel names today/yesterday", () => {
  const now = 1_700_000_000;
  assert.equal(dayKey(now), dayKey(now + 3600));
  const i = i18n();
  assert.equal(dayLabel(now, now, i), i.t("feed.today"));
  assert.equal(dayLabel(now - 86400, now, i), i.t("feed.yesterday"));
});

test("needsDaySeparator: first row yes, same day no, new day yes", () => {
  const now = 1_700_000_000;
  assert.equal(needsDaySeparator(null, msg({ created_at: now })), true);
  assert.equal(needsDaySeparator(msg({ created_at: now }), msg({ created_at: now + 60 })), false);
  assert.equal(needsDaySeparator(msg({ created_at: now }), msg({ created_at: now + 2 * 86400 })), true);
});

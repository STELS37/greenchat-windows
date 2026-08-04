import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import {
  isSelfDialog, chatRowView, upsertChat, dialogToEntry,
  type SelfRef,
} from "../src/screens/chat_model.ts";

const i18nEn = () => createI18n({ locale: "en", dicts: { ru, en } });
const i18nRu = () => createI18n({ locale: "ru", dicts: { ru, en } });
const me: SelfRef = { id: 7, name: "Me Myself", username: "me" };

function entry(over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 1, kind: "dialog", title: "Ann", username: null, photo_file_id: null,
    last_message: { id: 5, sender_id: 2, kind: "text", text: "hi", created_at: 1_700_000_000 },
    unread_count: 0, muted_until: 0, pinned: false, archived: false,
    my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1_700_000_000, ...over,
  };
}

// ---- isSelfDialog (T-427) -------------------------------------------------------------------------

test("isSelfDialog: a dialog titled with the viewer's own name is their Saved Messages", () => {
  assert.equal(isSelfDialog({ kind: "dialog", title: "Me Myself" }, me), true);
});

test("isSelfDialog: falls back to the @username when the viewer has no display name", () => {
  const nameless: SelfRef = { id: 7, name: "", username: "me" };
  assert.equal(isSelfDialog({ kind: "dialog", title: "me" }, nameless), true);
  assert.equal(isSelfDialog({ kind: "dialog", title: "Me Myself" }, nameless), false);
});

test("isSelfDialog: only dialogs — a group/channel that happens to share the name is not self", () => {
  assert.equal(isSelfDialog({ kind: "group", title: "Me Myself" }, me), false);
  assert.equal(isSelfDialog({ kind: "channel", title: "Me Myself" }, me), false);
});

test("isSelfDialog: a real peer dialog with a different title is not self", () => {
  assert.equal(isSelfDialog({ kind: "dialog", title: "Ann" }, me), false);
});

test("isSelfDialog: without a self reference (or a blank identity) we can't tell → false", () => {
  assert.equal(isSelfDialog({ kind: "dialog", title: "Me Myself" }, undefined), false);
  assert.equal(isSelfDialog({ kind: "dialog", title: "" }, { id: 7, name: "", username: "" }), false);
});

// ---- chatRowView self-labelling (T-427) -----------------------------------------------------------

test("chatRowView: the self-dialog row is titled 'Saved Messages' and flagged isSelf", () => {
  const v = chatRowView(entry({ title: "Me Myself" }), 1_700_000_100, i18nEn(), me);
  assert.equal(v.title, "Saved Messages");
  assert.equal(v.isSelf, true);
});

test("chatRowView: self-dialog uses the localized label (ru → Избранное)", () => {
  const v = chatRowView(entry({ title: "Me Myself" }), 1_700_000_100, i18nRu(), me);
  assert.equal(v.title, "Избранное");
  assert.equal(v.isSelf, true);
});

test("chatRowView: an ordinary peer keeps its own title and isSelf=false", () => {
  const v = chatRowView(entry({ title: "Ann" }), 1_700_000_100, i18nEn(), me);
  assert.equal(v.title, "Ann");
  assert.equal(v.isSelf, false);
});

test("chatRowView: with no self reference (old call sites) nothing is treated as self", () => {
  const v = chatRowView(entry({ title: "Me Myself" }), 1_700_000_100, i18nEn());
  assert.equal(v.title, "Me Myself");
  assert.equal(v.isSelf, false);
});

// ---- upsertChat (T-426 list insertion) ------------------------------------------------------------

test("upsertChat: a brand-new dialog is inserted and the list re-sorted (pinned first)", () => {
  const list = [entry({ id: 1, pinned: true, updated_at: 100 })];
  const out = upsertChat(list, entry({ id: 2, pinned: false, updated_at: 999, last_message: null }));
  assert.deepEqual(out.map((c) => c.id), [1, 2], "pinned id 1 stays on top despite id 2 being newer");
  assert.equal(out.length, 2);
  assert.notEqual(out, list, "input is never mutated");
});

test("upsertChat: re-opening an existing chat merges without losing its server preview", () => {
  const list = [entry({ id: 5, last_message: { id: 9, sender_id: 2, kind: "text", text: "real", created_at: 123 } })];
  const out = upsertChat(list, dialogToEntry({ id: 5, kind: "dialog", title: "Ann" }, 200));
  assert.equal(out.length, 1, "no duplicate row for the same id");
  assert.equal(out[0]!.last_message?.text, "real", "the richer existing preview survives the merge");
});

// ---- dialogToEntry (T-426 POST /v1/chats/dialog → list row) ----------------------------------------

test("dialogToEntry: fills list-only fields with empty defaults, stamping updated_at when absent", () => {
  const e = dialogToEntry({ id: 3, kind: "dialog", title: "Bob" }, 555);
  assert.equal(e.id, 3);
  assert.equal(e.last_message, null);
  assert.equal(e.unread_count, 0);
  assert.equal(e.pinned, false);
  assert.equal(e.archived, false);
  assert.equal(e.my_role, "member");
  assert.equal(e.message_ttl_sec, 0);
  assert.equal(e.updated_at, 555);
});

test("dialogToEntry: passes through the fields the dialog detail does carry", () => {
  const e = dialogToEntry(
    { id: 3, kind: "dialog", title: "Bob", username: "bob", my_role: "owner", message_ttl_sec: 60, updated_at: 42 },
    555,
  );
  assert.equal(e.username, "bob");
  assert.equal(e.my_role, "owner");
  assert.equal(e.message_ttl_sec, 60);
  assert.equal(e.updated_at, 42);
});

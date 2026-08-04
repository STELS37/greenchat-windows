import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import type { ChatEntry } from "../src/screens/types.ts";
import {
  filterChats,
  mutedNow,
  formatUnread,
  messagePreview,
  timeLabel,
  chatRowView,
  sortChats,
  applyListEvent,
  LIST_EVENTS,
} from "../src/screens/chat_model.ts";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en } });

// A ChatEntry factory with sane defaults; each test overrides only what it exercises.
function entry(over: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id: 1,
    kind: "private",
    title: "Ann",
    username: "ann",
    photo_file_id: null,
    last_message: { id: 5, sender_id: 2, kind: "text", text: "hi", created_at: 1_700_000_000 },
    unread_count: 0,
    muted_until: 0,
    pinned: false,
    archived: false,
    my_role: "member",
    message_ttl_sec: 0,
    draft: null,
    updated_at: 1_700_000_000,
    ...over,
  };
}

test("filterChats: 'all' hides archived, 'archived' shows only archived", () => {
  const rows = [entry({ id: 1 }), entry({ id: 2, archived: true })];
  assert.deepEqual(filterChats(rows, "all").map((c) => c.id), [1]);
  assert.deepEqual(filterChats(rows, "archived").map((c) => c.id), [2]);
});

test("mutedNow: muted only while the deadline is in the future", () => {
  assert.equal(mutedNow(entry({ muted_until: 0 }), 100), false);
  assert.equal(mutedNow(entry({ muted_until: 200 }), 100), true);
  assert.equal(mutedNow(entry({ muted_until: 50 }), 100), false);
});

test("formatUnread: empty at zero, capped at 999+", () => {
  assert.equal(formatUnread(0), "");
  assert.equal(formatUnread(-3), "");
  assert.equal(formatUnread(7), "7");
  assert.equal(formatUnread(999), "999");
  assert.equal(formatUnread(1000), "999+");
});

test("messagePreview: text vs localised media label vs no messages", () => {
  const i = i18n();
  assert.equal(messagePreview(entry(), i), "hi");
  assert.equal(messagePreview(entry({ last_message: null }), i), i.t("chat.noMessages"));
  const photo = entry({ last_message: { id: 1, sender_id: 2, kind: "photo", text: "", created_at: 1 } });
  assert.equal(messagePreview(photo, i), i.t("chat.kindPhoto"));
  const weird = entry({ last_message: { id: 1, sender_id: 2, kind: "quux", text: "", created_at: 1 } });
  assert.equal(messagePreview(weird, i), "quux");
  // A service row with no event still degrades to the generic wording (same string as chat.kindService).
  const svc = entry({ last_message: { id: 1, sender_id: 2, kind: "service", text: "", created_at: 1 } });
  assert.equal(messagePreview(svc, i), i.t("feed.svcGeneric"));
});

// Regression: the list used to print "Служебное сообщение" for every service row, so a pin, a join and
// a rename were indistinguishable without opening the chat. The preview must name the actual event,
// using the same dictionary the timeline uses.
test("messagePreview: a service row names its event, not a generic label", () => {
  const i = i18n();
  const svc = (event: string) =>
    entry({ last_message: { id: 1, sender_id: 2, kind: "service", text: "", created_at: 1, service_event: event } });
  assert.equal(messagePreview(svc("pinned_message"), i), i.t("feed.svcPinned"));
  assert.equal(messagePreview(svc("member_joined"), i), i.t("feed.svcMemberJoined"));
  assert.equal(messagePreview(svc("title_changed"), i), i.t("feed.svcTitleChanged"));
  assert.notEqual(messagePreview(svc("pinned_message"), i), messagePreview(svc("member_joined"), i));
  // An event the client does not know yet must not leak a raw identifier into the UI.
  assert.equal(messagePreview(svc("brand_new_event"), i), i.t("feed.svcGeneric"));
});

test("timeLabel: HH:MM same day, DD.MM otherwise", () => {
  const i = i18n();
  const now = 1_700_000_000;
  const same = timeLabel(entry({ last_message: null, updated_at: now }), now, i);
  assert.match(same, /\d{2}:\d{2}/);
  const older = timeLabel(entry({ last_message: null, updated_at: now - 3 * 86400 }), now, i);
  assert.match(older, /\d{2}\.\d{2}/);
  assert.equal(timeLabel(entry({ last_message: null, updated_at: 0 }), now, i), "");
});

test("chatRowView: assembles the flat row shape", () => {
  const i = i18n();
  const v = chatRowView(entry({ unread_count: 3, pinned: true, muted_until: 9_999_999_999 }), 1_700_000_000, i);
  assert.equal(v.title, "Ann");
  assert.equal(v.subtitle, "hi");
  assert.equal(v.unread, 3);
  assert.equal(v.unreadLabel, "3");
  assert.equal(v.pinned, true);
  assert.equal(v.muted, true);
  assert.equal(v.archived, false);
});

test("chatRowView: a bot dialog is labelled as a bot, not an ordinary contact", () => {
  const i = i18n();
  const v = chatRowView(entry({ kind: "dialog", title: "Помощник", peer_is_bot: true }), 1_700_000_000, i);
  assert.equal(v.title, `Помощник · ${i.t("chat.botBadge")}`);
});

// --- T-424: live list patching from the event stream --------------------------------------------

// Build a `message.new`/`message.edit` event with a full server Message payload.
const msgEvent = (
  type: string,
  m: { id: number; chat_id: number; senderId?: number | null; kind?: string; text?: string; created_at?: number },
) => ({
  type,
  payload: {
    message: {
      id: m.id,
      chat_id: m.chat_id,
      sender: m.senderId == null ? null : { id: m.senderId },
      kind: m.kind ?? "text",
      text: m.text ?? "",
      created_at: m.created_at ?? 1_700_000_100,
    },
  },
});

test("LIST_EVENTS: the list only reacts to chat/message events", () => {
  assert.ok(LIST_EVENTS.has("message.new"));
  assert.ok(LIST_EVENTS.has("chat.new"));
  assert.ok(LIST_EVENTS.has("chat.read"));
  assert.equal(LIST_EVENTS.has("typing"), false);
  assert.equal(LIST_EVENTS.has("presence"), false);
});

test("sortChats: pinned first, then newest-active", () => {
  const rows = [
    entry({ id: 1, updated_at: 100, last_message: { id: 1, sender_id: 2, kind: "text", text: "a", created_at: 100 } }),
    entry({ id: 2, pinned: true, updated_at: 50, last_message: { id: 2, sender_id: 2, kind: "text", text: "b", created_at: 50 } }),
    entry({ id: 3, updated_at: 300, last_message: { id: 3, sender_id: 2, kind: "text", text: "c", created_at: 300 } }),
  ];
  const ids = sortChats(rows).map((c) => c.id);
  assert.deepEqual(ids, [2, 3, 1], "pinned #2 first, then #3 (newest) then #1");
});

test("applyListEvent message.new: bumps unread, updates preview, moves the chat to the top", () => {
  const rows = [
    entry({ id: 1, unread_count: 0, updated_at: 100, last_message: { id: 10, sender_id: 2, kind: "text", text: "old", created_at: 100 } }),
    entry({ id: 2, unread_count: 0, updated_at: 200, last_message: { id: 20, sender_id: 3, kind: "text", text: "top", created_at: 200 } }),
  ];
  const res = applyListEvent(rows, msgEvent("message.new", { id: 30, chat_id: 1, senderId: 2, text: "new!", created_at: 300 }), { selfId: 99 });
  assert.equal(res.changed, true);
  assert.equal(res.refetch, false);
  assert.equal(res.entries[0]!.id, 1, "chat 1 jumped to the top");
  assert.equal(res.entries[0]!.unread_count, 1, "unread incremented");
  assert.equal(res.entries[0]!.last_message!.text, "new!", "preview updated");
});

test("applyListEvent message.new: my OWN message does not raise unread", () => {
  const rows = [entry({ id: 1, unread_count: 0 })];
  const res = applyListEvent(rows, msgEvent("message.new", { id: 30, chat_id: 1, senderId: 7, text: "hey", created_at: 300 }), { selfId: 7 });
  assert.equal(res.entries[0]!.unread_count, 0, "sender is me → no unread");
  assert.equal(res.entries[0]!.last_message!.text, "hey", "preview still updates");
});

test("applyListEvent message.new: the currently OPEN chat does not raise unread", () => {
  const rows = [entry({ id: 5, unread_count: 0 })];
  const res = applyListEvent(rows, msgEvent("message.new", { id: 40, chat_id: 5, senderId: 2 }), { selfId: 7, openChatId: 5 });
  assert.equal(res.entries[0]!.unread_count, 0, "message in the open chat is read immediately");
});

test("applyListEvent message.new: unknown chat → refetch (new dialog)", () => {
  const rows = [entry({ id: 1 })];
  const res = applyListEvent(rows, msgEvent("message.new", { id: 50, chat_id: 999, senderId: 2 }), { selfId: 7 });
  assert.equal(res.refetch, true, "we can't synthesise a brand-new dialog row locally");
  assert.equal(res.changed, false);
});

test("applyListEvent message.edit: a late edit of an OLDER message doesn't reorder or bump unread", () => {
  const rows = [
    entry({ id: 1, unread_count: 0, updated_at: 300, last_message: { id: 30, sender_id: 2, kind: "text", text: "newest", created_at: 300 } }),
  ];
  const res = applyListEvent(rows, msgEvent("message.edit", { id: 10, chat_id: 1, senderId: 2, text: "edited-old", created_at: 100 }), { selfId: 7 });
  assert.equal(res.entries[0]!.last_message!.text, "newest", "preview stays on the actual newest message");
  assert.equal(res.entries[0]!.unread_count, 0, "an edit never raises unread");
});

test("applyListEvent chat.read: clears the row's unread badge", () => {
  const rows = [entry({ id: 1, unread_count: 4 })];
  const res = applyListEvent(rows, { type: "chat.read", payload: { chat_id: 1 } }, { selfId: 7 });
  assert.equal(res.changed, true);
  assert.equal(res.entries[0]!.unread_count, 0);
});

test("applyListEvent chat.update: applies pin and re-sorts", () => {
  const rows = [
    entry({ id: 1, pinned: false, updated_at: 100, last_message: { id: 1, sender_id: 2, kind: "text", text: "a", created_at: 100 } }),
    entry({ id: 2, pinned: false, updated_at: 300, last_message: { id: 2, sender_id: 2, kind: "text", text: "b", created_at: 300 } }),
  ];
  const res = applyListEvent(rows, { type: "chat.update", payload: { chat_id: 1, pinned: true } }, { selfId: 7 });
  assert.equal(res.entries[0]!.id, 1, "pinning chat 1 floats it above the newer chat 2");
  assert.equal(res.entries[0]!.pinned, true);
});

test("applyListEvent message.delete of the preview message → refetch", () => {
  const rows = [entry({ id: 1, last_message: { id: 30, sender_id: 2, kind: "text", text: "bye", created_at: 300 } })];
  const res = applyListEvent(rows, { type: "message.delete", payload: { chat_id: 1, message_id: 30 } }, { selfId: 7 });
  assert.equal(res.refetch, true, "can't recompute the previous preview locally");
});

test("applyListEvent chat.new → refetch", () => {
  const res = applyListEvent([entry({ id: 1 })], { type: "chat.new", payload: { chat_id: 2 } }, { selfId: 7 });
  assert.equal(res.refetch, true);
});

test("applyListEvent does not mutate the input array", () => {
  const rows = [entry({ id: 1, unread_count: 0 })];
  const snapshot = JSON.parse(JSON.stringify(rows));
  applyListEvent(rows, msgEvent("message.new", { id: 30, chat_id: 1, senderId: 2 }), { selfId: 7 });
  assert.deepEqual(rows, snapshot, "the original entries are untouched (pure function)");
});

// Regression: a group row printed a naked sentence ("Второе: анимации переходов…") with no hint of who
// said it, so the list could not answer the one question it exists for — is this for me? And the
// viewer's own last message looked exactly like an answer from the other side.
test("messagePreview: names the author in groups and marks the viewer's own messages", () => {
  const i = i18n();
  const me = { id: 7, name: "Анна", username: "ann" };
  const group = (over: Record<string, unknown>) =>
    entry({
      kind: "group",
      title: "Дизайн",
      last_message: { id: 9, sender_id: 3, kind: "text", text: "готово", created_at: 1, ...over },
    });

  // Someone else in a group: the server's label goes in front of the text.
  assert.equal(messagePreview(group({ sender_name: "Борис" }), i, me), "Борис: готово");
  // The viewer's own message reads "Вы:" everywhere, group or dialog.
  assert.equal(messagePreview(group({ sender_id: 7, sender_name: "Анна" }), i, me), `${i.t("chat.previewYou")}: готово`);
  const ownDialog = entry({ last_message: { id: 9, sender_id: 7, kind: "text", text: "готово", created_at: 1 } });
  assert.equal(messagePreview(ownDialog, i, me), `${i.t("chat.previewYou")}: готово`);
  // The peer's message in a dialog is NOT prefixed: the row title already names them.
  assert.equal(messagePreview(entry(), i, me), "hi");
  // A media label is prefixed just like text.
  assert.equal(messagePreview(group({ sender_name: "Борис", kind: "photo", text: "" }), i, me), `Борис: ${i.t("chat.kindPhoto")}`);
  // A service row has no author to name, and an older server that omits sender_name must not print
  // a stray colon.
  const svc = group({ kind: "service", service_event: "pinned_message", sender_name: "Борис" });
  assert.equal(messagePreview(svc, i, me), i.t("feed.svcPinned"));
  assert.equal(messagePreview(group({}), i, me), "готово");
  // Without a known viewer identity nothing is guessed.
  assert.equal(messagePreview(group({ sender_id: 7 }), i), "готово");
});

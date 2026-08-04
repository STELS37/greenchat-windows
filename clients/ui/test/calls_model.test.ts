// clients/ui/test/calls_model.test.ts — the wording matrix of the call log (V74).
//
// The log is the one screen where a WRONG word is a real-world error: "Пропущенный" on a call the
// person themselves declined, or "Входящий" on a call they placed, is a lie about their own history.
// The model is pure (no DOM, no network), so every outcome is pinned here instead of being eyeballed
// on a running client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import {
  callOutcomeText, peerLabel, isMissedIncoming, describeCall,
  groupCallsByDay, missedCount, parseCallHistory,
  type CallHistoryItem, type CallDirection, type CallStatus,
} from "../src/screens/calls_model.ts";

const i18n = () => createI18n({ locale: "ru", dicts: { ru, en } });

function call(over: Partial<CallHistoryItem> = {}): CallHistoryItem {
  return {
    id: 1,
    chat_id: 10,
    direction: "in",
    status: "ok",
    duration_sec: 65,
    video: false,
    peer: { id: 2, name: "Мария Ли", username: "mari", deleted: false },
    created_at: 1_700_000_000,
    ...over,
  };
}

// ---- the outcome matrix: every (direction, status) pair says a DIFFERENT true thing ----

test("a connected call names the direction and prints the duration clock", () => {
  const t = i18n();
  assert.equal(callOutcomeText(call({ direction: "in", duration_sec: 65 }), t), "Входящий · 1:05");
  assert.equal(callOutcomeText(call({ direction: "out", duration_sec: 3_601 }), t), "Исходящий · 1:00:01");
});

test("a connected call of zero seconds still prints a clock instead of dropping it", () => {
  // Hanging up in the same second as the answer is a real outcome; "0:00" is honest, silence is not.
  assert.equal(callOutcomeText(call({ direction: "out", duration_sec: 0 }), i18n()), "Исходящий · 0:00");
});

test("missed vs no-answer: the same server status means opposite things per side", () => {
  const t = i18n();
  assert.equal(callOutcomeText(call({ direction: "in", status: "missed" }), t), "Пропущенный");
  assert.equal(callOutcomeText(call({ direction: "out", status: "missed" }), t), "Нет ответа");
});

test("a decline distinguishes who hung up", () => {
  const t = i18n();
  assert.equal(callOutcomeText(call({ direction: "in", status: "declined" }), t), "Вы отклонили");
  assert.equal(callOutcomeText(call({ direction: "out", status: "declined" }), t), "Отклонён");
});

test("busy: outgoing hit a busy line, incoming was missed while busy", () => {
  const t = i18n();
  assert.equal(callOutcomeText(call({ direction: "out", status: "busy" }), t), "Занято");
  assert.equal(callOutcomeText(call({ direction: "in", status: "busy" }), t), "Пропущенный: было занято");
});

test("an unreadable row says «Звонок» and never invents an outcome", () => {
  const t = i18n();
  const line = callOutcomeText(call({ status: "unknown", duration_sec: 999 }), t);
  assert.equal(line, "Звонок");
  assert.doesNotMatch(line, /\d/, `an unknown outcome must not print a duration: ${line}`);
});

test("every (direction, status) pair produces a distinct phrase — no two rows read alike", () => {
  const t = i18n();
  const seen = new Map<string, string>();
  const dirs: CallDirection[] = ["in", "out"];
  const statuses: CallStatus[] = ["ok", "missed", "declined", "busy"];
  for (const direction of dirs) {
    for (const status of statuses) {
      const text = callOutcomeText(call({ direction, status, duration_sec: 5 }), t);
      const key = `${direction}/${status}`;
      const clash = seen.get(text);
      assert.equal(clash, undefined, `${key} says the same as ${clash}: ${text}`);
      seen.set(text, key);
    }
  }
});

// ---- who the call was with ----

test("the peer label falls back through name → handle → neutral, and honours deletion", () => {
  const t = i18n();
  assert.equal(peerLabel({ id: 2, name: "Мария Ли", username: "mari" }, t), "Мария Ли");
  assert.equal(peerLabel({ id: 2, name: "   ", username: "mari" }, t), "@mari");
  assert.equal(peerLabel({ id: 2, name: "", username: null }, t), "Неизвестный контакт");
  assert.equal(peerLabel(null, t), "Неизвестный контакт");
  // A deleted account keeps the row — the call did happen — under the same label the timeline uses.
  assert.equal(peerLabel({ id: 2, name: "Мария Ли", username: "mari", deleted: true }, t), t.t("feed.deletedAccount"));
});

// ---- the alert row ----

test("only an unanswered INCOMING call is the alert row", () => {
  assert.equal(isMissedIncoming(call({ direction: "in", status: "missed" })), true);
  assert.equal(isMissedIncoming(call({ direction: "in", status: "busy" })), true);
  // Deliberate: I declined it, so it is not something I need to notice.
  assert.equal(isMissedIncoming(call({ direction: "in", status: "declined" })), false);
  assert.equal(isMissedIncoming(call({ direction: "out", status: "missed" })), false);
  assert.equal(isMissedIncoming(call({ direction: "in", status: "ok" })), false);
});

test("the glyph follows the same rule as the tone, so the icon column is scannable", () => {
  const t = i18n();
  assert.equal(describeCall(call({ direction: "in", status: "missed" }), t).icon, "callMissed");
  assert.equal(describeCall(call({ direction: "in", status: "ok" }), t).icon, "callIn");
  assert.equal(describeCall(call({ direction: "out", status: "missed" }), t).icon, "callOut");
  assert.equal(describeCall(call({ direction: "in", status: "missed" }), t).missed, true);
  assert.equal(describeCall(call({ direction: "out", status: "missed" }), t).missed, false);
});

test("missedCount counts exactly the alert rows", () => {
  const items = [
    call({ id: 1, direction: "in", status: "missed" }),
    call({ id: 2, direction: "out", status: "missed" }),
    call({ id: 3, direction: "in", status: "busy" }),
    call({ id: 4, direction: "in", status: "declined" }),
    call({ id: 5, direction: "in", status: "ok" }),
  ];
  assert.equal(missedCount(items), 2);
  assert.equal(missedCount([]), 0);
});

// ---- day grouping ----

test("grouping keeps the server order and opens a new group per calendar day", () => {
  const t = i18n();
  const now = 1_700_000_000;
  const items = [
    call({ id: 1, created_at: now }),
    call({ id: 2, created_at: now - 600 }),
    call({ id: 3, created_at: now - 86_400 * 2 }),
  ];
  const groups = groupCallsByDay(items, now, t);
  assert.equal(groups.length, 2, `two calendar days expected, got ${groups.map((g) => g.label).join("|")}`);
  assert.deepEqual(groups[0]!.items.map((i) => i.id), [1, 2]);
  assert.deepEqual(groups[1]!.items.map((i) => i.id), [3]);
  // Newest first is preserved: the log must not silently reorder the server's page.
  assert.ok(groups[0]!.items[0]!.created_at >= groups[0]!.items[1]!.created_at);
});

test("an empty page produces no groups instead of an empty day header", () => {
  assert.deepEqual(groupCallsByDay([], 1_700_000_000, i18n()), []);
});

// ---- defensive parsing: the screen must survive any payload ----

test("parseCallHistory drops rows without a usable id or timestamp", () => {
  const page = parseCallHistory({
    items: [
      { id: 1, created_at: 1_700_000_000 },
      { id: "nope", created_at: 1_700_000_000 },
      { id: 2 },
      null,
      "row",
    ],
    next_before: 99,
  });
  assert.deepEqual(page.items.map((i) => i.id), [1]);
  assert.equal(page.next_before, 99);
});

test("parseCallHistory normalises unknown enums instead of trusting the wire", () => {
  const page = parseCallHistory({
    items: [{ id: 1, created_at: 1_700_000_000, direction: "sideways", status: "exploded", duration_sec: -5, video: "yes" }],
  });
  const row = page.items[0]!;
  assert.equal(row.direction, "in");
  assert.equal(row.status, "unknown");
  assert.equal(row.duration_sec, 0, "a negative duration must clamp, not print as -5");
  assert.equal(row.video, false, "only a real boolean marks a call as video");
});

test("parseCallHistory survives a non-object payload and reports no cursor", () => {
  for (const raw of [null, undefined, 42, "boom", [], { items: "nope" }]) {
    const page = parseCallHistory(raw);
    assert.deepEqual(page.items, []);
    assert.equal(page.next_before, null);
  }
});

test("a zero or negative cursor is not a cursor — it must not loop the pager forever", () => {
  assert.equal(parseCallHistory({ items: [], next_before: 0 }).next_before, null);
  assert.equal(parseCallHistory({ items: [], next_before: -1 }).next_before, null);
  assert.equal(parseCallHistory({ items: [], next_before: "x" }).next_before, null);
});

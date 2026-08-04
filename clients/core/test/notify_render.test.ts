// clients/core/test/notify_render.test.ts — T-531 (DS-13): the notification display-mode render.
// Pins DEVICE_SECURITY §7: modes «полное/только имя/generic», hidden chats always generic, and the
// payload contract (server/src/push/senders.ts buildPayload — identifiers always, title/body only on
// opt-in). The sw.js-mirror equivalence pin lives in notify_render_sw.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderNotification,
  normalizeNotifyMode,
  NOTIFY_MODES,
  NOTIFY_MODE_DEFAULT,
  NOTIFY_MODE_KV_KEY,
} from "../src/notify_render.ts";

// A payload exactly as the server builds it WITH the recipient's notify_preview opt-in
// (server/src/push/senders.ts:34 buildPayload + worker.ts previewFor): identifiers + sent_at always,
// title/body only because the caller resolved the opt-in.
const optedIn = { chat_id: 42, message_id: 7, kind: "text", sent_at: 1752480000, title: "Alice", body: "Привет!" };
// The privacy-first default payload (notify_preview=false ⇒ buildPayload skips title/body entirely).
const minimal = { chat_id: 42, message_id: 7, kind: "text", sent_at: 1752480000 };
const callPayload = { chat_id: 9, message_id: 0, kind: "call", sent_at: 1752480000, urgent: true };

test("mode matrix on an opted-in payload: full / name / generic", () => {
  const full = renderNotification(optedIn, "full");
  assert.equal(full.title, "Alice", "full: server title shown");
  assert.equal(full.options.body, "Привет!", "full: server body shown");

  const name = renderNotification(optedIn, "name");
  assert.equal(name.title, "Alice", "name: title kept");
  assert.equal(name.options.body, "Новое сообщение", "name: body replaced with the generic string");

  const generic = renderNotification(optedIn, "generic");
  assert.equal(generic.title, "Green Chat", "generic: no name");
  assert.equal(generic.options.body, "Новое сообщение", "generic: no text");
  const s = JSON.stringify(generic);
  assert.ok(!s.includes("Alice") && !s.includes("Привет"), "generic result carries no payload content");
});

test("minimal payload (no opt-in): every mode degrades to the same generic strings", () => {
  for (const mode of NOTIFY_MODES) {
    const r = renderNotification(minimal, mode);
    assert.equal(r.title, "Green Chat", `${mode}: generic title`);
    assert.equal(r.options.body, "Новое сообщение", `${mode}: generic body`);
  }
});

test("per-chat tag survives every mode (coalescing must not break)", () => {
  for (const mode of NOTIFY_MODES) {
    assert.equal(renderNotification(optedIn, mode).options.tag, "gc-chat-42", `${mode}: tag kept`);
  }
  assert.equal(renderNotification({ kind: "text" }, "full").options.tag, undefined, "no chat_id → no tag");
});

test("kind=call: distinguishable as a call in every mode, renotify set, no content leaked", () => {
  for (const mode of NOTIFY_MODES) {
    const r = renderNotification(callPayload, mode);
    assert.equal(r.options.body, "Входящий звонок", `${mode}: call stays a call`);
    assert.equal(r.options.renotify, true, `${mode}: renotify for calls`);
  }
  // Even a call payload that (contra contract) carried a title shows none in generic mode.
  const leaky = renderNotification({ ...callPayload, title: "Alice" }, "generic");
  assert.equal(leaky.title, "Green Chat");
});

test("notification data carries exactly the identifiers the click handler needs", () => {
  const r = renderNotification(optedIn, "generic");
  assert.deepEqual(r.options.data, { chat_id: 42, message_id: 7, kind: "text" });
});

test("normalizeNotifyMode: enum members pass, anything else → default (full)", () => {
  assert.equal(NOTIFY_MODE_DEFAULT, "full");
  assert.equal(NOTIFY_MODE_KV_KEY, "notify_mode");
  for (const m of NOTIFY_MODES) assert.equal(normalizeNotifyMode(m), m);
  for (const junk of [undefined, null, "", "FULL", "off", 3, {}, []]) {
    assert.equal(normalizeNotifyMode(junk), "full", `junk mode ${String(junk)} → default`);
  }
});

test("hidden chat (T-527 hook): always generic regardless of mode; other chats unaffected", () => {
  const isHiddenChat = (chatId: unknown): boolean => chatId === 42;
  for (const mode of NOTIFY_MODES) {
    const r = renderNotification(optedIn, mode, { isHiddenChat });
    assert.equal(r.title, "Green Chat", `${mode}: hidden → generic title`);
    assert.equal(r.options.body, "Новое сообщение", `${mode}: hidden → generic body`);
    assert.equal(r.options.tag, "gc-chat-42", `${mode}: hidden keeps coalescing tag`);
  }
  const other = renderNotification({ ...optedIn, chat_id: 5 }, "full", { isHiddenChat });
  assert.equal(other.title, "Alice", "non-hidden chat renders by mode as usual");
});

test("a throwing isHiddenChat counts as not hidden — rendering never fails", () => {
  const r = renderNotification(optedIn, "full", { isHiddenChat: () => { throw new Error("boom"); } });
  assert.equal(r.title, "Alice");
});

test("contract pin: malformed payloads never throw and render generic", () => {
  for (const junk of [undefined, null, "str", 42, [], {}, { title: 5, body: {} }, { chat_id: {}, kind: [] }]) {
    const r = renderNotification(junk, "full");
    assert.equal(typeof r.title, "string");
    assert.equal(typeof r.options.body, "string");
    assert.equal(r.options.body === "Новое сообщение" || r.options.body === "Входящий звонок", true);
  }
  // Non-string title/body (contract violation) are ignored, not rendered or crashed on.
  const bad = renderNotification({ chat_id: 1, title: 123, body: { secret: "x" } }, "full");
  assert.equal(bad.title, "Green Chat");
  assert.equal(bad.options.body, "Новое сообщение");
});

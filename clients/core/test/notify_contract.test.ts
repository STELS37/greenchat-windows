// clients/core/test/notify_contract.test.ts — T-531 CONTRACT-PIN (CLIENTS §8.3 / DEVICE_SECURITY §7).
// The push payload NEVER carries message text; the client processes it ONLY via
// {chat_id, message_id, kind, title?, body?, sent_at}. This file pins the client half of that contract:
//   • fixtures are built EXACTLY like the server builds them (server/src/push/senders.ts:34 buildPayload:
//     identifiers + sent_at always; title/body/emoji only on the recipient's notify_preview opt-in,
//     and even then body is the KIND, never message text — worker.ts previewFor);
//   • a recording Proxy proves rendering reads NO fields beyond the whitelist — a future "text" field
//     smuggled into the payload could never influence (or leak from) the notification path;
//   • console stays untouched: payload content is never logged;
//   • missing title/body ⇒ the generic strings, on every mode, without a crash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderNotification, NOTIFY_MODES } from "../src/notify_render.ts";

// Mirror of server/src/push/senders.ts:34 buildPayload (kept literal so drift is visible in review).
function buildPayload(msg: {
  chatId: number; messageId: number; kind: string;
  title?: string; body?: string; emoji?: string; urgent?: boolean;
}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    chat_id: msg.chatId,
    message_id: msg.messageId,
    kind: msg.kind,
    sent_at: 1752480000,
  };
  if (msg.title !== undefined) p.title = msg.title;
  if (msg.body !== undefined) p.body = msg.body;
  if (msg.emoji !== undefined) p.emoji = msg.emoji;
  if (msg.urgent) p.urgent = true;
  return p;
}

const ALLOWED_FIELDS = new Set(["chat_id", "message_id", "kind", "title", "body", "sent_at"]);

test("render reads ONLY the contract fields — pinned by a recording Proxy", () => {
  for (const payload of [
    buildPayload({ chatId: 1, messageId: 2, kind: "text" }),
    buildPayload({ chatId: 1, messageId: 2, kind: "text", title: "Новое сообщение", body: "photo", emoji: "👍", urgent: true }),
    buildPayload({ chatId: 3, messageId: 0, kind: "call", urgent: true }),
    // A hostile/future payload: extra fields must stay invisible to the render.
    { ...buildPayload({ chatId: 4, messageId: 5, kind: "text" }), text: "СЕКРЕТНЫЙ ТЕКСТ", sender_name: "Alice" },
  ]) {
    const read = new Set<string>();
    const spy = new Proxy(payload, {
      get(t, prop, r) { if (typeof prop === "string") read.add(prop); return Reflect.get(t, prop, r); },
    });
    for (const mode of NOTIFY_MODES) {
      const res = renderNotification(spy, mode);
      const s = JSON.stringify(res);
      assert.ok(!s.includes("СЕКРЕТНЫЙ ТЕКСТ") && !s.includes("👍"), `${mode}: no non-contract content in the result`);
    }
    for (const prop of read) {
      assert.ok(ALLOWED_FIELDS.has(prop), `render must not read payload field "${prop}"`);
    }
  }
});

test("render never logs: console untouched for any payload/mode", () => {
  const calls: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  console.log = console.warn = console.error = console.info = console.debug =
    ((...a: unknown[]) => { calls.push(a.map(String).join(" ")); }) as typeof console.log;
  try {
    for (const payload of [
      buildPayload({ chatId: 1, messageId: 2, kind: "text", title: "Alice", body: "секрет" }),
      null, "junk", { title: 1, body: [] },
    ]) {
      for (const mode of [...NOTIFY_MODES, "junk"]) renderNotification(payload, mode);
    }
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(calls, [], "rendering logged something — payload content must never reach logs");
});

test("opt-out payload (server default): title/body absent ⇒ generic strings in every mode", () => {
  const p = buildPayload({ chatId: 7, messageId: 8, kind: "text" });
  assert.ok(!("title" in p) && !("body" in p), "buildPayload without opt-in carries no preview fields");
  for (const mode of NOTIFY_MODES) {
    const r = renderNotification(p, mode);
    assert.equal(r.title, "Green Chat");
    assert.equal(r.options.body, "Новое сообщение");
    assert.equal(r.options.tag, "gc-chat-7");
  }
});

test("opt-in payload: even then body is the KIND (never message text) and modes strip it as configured", () => {
  // worker.ts previewFor: title «Новое сообщение», body = kind for non-text, undefined for text.
  const photo = buildPayload({ chatId: 7, messageId: 9, kind: "photo", title: "Новое сообщение", body: "photo" });
  assert.equal(renderNotification(photo, "full").options.body, "photo");
  assert.equal(renderNotification(photo, "name").options.body, "Новое сообщение");
  assert.equal(renderNotification(photo, "generic").title, "Green Chat");
});

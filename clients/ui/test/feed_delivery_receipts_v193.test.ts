// V193 — outgoing bubble receipt progression: stored ✓, delivered ✓✓, read ✓✓ with an accent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { receiptForMessage, receiptGlyph } from "../src/screens/feed_model.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatMember, ChatReceiptState, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const deliveryCss = readFileSync(resolve(here, "../../web/src/message_delivery.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("V193: receipt model is monotonic per message and read wins over delivery", () => {
  assert.equal(receiptForMessage(42, 0, 0), "sent");
  assert.equal(receiptGlyph("sent"), "✓");
  assert.equal(receiptForMessage(42, 42, 0), "delivered");
  assert.equal(receiptGlyph("delivered"), "✓✓");
  assert.equal(receiptForMessage(42, 42, 42), "read");
  assert.equal(receiptGlyph("read"), "✓✓");
  assert.equal(receiptForMessage(42, 0, 42), "read", "read itself proves the message was delivered");
  assert.equal(receiptForMessage(43, 42, 42), "sent", "a cursor never colours a later message");
});

test("V193: malformed receipt cursors fail closed to the stored check", () => {
  assert.equal(receiptForMessage(42, Number.NaN, Number.POSITIVE_INFINITY), "sent");
  assert.equal(receiptForMessage(42, -1, -1), "sent");
  assert.equal(receiptForMessage(42, Number.MAX_SAFE_INTEGER + 1, 0), "sent");
  assert.equal(receiptForMessage(0, 100, 100), "sent");
});

test("V193: pending layout reserves the widest double-check state and read has a distinct tone", () => {
  assert.match(deliveryCss, /content:\s*"00:00 ✓✓"/);
  assert.match(deliveryCss, /content:\s*"00:00 PM ✓✓"/);
  assert.match(deliveryCss, /\.gc-bubble-tick:is\(\.tick-delivered, \.tick-read\)/);
  const readRule = deliveryCss.match(/\.gc-bubble\.is-mine \.gc-bubble-tick\.tick-read\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(readRule, /color:\s*var\(--gc-accent-strong\)/);
  assert.match(readRule, /font-weight:\s*var\(--gc-weight-semibold\)/);
});


installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const ownMessage: Message = {
  id: 42,
  chat_id: 9,
  sender: { id: 1, username: "alice", name: "Alice" },
  kind: "text",
  text: "receipt",
  created_at: 1_700_000_042,
};

class ReceiptFeedApi implements ApiLike {
  receipt: ChatReceiptState | null = {
    chat_id: 9,
    delivered_up_to_message_id: 42,
    read_up_to_message_id: 0,
  };
  failReceipt = false;

  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([ownMessage] as T);
    if (path === "/v1/chats/9/receipt-state") {
      if (this.failReceipt) return Promise.reject(new Error("legacy server"));
      return Promise.resolve(this.receipt as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "bob", name: "Bob" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    if (path.startsWith("/v1/chats?")) return Promise.resolve([] as T);
    if (path === "/v1/users/2") return Promise.resolve({ last_seen: "recently" } as T);
    return Promise.resolve([] as T);
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({ unread_count: 0 } as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.resolve({} as T); }
  patch<T>(): Promise<T> { return Promise.resolve({} as T); }
  delete<T>(): Promise<T> { return Promise.resolve({} as T); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const receiptOutbox: OutboxPort = {
  enqueueMessage: () => Promise.reject(new Error("unexpected enqueue")),
  enqueueEdit: () => Promise.reject(new Error("unexpected edit")),
  enqueueDelete: () => Promise.reject(new Error("unexpected delete")),
  cancel: () => Promise.resolve(false),
  retry: () => Promise.reject(new Error("unexpected retry")),
  subscribe: () => () => {},
};

type ReceiptEvent = { type: string; payload: unknown };
type ReceiptHandler = (event: ReceiptEvent) => void | Promise<void>;

async function mountReceiptFeed(api: ReceiptFeedApi): Promise<{
  root: StubNode;
  emit(event: ReceiptEvent): Promise<void>;
  destroy(): void;
}> {
  let handler: ReceiptHandler = () => {};
  const events: EventFeed = {
    subscribe(next) {
      handler = next;
      return () => {};
    },
  };
  const view = createFeedScreen({
    api,
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox: receiptOutbox,
    events,
    onBack() {},
  });
  await settle();
  await settle();
  return {
    root: view.root as unknown as StubNode,
    async emit(event) {
      await handler(event);
      await settle();
    },
    destroy: () => view.destroy(),
  };
}

function visibleReceipt(root: StubNode): StubNode {
  const tick = root
    .findAll((node) => node.hasClass("gc-bubble-tick"))
    .find((node) => node.parent?.hasClass("gc-bubble-meta"));
  assert.ok(tick, "an outgoing message exposes its visible receipt glyph");
  return tick;
}

test("V193: restored delivery and live read repaint the actual outgoing bubble", async () => {
  const mounted = await mountReceiptFeed(new ReceiptFeedApi());
  try {
    let tick = visibleReceipt(mounted.root);
    assert.equal(tick.textContent, "✓✓");
    assert.ok(tick.hasClass("tick-delivered"));
    assert.equal(tick.getAttribute("title"), "Delivered to recipient");

    await mounted.emit({
      type: "chat.read",
      payload: { chat_id: 9, user_id: 2, up_to_message_id: 42 },
    });
    tick = visibleReceipt(mounted.root);
    assert.equal(tick.textContent, "✓✓");
    assert.ok(tick.hasClass("tick-read"));
    assert.equal(tick.getAttribute("title"), "Read");

    await mounted.emit({
      type: "chat.delivered",
      payload: { chat_id: 9, user_id: 2, up_to_message_id: 41 },
    });
    assert.ok(visibleReceipt(mounted.root).hasClass("tick-read"), "a stale delivery cannot regress read");

    await mounted.emit({
      type: "chat.read",
      payload: { chat_id: 9, user_id: 1, up_to_message_id: 999 },
    });
    assert.ok(visibleReceipt(mounted.root).hasClass("tick-read"), "own-device read events are ignored");
  } finally {
    mounted.destroy();
  }
});

test("V193: a legacy server without receipt-state fails closed to one stored check", async () => {
  const api = new ReceiptFeedApi();
  api.failReceipt = true;
  const mounted = await mountReceiptFeed(api);
  try {
    const tick = visibleReceipt(mounted.root);
    assert.equal(tick.textContent, "✓");
    assert.ok(tick.hasClass("tick-sent"));
  } finally {
    mounted.destroy();
  }
});

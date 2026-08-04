// clients/ui/test/visual_bubble_meta_reserve_v90.test.ts — V90 regression guard.
//
// Measured on the signed direct APK (versionCode 1000010, build 5) on redroid 15 at 1080x2400 /
// density 443 (= 390 dp), system locale en-US, screenshot /root/gc-p0-b5-sent.png: an own message
// reading "P0-check-1000010" is painted with its timestamp GLUED ON TOP of the last character —
// "P0-check-1000010" ends at x=470 and "06:49 PM ✓" starts at x=473, i.e. the meta overlaps the
// glyph instead of following it.
//
// Cause: the corner meta is absolutely positioned, and the body reserved room for it with a
// hardcoded `::after { width: 46px }` (60px on own bubbles). Those two numbers were measured once
// against a 24-hour clock ("18:49 ✓"). A 12-hour locale renders "06:49 PM ✓", which is wider, so
// the reservation was too small and the text ran under the meta. The same failure appears for any
// locale with a longer time format, for "edited · time · tick", and at any system font zoom — the
// reservation is a constant while the thing it reserves for is not.
//
// Fix: the body ends with a hidden COPY of the meta (`.gc-bubble-metaspace`) carrying the very same
// classes, so it occupies exactly the width the real meta will occupy, in every locale, for every
// combination of edited/tick, at every font size. No constant to keep in sync.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createFeedScreen, type EventFeed, type OutboxPort } from "../src/screens/feed_screen.ts";
import type { ChatEntry, ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const mine: Message = {
  id: 41,
  chat_id: 9,
  sender: { id: 1, username: "alice", name: "Alice" },
  kind: "text",
  text: "P0-check-1000010",
  created_at: 1_700_000_000,
  edited_at: 1_700_000_100,
};

class FeedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?")) return Promise.resolve([mine] as T);
    if (path === "/v1/chats?filter=all")
      return Promise.resolve([
        {
          id: 9, kind: "dialog", title: "Bob", username: "bob", photo_file_id: null,
          last_message: null, unread_count: 0, muted_until: 0, pinned: false, archived: false,
          my_role: "member", message_ttl_sec: 0, draft: null, updated_at: 1,
        },
      ] as ChatEntry[] as T);
    if (path === "/v1/chats/9/members")
      return Promise.resolve([{ id: 1, username: "alice", name: "Alice" }] as ChatMember[] as T);
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const outbox: OutboxPort = {
  enqueueMessage: () => Promise.reject(new Error("unexpected enqueue")),
  enqueueEdit: () => Promise.reject(new Error("unexpected edit")),
  enqueueDelete: () => Promise.reject(new Error("unexpected delete")),
  cancel: () => Promise.resolve(false),
  retry: () => Promise.reject(new Error("unexpected retry")),
  subscribe: () => () => {},
};
const events: EventFeed = { subscribe: () => () => {} };

const textOf = (node: StubNode): string =>
  // `findAll` includes the node itself; the spacer IS a span, the meta is a div, so compare only
  // the inner spans or the two shapes would never line up.
  node.findAll((n) => n !== node && n.tag === "span").map((n) => n.textContent).join("|");

test("V90: the body reserves the meta's real width, not a constant", async () => {
  const view = createFeedScreen({
    api: new FeedApi(), i18n, chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox, events, onBack() {},
  });
  await settle();
  const root = view.root as unknown as StubNode;
  const body = root.find((n) => n.hasClass("gc-bubble-body"));
  assert.ok(body, "the own message renders a body");
  const spacer = body.find((n) => n.hasClass("gc-bubble-metaspace"));
  assert.ok(spacer, "the body ends with a hidden copy of the meta to reserve its exact width");
  // Hidden from assistive tech and from the accessible name of the message.
  assert.equal(spacer.attrs["aria-hidden"], "true", "the copy must not be announced twice");

  const meta = root.find((n) => n.hasClass("gc-bubble-meta"));
  assert.ok(meta, "the corner meta is still painted");
  // Same glyphs in the same classes => same rendered width, whatever the locale/zoom does to it.
  assert.equal(
    textOf(spacer),
    textOf(meta),
    "the reservation must mirror the meta exactly (edited + time + tick)",
  );
  view.destroy();
});

test("V90: no hardcoded pixel reservation survives in the stylesheet", () => {
  assert.ok(
    !/\.gc-bubble-body::after\s*\{[^}]*width:\s*\d+px/.test(css),
    "the constant-width ::after reservation is gone (it was measured for a 24h clock only)",
  );
  assert.ok(
    !/\.gc-bubble\.is-mine\s+\.gc-bubble-body::after/.test(css),
    "…including the own-bubble override",
  );
  // Where the meta is pinned into the corner — the redesigned shell (`.gc-superapp` and the overlay
  // scopes) — the copy must be INVISIBLE BUT LAID OUT: `visibility: hidden` reserves the box,
  // `display: none` would reserve nothing and the overlap would come straight back.
  const scoped = /:is\([^)]*\)\s*\.gc-bubble-metaspace\s*\{([^}]*)\}/.exec(css);
  assert.ok(scoped, "the redesigned shell styles the reservation copy");
  assert.match(scoped[1], /display:\s*inline-flex/, "the copy is laid out inline with the text");
  assert.match(scoped[1], /visibility:\s*hidden/, "the copy is invisible");
  assert.doesNotMatch(scoped[1], /display:\s*none/, "the copy still occupies its width");
  // Outside that scope (the legacy stylesheet) the meta is a static row of its own, so there is
  // nothing to reserve for and the copy must not add a phantom box to the last line.
  assert.match(
    css,
    /^\.gc-bubble-metaspace\s*\{[^}]*display:\s*none/m,
    "the legacy theme, whose meta is not pinned, reserves nothing",
  );
  // With reactions the meta joins the reaction row and the corner is free again.
  assert.match(
    css,
    /\.gc-bubble\.has-reactions\s+\.gc-bubble-metaspace\s*\{[^}]*display:\s*none/,
    "no reservation when the meta is not in the corner",
  );
});

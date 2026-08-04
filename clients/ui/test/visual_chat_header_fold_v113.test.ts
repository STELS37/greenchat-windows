// clients/ui/test/visual_chat_header_fold_v113.test.ts — V205 keeps both 1:1 call actions visible on
// phones. Search may still fold into overflow so the identity has room, but audio and video are
// adjacent primary actions and must never move behind a menu.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  createFeedScreen,
  type EventFeed,
  type OutboxPort,
} from "../src/screens/feed_screen.ts";
import type {
  CachePolicyPort,
  CacheRetentionMode,
  ChatCacheMode,
} from "../src/screens/cache_policy_model.ts";
import type { ChatEntry, ChatMember } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8");
const composerTs = readFileSync(
  resolve(here, "../src/screens/composer.ts"),
  "utf8",
);

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

/** A chat that either has one other person in it (callable) or a crowd (not). */
class ChatApi implements ApiLike {
  readonly kind: "dialog" | "group";
  constructor(kind: "dialog" | "group") {
    this.kind = kind;
  }
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?"))
      return Promise.resolve([] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([
        {
          id: 9,
          kind: this.kind,
          title: "Артём Волков",
          username: "artem",
          photo_file_id: null,
          last_message: null,
          unread_count: 0,
          muted_until: 0,
          pinned: false,
          archived: false,
          my_role: "member",
          message_ttl_sec: 0,
          draft: null,
          updated_at: 1,
        },
      ] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      const members: ChatMember[] = [
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "artem", name: "Артём Волков" },
      ];
      if (this.kind === "group")
        members.push({ id: 3, username: "lena", name: "Лена Гриб" });
      return Promise.resolve(members as T);
    }
    if (path === "/v1/users/2")
      return Promise.resolve({ last_seen: 1_700_000_000 } as T);
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
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

function cachePolicyStub(): CachePolicyPort {
  let chatMode: ChatCacheMode = "7d";
  return {
    getGlobal: () => "forever" as CacheRetentionMode,
    setGlobal: () => Promise.resolve(),
    getChat: () => chatMode,
    setChat: (_chatId, mode) => {
      chatMode = mode;
      return Promise.resolve();
    },
    shouldPersist: () => true,
    recordMedia: () => Promise.resolve(),
    subscribe: () => () => {},
  };
}

function useViewport(narrow: boolean): void {
  (globalThis as unknown as { matchMedia: (q: string) => unknown }).matchMedia =
    (q: string) => ({
      media: q,
      matches: q.includes("max-width") ? narrow : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
}

interface Opened {
  root: StubNode;
  destroy(): void;
  calls: Array<{ peer: number; video: boolean }>;
}

async function open(kind: "dialog" | "group"): Promise<Opened> {
  const calls: Array<{ peer: number; video: boolean }> = [];
  const view = createFeedScreen({
    api: new ChatApi(kind),
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    cachePolicy: cachePolicyStub(),
    onStartCall: (peer, video) => {
      calls.push({ peer: peer.id, video });
    },
  });
  await settle();
  return {
    root: view.root as unknown as StubNode,
    destroy: () => view.destroy(),
    calls,
  };
}

const barTitles = (root: StubNode): string[] => {
  const actions = root.find((n) => n.hasClass("gc-feed-header-actions"));
  assert.ok(actions, "the header exposes its actions row");
  return actions.children
    .filter(
      (n) => n.tag === "button" && !n.hidden && n.attrs.hidden === undefined,
    )
    .map((n) => String(n.attrs.title ?? ""));
};

const openMenu = (root: StubNode): void => {
  const overflow = root.find(
    (n) => n.tag === "button" && n.hasClass("gc-feed-overflow"),
  );
  assert.ok(overflow, "the overflow button exists");
  overflow.dispatch("click", { stopPropagation() {} });
};

test("V205: a phone bar keeps audio and video calls side by side", async () => {
  useViewport(true);
  const view = await open("dialog");
  try {
    const titles = barTitles(view.root);
    assert.deepEqual(
      titles.slice(0, 2),
      [i18n.t("call.startAudio"), i18n.t("call.startVideo")],
      "both primary call actions stay visible and adjacent on a phone",
    );
    openMenu(view.root);
    assert.equal(
      view.root.find((n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call"),
      null,
      "the visible video action must not be duplicated in overflow",
    );
    const video = view.root.find(
      (n) => n.tag === "button" && n.attrs.title === i18n.t("call.startVideo") && !n.hidden,
    );
    assert.ok(video, "the phone exposes a directly tappable video button");
    video.dispatch("click");
    await settle();
    assert.deepEqual(view.calls, [{ peer: 2, video: true }]);
  } finally {
    view.destroy();
  }
});

test("V205: a group does not expose dead one-to-one call actions", async () => {
  useViewport(true);
  const view = await open("group");
  try {
    const titles = barTitles(view.root);
    assert.equal(titles.includes(i18n.t("call.startAudio")), false);
    assert.equal(titles.includes(i18n.t("call.startVideo")), false);
    openMenu(view.root);
    assert.equal(
      view.root.find((n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call"),
      null,
    );
  } finally {
    view.destroy();
  }
});

test("V205: a wide window also keeps both call actions visible", async () => {
  useViewport(false);
  const view = await open("dialog");
  try {
    const titles = barTitles(view.root);
    assert.deepEqual(
      titles.slice(0, 2),
      [i18n.t("call.startAudio"), i18n.t("call.startVideo")],
    );
    openMenu(view.root);
    assert.equal(
      view.root.find((n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call"),
      null,
    );
  } finally {
    view.destroy();
  }
});

test("V205: a narrow conversation column folds search, never video", async () => {
  useViewport(false);
  const observers: Array<{ target: StubNode; fire: () => void }> = [];
  const realRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; }
    observe(target: StubNode): void {
      observers.push({ target, fire: () => this.cb() });
    }
    disconnect(): void {}
  };
  let view: Opened | null = null;
  try {
    view = await open("dialog");
    const header = view.root.find((n) => n.hasClass("gc-feed-header"));
    assert.ok(header, "the bar exists");
    (header as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => ({ width: 388 });
    const watcher = observers.find((o) => o.target === header);
    assert.ok(watcher, "the bar watches its own size");
    watcher.fire();
    assert.deepEqual(
      barTitles(view.root),
      [i18n.t("call.startAudio"), i18n.t("call.startVideo"), i18n.t("chat.rowActions")],
      "search moves to overflow while both call buttons remain in the bar",
    );
    openMenu(view.root);
    assert.equal(
      view.root.find((n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call"),
      null,
    );
  } finally {
    view?.destroy();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  }
});

/** The declarations of the last rule whose selector mentions `name`. */
const lastRuleFor = (name: string): string => {
  const at = css.lastIndexOf(name);
  assert.ok(at > 0, `${name} must be styled at all`);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("}", open));
};

test("V113: an enlarged system font lets the peer's name wrap instead of being cut", () => {
  const rule = lastRuleFor(".gc-feed-title, .gc-feed-subtitle)");
  assert.match(
    rule,
    /white-space:\s*normal/,
    "the nowrap line is what forced the ellipsis",
  );
  assert.match(
    rule,
    /text-overflow:\s*clip/,
    "and the ellipsis itself must go",
  );
  assert.match(
    rule,
    /overflow-wrap:\s*anywhere/,
    "«Безопасность»-class single words are wider than the box; a between-words break never comes",
  );
  const selectorStart = css.lastIndexOf(
    ":root",
    css.lastIndexOf(".gc-feed-title, .gc-feed-subtitle)"),
  );
  assert.match(
    css.slice(
      selectorStart,
      css.lastIndexOf(".gc-feed-title, .gc-feed-subtitle)"),
    ),
    /:root\[data-gc-text-zoom\]/,
    "responsive title wrapping remains scoped to enlarged system text",
  );
});

test("V113: the two-row composer is scoped to the one case that needs it", () => {
  const at = css.lastIndexOf(".gc-composer-row");
  assert.ok(at > 0, "the composer row must carry the rule");
  const rule = css.slice(
    css.indexOf("{", at) + 1,
    css.indexOf("}", css.indexOf("{", at)),
  );
  assert.match(
    rule,
    /flex-wrap:\s*wrap/,
    "the send button moving to its own line is what widens the field",
  );
  const head = css.slice(css.lastIndexOf("@media", at), at);
  assert.match(
    head,
    /max-width:\s*360px/,
    "390 and 430 dp fit «Сообщение» at 2.0 and must not wrap",
  );
  assert.match(
    head,
    /data-gc-text-zoom="large"/,
    "at the default font the hint needs 81 px of a 136 px box — nothing to solve",
  );
});

test("V113: the visible hint fits the pill and the spoken one keeps the verb", () => {
  // 15 px system UI type, measured on the device: the box is 136 px on a 320 dp phone.
  const measured: Record<string, number> = {
    "Написать сообщение…": 160,
    Сообщение: 81,
    Message: 63,
  };
  for (const dict of [ru, en]) {
    const hint = dict["feed.placeholder"];
    assert.ok(hint, "every locale keeps a hint");
    const width = measured[hint];
    assert.ok(
      width !== undefined,
      `add the measured width of "${hint}" before shipping it`,
    );
    assert.ok(
      width <= 136,
      `"${hint}" needs ${width} px in a 136 px box on a 320 dp phone`,
    );
    assert.ok(
      dict["feed.composeLabel"],
      "the spoken name of the field is a separate string",
    );
  }
  assert.match(
    ru["feed.composeLabel"] ?? "",
    /Написать/,
    "shortening what is SEEN must not shorten what a screen reader HEARS",
  );
  assert.match(
    composerTs,
    /"aria-label":\s*i18n\.t\("feed\.composeLabel"\)/,
    "the field must be announced by the verb, not by the one-word hint",
  );
});

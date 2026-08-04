// clients/ui/test/visual_chat_header_fold_v113.test.ts — V113: on a 320 dp phone the conversation
// bar named the person you were talking to as «Артём В», and the input pill invited you to
// «Написать» — both at the DEFAULT system font, i.e. with no accessibility setting touched.
//
// Evidence (signed direct APK app.greenchat on redroid Android 15, `wm density 540` = 320 dp,
// ru-RU, CDP against the device WebView, route #/chat/17, peer «Артём Волков», 2026-07-31; the
// "painted" column is rebuilt character by character from Range rects, not guessed):
//
//   HEADER            actions   title box / needed    painted
//   font_scale 1.0    3 x 44     72 / 111             «Артём В»
//   font_scale 1.0    2 x 44    111 / 111             «Артём Волков»   <- video folded
//   font_scale 1.3    3 x 44     72 / 145             «Артём »
//   font_scale 1.3    2 x 44    116 / 145             «Артём Вол»      <- fold alone falls short
//   font_scale 1.3    2 x 44 + wrap                   «Артём Волков», header 56 -> 75 px
//   font_scale 2.0    3 x 44     72 / 223             «Арт»
//   font_scale 2.0    2 x 44 + wrap                   «Артём Волков», header 72 -> 143 px
//
//   COMPOSER          text box   «Написать сообщение…»   «Сообщение»
//   320 dp fs 1.0     136        160  cut               81  fits
//   320 dp fs 1.3     136        208  cut              105  fits
//   320 dp fs 2.0     136        320  cut              162  cut  -> row wraps, box 196, fits
//   390 dp fs 2.0     209        320  cut              162  fits
//   430 dp fs 2.0     246        320  cut              162  fits
//
// Two mechanisms, both already used by this product: fold a secondary icon into the header menu
// (V105 did it for search), and let fixed chrome grow instead of cutting words once the system font
// is enlarged (V109 did it for screen titles). Nothing is deleted: the video call becomes the first
// item of the menu that is already in the bar, and it is offered only while a call is possible.
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

test("V113: a phone bar keeps the audio call and hands the video call to the menu", async () => {
  useViewport(true);
  const view = await open("dialog");

  const titles = barTitles(view.root);
  assert.ok(
    titles.includes(i18n.t("call.startAudio")),
    "the audio call is the action the bar keeps",
  );
  assert.ok(
    !titles.includes(i18n.t("call.startVideo")),
    "with 3 x 44 px of icons the 320 dp title box is 72 px and «Артём Волков» needs 111",
  );

  openMenu(view.root);
  const item = view.root.find(
    (n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call",
  );
  assert.ok(
    item,
    "the folded video call is offered by the header menu — folded, not deleted",
  );
  assert.equal(
    item.textContent.includes(i18n.t("call.startVideo")),
    true,
    "the item is labelled",
  );

  item.dispatch("click", {});
  await settle();
  assert.deepEqual(
    view.calls,
    [{ peer: 2, video: true }],
    "choosing it starts the same video call the icon started, with the same peer",
  );
  view.destroy();
});

test("V113: a group has nobody to ring, so the menu offers no call either", async () => {
  useViewport(true);
  const view = await open("group");
  openMenu(view.root);
  const item = view.root.find(
    (n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call",
  );
  assert.equal(
    item,
    null,
    "V75 hid the dead icon; the fold must not resurrect it as a dead menu row",
  );
  view.destroy();
});

test("V113: a wide window keeps the video call as an icon and out of the menu", async () => {
  useViewport(false);
  const view = await open("dialog");
  assert.ok(
    barTitles(view.root).includes(i18n.t("call.startVideo")),
    "a desktop bar has the width for both call buttons",
  );
  openMenu(view.root);
  assert.equal(
    view.root.find(
      (n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call",
    ),
    null,
    "the same action must never be reachable twice in one bar",
  );
  view.destroy();
});

test("V113b: a wide window with a narrow conversation column folds like a phone", async () => {
  // Landscape on a 390 dp phone: the window is 819 px, so `(max-width: 480px)` is false, but the
  // shell is two-pane and the conversation column is 388 px — measured on the signed APK.
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
  // A failed assertion must not leave the screen's timers running: node's runner would then keep
  // the process alive after reporting the failure, and a red test would read as a hung suite.
  let view: Opened | null = null;
  try {
    view = await open("dialog");
    assert.ok(
      barTitles(view.root).includes(i18n.t("call.startVideo")),
      "before layout the bar can only trust the window, and the window says desktop",
    );
    const header = view.root.find((n) => n.hasClass("gc-feed-header"));
    assert.ok(header, "the bar exists");
    (header as unknown as { getBoundingClientRect: () => { width: number } }).getBoundingClientRect =
      () => ({ width: 388 });
    const watcher = observers.find((o) => o.target === header);
    assert.ok(watcher, "the bar watches its OWN size, not only the window's");
    watcher.fire();

    assert.deepEqual(
      barTitles(view.root),
      [i18n.t("call.startAudio"), i18n.t("chat.rowActions")],
      "388 px of bar is narrower than any phone in portrait, so it folds like one",
    );
    openMenu(view.root);
    assert.ok(
      view.root.find(
        (n) => n.tag === "button" && n.attrs["data-action"] === "chat-video-call",
      ),
      "and the folded call is offered by the menu, exactly as on a phone",
    );
  } finally {
    view?.destroy();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = realRO;
  }
});

test("V113b: a genuinely wide bar keeps every icon", async () => {
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
      () => ({ width: 900 });
    observers.find((o) => o.target === header)?.fire();
    assert.ok(
      barTitles(view.root).includes(i18n.t("call.startVideo")),
      "measuring the bar must not fold a bar that has the room",
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
    "a device at the default font must render byte-identical CSS: the fold alone fixes it there",
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

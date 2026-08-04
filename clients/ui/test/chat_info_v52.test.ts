// clients/ui/test/chat_info_v52.test.ts — V52 regression guards: the conversation header is a way IN,
// and a reaction is a target you can actually hit.
//
// Measured on the running client at the 390x844 touch profile
// (var/ux-audit/tools/probe_v52.mjs, 2026-07-30), after the whole authenticated surface had already
// been walked screen by screen. Two defects were left, and one of them was a missing screen:
//
//   1. `.gc-feed-identity` — the avatar+name block at the top of every conversation — was a plain
//      <div> with no click handler. In every mainstream messenger that block is THE entry point to
//      "who am I talking to"; here it was dead to the touch, and there was no chat-info screen at all
//      anywhere in the client. A peer's bio and @handle were never rendered, and the participant
//      roster was fetched only to feed @mention autocomplete.
//   2. A reaction chip measured 45x26 px. The chip SHOULD stay dense — a fat reaction pill is not what
//      a reaction looks like in any messenger — so the fix is the hit slop every native client puts
//      around a small control: the target grows, the paint does not.
//
// Two numbers below look arbitrary and are not; both were wrong on the first attempt and are pinned
// so the next edit cannot silently undo the correction:
//
//   * the slop inset is -10px, not -9px. The containing block of an absolutely positioned
//     pseudo-element is its parent's PADDING box, and the chip carries a 1px border, so the box being
//     stretched is 24px tall, not the 26px the chip measures. With -9px the live target came out
//     42px; with -10px it is 24 + 20 = 44px exactly.
//   * the slop is vertical only. The chip is already 45px wide (over the floor), and the gap between
//     chips is 4px, so horizontal slop would make neighbouring reactions overlap and steal each
//     other's taps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createChatInfoOverlay } from "../src/screens/chat_info.ts";
import type { ChatInfoDetail, ChatInfoProfile } from "../src/screens/chat_info.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const here = dirname(fileURLToPath(import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const feed = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");

// Only the V52 section is policed; earlier layers are frozen history.
const V52_HEADER = "V52 — the conversation header becomes a destination";
const v52 = (() => {
  const at = redesign.indexOf(V52_HEADER);
  assert.notEqual(at, -1, "the V52 layer must exist in redesign.css");
  // Comments are stripped first: this layer explains every number in prose directly above the
  // declaration it justifies, and a `/* … */` block sitting between `{` and a property is enough to
  // make a naive "start of line or after a semicolon" scan miss the declaration entirely.
  return redesign.slice(at).replace(/\/\*[\s\S]*?\*\//g, "");
})();

/** Last declaration of `prop` inside `selector`, searching the V52 layer only (later rules win). */
const decl = (selector: string, prop: string): string | null => {
  const rule = new RegExp(`(^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  let found: string | null = null;
  for (const m of v52.matchAll(rule)) {
    const hit = [...m[2]!.matchAll(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "g"))].pop();
    if (hit) found = hit[1]!.trim();
  }
  return found;
};

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

// ---- 1. the header is a real control -------------------------------------------------------------

test("the conversation header is a button with an accessible name, not a decorative div", () => {
  const block = feed.slice(feed.indexOf("const identityEl"), feed.indexOf("const identityEl") + 500);
  assert.match(block, /el\("button"/, "the identity block must be a <button>: a div cannot be tabbed to or activated by keyboard");
  assert.match(block, /type:\s*"button"/, "without type=button it would submit any enclosing form");
  assert.match(block, /"aria-label":\s*i18n\.t\("chatInfo\.open"\)/, "the block has no text of its own beyond the peer name, so it needs an explicit name");
  assert.match(feed, /identityEl\.addEventListener\("click"/, "a button with no handler is the very defect this layer fixes");
  assert.match(feed, /createChatInfoOverlay/, "the header must open the chat-info sheet");
});

// ---- 2. the sheet itself --------------------------------------------------------------------------

const member = (id: number, name: string, username: string, role?: string) => ({ id, name, username, ...(role ? { role } : {}) });

const openSheet = (over: Partial<Parameters<typeof createChatInfoOverlay>[0]> = {}) =>
  createChatInfoOverlay({
    i18n,
    title: "Тестовая группа",
    subtitle: "5 участников",
    kind: "group",
    peerId: null,
    members: [member(1, "Анна", "anna", "owner"), member(2, "Борис", "boris")],
    loadChat: () => Promise.resolve<ChatInfoDetail>({ about: "О группе", username: "testgroup", members_count: 5 }),
    loadUser: () => Promise.resolve<ChatInfoProfile>({}),
    ...over,
  });

const root = (o: { root: HTMLElement }) => o.root as unknown as StubNode;
const byClass = (n: StubNode, cls: string) => n.findAll((x) => x.hasClass(cls));

test("the sheet paints the header data instantly, before either read resolves", () => {
  // The caller already knows the title, the subtitle and the roster, so nothing the user can see is
  // allowed to wait on the network: a sheet that opens empty and fills in later reads as a bug.
  const sheet = openSheet({
    loadChat: () => new Promise<ChatInfoDetail>(() => {}),
    loadUser: () => new Promise<ChatInfoProfile>(() => {}),
  });
  const node = root(sheet);
  assert.equal(byClass(node, "gc-info-name")[0]?.textContent, "Тестовая группа");
  assert.equal(byClass(node, "gc-info-subtitle")[0]?.textContent, "5 участников");
  assert.equal(byClass(node, "gc-info-member").length, 2, "the roster the caller already holds is painted immediately");
  const panel = byClass(node, "gc-info-panel")[0]!;
  assert.equal(panel.attrs["role"], "dialog");
  assert.equal(panel.attrs["aria-modal"], "true");
});

test("the two reads only enrich the sheet: description, @handle and the real member count", async () => {
  const sheet = openSheet();
  await settle();
  const node = root(sheet);
  const values = byClass(node, "gc-info-fact-value").map((n) => n.textContent);
  assert.deepEqual(values, ["О группе", "@testgroup"]);
  const counter = byClass(node, "gc-info-section")[0]!;
  assert.match(counter.textContent, /5$/, "members_count from the server replaces the local roster length");
});

test("a peer's bio and @handle are shown for a 1:1 — the data that had no screen before", async () => {
  const sheet = openSheet({
    kind: "dialog",
    peerId: 42,
    members: [],
    title: "Анна",
    subtitle: "в сети",
    loadChat: () => Promise.resolve<ChatInfoDetail>({}),
    loadUser: () => Promise.resolve<ChatInfoProfile>({ bio: "Люблю чай", username: "anna" }),
  });
  await settle();
  const node = root(sheet);
  assert.deepEqual(byClass(node, "gc-info-fact-value").map((n) => n.textContent), ["Люблю чай", "@anna"]);
  assert.equal(byClass(node, "gc-info-member").length, 0, "a 1:1 has no roster section");
});

test("the peer's @handle is printed once, with the label a person deserves", async () => {
  // Seen on the 390x844 screenshot (2026-07-30): a 1:1 chat carries the peer's @handle as its own
  // `username`, so the chat read and the profile read returned the same string and the sheet stacked
  // it twice — «Публичная ссылка» above «Имя пользователя». Both halves of the fix are pinned: the
  // label follows the chat kind, and any later fact repeating a value already on screen is dropped.
  const sheet = openSheet({
    kind: "dialog",
    peerId: 42,
    members: [],
    title: "Пётр Смирнов",
    subtitle: "был(а) в 01:48",
    loadChat: () => Promise.resolve<ChatInfoDetail>({ username: "uxbob97382" }),
    loadUser: () => Promise.resolve<ChatInfoProfile>({ username: "uxbob97382", bio: "" }),
  });
  await settle();
  const node = root(sheet);
  assert.deepEqual(byClass(node, "gc-info-fact-value").map((n) => n.textContent), ["@uxbob97382"]);
  assert.deepEqual(byClass(node, "gc-info-fact-label").map((n) => n.textContent), [i18n.t("chatInfo.username")]);
});

test("a group still calls its handle a public link", async () => {
  const sheet = openSheet({ loadChat: () => Promise.resolve<ChatInfoDetail>({ username: "testgroup" }) });
  await settle();
  assert.deepEqual(byClass(root(sheet), "gc-info-fact-label").map((n) => n.textContent), [i18n.t("chatInfo.link")]);
});

test("a failed read degrades to one quiet line instead of replacing the sheet with an error", async () => {
  const sheet = openSheet({ loadChat: () => Promise.reject(new Error("offline")) });
  await settle();
  const node = root(sheet);
  assert.equal(byClass(node, "gc-info-name")[0]?.textContent, "Тестовая группа", "the content the caller supplied survives");
  assert.equal(byClass(node, "gc-info-status")[0]?.textContent, i18n.t("chatInfo.partial"));
});

test("a read that lands after close() cannot repaint a dead sheet", async () => {
  let release!: (d: ChatInfoDetail) => void;
  const sheet = openSheet({ loadChat: () => new Promise<ChatInfoDetail>((ok) => { release = ok; }) });
  sheet.close();
  release({ about: "поздний ответ", members_count: 9 });
  await settle();
  assert.equal(byClass(root(sheet), "gc-info-fact-value").length, 0);
});

test("both dictionaries define every chatInfo key the sheet asks for", () => {
  const src = readFileSync(resolve(here, "../src/screens/chat_info.ts"), "utf8");
  const keys = new Set([...src.matchAll(/i18n\.t\("(chatInfo\.[a-zA-Z.]+)"\)/g)].map((m) => m[1]!));
  keys.add("chatInfo.open"); // used by the feed header
  for (const role of ["owner", "admin"]) keys.add(`chatInfo.role.${role}`); // built by template literal
  assert.ok(keys.size >= 8, `expected the sheet to use several keys, found ${keys.size}`);
  for (const key of keys) {
    assert.ok(key in ru, `ru.ts is missing ${key}`);
    assert.ok(key in en, `en.ts is missing ${key}`);
  }
});

// ---- 3. the reaction hit slop ---------------------------------------------------------------------

test("a reaction keeps its 26px paint and gains a 44px target", () => {
  assert.equal(decl(".gc-reaction::after", "content"), '""', "the slop needs a rendered pseudo-element");
  assert.equal(decl(".gc-reaction::after", "position"), "absolute");
  const inset = decl(".gc-reaction::after", "inset");
  assert.equal(inset, "-10px 0", "vertical slop only; horizontal slop would overlap the 4px gap between chips");

  // Reproduce the measurement rather than trusting the string: padding box = chip - 2*border.
  const chipHeight = 26; // .gc-reaction min-height, styles.css
  const border = 1; // .gc-reaction border-width, styles.css
  const slop = Math.abs(Number(/^(-?\d+)px/.exec(inset!)![1]));
  const target = chipHeight - 2 * border + 2 * slop;
  assert.equal(target, 44, `the live target must be 44px, arithmetic gives ${target}px`);
});

test("the slop is invisible: it may not paint a background or a border", () => {
  const rule = /\.gc-reaction::after\s*\{([^}]*)\}/.exec(v52)![1]!;
  assert.doesNotMatch(rule, /(^|;)\s*(background|border(?!-radius)|box-shadow)\s*:/, "growing the target must not grow the ink");
});

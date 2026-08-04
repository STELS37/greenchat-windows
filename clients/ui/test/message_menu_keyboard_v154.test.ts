// clients/ui/test/message_menu_keyboard_v154.test.ts — V154: the overflow menu that focuses a heading.
//
// message_menu.ts is the most-used secondary surface in the app: long-press a message and you get
// reply, copy, forward, pin, delete; tap the header's «…» and you get the chat's own actions. It
// already does most of what it owes a keyboard: Escape closes, close() hands the caret back to
// `previouslyFocused`, and the siblings of its layer are made `inert`, so the greyed-out conversation
// leaves both the tab order and the accessibility tree. It also takes focus when it opens:
//
//     host.append(layer);
//     setBackgroundInert(true);
//
//     const first = list.firstChild as { focus?: () => void } | null;
//     first?.focus?.();
//
// `list.firstChild` is the flaw. Items may carry a `heading`, and the first item that introduces one
// gets a `<div class="gc-msgmenu-group" role="presentation">` inserted BEFORE it. When the first
// entry in the menu is such an item, `list.firstChild` is that heading — and a heading is not a
// focusable element. `HTMLElement.focus()` exists on every element and does nothing on one that
// cannot take focus; it reports nothing either. So the caret does not move.
//
// Which would be survivable on its own, except for the line directly above it. The button that opened
// the menu lives in a sibling subtree that `setBackgroundInert(true)` has just inerted, and a browser
// blurs a focused element the instant it becomes inert. Caret nowhere, menu unannounced, background
// unreachable: a complete dead end, reachable today. feed_screen.ts builds its overflow menu as
//
//     [video call?] [search?] [support?] ...cacheMenuItems()
//
// where only the cache items carry a heading. A wide window (search not folded) on a chat that cannot
// be called (a group, Saved Messages), in a shell that wires `cachePolicy` but not `onOpenSupport`,
// leaves the cache items as the ONLY entries — so the heading is first.
//
// The second half is conformance. The panel says `role="menu"` and its buttons say `role="menuitem"`,
// which promises assistive technology that arrow keys walk the list. The only key this surface has
// ever handled is Escape.
//
// Note on the harness: ./dom_stub.ts used to let any node become activeElement, so focusing a
// non-focusable <div> looked like it worked and this defect could not be expressed at all. The stub
// now refuses exactly as a browser does (V154). That repair alone moved no existing verdict —
// 1047/1047 before and after — so what fails below is the product's answer.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { installDomStub, dispatchDocument, StubNode } from "./dom_stub.ts";
import type { MessageMenuItem } from "../src/screens/message_menu.ts";

installDomStub();

const { openMessageMenu } = await import("../src/screens/message_menu.ts");
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

interface Doc { activeElement: StubNode | null }
const active = (): StubNode | null =>
  (globalThis as unknown as { document: Doc }).document.activeElement;

interface Opened {
  host: StubNode;
  layer: StubNode;
  opener: StubNode;
  feed: StubNode;
  handle: ReturnType<typeof openMessageMenu>;
}

const PLAIN: MessageMenuItem[] = [
  { id: "reply", label: "Reply", glyph: "reply", run: () => {} },
  { id: "copy", label: "Copy", glyph: "copy", run: () => {} },
  { id: "delete", label: "Delete", glyph: "trash", danger: true, run: () => {} },
];

// Exactly the shape feed_screen.ts's cacheMenuItems() produces: every entry under one heading, and
// nothing else in the menu.
const HEADED: MessageMenuItem[] = ["auto", "always", "never"].map((mode) => ({
  id: `cache-${mode}`,
  label: `Cache: ${mode}`,
  glyph: "layers",
  heading: "Media cache",
  checked: mode === "auto",
  run: () => {},
}));

/**
 * A host laid out the way a screen actually is: a column that already holds the focused control, with
 * the menu layer appended beside it. That sibling relationship is the whole point — it is what
 * `setBackgroundInert` reaches for, and what makes a stranded caret unrecoverable.
 */
function openSheet(items: MessageMenuItem[] = PLAIN, quick = true): Opened {
  const host = new StubNode("div");
  const feed = new StubNode("div");
  const opener = new StubNode("button");
  feed.append(opener);
  host.append(feed);
  opener.focus();

  const handle = openMessageMenu({
    i18n,
    host: host as unknown as HTMLElement,
    ...(quick ? { quickReactions: ["👍"], onReact: () => {} } : {}),
    items,
  });
  return { host, layer: handle.root as unknown as StubNode, opener, feed, handle };
}

/** Everything the arrows should walk, in reading order: the reaction strip, then the actions. */
const ring = (s: Opened): StubNode[] =>
  s.layer.findAll((n) => {
    const role = n.getAttribute("role");
    return role === "menuitem" || role === "menuitemradio";
  });

/** Only the action rows — a reaction is a menu item too, but it is not one of the listed actions. */
const actions = (s: Opened): StubNode[] => s.layer.findAll((n) => n.hasAttribute("data-action"));

test("V154: the background goes inert, so the caret cannot be left behind in it", () => {
  const s = openSheet();
  assert.equal(
    s.feed.getAttribute("inert"),
    "",
    "the column behind is inerted while the sheet is open — correct, existing behaviour, and exactly " +
      "why the caret may not be left standing in it",
  );
  s.handle.close();
});

test("V154: a menu of plain items takes the caret (the case that already worked)", () => {
  const s = openSheet();
  assert.ok(
    s.layer.contains(active()),
    "with no headings, list.firstChild is a real <button> and focus lands on it",
  );
  s.handle.close();
});

test("V154: a menu whose first entry has a group heading strands the caret", () => {
  const s = openSheet(HEADED, false);
  assert.notEqual(
    active(),
    null,
    "the opener was inerted the line before focus was attempted; if focus() was a no-op the caret is " +
      "on nothing at all",
  );
  assert.ok(
    s.layer.contains(active()),
    'list.firstChild here is the <div role="presentation"> heading, which no browser will focus — so ' +
      "the menu opens unannounced, with the caret nowhere and every route back inerted. This is " +
      "feed_screen.ts's overflow menu on a wide window, in a chat that cannot be called, in a shell " +
      "with a cache policy and no support link",
  );
  s.handle.close();
});

test("V154: the caret lands on the first real action, not on a decoration", () => {
  const s = openSheet(HEADED, false);
  assert.equal(
    active(),
    actions(s)[0],
    "a menu focuses its first item — that is the platform's own convention and what a screen reader " +
      "reads out as «1 of 3». A heading is not an item",
  );
  s.handle.close();
});

test("V154: ArrowDown steps through the items", () => {
  const s = openSheet(PLAIN, false);
  const items = actions(s);
  assert.ok(items.length >= 3, "the fixture has reply/copy/delete");
  items[0]!.focus();
  dispatchDocument("keydown", { key: "ArrowDown" });
  assert.equal(
    active(),
    items[1],
    'the panel says role="menu" and its buttons say role="menuitem" — a promise to assistive ' +
      "technology that arrows walk the list. The only key this surface ever handled was Escape",
  );
  dispatchDocument("keydown", { key: "ArrowDown" });
  assert.equal(active(), items[2], "…and keeps stepping");
  s.handle.close();
});

test("V154: the item ring wraps in both directions", () => {
  const s = openSheet(PLAIN, false);
  const items = actions(s);
  items[items.length - 1]!.focus();
  dispatchDocument("keydown", { key: "ArrowDown" });
  assert.equal(active(), items[0], "past the last item is the first, not the inerted screen behind");
  dispatchDocument("keydown", { key: "ArrowUp" });
  assert.equal(active(), items[items.length - 1], "and back again");
  s.handle.close();
});

test("V154: Home and End reach the ends of a long menu without a walk", () => {
  const s = openSheet(PLAIN, false);
  const items = actions(s);
  items[1]!.focus();
  dispatchDocument("keydown", { key: "End" });
  assert.equal(active(), items[items.length - 1], "End is the shortcut to «Delete» at the bottom");
  dispatchDocument("keydown", { key: "Home" });
  assert.equal(active(), items[0], "Home is the way back to the top of a menu that scrolls");
  s.handle.close();
});

test("V154: the quick-reaction strip is part of the ring, not a separate island", () => {
  const s = openSheet();
  const reaction = s.layer.find((n) => n.hasClass("gc-msgmenu-reaction"))!;
  assert.equal(
    ring(s)[0],
    reaction,
    'a role="menu" may only own menu items, so the emoji buttons must be items and must come first',
  );
  reaction.focus();
  dispatchDocument("keydown", { key: "ArrowDown" });
  assert.equal(
    active(),
    actions(s)[0],
    "arrowing down off the emoji strip must reach the actions below it — the strip is the first row " +
      "of this menu, not a place to get stuck",
  );
  s.handle.close();
});

test("V154: Escape still closes and still gives the caret back", () => {
  const s = openSheet();
  dispatchDocument("keydown", { key: "ArrowDown" });
  dispatchDocument("keydown", { key: "Escape" });
  assert.equal(s.host.children.includes(s.layer), false, "the sheet is gone");
  assert.equal(
    active(),
    s.opener,
    "close() has always restored `previouslyFocused`; moving focus on open must not break that — the " +
      "person goes back to the message they were reading",
  );
  assert.equal(s.feed.getAttribute("inert"), null, "and the screen is interactive again");
});

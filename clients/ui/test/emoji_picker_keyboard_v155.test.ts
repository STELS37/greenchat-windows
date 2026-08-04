// clients/ui/test/emoji_picker_keyboard_v155.test.ts — V155: the emoji panel a keyboard cannot use.
//
// The composer's emoji button declares `aria-haspopup="dialog" aria-expanded`, and the panel it opens
// declares `role="dialog"`, `role="listbox"` for the glyph grid and `role="tablist"` for the category
// strip. Four ARIA contracts, and the file handles exactly one key: Escape, on the document.
//
// Measured on a freshly built composer (var/tmp witness, archived in probe-before.txt):
//
//   panel closed →   3 tab stops in the whole composer
//   panel open   → 101 tab stops: 90 emoji + 8 category tabs + the original 3
//
// and because `emoji.root` is mounted BEFORE the row that holds the button (composer.ts builds
// `[banner, emoji.root, row]`), the entire panel lies BEHIND its own trigger in the tab order. The
// button is stop #98; the first emoji is stop #0. Reaching 😀 from the button costs 98 Shift+Tab
// presses, and walking the page FORWARD you meet all 90 glyphs before you reach the message field.
//
// Opening moves no focus at all — `aria-expanded` flips to "true" while the caret sits on the button —
// so the "dialog" both ends promise is announced and then never arrives. And Escape while the caret is
// on a glyph hides the panel out from under it: `.gc-emoji-panel[hidden] { display: none }`, so a
// browser blurs the cell and the caret lands on <body>. That is the V154 dead end in a new surface.
//
// This file pins the contract the three declared roles already promise: focus enters on open and comes
// back on close, one tab stop per region instead of one per glyph, and arrows that move.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createEmojiPicker, rowStride, EMOJI_GROUPS } from "../src/screens/emoji_picker.ts";
import { createComposer } from "../src/screens/composer.ts";
import { focusableWithin } from "../src/a11y.ts";
import { installDomStub, dispatchDocument, StubNode } from "./dom_stub.ts";

const i18n = createI18n({ locale: "en", dicts: { en, ru } });

interface Doc { body: StubNode; activeElement: StubNode | null }
const doc = (): Doc => (globalThis as unknown as { document: Doc }).document;
const active = (): StubNode | null => doc().activeElement;

/** A body with one focusable control standing in for the composer's emoji button. */
function stage(): { body: StubNode; opener: StubNode } {
  installDomStub();
  const body = new StubNode("body");
  doc().body = body;
  const opener = new StubNode("button");
  body.append(opener);
  opener.focus();
  return { body, opener };
}

interface Panel {
  opener: StubNode;
  root: StubNode;
  picker: ReturnType<typeof createEmojiPicker>;
}

function openPicker(recents: string[] = []): Panel {
  const { body, opener } = stage();
  const store = new Map<string, string>();
  if (recents.length > 0) store.set("gc.emoji.recent", JSON.stringify(recents));
  const picker = createEmojiPicker({
    i18n,
    onPick: () => {},
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
    },
  });
  const root = picker.root as unknown as StubNode;
  body.append(root);
  picker.open();
  return { opener, root, picker };
}

const options = (root: StubNode): StubNode[] => root.findAll((n) => n.getAttribute("role") === "option");
const tabsOf = (root: StubNode): StubNode[] => root.findAll((n) => n.getAttribute("role") === "tab");

/**
 * The product listens for arrows on the PANEL, not on the document: while the picker is open the
 * caret may equally be in the message field behind it, and a document-level arrow handler would steal
 * the caret keys of a textarea the person is still typing in. In a browser the keydown starts on the
 * focused cell and bubbles up to the panel; the stub has no bubbling, so the probe dispatches at the
 * node the product actually listens on. Returns whether the panel claimed the key.
 */
function press(node: StubNode, key: string): boolean {
  let prevented = false;
  node.dispatch("keydown", { key, preventDefault: () => { prevented = true; } });
  return prevented;
}

// ---- 1. the tab-order bill -------------------------------------------------------------------------

test("V155: opening the emoji panel does not turn the composer into a 101-stop corridor", () => {
  installDomStub();
  const body = new StubNode("body");
  doc().body = body;
  const composer = createComposer({
    i18n, onSubmit: () => {}, onDraft: () => {}, members: () => [], emojiStorage: null,
  });
  const root = composer.root as unknown as StubNode;
  body.append(root);

  const ring = (): StubNode[] => focusableWithin(root as unknown as HTMLElement) as unknown as StubNode[];
  const closed = ring().length;
  assert.equal(closed, 3, "a closed composer is the attach/emoji button, the field and Send");

  const emojiBtn = root.find((n) => n.hasClass("gc-composer-emoji"))!;
  emojiBtn.focus();
  emojiBtn.dispatch("click");

  const panel = root.find((n) => n.hasClass("gc-emoji-panel"))!;
  assert.equal(panel.hidden, false, "the click opened it");
  assert.ok(options(panel).length > 80, "…and painted a full group of glyphs");

  const open = ring().length;
  assert.ok(
    open <= closed + 2,
    `the panel is two regions — a glyph grid and a category strip — so it must cost the Tab key two ` +
      `stops, not one per glyph. Measured ${open} stops with it open against ${closed} closed: every ` +
      `emoji and every category is its own stop, and since the panel is mounted before the row that ` +
      `holds its button, all of them sit BEHIND the trigger. Reaching the first glyph costs ` +
      `${open - closed} Shift+Tab presses.`,
  );
});

// ---- 2. focus enters, and comes back ---------------------------------------------------------------

test("V155: opening the panel moves the caret into it", () => {
  const { root, opener } = openPicker();
  assert.notEqual(active(), opener, "the caret must leave the button that opened the panel");
  assert.ok(
    root.contains(active()),
    'the button says aria-haspopup="dialog" and the panel says role="dialog"; a dialog that never ' +
      "takes the caret is announced and then never arrives",
  );
});

test("V155: the panel states the modality it actually has", () => {
  const { root } = openPicker();
  assert.equal(
    root.getAttribute("aria-modal"),
    "false",
    "this panel is deliberately NOT modal — the message field behind it stays live so a person can " +
      "keep typing — and saying so is what separates it from the sheets V152/V153 made modal",
  );
});

test("V155: Escape from a glyph closes the panel and hands the caret back", () => {
  const { root, opener, picker } = openPicker();
  const cell = options(root)[0]!;
  cell.focus();
  assert.equal(active(), cell, "the caret is on a glyph");

  dispatchDocument("keydown", { key: "Escape" });
  assert.equal(picker.isOpen(), false, "Escape closes the panel");
  assert.equal(
    active(),
    opener,
    "`.gc-emoji-panel[hidden] { display: none }` — the cell the caret was on stops existing for the " +
      "keyboard the moment the panel hides, so a browser drops the caret on <body> and the next Tab " +
      "restarts at the top of the document. The caret belongs back on the button that opened this.",
  );
});

test("V155: closing while the caret is elsewhere leaves it alone", () => {
  const { root, picker } = openPicker();
  // Sending a message calls emoji.close() with the caret in the message field (composer.ts submit()),
  // and so does the composer's own Escape handler. Yanking it to the button then would be a new bug.
  const elsewhere = new StubNode("textarea");
  doc().body.append(elsewhere);
  elsewhere.focus();
  picker.close();
  assert.equal(active(), elsewhere, "a close that the caret was not part of must not move the caret");
  assert.ok(!root.contains(active()), "sanity: the caret really was outside the panel");
});

// ---- 3. one stop per region, not one per glyph -----------------------------------------------------

test("V155: the glyph grid is a single roving tab stop", () => {
  const { root } = openPicker();
  const cells = options(root);
  assert.ok(cells.length > 80, "a full group is painted");
  const stops = cells.filter((c) => c.getAttribute("tabindex") !== "-1");
  assert.equal(
    stops.length,
    1,
    `a role="listbox" promises one tab stop and arrows inside it; ${cells.length} native <button> ` +
      "options are 90 stops, which is why walking past an open panel takes 90 presses",
  );
});

test("V155: the category strip is a single roving tab stop", () => {
  const { root } = openPicker();
  const tabs = tabsOf(root);
  assert.equal(tabs.length, EMOJI_GROUPS.length, "one tab per catalog group, no recents seeded");
  const stops = tabs.filter((t) => t.getAttribute("tabindex") !== "-1");
  assert.equal(stops.length, 1, 'a role="tablist" is one tab stop; the arrows move between the tabs');
  assert.equal(
    stops[0]!.getAttribute("aria-selected"),
    "true",
    "and the stop is the SELECTED tab, so Tab lands where the person already is",
  );
});

// ---- 4. arrows that move ---------------------------------------------------------------------------

test("V155: Left/Right walk the glyphs and stop at the ends", () => {
  const { root } = openPicker();
  const cells = options(root);
  cells[0]!.focus();

  assert.ok(press(root, "ArrowRight"), "the panel claims the key so the grid does not scroll instead");
  assert.equal(active(), cells[1], "ArrowRight steps to the next glyph");
  assert.ok(press(root, "ArrowLeft"));
  assert.equal(active(), cells[0], "ArrowLeft steps back");
  assert.ok(press(root, "ArrowLeft"));
  assert.equal(active(), cells[0], "…and stops at the first rather than wrapping to the far end");
});

test("V155: Home and End reach the ends of the group", () => {
  const { root } = openPicker();
  const cells = options(root);
  cells[3]!.focus();
  assert.ok(press(root, "End"));
  assert.equal(active(), cells[cells.length - 1], "End is how a keyboard reaches a scrolled-off glyph");
  assert.ok(press(root, "Home"));
  assert.equal(active(), cells[0], "Home comes back");
});

test("V155: Up/Down step by a row, and by one when no layout has been measured", () => {
  const { root } = openPicker();
  const cells = options(root);
  cells[0]!.focus();
  // The grid is `repeat(auto-fill, minmax(44px, 1fr))`: the column count is a LAYOUT fact, not a
  // source fact, so it is read back from the cells. There is no layout here, so the honest step is 1 —
  // the plain one-dimensional listbox the role already promises. rowStride is unit-tested below for
  // the shapes a real browser reports.
  assert.ok(press(root, "ArrowDown"));
  assert.equal(active(), cells[1], "with no measurable row, Down behaves as Right rather than guessing");
  assert.ok(press(root, "ArrowUp"));
  assert.equal(active(), cells[0]);
});

test("V155: rowStride reads the column count out of the layout the browser produced", () => {
  assert.equal(rowStride([0, 0, 0, 44, 44, 44, 88]), 3, "three cells share the first row");
  assert.equal(rowStride([0, 0, 44, 44]), 2);
  assert.equal(rowStride([]), 1, "no cells");
  assert.equal(rowStride([0, 44, 88]), 1, "one per row");
  assert.equal(
    rowStride([0, 0, 0]),
    1,
    "every cell on one line means either a single-row grid or a grid nobody has laid out yet; ±1 is " +
      "correct for the first and the only honest answer for the second",
  );
  assert.equal(
    rowStride([undefined, undefined] as unknown as number[]),
    1,
    "no layout at all (a detached or display:none grid) must not be read as one enormous row",
  );
});

// ---- 5. the category strip ------------------------------------------------------------------------

test("V155: Left/Right switch category and keep the caret on the new tab", () => {
  const { root } = openPicker();
  const before = tabsOf(root);
  before[0]!.focus();
  assert.ok(press(root, "ArrowRight"), "the strip claims the key");

  const after = tabsOf(root);
  assert.equal(
    after[1]!.getAttribute("aria-selected"),
    "true",
    "the WAI-ARIA tabs pattern activates on arrow when revealing the panel is cheap — repainting a " +
      "grid of buttons is",
  );
  assert.equal(
    active(),
    after[1],
    "selecting a category rebuilds the whole strip, so the node the caret was on is destroyed; " +
      "without re-seating the caret on its replacement a browser drops it on <body>",
  );
  assert.equal(
    options(root)[0]!.textContent,
    EMOJI_GROUPS[1]!.emojis[0],
    "…and the grid below now shows the group that was selected",
  );
});

test("V155: the category strip wraps, the way the tabs pattern says", () => {
  const { root } = openPicker();
  tabsOf(root)[0]!.focus();
  assert.ok(press(root, "ArrowLeft"));
  const tabs = tabsOf(root);
  assert.equal(active(), tabs[tabs.length - 1], "Left from the first category reaches the last");
  assert.ok(press(root, "ArrowRight"));
  assert.equal(active(), tabsOf(root)[0], "…and Right comes back round");
});

test("V155: a seeded recents tab is part of the same ring", () => {
  const { root } = openPicker(["🔥", "🙂"]);
  const tabs = tabsOf(root);
  assert.equal(tabs.length, EMOJI_GROUPS.length + 1, "recents lead the strip");
  assert.equal(tabs[0]!.getAttribute("aria-selected"), "true", "and are the group shown on open");
  assert.equal(options(root).length, 2, "the two seeded glyphs");
  tabs[0]!.focus();
  assert.ok(press(root, "ArrowRight"));
  assert.equal(tabsOf(root)[1]!.getAttribute("aria-selected"), "true", "the ring includes recents");
});

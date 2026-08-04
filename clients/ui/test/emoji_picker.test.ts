// Unit tests for the composer emoji panel (UI redesign V7). The two decisions that can silently
// corrupt a draft — recents bookkeeping and caret insertion — are pure and tested directly; the panel
// itself is exercised against the shared DOM stub (installDomStub), the same way the other screen
// tests run under node:test without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDomStub, type StubNode } from "./dom_stub.ts";
import {
  pushRecent,
  insertAtCaret,
  parseRecents,
  RECENT_MAX,
  EMOJI_GROUPS,
  createEmojiPicker,
  type EmojiStorageLike,
} from "../src/screens/emoji_picker.ts";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";

const i18n = (): ReturnType<typeof createI18n> =>
  createI18n({ locale: "ru", dicts: { ru, en }, fallbackLocale: "en" });

function fakeStorage(seed: Record<string, string> = {}): EmojiStorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => { data[k] = v; },
  };
}

test("pushRecent moves a repeat pick to the front without duplicating it", () => {
  assert.deepEqual(pushRecent(["🔥", "👍"], "👍"), ["👍", "🔥"]);
  assert.deepEqual(pushRecent([], "👍"), ["👍"]);
});

test("pushRecent caps the list at the configured maximum", () => {
  const long = Array.from({ length: RECENT_MAX }, (_, i) => `e${i}`);
  const next = pushRecent(long, "new");
  assert.equal(next.length, RECENT_MAX);
  assert.equal(next[0], "new");
  assert.equal(next.includes(`e${RECENT_MAX - 1}`), false); // the oldest fell off
});

test("insertAtCaret splices at the caret and replaces a selection", () => {
  assert.deepEqual(insertAtCaret("ab", 1, 1, "🔥"), { value: "a🔥b", caret: 3 });
  assert.deepEqual(insertAtCaret("hello", 0, 5, "👍"), { value: "👍", caret: 2 });
  // Out-of-range offsets (a stale caret after an async draft restore) must clamp, never throw.
  assert.deepEqual(insertAtCaret("ab", 99, 99, "x"), { value: "abx", caret: 3 });
  assert.deepEqual(insertAtCaret("ab", -5, 1, "x"), { value: "xb", caret: 1 });
});

test("parseRecents rejects anything that is not a list of short glyphs", () => {
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents("not json"), []);
  assert.deepEqual(parseRecents('{"a":1}'), []);
  assert.deepEqual(parseRecents('["👍", 5, "", "way too long to be an emoji"]'), ["👍"]);
});

test("the catalog has no duplicate glyphs and no empty group", () => {
  const seen = new Set<string>();
  for (const group of EMOJI_GROUPS) {
    assert.ok(group.emojis.length > 0, `group ${group.key} is empty`);
    for (const e of group.emojis) {
      assert.equal(seen.has(e), false, `duplicate glyph ${e} in ${group.key}`);
      seen.add(e);
    }
  }
  assert.ok(seen.size > 250, `catalog too small: ${seen.size}`);
});

test("panel opens closed, paints a grid on open and reports picks", () => {
  installDomStub();
  const picked: string[] = [];
  const store = fakeStorage();
  const picker = createEmojiPicker({ i18n: i18n(), onPick: (e) => picked.push(e), storage: store });
  const root = picker.root as unknown as StubNode;

  assert.equal(picker.isOpen(), false);
  assert.equal(root.attrs["hidden"] !== undefined, true);
  assert.equal(root.findAll((n) => n.hasClass("gc-emoji-cell")).length, 0);

  picker.open();
  assert.equal(picker.isOpen(), true);
  const cells = root.findAll((n) => n.hasClass("gc-emoji-cell"));
  assert.ok(cells.length > 10);
  cells[0]!.dispatch("click");
  assert.deepEqual(picked, [EMOJI_GROUPS[0]!.emojis[0]]);
  assert.deepEqual(picker.recents(), [EMOJI_GROUPS[0]!.emojis[0]]);
  assert.equal(JSON.parse(store.data["gc.emoji.recent"]!)[0], EMOJI_GROUPS[0]!.emojis[0]);

  picker.close();
  assert.equal(picker.isOpen(), false);
});

test("seeded recents surface as the first tab and survive a reload", () => {
  installDomStub();
  const store = fakeStorage({ "gc.emoji.recent": JSON.stringify(["🔥", "👍"]) });
  const picker = createEmojiPicker({ i18n: i18n(), onPick: () => {}, storage: store });
  assert.deepEqual(picker.recents(), ["🔥", "👍"]);
  picker.open();
  const root = picker.root as unknown as StubNode;
  const cells = root.findAll((n) => n.hasClass("gc-emoji-cell"));
  assert.deepEqual(cells.slice(0, 2).map((c) => c.textContent), ["🔥", "👍"]);
});

test("switching a category tab repaints the grid", () => {
  installDomStub();
  const picker = createEmojiPicker({ i18n: i18n(), onPick: () => {}, storage: null });
  picker.open();
  const root = picker.root as unknown as StubNode;
  const tabs = root.findAll((n) => n.hasClass("gc-emoji-tab"));
  assert.equal(tabs.length, EMOJI_GROUPS.length); // no "recent" tab without history
  const before = root.findAll((n) => n.hasClass("gc-emoji-cell")).map((c) => c.textContent);
  tabs[2]!.dispatch("click");
  const after = root.findAll((n) => n.hasClass("gc-emoji-cell")).map((c) => c.textContent);
  assert.notDeepEqual(before, after);
  assert.deepEqual(after.slice(0, 3), [...EMOJI_GROUPS[2]!.emojis.slice(0, 3)]);
});

test("a storage that throws never breaks the panel", () => {
  installDomStub();
  const hostile: EmojiStorageLike = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("quota"); },
  };
  const picked: string[] = [];
  const picker = createEmojiPicker({ i18n: i18n(), onPick: (e) => picked.push(e), storage: hostile });
  picker.open();
  const cell = (picker.root as unknown as StubNode).findAll((n) => n.hasClass("gc-emoji-cell"))[0]!;
  cell.dispatch("click");
  assert.equal(picked.length, 1);
  assert.deepEqual(picker.recents(), [EMOJI_GROUPS[0]!.emojis[0]]);
});

test("open-state changes are reported so the trigger button can stay in sync", () => {
  installDomStub();
  const seen: boolean[] = [];
  const picker = createEmojiPicker({ i18n: i18n(), onPick: () => {}, storage: null, onOpenChange: (o) => seen.push(o) });
  picker.toggle();
  picker.toggle();
  picker.close(); // already closed → no extra event
  assert.deepEqual(seen, [true, false]);
});

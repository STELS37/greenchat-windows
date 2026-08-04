// clients/ui/test/visual_import_server_scroll_v145.test.ts — V145: «Импорт из Telegram» and
// «Сервер» hid their own controls below the viewport, and no finger could bring them back.
//
// Evidence (stand `gc-ui-stand`, own GC_DATA_DIR, port 9320; Chromium reproducing the Android
// WebView system font the way this project measures it — `--enable-text-autosizing` plus
// `-webkit-text-size-adjust`, mobile context, deviceScaleFactor 2; ru-RU, signed in; 320x568 at
// system font 2.0; probe `probes/finger_reach.mjs` of the outbox package, 2026-08-02). Each control
// was swiped at SIX times with a real touchStart/touchMove/touchEnd sequence, then hit-tested at
// its own centre:
//
//   route      control                          box before   after 6 swipes   hits itself
//   #/import   «Выбрать папку»                  y 838…949    y 838…949        no
//   #/import   «Выбрать ZIP-архив»              y 959…1070   y 959…1070       no
//   #/connect  переключатель автопереключения   y 633…679    y 633…679        no
//   #/connect  пояснение под переключателем     y 690…893    y 690…893        no
//
// The window is 568 px tall, so all four sit below it, and the probe found NO scrollable surface on
// either screen: the hosting section is `overflow-y: hidden`, so neither the window nor any
// ancestor scrolls. On #/import that meant one sentence cut mid-word and no buttons whatsoever —
// the entire purpose of the screen was unreachable. The same run carried its own positive control:
// `#/settings` scrolled 1309/1309 px by the identical gesture.
//
// Cause: both roots are plain `display: block` boxes of `height: 100%`, while every screen that
// behaves (`.gc-settings-index`, `.gc-settings-panel`, `.gc-state:only-child` after V128) is a flex
// column with a `min-height: 0; overflow-y: auto` child.
//
// This file pins the SHAPE, read out of the cascade rather than out of a comment: it parses
// redesign.css, keeps every rule that targets these five class names, and asks what the last
// declaration in document order actually says — which is what the browser applies, the rules being
// of equal specificity. So the test keeps its meaning if the block is renumbered, moved or merged,
// and it fails the moment someone drops the scrollport.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");

interface Rule {
  /** Selector list as written. */
  sel: string;
  /** Declarations of that block (inner blocks included, which nothing here uses). */
  decls: string;
  /** `@media …` chain the rule sits under, empty for an unconditional rule. */
  at: string;
}

/** Comments hold prose that mentions these very class names, so they go first. */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "");

/** Brace scanner: enough for this sheet (no nesting, no strings with braces). */
function collectRules(src: string): Rule[] {
  const out: Rule[] = [];
  const stack: { sel: string; start: number; at: string }[] = [];
  let preludeStart = 0;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") {
      const sel = src.slice(preludeStart, i).trim();
      const parentAt = stack.map((s) => s.sel).filter((s) => s.startsWith("@")).join(" ");
      stack.push({ sel, start: i + 1, at: parentAt });
      preludeStart = i + 1;
    } else if (c === "}") {
      const top = stack.pop();
      if (top && !top.sel.startsWith("@")) {
        out.push({ sel: top.sel, decls: src.slice(top.start, i), at: top.at });
      }
      preludeStart = i + 1;
    }
  }
  return out;
}

const rules = collectRules(stripComments(css));

/** Split a selector list on its TOP-LEVEL commas — commas inside `:is(...)` are not separators. */
function selectorList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      out.push(sel.slice(start, i));
      start = i + 1;
    }
  }
  out.push(sel.slice(start));
  return out;
}

/** The compound the rule actually styles: everything after the last top-level combinator. */
function subject(sel: string): string {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < sel.length; i += 1) {
    const c = sel[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (depth === 0 && (c === " " || c === "\t" || c === "\n" || c === ">" || c === "+" || c === "~")) {
      last = i + 1;
    }
  }
  return sel.slice(last);
}

/**
 * Every rule that styles `cls` ITSELF — the class must be the subject of at least one selector in
 * the list, not merely mentioned in an ancestor position.
 *
 * Matching the whole selector string was wrong and silently mis-reported the screen: on 2026-08-04
 * `:is(...) .gc-server-card > * { flex: 0 0 auto }` (V195, the rule that stops flexbox from deleting
 * the failover switch) made this file read the card's own `flex` as `0 0 auto` and fail — while a
 * browser never applies a `> *` rule to the parent. The same flaw made every `.gc-server-card
 * .gc-setting-list` declaration look like a declaration on the card.
 */
const rulesFor = (cls: string): Rule[] => {
  const token = new RegExp(`\\.${cls}(?![\\w-])`);
  return rules.filter((r) => selectorList(r.sel).some((one) => token.test(subject(one))));
};

/** What the browser ends up applying: the LAST declaration of `prop` in document order. */
function effective(cls: string, prop: string): { value: string | null; at: string } {
  let value: string | null = null;
  let at = "";
  for (const r of rulesFor(cls)) {
    const m = r.decls.match(new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`));
    if (m) {
      value = m[1].trim();
      at = r.at;
    }
  }
  return { value, at };
}

test("V145: both screen roots are flex columns, not clipping block boxes", () => {
  for (const root of ["gc-import", "gc-server"]) {
    assert.match(
      effective(root, "display").value ?? "",
      /flex/,
      `.${root} must be a flex column; a block box cannot hold a scrollport child`,
    );
    assert.match(effective(root, "flex-direction").value ?? "", /column/);
  }
});

test("V145: the import page is the scroll container and takes the free space", () => {
  assert.match(
    effective("gc-import-body", "overflow-y").value ?? "",
    /auto|scroll/,
    "the import body must be able to scroll — its two buttons live below the fold at font 2.0",
  );
  assert.equal(
    effective("gc-import-body", "min-height").value,
    "0",
    "without `min-height: 0` a flex item never shrinks below its content, so no scrollport appears",
  );
  assert.match(effective("gc-import-body", "flex").value ?? "", /^1\s+1\s+auto/);
  assert.match(
    effective("gc-import-body", "overscroll-behavior-y").value ?? "",
    /contain/,
    "a swipe past the end must not drag the shell behind it",
  );
});

test("V145: the server card scrolls but never grows into a full-screen panel", () => {
  assert.match(effective("gc-server-card", "overflow-y").value ?? "", /auto|scroll/);
  assert.equal(effective("gc-server-card", "min-height").value, "0");
  // `0 1` — may shrink, never grows: the card carries its own background, and a stretched card
  // would repaint the whole screen even when three rows are all it has to show.
  assert.match(
    effective("gc-server-card", "flex").value ?? "",
    /^0\s+1\s+auto/,
    "the card must only shrink into its scrollport, never grow",
  );
});

test("V145: header and status line are pinned, so the scrollport cannot squeeze them", () => {
  for (const pinned of ["gc-import-header", "gc-server-header", "gc-server-status"]) {
    assert.match(
      effective(pinned, "flex").value ?? "",
      /^0\s+0\s+auto/,
      `measured at 320 dp/font 1.3: an unpinned header shrank 66 -> 62 px and pushed its own title 2 px out of its box (.${pinned})`,
    );
  }
});

test("V145: an empty status line keeps exactly the gap it used to collapse", () => {
  // `p.gc-server-status` is empty until the address is saved. Block flow collapsed its top and
  // bottom margins through the empty box into ONE gap; a flex column does not collapse anything, so
  // the card and its 12 rows dropped a second 1em (measured: 13 boxes down 15 px on #/connect at
  // every width tried). Dropping the trailing margin while the line is empty restores the old
  // geometry at any font size — the probe `zerocost2.mjs` then reports not one moved box on
  // #/connect outside the scrollport itself.
  const emptyRules = rules.filter((r) => /\.gc-server-status:empty(?![\w-])/.test(r.sel));
  assert.ok(
    emptyRules.length > 0,
    "the empty status line needs a rule of its own, or flex layout adds a phantom 1em gap",
  );
  const decls = emptyRules.map((r) => r.decls).join(";");
  assert.match(
    decls,
    /margin-(?:block-end|bottom)\s*:\s*0(?:px)?\s*(?:;|$)/,
    "the empty line must not contribute a second gap under the header",
  );
  // `display: none` would do the same to the layout and take the live region out of the
  // accessibility tree with it, so «Сохранено» would be announced to nobody.
  assert.doesNotMatch(decls, /display\s*:\s*none/);
  assert.ok(
    emptyRules.every((r) => r.at === ""),
    "the collapse fix must hold at every width, like the flex layout that made it necessary",
  );
});

test("V145: the scrollport is unconditional, not gated behind a width or a font attribute", () => {
  // At 320 dp/font 1.3 and at 390 dp/font 2.0 the same screens cut TEXT rather than buttons; a fix
  // that only fired at `[data-gc-text-zoom="large"]`, or only inside a `@media` range, would leave
  // those cases clipped.
  for (const cls of ["gc-import-body", "gc-server-card"]) {
    const { at } = effective(cls, "overflow-y");
    assert.equal(at, "", `the scrollport of .${cls} must not depend on a media query (found ${at})`);
    const gated = rulesFor(cls).some(
      (r) => /overflow-y/.test(r.decls) && r.sel.includes("data-gc-text-zoom"),
    );
    assert.equal(gated, false, `the scrollport of .${cls} must not depend on the system font size`);
  }
});

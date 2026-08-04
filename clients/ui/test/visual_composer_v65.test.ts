// clients/ui/test/visual_composer_v65.test.ts — V65 regression guard.
//
// Defect, measured on the running client at the 390x844 touch profile
// (probes var/ux-audit/tools/m_composer_v65.mjs + m_grow_v65.mjs, 2026-07-30):
//
//   .gc-composer            390 x 63    padding 7px 10px 8px
//   .gc-composer-row        370 x 47    align-items: flex-end, gap 8px
//   .gc-composer-inputwrap  318 x 47    border 1px, padding-left 2px
//     .gc-composer-emoji     44 x 44    x=15  y=790    radius 50%          glyph 22
//     .gc-composer-input    224 x 44.2  x=59  y=790.8
//     .gc-composer-attach    44 x 44    x=283 y=791    radius 0 24 24 0    glyph 21
//   .gc-composer-send        44 x 46    x=336 y=790    radius 50%          glyph 20
//
// 1. THE VISIBLE ONE. The send button is a circle that is not round: 44 wide, 46 tall, with
//    `border-radius: 50%`, so it renders as an ellipse 2px out of true. The mechanism is two tokens
//    claiming one role — tokens.css declares BOTH `--gc-control-height: 46px` and
//    `--gc-touch-target: 44px`. The markup is `class="gc-btn gc-btn-accent gc-composer-send"`
//    (ui/src/screens/composer.ts), `.gc-btn` sets `min-height: var(--gc-control-height)`, and a
//    min-height of 46 outranks the button's own `height: 44px`. Nobody wrote 44x46 anywhere: the
//    shape is the arithmetic of two numbers that were never reconciled.
// 2. Its box was declared four times with four answers (42x42, 46x46, round-vs-token, 44x44); the
//    paperclip three times (42x42, 44x44, 40x42) and the emoji twice (40x40, floored to 44). Three
//    sibling controls of ONE role — a bare icon action in the input row — and nine box declarations.
// 3. Their glyphs were 22px, 21px and 20px: three sizes for one role, lined up 8px apart where the
//    eye reads them as one row.
// 4. The paperclip's radius was `0 24px 24px 0` — a D, not a disc — between two circles.
// 5. The row was 47px tall and nobody chose 47 either: `.gc-composer-emoji` carried
//    `margin: 0 0 1px 2px`, so the row was as tall as whatever it happened to contain — the same
//    defect V63 removed from the top bars. That 1px also put the three controls on three different
//    top edges (790 / 791 / 790).
// 6. The field itself was 44.2px, not 44: the page's line-height is 1.48, so 11 + 22.2 + 11 landed
//    0.2px past its three neighbours and dragged the pill and the row with it.
// 7. The growth cap was a bare `160` in JS (`Math.min(textarea.scrollHeight, 160)`), a third number
//    in a row measured in 44s and 22s, so a full field ended mid-line.
//
// Reference (Telegram for Android master, ChatActivityEnterView.java, read 2026-07-30):
//   `public static final int DEFAULT_HEIGHT = 44;` — ONE constant for the whole input row. Eighteen
//   call sites lay their control out as `createFrame(DEFAULT_HEIGHT, DEFAULT_HEIGHT)`: emojiButton,
//   attachButton, scheduledButton, botButton, audioVideoButtonContainer, cancelBotButton,
//   sendButtonBlockedByTypingView, expandStickersButton... every control is the same square, and the
//   pressed background is a round rect of radius dp(19) on it, i.e. a disc.
//   The send glyph is `R.drawable.send_plane_24` — 24dp, the size Material states for a bare icon
//   action (mtrl_navigation_item_icon_size / design_bottom_navigation_icon_size).
//   `messageEditText.setMaxLines(6)` — the growth cap is a line count, not a pixel height.
//
// The guard is textual against the source, like V63's and V64's: the fix is that ONE declaration
// derived from ONE token owns the boxes of all three controls. A rendering assertion would still
// pass on a build where nine separate literals happen to agree today and drift apart tomorrow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const composerTs = readFileSync(resolve(here, "../src/screens/composer.ts"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every top-level rule of the sheet, in source order, as [selector, declarations, index]. */
const rules: Array<{ selector: string; decl: string; at: number }> = (() => {
  const out: Array<{ selector: string; decl: string; at: number }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < bare.length; i += 1) {
    const ch = bare[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const head = bare.slice(0, start);
        const selector = head.slice(head.lastIndexOf("}") + 1).replace(/^[^}]*?;/g, "").trim();
        if (!selector.startsWith("@")) out.push({ selector, decl: bare.slice(start + 1, i), at: start });
      }
    }
  }
  return out;
})();

/** Rules naming a class, matched on a whole class-name boundary. */
const naming = (...names: string[]): typeof rules =>
  rules.filter((r) => names.every((n) => new RegExp(`\\.${n}(?![\\w-])`).test(r.selector)));

test("the composer's box is one token, and it is the touch target", () => {
  assert.match(
    tokens,
    /--gc-touch-target:\s*44px\s*;/,
    "44 is the reference's DEFAULT_HEIGHT and the row's unit of measure — it must stay a named decision",
  );
});

test("all three input-row controls are one square, declared once, from that token", () => {
  const boxes = rules.filter(
    (r) =>
      /\.gc-composer-send(?![\w-])/.test(r.selector) &&
      /(^|[\s;{])height:\s*var\(--gc-touch-target\)\s*(;|$)/m.test(r.decl),
  );
  assert.equal(boxes.length, 1, "one box for one role: nine declarations is how 44x46 happened");
  const { selector, decl, at } = boxes[0]!;
  for (const sibling of ["gc-composer-emoji", "gc-composer-attach"]) {
    assert.match(
      selector,
      new RegExp(`\\.${sibling}(?![\\w-])`),
      `${sibling} must share the SAME rule, or it can be given a different box later`,
    );
  }
  for (const prop of ["width", "height", "min-width", "min-height"]) {
    assert.match(
      decl,
      new RegExp(`${prop}:\\s*var\\(--gc-touch-target\\)\\s*(;|$)`, "m"),
      `${prop} must come from the token; the 46px min-height floor of .gc-btn is what deformed the circle`,
    );
  }
  assert.match(decl, /border-radius:\s*50%\s*(;|$)/m, "a disc, like every sibling in the reference");
  assert.match(decl, /margin:\s*0\s*(;|$)/m, "the emoji's `margin: 0 0 1px 2px` is what made the row 47px tall");
  assert.match(decl, /align-self:\s*flex-end\s*(;|$)/m, "three controls, one bottom edge");

  // Order is the fix's whole mechanism: the earlier per-button literals are still in the sheet
  // (they are the desktop-era rules) and lose only because this rule comes after them.
  const earlier = rules.filter(
    (r) =>
      r.at < at &&
      /\.gc-composer-(send|attach|emoji)(?![\w-])/.test(r.selector) &&
      /(^|[\s;{])(width|height):\s*\d/m.test(r.decl),
  );
  assert.ok(earlier.length > 0, "sanity: the superseded literals are expected to still be present");
  const later = rules.filter(
    (r) =>
      r.at > at &&
      /\.gc-composer-(send|attach|emoji)(?![\w-])/.test(r.selector) &&
      !/\.gc-icon(?![\w-])/.test(r.selector) && // the glyph is sized separately, and is not the box
      /(^|[\s;{])(width|height|min-width|min-height|margin):\s*\d*\.?\d+px/m.test(r.decl),
  );
  assert.deepEqual(
    later.map((r) => r.selector),
    [],
    "no layer after this one may restore a hand-written box for a control of this row",
  );
});

test("the three glyphs are one size, the reference's 24dp", () => {
  const glyphRules = rules.filter(
    (r) => /\.gc-composer-(send|attach|emoji)(?![\w-])/.test(r.selector) && /\.gc-icon(?![\w-])/.test(r.selector),
  );
  const sized = glyphRules.filter((r) => /(^|[\s;{])width:\s*24px\s*(;|$)/m.test(r.decl));
  assert.equal(sized.length, 1, "22 / 21 / 20 was three answers to one question; 24 must be stated exactly once");
  const { selector, decl, at } = sized[0]!;
  for (const sibling of ["gc-composer-emoji", "gc-composer-attach", "gc-composer-send"]) {
    assert.match(selector, new RegExp(`\\.${sibling}(?![\\w-])`), `${sibling}'s glyph must be sized by the same rule`);
  }
  for (const axis of ["width", "height"]) {
    assert.match(decl, new RegExp(`${axis}:\\s*24px\\s*(;|$)`, "m"), `the glyph's ${axis} is the reference's 24dp`);
  }
  // As with the box: the superseded 20/21/22px rules are still in the sheet and lose on order alone.
  assert.deepEqual(
    glyphRules.filter((r) => r.at > at).map((r) => r.selector),
    [],
    "no layer after this one may resize one of the three glyphs on its own",
  );
});

test("the pill's ring is decoration and spends no layout height", () => {
  const pill = naming("gc-composer-inputwrap").filter((r) => /(^|[\s;{])border:\s*0\s*(;|$)/m.test(r.decl));
  assert.equal(pill.length, 1, "the 1px border is what made a 44px pill 46px tall around a 44px control");
  assert.match(
    pill[0]!.decl,
    /box-shadow:\s*inset 0 0 0 1px/,
    "an inset ring paints the same line without joining the box model",
  );
  const focus = naming("gc-composer-inputwrap").filter((r) => /:focus-within/.test(r.selector) && r.at > pill[0]!.at);
  assert.equal(focus.length, 1, "the focus ring must move to box-shadow with it, or focus regrows the row");
  assert.match(focus[0]!.decl, /box-shadow:\s*inset 0 0 0 1px/, "focus is a ring, not a border");
});

test("the row's height is stated from the control box, not inherited from its tallest child", () => {
  const row = naming("gc-composer-row").filter((r) => /min-height:\s*var\(--gc-touch-target\)\s*(;|$)/m.test(r.decl));
  assert.equal(row.length, 1, "47px was nobody's decision — exactly the defect V63 removed from the top bars");
  assert.match(row[0]!.decl, /align-items:\s*flex-end\s*(;|$)/m, "a growing field grows upward, off a fixed bottom edge");
});

test("the field's own box is the control box by construction", () => {
  const field = naming("gc-composer-input").filter((r) =>
    /line-height:\s*calc\(var\(--gc-touch-target\)\s*\/\s*2\)/.test(r.decl),
  );
  assert.equal(field.length, 1, "11 + 22.2 + 11 = 44.2 is how the field outgrew its three neighbours by 0.2px");
  const { decl } = field[0]!;
  assert.match(
    decl,
    /padding-block:\s*calc\(var\(--gc-touch-target\)\s*\/\s*4\)/,
    "half the box for the line and a quarter for each inset add back to exactly the box",
  );
  assert.match(decl, /min-height:\s*var\(--gc-touch-target\)\s*(;|$)/m, "an empty field is one control box tall");
  assert.match(
    decl,
    /max-height:\s*calc\(var\(--gc-touch-target\)\s*\/\s*2\s*\*\s*6\s*\+\s*var\(--gc-touch-target\)\s*\/\s*2\)/,
    "the cap is six LINES (the reference's setMaxLines(6)) expressed in the same unit as the box",
  );
});

test("no pixel growth cap survives in the composer's script", () => {
  assert.ok(
    !/Math\.min\(\s*textarea\.scrollHeight\s*,\s*\d+\s*\)/.test(composerTs),
    "a bare pixel cap in JS is a fourth number in a row measured in 44s and 22s, and it capped mid-line",
  );
  assert.match(
    composerTs,
    /textarea\.style\.height\s*=\s*`\$\{textarea\.scrollHeight\}px`/,
    "the script follows the content; the limit belongs with the rest of the box, in CSS",
  );
});

// clients/ui/test/visual_avatar_zoom_v120.test.ts — V120: an avatar disc is a fixed box, so its
// monogram must not follow the Android system font size out of the circle.
//
// Numbered V120 and not V119 because clients/ui/test/visual_chat_row_zoom_v119.test.ts already
// holds V119; the evidence for THIS rule lives in var/ux-audit/v119/ (probes
// var/ux-audit/tools/m_monofit_v119.mjs and m_callavatar_v119.mjs).
//
// Measured on the signed superapp artifact (sha256 c53407eb…, device gc-android-p0, redroid Android,
// `wm density 540` = 320 dp, ru-RU, DE2, 2026-08-02). Every number below is the width the engine
// PAINTED, cross-checked against the model to 0 px on all nine surfaces and reconciled with
// `scrollWidth` (a centred disc reports (client + painted) / 2) to 0 px:
//
//   surface                  box  type  worst REAL monogram  system 2.0  verdict before this rule
//   .gc-avatar                54  20px  «ДG» 57.5            font 40px   CUT 1.8 px per side
//   .gc-avatar.gc-call-…      54  20px  «КД» 56.0            font 40px   CUT 1.0
//   .gc-feed-avatar           32  13px  «ДG» 37.4            font 26px   CUT 2.7
//   .gc-info-avatar           96  34px  «ДG» 97.7            font 68px   CUT 0.9
//   .gc-bubble-avatar         30  11px  «КД» 30.8            font 22px   CUT 0.4
//   .gc-info-member-avatar    38  14px  «КД» 39.3            font 28px   CUT 0.6
//   .gc-profile-avatar        64  20px  «АК» 53.1            font 40px   fits (cuts «ЩЩ» above 31.1)
//   .gc-callscreen-avatar    116  40px  «БТ» 97.5            font 80px   fits by 4 px, «ЩЩ» needs 163
//   .gc-account-card-avatar   52  20px  «АК» 26.7            font 20px   already pinned by V118
//
// After the rule, on the same running artifact with the declarations injected verbatim:
//   system font 2.0 — six CUT verdicts became zero, the call disc went 80 -> 56 px, the account card
//                     did not move (V118 still wins on source order)
//   system font 1.3 — all nine discs byte-identical to the shipped build (diff empty), call disc 52
//
// The ceiling invents nothing: it is the product's own FONT_SCALE_MAX, i.e. what the in-app font
// preference at its top setting already renders on a device with the system font at 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FONT_SCALE_MAX } from "../src/theme.ts";

const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");

/** The declaration block that follows the FIRST mention of `sel` in `source`. */
function blockFor(source: string, sel: string): string {
  const idx = source.indexOf(sel);
  assert.notEqual(idx, -1, `styles.css must contain ${sel}`);
  const open = source.indexOf("{", idx);
  const close = source.indexOf("}", open);
  assert.ok(open !== -1 && close !== -1, `${sel} must have a declaration block`);
  return source.slice(open + 1, close);
}

/** The selector text preceding the FIRST mention of `sel`, split into its top-level forms. */
function selectorFormsFor(source: string, sel: string): string[] {
  const idx = source.indexOf(sel);
  assert.notEqual(idx, -1, `styles.css must contain ${sel}`);
  const selector = source.slice(source.lastIndexOf("}", idx) + 1, source.indexOf("{", idx));
  // commas inside :is(...) separate matched classes, not rules — blank the groups out, keeping the
  // same length so the offsets still address the untouched text
  const flat = selector.replace(/\([^()]*\)/g, (group) => "(".padEnd(group.length - 1, " ") + ")");
  const forms: string[] = [];
  let cursor = 0;
  for (let i = 0; i < flat.length; i += 1) {
    if (flat[i] === ",") {
      forms.push(selector.slice(cursor, i));
      cursor = i + 1;
    }
  }
  forms.push(selector.slice(cursor));
  return forms;
}

/** Every disc that carries a MEASURED design type, and the type measured for it. */
const MEASURED_TYPE: ReadonlyArray<readonly [string, string]> = [
  [".gc-avatar", "20px"],
  [".gc-profile-avatar", "20px"],
  [".gc-info-avatar", "34px"],
  [".gc-info-member-avatar", "14px"],
  [".gc-feed-avatar", "13px"],
  [".gc-bubble-avatar", "11px"],
  // V121. This disc was first left out on the claim that it "is not painted at 320, 390 or 430 dp".
  // Only portrait had been looked at: the matrix on artifact 0bd24b11… paints it in LANDSCAPE at 390
  // and 430 dp. Its monogram is one character (app.ts `displayName.slice(0, 1).toUpperCase()`), and
  // measured inside the real disc on the device at 430 dp landscape, system font 2.0, box 38 px:
  //   in-app scale 1.0, font 30px — «Щ» 31.0  «Ж» 30.6  «Ш» 28.9  «😀» 37.4        fits
  //   in-app scale 1.4, font 42px — «Щ» 43.4  «Ж» 42.9  «Ш» 40.4  «😀» 52.3        CUT 2.7/side
  // 15px is not a guess: --gc-fs-15 is `calc(15px * var(--gc-font-scale))` (clients/ui/src/
  // tokens.css) and the device shows 15px with the system font at 1.
  [".gc-shell-account-avatar", "15px"],
  // V150. The Bot Center shipped after this rule and joined none of its families. Both of its discs
  // hold ONE character (clients/ui/src/screens/bots_screen.ts:555 and :651 —
  // `bot.name.trim().slice(0, 1).toUpperCase()`), and the cut here is VERTICAL, which is why the
  // horizontal matrix above could not have caught it. Measured on the stand at 320 dp, system font
  // 2.0, ink taken with a Range inside the LIVE element (probe bots_defect_scan.mjs of the outbox
  // package 2026-08-03-bot-center-system-font):
  //   .gc-bot-avatar        box 48  type 20px -> font 40px  content 48x59 — 11 px of line box below the rim
  //   .gc-bot-avatar-large  box 48  type 24px -> font 48px  content 40x71 — 8 px out, and the disc
  //                         itself squeezed to 40.1 px wide (fixed by `flex` in bot_center.css)
  // 20px and 24px are not guesses: `--gc-fs-20` and `--gc-fs-24` are what the `.gc-bot-avatar` and
  // `.gc-bot-avatar-large` rules of bot_center.css give the two discs, and the stand shows exactly
  // 20px and 24px on the device with the system font at 1.
  // Only the base class is listed in the capped rule: the hero disc carries BOTH classes and
  // overrides nothing but the type.
  [".gc-bot-avatar", "20px"],
];

test("V120: every capped disc states the type that was measured on the device", () => {
  for (const [sel, type] of MEASURED_TYPE) {
    const declared = new RegExp(`\\n${sel.replace(".", "\\.")} \\{ --gc-disc-type: (\\d+px); \\}`).exec(css);
    assert.ok(declared, `${sel} must declare its measured design type as --gc-disc-type`);
    assert.equal(
      declared![1],
      type,
      `${sel} was measured at ${type} on the signed artifact; a different number here is a guess`,
    );
  }
  assert.match(
    css,
    /\.gc-callscreen-avatar \{ --gc-disc-literal: 40px; \}/,
    "the call screen states a literal px and never followed the in-app preference, so it is separate",
  );
});

test("V120: the ceiling is the product's own maximum, not a new invention", () => {
  const root = /:root \{ --gc-disc-zoom-max: ([\d.]+); \}/.exec(css);
  assert.ok(root, "the ceiling must be one named variable, not repeated in each rule");
  assert.equal(
    Number(root![1]),
    FONT_SCALE_MAX,
    "the ceiling must track FONT_SCALE_MAX in clients/ui/src/theme.ts, or the two drift apart",
  );
});

test("V120: the cap is a ceiling over the in-app preference, never a replacement for it", () => {
  const rule = blockFor(css, ":is(.gc-avatar, .gc-profile-avatar, .gc-info-avatar");
  assert.match(rule, /font-size:\s*min\(/, "the smaller of preference and ceiling is what renders");
  assert.match(
    rule,
    /calc\(var\(--gc-disc-type, 20px\) \* var\(--gc-font-scale, 1\)\)/,
    "at system zoom 1 the user's in-app font preference must still size the monogram",
  );
  assert.match(
    rule,
    /calc\(var\(--gc-disc-type, 20px\) \* var\(--gc-disc-zoom-max, 1\.4\) \/ var\(--gc-sys-text-zoom, 1\)\)/,
    "the ceiling divides by the measured system zoom, because that is what multiplies the text",
  );
  const call = blockFor(css, ":root[data-gc-text-zoom] .gc-callscreen-avatar");
  assert.match(
    call,
    /min\(\s*var\(--gc-disc-literal, 40px\),/,
    "the call disc has no in-app term to preserve: it never followed the preference",
  );
  assert.match(
    call,
    /var\(--gc-disc-literal, 40px\) \* var\(--gc-disc-zoom-max, 1\.4\) \/ var\(--gc-sys-text-zoom, 1\)/,
    "same ceiling as every other disc, so one number governs all nine",
  );
});

test("V120: nothing applies to a device left at the default system font", () => {
  const rules = [
    ":is(.gc-avatar, .gc-profile-avatar, .gc-info-avatar",
    ":root[data-gc-text-zoom] .gc-callscreen-avatar", // the bare second form, not the token line
  ];
  for (const sel of rules) {
    const forms = selectorFormsFor(css, sel);
    assert.equal(forms.length, 2, `${sel} needs exactly the shell-scoped form and the bare one`);
    for (const form of forms) {
      assert.ok(
        form.includes(":root[data-gc-text-zoom]"),
        "every form must be gated on the attribute the product only publishes when the system zooms text",
      );
    }
    assert.ok(
      forms.some((form) =>
        form.includes(":is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer)"),
      ),
      "0-4-0 is required: redesign.css loads later and its strongest competing rule is 0-3-0",
    );
  }
});

test("V120: the account card keeps V118's stricter pin, which only source order can guarantee", () => {
  const capped = css.indexOf(":is(.gc-avatar, .gc-profile-avatar, .gc-info-avatar");
  const pinned = css.indexOf(":root[data-gc-text-zoom] .gc-account-card-avatar");
  assert.notEqual(pinned, -1, "V118 must still pin the account card");
  assert.ok(
    capped !== -1 && capped < pinned,
    "the card carries .gc-avatar and matches the cap at the same 0-4-0; its box holds the worst pair " +
      "only to 24.9 px, under the 28 px the cap allows, so V118 must stay LAST and win",
  );
  assert.match(
    blockFor(css.slice(pinned), ".gc-account-card-avatar"),
    /font-size:\s*calc\(20px \/ var\(--gc-sys-text-zoom, 1\)\)/,
    "V118's pin must survive this change unedited",
  );
});

test("V120: no disc is capped on an unmeasured guess", () => {
  const forms = selectorFormsFor(css, ":is(.gc-avatar, .gc-profile-avatar, .gc-info-avatar");
  const measured = MEASURED_TYPE.map(([sel]) => sel);
  // Per FORM, not on the joined text. A disc dropped from the first, shell-scoped form still shows
  // up in the joined string while silently losing the 0-4-0 that beats redesign.css — a mutation
  // that did exactly that passed an earlier version of this test.
  for (const form of forms) {
    const capped = (form.match(/\.gc-[a-z-]*avatar/g) ?? []).filter((s, i, a) => a.indexOf(s) === i);
    for (const sel of capped) {
      assert.ok(
        measured.includes(sel),
        `${sel} is capped but no design type was measured for it on the device; a rule with an ` +
          "unmeasured constant in it is a guess",
      );
    }
    for (const sel of measured) {
      assert.ok(
        capped.includes(sel),
        `${sel} was measured as cut and must be capped in EVERY form of the rule, missing from: ` +
          form.trim(),
      );
    }
  }
});

// clients/ui/test/auth_form_v50.test.ts — V50 regression guards for the sign-in / sign-up screens.
//
// Context. Every redesign pass before this one walked the AUTHENTICATED screens, so the two screens a
// new person actually sees first still shipped the original 2019-era form. Measured on the running
// client at the 390x844 touch profile (var/ux-audit/tools/probe_auth.mjs), the sign-up screen had four
// arithmetic defects, and each of them is pinned below so the next stylesheet edit cannot quietly
// bring them back:
//
//   1. The --gc-fs-* integer type ramp added in V10 was scoped to `.gc-superapp`, i.e. to the logged-in
//      shell. The pre-login screens kept `calc(0.66 * …)` multipliers and resolved to 12 distinct
//      sizes, 9 of them fractional (10.56 / 12.16 / 12.48 / 13.12 / 13.5 / 13.8 / 15.2 / 21.6 / 26.4).
//   2. The card measured 1032 px tall in an 844 px viewport, because each of four fields carried a
//      caption row, a slab and a PERMANENT hint paragraph. The primary button was always below the
//      fold. Fix: the label moved inside the plate and the hint became conditional — but the hint node
//      must stay in the DOM, because aria-describedby points at it.
//   3. Each required field printed "ОБЯЗАТЕЛЬНО" in 10.56 px uppercase. DESIGN_V4 §Auth requires
//      "формы остаются простыми"; requiredness belongs in aria-required, not in decoration.
//   4. The consent checkboxes were 18x18 px next to two underlined links. DESIGN_V4 §6 and WCAG 2.5.5
//      both set the floor at 44x44 for the row.
//
// What must NOT be "simplified" away, and is therefore asserted as a contract rather than a style:
//   * both consent checkboxes stay real controls — docs/legal/tos.md records that age confirmation
//     "uses a checkbox", so this is a legal capture mechanism, not chrome;
//   * `placeholder=" "` on every auth input is load-bearing: :placeholder-shown is the only CSS signal
//     that tells an empty plate from a filled one, which is what drives the floating label.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
const tokens = readFileSync(resolve(here, "../src/tokens.css"), "utf8");
const screen = readFileSync(resolve(here, "../src/screens/auth_screen.ts"), "utf8");

// Only the V50 section is policed. Earlier layers are frozen history, migrated screen by screen.
const V50_HEADER = "V50 — the first screen a human sees";
const v50 = (() => {
  const at = redesign.indexOf(V50_HEADER);
  assert.notEqual(at, -1, "the V50 layer must exist in redesign.css");
  // Comments are stripped before anything here parses a declaration. Every layer in this file
  // documents the defect it fixes by quoting the OLD value ("the UA default h2 { font-size: 1.5em }"),
  // and the fractional-size guard below matched that prose, failing on a layer that had done nothing
  // wrong. A comment is not a declaration.
  return redesign.slice(at).replace(/\/\*[\s\S]*?\*\//g, "");
})();

/** Resolve a `var(--gc-fs-N)` reference to its pixel value as declared in tokens.css. */
const rampPx = (name: string): number => {
  const m = new RegExp(`--gc-fs-${name}:\\s*calc\\((\\d+)px \\* var\\(--gc-font-scale\\)\\)`).exec(tokens);
  assert.ok(m, `--gc-fs-${name} is used by V50 but not declared in tokens.css`);
  return Number(m![1]);
};

/** Value of `prop` from the first rule whose selector contains `selector` AND declares that prop.
 *  A selector can legitimately appear in several V50 rules (the type-ramp block sets font-size, the
 *  geometry block sets sizes), so "first rule wins" would read the wrong one. */
const decl = (selector: string, prop: string): string | null => {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^{}]*\\{([^}]*)\\}`, "g");
  for (const rule of v50.matchAll(re)) {
    const hit = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule[1]!);
    if (hit) return hit[1]!.trim();
  }
  return null;
};

test("1. the pre-login screens are typed from the integer ramp, never from a fractional multiplier", () => {
  const strays = [...v50.matchAll(/font-size:\s*([\d.]*\.[\d]+)(rem|px|em)/g)].map((m) => m[1]! + m[2]!);
  assert.deepEqual(strays, [], `V50 must size text via var(--gc-fs-*); found fractional sizes: ${strays.join(", ")}`);

  const used = [...new Set([...v50.matchAll(/var\(--gc-fs-(\d+)\)/g)].map((m) => m[1]!))];
  assert.ok(used.length >= 8, `expected the ramp to reach most auth text, only ${used.length} steps used`);
  for (const step of used) assert.equal(rampPx(step), Number(step), `--gc-fs-${step} must resolve to ${step}px`);

  // The field's own text must be >= 16px: iOS Safari force-zooms the page on focus below that.
  const inputFs = decl(".gc-auth .gc-field-box .gc-input", "font-size");
  assert.ok(inputFs, "the plated input must declare a font-size");
  const inputPx = rampPx(/--gc-fs-(\d+)/.exec(inputFs!)![1]!);
  assert.ok(inputPx >= 16, `auth inputs are ${inputPx}px; < 16px makes mobile Safari zoom the form on focus`);
});

test("2. the floating label cannot overlap the value it labels", () => {
  // Geometry the browser will compute: caption sits at `top`, is `--gc-fs-12 * line-height` tall, and
  // the input reserves `padding-top` above the text. The caption must fit inside that padding.
  const top = Number(/^(\d+)px/.exec(decl(".gc-auth .gc-field-label", "top")!)![1]!);
  // The caption's own size lives in the geometry rule, not in the earlier type-ramp rule for the same
  // selector, which is why every read goes through decl() instead of "first rule wins".
  const capPx = rampPx(/--gc-fs-(\d+)/.exec(decl(".gc-auth .gc-field-label", "font-size")!)![1]!);
  const leading = Number(/^([\d.]+)/.exec(decl(".gc-auth .gc-field-label", "line-height")!)![1]!);
  const padTop = Number(/^(\d+)px/.exec(decl(".gc-auth .gc-field-box .gc-input", "padding")!)![1]!);
  const capHeight = Math.ceil(capPx * leading);
  assert.ok(
    top + capHeight <= padTop,
    `caption occupies ${top}..${top + capHeight}px but the input only reserves ${padTop}px of padding — the label would sit on the typed text`,
  );

  // Raised is the DEFAULT state; the lowered (placeholder-like) state is the :has() override. A WebView
  // without :has() support then degrades to a plain labelled box instead of an overlap.
  const lowered = /:has\(\.gc-input:placeholder-shown\)\)?:not\(:focus-within\) \.gc-field-label \{([^}]*)\}/.exec(v50);
  assert.ok(lowered, "the empty+unfocused state must be expressed as a :has(:placeholder-shown) override");
  const loweredPx = rampPx(/font-size:\s*var\(--gc-fs-(\d+)\)/.exec(lowered![1]!)![1]!);
  assert.ok(loweredPx > capPx, `placeholder state (${loweredPx}px) must be larger than the raised caption (${capPx}px)`);

  // …which only works because the markup ships a blank placeholder on every auth input.
  assert.match(
    screen,
    /placeholder:\s*" "/,
    'auth inputs must be created with placeholder: " " — :placeholder-shown is the CSS signal the floating label depends on',
  );
});

test("3. requiredness is announced, not decorated", () => {
  assert.doesNotMatch(screen, /gc-field-badge/, "the auth markup must not emit a REQUIRED badge element");
  assert.doesNotMatch(screen, /auth\.required/, 'the "обязательно" badge string must be gone from the auth markup');
  assert.match(screen, /setAttribute\("aria-required", "true"\)/, "required fields must still expose aria-required");
  // The hint text stays reachable for assistive tech even while visually collapsed.
  assert.match(screen, /aria-describedby/, "field hints must remain wired via aria-describedby");
  assert.equal(decl(".gc-auth .gc-field-hint", "display"), "none", "hints must collapse by default");
  assert.ok(/\.gc-auth \.gc-field:focus-within \.gc-field-hint \{[^}]*display:\s*block/.test(v50), "…and appear while the field is in play");
});

test("4. consent rows are legal controls AND real touch targets", () => {
  // Contract: docs/legal/tos.md §93 records age confirmation as a checkbox. Two rows must exist.
  const rows = [...screen.matchAll(/class:\s*"gc-check"/g)];
  assert.equal(rows.length, 2, `expected exactly 2 consent checkbox rows, found ${rows.length}`);
  assert.match(screen, /legalInput/, "the terms/privacy consent input must stay in the markup");
  assert.match(screen, /ageInput/, "the age confirmation input must stay in the markup");

  const rowMin = Number(/(\d+)px/.exec(decl(".gc-auth .gc-check", "min-height")!)![1]!);
  assert.ok(rowMin >= 44, `consent row is ${rowMin}px tall; WCAG 2.5.5 and DESIGN_V4 §6 require >= 44`);
  const box = Number(/(\d+)px/.exec(decl(".gc-auth .gc-check input", "width")!)![1]!);
  assert.ok(box >= 22, `checkbox is ${box}px; the measured 18px default is a coin-flip tap`);

  const plate = Number(/(\d+)px/.exec(decl(".gc-auth .gc-field-box .gc-input", "min-height")!)![1]!);
  assert.ok(plate >= 48, `field plate is ${plate}px tall; a primary form control must clear 44px comfortably`);
});

test("5. nothing on the first screen has texture, and a clean form has no blank row", () => {
  const backdrop = /\.gc-auth::before,\s*\n\.gc-lock::before \{([^}]*)\}/.exec(v50);
  assert.ok(backdrop, "V50 must override the auth backdrop");
  assert.doesNotMatch(backdrop![1]!, /radial-gradient/, "the 34px dot-grid stipple must be gone — nothing else in the product has texture");

  // The form-wide error reserved min-height at all times, leaving a 23px hole above the submit button.
  const empty = /\.gc-auth \.gc-auth-error:empty \{([^}]*)\}/.exec(v50);
  assert.ok(empty, "the empty error line must collapse");
  assert.match(empty![1]!, /display:\s*none/);
  assert.match(empty![1]!, /min-height:\s*0/);
  // …but the node itself must still be rendered up-front, or role="alert" never announces.
  assert.match(screen, /role:\s*"alert"/, "the alert container must exist before the message arrives");
});

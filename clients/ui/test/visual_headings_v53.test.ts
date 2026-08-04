// clients/ui/test/visual_headings_v53.test.ts — V53 regression guards.
//
// Two defects, both measured on the running client at the 390x844 touch profile
// (/tmp/probe_headings.mjs and /tmp/probe_v53b.mjs, 2026-07-30), both of the same family: an element
// that nobody styled fell back to the browser's own 1990s defaults inside an otherwise redesigned app.
//
//   1. The licenses screen rendered a 22.5 px heading. 22.5 px is not a token and never was one — it
//      is the user-agent default `h2 { font-size: 1.5em }` resolved against the 15 px body size
//      (1.5 x 15 = 22.5). No rule in any stylesheet bound bare h1..h6, so EVERY heading written
//      without its own class rule silently inherited UA metrics, and every new screen re-introduced
//      the defect. The ramp is now attached to the elements themselves at element specificity
//      (0,0,1), which is below every class rule in the product: nothing already designed changes,
//      everything not yet designed is caught. Verified after the fix: the same heading measures
//      20 px.
//   2. `.gc-settings-title` was the last hand-typed size in the authenticated shell at 19 px, one
//      step off a ramp that has 17 and 20 and nothing between them. Verified after the fix: 20 px.
//   3. Four call sites (support_overlay.ts x2, report_overlay.ts, safety_screen.ts) render
//      `<input type="checkbox">` / `<input type="radio">` with no class at all. Those measured
//      13x13 px — the OS-painted control, i.e. the most literal "web form from 1999" element left in
//      the client. They are now drawn by the product. Verified after the fix on the Security screen:
//      20x20, `appearance: none`, 6 px radius. `.gc-toggle` MUST stay excluded: it is a switch, its
//      own rule has the same specificity (0,1,1), and this layer is appended later in the file, so
//      without `:not(.gc-toggle)` source order alone would silently turn every switch back into a
//      square box.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");
// Comments carry example values ("1.5em", "13x13"), so they are stripped before any rule is parsed.
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the LAST rule whose selector list matches `selector` exactly. */
const lastBlock = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  const hits = [...bare.matchAll(re)];
  assert.ok(hits.length > 0, `no rule found for selector "${selector}"`);
  return hits[hits.length - 1]![1]!;
};

/**
 * The app scope of the redesign layer, as a pattern rather than a literal. V55 widened every
 * descendant selector from `.gc-superapp x` to `:is(.gc-superapp, .gc-overlay, ...) x` so that
 * body-level sheets stop falling back to the legacy skin. This guard is about the SIZE the settings
 * title resolves to, not about how the scope is spelled, so it matches either form and only insists
 * that `.gc-superapp` is still part of it.
 */
const APP_SCOPE = String.raw`(?:\.gc-superapp|:is\([^)]*\.gc-superapp[^)]*\))`;

/** As `lastBlock`, but for a selector that lives behind the app scope. */
const lastScopedBlock = (tail: string): string => {
  const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\})\\s*${APP_SCOPE}\\s+${escaped}\\s*\\{([^}]*)\\}`, "g");
  const hits = [...bare.matchAll(re)];
  assert.ok(hits.length > 0, `no scoped rule found for selector "${tail}"`);
  return hits[hits.length - 1]![1]!;
};

const RAMP: Record<string, string> = {
  h1: "--gc-fs-24",
  h2: "--gc-fs-20",
  h3: "--gc-fs-17",
  h4: "--gc-fs-16",
  h5: "--gc-fs-15",
  h6: "--gc-fs-13",
};

test("every heading level is bound to the integer ramp, so none can fall back to the UA default", () => {
  for (const [tag, token] of Object.entries(RAMP)) {
    const block = lastBlock(tag);
    const m = /font-size:\s*var\((--gc-fs-\d+)\)/.exec(block);
    assert.ok(m, `${tag} must declare font-size from the ramp, found: ${block.trim()}`);
    assert.equal(m[1], token, `${tag} must use ${token} (a raw px here re-opens the 22.5px hole)`);
  }
});

test("the heading rules stay at element specificity so designed screens keep their own sizes", () => {
  // A selector like `.gc-superapp h2` would outrank `.gc-calls-heading h2` and silently reskin
  // screens this layer never measured. The guard is textual on purpose: it is the specificity, not
  // the value, that makes rule 1 safe.
  for (const tag of Object.keys(RAMP)) {
    const re = new RegExp(`(?:^|\\})\\s*${tag}\\s*\\{`, "g");
    assert.ok(re.test(bare), `${tag} must be styled as a bare element selector`);
  }
});

test("the settings title sits on the ramp instead of a hand-typed 19px", () => {
  const block = lastScopedBlock(".gc-settings-title");
  assert.match(block, /font-size:\s*var\(--gc-fs-20\)/, "the settings title must use --gc-fs-20");
  // The earlier rule still declares 19px; what matters is that the LAST word on the size is the token.
  const sizes = [...bare.matchAll(/\.gc-settings-title\s*\{[^}]*?font-size:\s*([^;]+);/g)].map((m) => m[1]!.trim());
  assert.equal(sizes[sizes.length - 1], "var(--gc-fs-20)", `last declared size was ${sizes[sizes.length - 1]}`);
});

test("bare checkboxes and radios are drawn by the product, never by the OS", () => {
  for (const sel of ['input[type="checkbox"]:not(.gc-toggle)', 'input[type="radio"]:not(.gc-toggle)']) {
    const first = new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`, "g");
    assert.ok(first.test(bare) || bare.includes(sel), `${sel} must be styled`);
  }
  // The shared base block declares the box; find it by its appearance reset.
  const base = /input\[type="checkbox"\]:not\(\.gc-toggle\),\s*input\[type="radio"\]:not\(\.gc-toggle\)\s*\{([^}]*)\}/.exec(bare);
  assert.ok(base, "the checkbox/radio base rule must list both types in one block");
  const block = base[1]!;
  assert.match(block, /appearance:\s*none/, "the OS control must be switched off");
  assert.match(block, /width:\s*20px/, "measured 20px after the fix");
  assert.match(block, /height:\s*20px/, "measured 20px after the fix");
});

test("the switch is excluded from the box rules, or every toggle turns back into a square", () => {
  const rules = [...bare.matchAll(/input\[type="(?:checkbox|radio)"\]([^{,]*)/g)].map((m) => m[1]!);
  assert.ok(rules.length > 0, "expected checkbox/radio rules");
  for (const tail of rules) {
    assert.ok(
      tail.includes(":not(.gc-toggle)"),
      `every checkbox/radio selector must exclude .gc-toggle, found "input[type=...]${tail}"`,
    );
  }
});

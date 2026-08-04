// clients/ui/test/visual_finance_tiles_narrow_v86.test.ts — V86 regression guard.
//
// Defect, measured on the signed direct APK on redroid 15 at 1080x2400 with `wm density 540`
// (= a 320 dp phone, the narrowest width the owner listed for the beta gate) and the system font
// left at the default 1.0, screenshot /root/gc-p0-w320-wallet.png:
//
//   wallet quick actions   4-up grid, tile ~53 dp wide, ~47 dp of usable width after padding
//   label "Addresses"      ~55 dp at --gc-fs-11 → the final "s" is cut off by the tile edge
//
// So this is NOT the system-font case (V85/text_zoom): it clips at the default font size purely
// because four fixed cells do not fit a 320 dp screen. The labels are single unbreakable words, so
// neither ellipsis nor wrapping can rescue them inside a 47 dp box — the row itself has to get
// fewer columns. Three columns give ~84 dp of usable width, which fits the longest label with room
// to spare, and the seven actions lay out 3+3+1 instead of 4+3.
//
// Textual guard: the rule, not a rendering, is the claim being frozen; the screen's contents depend
// on /v1/config and on the account's assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (name: string): string =>
  strip(readFileSync(resolve(here, `../../web/src/${name}`), "utf8"));
// main.ts loads styles.css and then redesign.css, so BOTH decide what the phone actually paints.
// The first version of this guard read styles.css alone and passed while the device still rendered
// four columns: `.gc-finance-actions` (0-1-0) in a media query cannot beat
// `:is(.gc-superapp, …) .gc-finance-actions` (0-2-0) in the layer loaded after it.
const sheets: Array<[string, string]> = [
  ["styles.css", read("styles.css")],
  ["redesign.css", read("redesign.css")],
];
const css = sheets[0]![1];

/** Bodies of every `@media (max-width: <=380px)` block of `sheet` that mentions `selector`. */
function narrowBlocksIn(sheet: string, selector: string): string {
  const out: string[] = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sheet))) {
    if (Number(m[1]) > 380) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < sheet.length && depth > 0) {
      if (sheet[i] === "{") depth += 1;
      else if (sheet[i] === "}") depth -= 1;
      i += 1;
    }
    const body = sheet.slice(re.lastIndex, i - 1);
    if (body.includes(selector)) out.push(body);
  }
  return out.join("\n");
}

/** Every rule that pins a column count on the plain action row, with the media context it sits in. */
function columnRules(): Array<{ sheet: string; selector: string; columns: number; narrow: boolean }> {
  const found: Array<{ sheet: string; selector: string; columns: number; narrow: boolean }> = [];
  for (const [name, sheet] of sheets) {
    const narrow = narrowBlocksIn(sheet, ".gc-finance-actions");
    const re = /([^{}]*?\.gc-finance-actions)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sheet))) {
      const selector = m[1]!.trim().replace(/\s+/g, " ");
      // `.gc-finance-actions.gc-market-actions` (the two-tile exchange hero) is a different row.
      if (/\.gc-finance-actions\./.test(selector)) continue;
      const cols = /grid-template-columns:\s*repeat\((\d+),/.exec(m[2]!);
      if (!cols) continue;
      found.push({
        sheet: name,
        selector,
        columns: Number(cols[1]),
        narrow: narrow.includes(m[0]!),
      });
    }
  }
  return found;
}

test("V86: at 320 dp the wallet quick actions drop to three columns", () => {
  const rules = columnRules();
  const wide = rules.filter((r) => !r.narrow);
  assert.ok(wide.length, "some rule must set the default column count");
  // Every scope that pins four columns needs its OWN narrow override: a later, more specific layer
  // silently reinstates the four-up row otherwise — which is exactly how the label kept clipping on
  // the device after the first fix.
  for (const rule of wide) {
    if (rule.columns < 4) continue;
    const override = rules.find(
      (r) => r.narrow && r.selector === rule.selector && r.columns === 3,
    );
    assert.ok(
      override,
      `\`${rule.selector}\` (${rule.sheet}) keeps ${rule.columns} columns at 320 dp: ` +
        "the same selector must be repeated inside a narrow media block with three columns, " +
        "or the more specific rule wins and the tile labels clip",
    );
  }
});

test("V86: the wide default stays four columns", () => {
  const base = /\.gc-finance-actions\s*\{([^}]*)\}/.exec(css);
  assert.ok(base);
  assert.match(base[1]!, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
});

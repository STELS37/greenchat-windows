// clients/ui/test/visual_landscape_pane_v106.test.ts — V106, B-P0-5 (rotation axis, owner directive
// 2026-07-30): the pane that was never given a height, so four of the five tabs lost their bottom.
//
// Evidence (signed APK versionCode 1000010, emulator 1080x2400 @ dpr 2.75, device WebView over CDP,
// 2026-07-31, landscape = 825 x 369 CSS px). Measured `clientHeight / scrollHeight`:
//
//   tab       .gc-superapp-stage   .gc-superapp-view   deepest element bottom   reachable?
//   Чаты      348 / 348            348 / 348           369                      yes
//   Звонки    348 / 568            568 / 568            578                     NO
//   Кошелёк   348 / 1495           1495 / 1495         1506                     NO
//   Биржа     348 / 722            722 / 722            733                     NO
//   Ещё       348 / 862            862 / 862           872                      NO
//
// `.gc-superapp-stage` clips (`overflow: hidden`, styles.css), so everything past 348 px was simply
// gone: no scrollbar, no page scroll, no gesture. On «Ещё» that hid the whole «Настройки и аккаунт»
// list — Профиль, Приватность, Безопасность, Лицензии and the sign-out row were unreachable in
// landscape. On «Кошелёк» 1147 px of wallet was unreachable.
//
// Cause: `.gc-superapp-view` is only given `height: 100%` inside `@media (max-width: 760px)`
// (styles.css). A phone in landscape is 825 px WIDE, so the rule missed, the section fell back to
// `height: auto`, grew to its content, and the stage clipped it. `.gc-settings { height: 100% }`
// then resolved against an auto-height parent, so the V73b scroll container (`.gc-settings-index`,
// `flex:1; min-height:0; overflow-y:auto`) never got a bounded frame to scroll inside.
//
// This is NOT landscape-only: the same measurement at 1280x800 clipped 67 px (stage 779 / view 846)
// and at 900x700 clipped 183 px. The single-pane shell has no height at any width above 760 px.
//
// Verified on the device with the rule injected live (same session, same route):
//
//   tab       scroll container         client / scroll   scrolled to bottom   last row visible
//   Звонки    .gc-calls-body           238 / 458         yes                  yes
//   Кошелёк   .gc-finance-body         190 / 1337        yes                  yes
//   Биржа     .gc-finance-body         190 / 565         yes                  yes
//   Ещё       .gc-settings-index       257 / 771         yes                  yes («Лицензии»)
//
// The guard is structural, not pixel-based: the numbers above are the pixels. It pins that the
// correction is unconditional (a `@media`-scoped fix would repeat the original mistake of keying a
// layout invariant on width) and that it still declares `min-height: 0`, without which a flex/grid
// child refuses to shrink below its content and the overflow simply moves one level up the chain.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const shortscreen = strip(read("../../web/src/shortscreen.css"));
const styles = strip(read("../../web/src/styles.css"));

/** Top-level rules only: everything inside any `@media { … }` block is removed first. */
function topLevel(css: string): Array<[string, string]> {
  let out = "";
  let depth = 0;
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("@media", i)) {
      // skip to the matching closing brace of this at-rule
      let j = css.indexOf("{", i);
      if (j < 0) break;
      depth = 1;
      j += 1;
      while (j < css.length && depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      i = j;
      continue;
    }
    out += css[i];
    i += 1;
  }
  const rules: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) rules.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return rules;
}

const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim() : null;
};

test("V106: the single-pane view is given a height outside any media query", () => {
  const rules = topLevel(shortscreen).filter(([sel]) => /\.gc-superapp-single[^,{]*\.gc-superapp-view/.test(sel));
  assert.ok(
    rules.length > 0,
    "the landscape/wide single-pane shell must get its height unconditionally — the defect was a " +
      "layout invariant keyed on `@media (max-width: 760px)`",
  );
  const body = rules.map(([, b]) => b).join(";");
  assert.equal(decl(body, "height"), "100%", "the pane must fill the stage that clips it");
  assert.equal(
    decl(body, "min-height"),
    "0",
    "without min-height:0 the child refuses to shrink and the overflow moves up the chain",
  );
});

test("V106: the gap it closes is still real in the shipped sheet", () => {
  // If styles.css ever grows an unconditional `.gc-superapp-view { height: … }`, this guard has
  // served its purpose and the comment above should be revisited rather than silently kept.
  const unconditional = topLevel(styles).some(
    ([sel, body]) => /\.gc-superapp-view/.test(sel) && decl(body, "height") !== null,
  );
  assert.equal(
    unconditional,
    false,
    "styles.css grants the pane a height only inside the phone-width media query — that is the gap",
  );
});

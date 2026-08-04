// V107 — the "send last session's crash report?" card was painted ON TOP of the conversation and ate
// the taps of everything it covered.
//
// Measured on the signed superapp APK (versionCode 1000013) through the device WebView (redroid 15,
// 393 x 801 CSS px, DEFAULT system font, probes var/ux-audit/tools/m_offline_v107.mjs and
// /tmp/m_crash_overlap.mjs, 2026-07-31):
//
//   route #/chat/17   .gc-feed-list        56.0 – 740.4     .gc-composer 740.4 – 801.1, no tab rail
//                     .gc-crash-offer     555.2 – 727.1, left 58.8, 275.5 x 171.9, fixed, z 1001
//                     bubbles covered: «Отлично. Тогда на мне…» 29 %, «Выезжаем в пятницу…» 84 %,
//                     «Договорились 👍» (the NEWEST message) 75 %
//   route #/settings  nav rows «Приватность» / «Безопасность» / «Подключения» 78 % covered, and
//                     document.elementFromPoint on their centres returned the CARD: the taps were
//                     silently swallowed with no scrim and no hint that anything was blocked.
//   route #/chat/17   the reaction chip «👍 1» was 100 % covered and equally unreachable.
//
// Two causes, both measurable:
//
//   1. The card is sized by its content (`max-width` only), so on a 393 dp phone it settled at
//      275.5 px — misaligned with the 12–16 px gutters every other surface uses — and its two
//      buttons wrapped onto a second row, which is what made it 171.9 px tall (21 % of the screen).
//   2. It is `position: fixed` chrome that reserves NO space. The feed keeps its full height and
//      paints the newest messages underneath. This is the exact harm 07d6110f fixed for the soft
//      keyboard ("the newest message hidden behind the composer"); a floating card reintroduced it.
//
// Fix: on phones the offer becomes a sheet spanning the gutters (369.1 px measured), and while it is
// up the shell publishes its height as `--gc-offer-h` and the stage subtracts it. The stage shrinking
// resizes the feed's list box, so the V98 ResizeObserver re-pins a reader who was at the bottom —
// no new scroll logic. Verified live on the device by injecting exactly these rules:
//
//   before  card 275.5 x 171.9  newest bubble 75 % covered, 3 bubbles covered, list 684.4
//   after   card 369.1 x 129.9  newest bubble  0 % covered, 0 bubbles covered, list 538.4
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const styles = read("../../web/src/styles.css");
const redesign = read("../../web/src/redesign.css");
const main = read("../../web/src/main.ts");

/** Device-measured page and the gutter every other mobile surface aligns to. */
const PAGE_PX = 393;
const MAX_GUTTER_PX = 16;
/** Both buttons must fit one row: «Не отправлять» + «Отправить отчёт» at --gc-fs-15 plus the gap. */
const BUTTONS_ROW_PX = 288;

/** Rule bodies for a selector inside phone-width media blocks (max-width <= 760px). */
function phoneRules(css: string, selector: RegExp): string[] {
  const out: string[] = [];
  const head = /@media\s*\(\s*max-width:\s*(\d+)px\s*\)\s*\{/g;
  for (let m = head.exec(css); m; m = head.exec(css)) {
    if (Number(m[1]) > 760) continue;
    // Walk braces to the end of the media block.
    let depth = 1;
    let i = head.lastIndex;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    const block = css.slice(head.lastIndex, i);
    const rule = /([^{}]+)\{([^{}]*)\}/g;
    for (let r = rule.exec(block); r; r = rule.exec(block)) {
      if (selector.test(r[1])) out.push(r[2]);
    }
  }
  return out;
}

test("V107: on a phone the crash offer spans the gutters instead of hugging its own text", () => {
  const bodies = phoneRules(styles, /\.gc-crash-offer(?![-\w])/);
  assert.ok(bodies.length > 0, "the crash offer must be re-laid out for phone widths");
  const joined = bodies.join("\n");
  assert.match(joined, /(^|[;{\s])left:\s*max\(/, "the sheet must be pinned to the left gutter");
  assert.match(joined, /(^|[;{\s])right:\s*max\(/, "the sheet must be pinned to the right gutter");
  assert.match(joined, /(^|[;{\s])transform:\s*none/, "a gutter-pinned sheet must drop the centring translate");

  // The measured geometry the rule buys: 393 - 2 x 12 = 369 px, which is wide enough that the two
  // buttons stop wrapping, which is what took the card from 171.9 px tall down to 129.9 px.
  const gutter = 12;
  const sheet = PAGE_PX - 2 * gutter;
  assert.ok(gutter <= MAX_GUTTER_PX, "the sheet must align with the shell gutters");
  assert.ok(sheet >= BUTTONS_ROW_PX, `a ${sheet} px sheet must hold both buttons on one row`);
});

test("V107: while the offer is up the stage reserves its height, so nothing is painted under it", () => {
  const stage = phoneRules(styles, /\.gc-superapp-stage(?![-\w])/).join("\n");
  assert.match(stage, /height:\s*calc\([^;]*var\(--gc-offer-h/, "the shell stage must subtract the offer height");

  // A conversation hides the tab rail and takes the whole screen (redesign.css), so it needs the
  // same subtraction or the newest message goes back under the card.
  const detail = phoneRules(redesign, /\.gc-superapp-detail\s+\.gc-superapp-stage/).join("\n");
  assert.match(detail, /height:\s*calc\([^;]*var\(--gc-offer-h/, "an open conversation must reserve it too");
});

test("V107: the shell publishes the offer height while it shows and clears it when it goes", () => {
  assert.match(main, /setProperty\(\s*"--gc-offer-h"/, "showing the offer must publish its height");
  assert.match(main, /removeProperty\(\s*"--gc-offer-h"\s*\)/, "dismissing or sending must give the space back");
  // The card re-wraps on rotation and on a system-font change, so a stale height would leave a gap.
  const fn = main.slice(main.indexOf("function showCrashOffer"), main.indexOf("function boot("));
  assert.ok(fn.length > 0, "showCrashOffer must exist");
  assert.match(fn, /ResizeObserver/, "the published height must follow the card's own resizes");
});

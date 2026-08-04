// clients/ui/test/visual_touch_target_v97.test.ts — V97 regression guard (owner directive
// 2026-07-30, pre-beta P1; the first of the two defects was handed over from the P0 emulator sweep,
// var/evidence/p0-beta-emulator/findings.md, section "P0-5 — ширины 320 / 390 / 430 px").
//
// Defect, measured twice: once on the emulator during P0, then reproduced and quantified on the
// stand at 390x844, deviceScaleFactor 2, ru-RU by var/ux-audit/tools/m_hit_v97.mjs, which walks
// every visible interactive box in chats / calls / more / wallet / exchange. Before the fix the
// sweep reported 18 boxes under the product's own 44 px floor, all of them on the call log:
//
//   1. `.gc-call-log-redial` rendered 40x40. It is the one action a call log exists for, it sits in
//      the right edge gutter where thumb accuracy is worst, and the row underneath opens the chat —
//      so a miss is not "nothing happened", it is "the wrong screen opened".
//   2. `.gc-call-log-tabs .gc-tab` rendered 41 px tall. The sheet does declare a 44 px floor for
//      `.gc-superapp .gc-tab`, but the shared chats/call-log rule is MORE specific and re-declared
//      40 px. The chats header survived only because a later rule happens to push it to 46 px; the
//      call log had no such patch. A floor that any later, more specific rule may silently undercut
//      is not a floor, which is why the value was fixed in the shared rule itself.
//
// What is pinned here: the two boxes keep a >= 44 px target, the shared strip rule keeps the floor
// rather than relying on a per-strip override, and the icon inside the redial stays 18 px so the
// fix cannot be "solved" by inflating the glyph instead of the target.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const redesign = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8");

const MIN_TOUCH_PX = 44;

/** Body of the LAST rule whose selector list contains `needle`, comments stripped. */
const ruleBody = (needle: string, opts: { exact?: boolean } = {}): string => {
  const bodies: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(redesign)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (!selector.includes(needle)) continue;
    if (opts.exact && !selector.split(",").some((s) => s.trim().endsWith(needle))) continue;
    bodies.push(m[2]);
  }
  assert.ok(bodies.length > 0, `no rule in redesign.css selects ${needle}`);
  return bodies.join("\n");
};

const px = (body: string, prop: string): number | null => {
  const hits = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*(-?[\\d.]+)px`, "g"))];
  if (hits.length === 0) return null;
  return Number(hits[hits.length - 1][1]);
};

test("V97: the call log redial keeps a full touch target", () => {
  const body = ruleBody(".gc-call-log-redial", { exact: true });
  const w = px(body, "width");
  const h = px(body, "height");
  assert.ok(w !== null && h !== null, "the redial must declare an explicit box");
  assert.ok(
    (w as number) >= MIN_TOUCH_PX,
    `redial width ${w}px is under the ${MIN_TOUCH_PX}px minimum touch target`,
  );
  assert.ok(
    (h as number) >= MIN_TOUCH_PX,
    `redial height ${h}px is under the ${MIN_TOUCH_PX}px minimum touch target`,
  );
});

test("V97: growing the target did not grow the glyph", () => {
  const svg = ruleBody(".gc-call-log-redial svg");
  assert.equal(px(svg, "width"), 18, "the redial icon stays 18px; only the hit area grows");
  assert.equal(px(svg, "height"), 18, "the redial icon stays 18px; only the hit area grows");
});

test("V97: the shared chats/call-log tab rule carries the floor itself", () => {
  const shared = /\.gc-chats-header \.gc-tab,\s*:is\([^)]*\) \.gc-call-log-tabs \.gc-tab \{([^}]*)\}/.exec(
    redesign,
  );
  assert.ok(shared, "the shared chats/call-log tab rule must still exist");
  const min = px(shared[1], "min-height");
  assert.ok(
    min !== null && min >= MIN_TOUCH_PX,
    `the shared strip rule declares min-height ${min}px; it outranks the sheet's own ` +
      `${MIN_TOUCH_PX}px floor, so anything smaller ships as a sub-minimum tab`,
  );
});

test("V97: no strip override drops a tab back under the floor", () => {
  const re = /([^{}]*\.gc-tab[^{},]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const offenders: string[] = [];
  while ((m = re.exec(redesign)) !== null) {
    const selector = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    if (selector.includes(".gc-tab-label") || selector.includes(".gc-tab-badge")) continue;
    for (const prop of ["height", "min-height"] as const) {
      const v = px(m[2], prop);
      if (v !== null && v < MIN_TOUCH_PX) {
        offenders.push(`${selector} { ${prop}: ${v}px }`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `every tab is a touch target and must stay >= ${MIN_TOUCH_PX}px:\n${offenders.join("\n")}`,
  );
});

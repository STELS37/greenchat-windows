// clients/ui/test/visual_call_log_v74.test.ts — V74 regression guard.
//
// Defect, measured on the running client at 390x844 with twelve seeded outcome rows (probes
// var/ux-audit/tools/m_calllog_v74.mjs, m_callgeom_v74.mjs, m_lead_v74.mjs, 2026-07-30, pointer parked
// off the page):
//
//   1. The screen named "Звонки" showed NO calls. The server has written an outcome row per call since
//      T-202 (finalize → {status, duration_sec, video}) and FEATURES §M2 says the log IS a selection
//      over them, but nothing selected them: the tab listed dialogs only. GET /v1/calls/history now
//      publishes the rows and this screen renders them.
//   2. Once rendered, nothing in either sheet matched `.gc-call-log-*`, so the browser's own button
//      defaults drew the log: rows 292x97, 225x97, 210x140 — a DIFFERENT width per row, grey
//      rgb(239,239,239) fill, 2px borders, the direction glyph stretched to 276x21 inline.
//   3. `.gc-calls-section { margin-top: 20px }` also applied to the FIRST section, so on a 844px phone
//      the first painted word sat at y=133.4 with 32px of pure air above it (wallet/exchange, whose
//      first child has no such margin, start their content at +10px).
//
// Pinned here: the log is a fixed grid (one width, one height per row), the alert tone is reserved for
// the unanswered incoming call, day labels are typographically demoted, the clock is tabular, and a
// first section never restates the body's own top gutter.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const legacy = strip(readFileSync(resolve(here, "../../web/src/styles.css"), "utf8"));
const screenSource = readFileSync(resolve(here, "../src/screens/calls_screen.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = [...rules(legacy), ...rules(redesign)];
const decl = (body: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, "i").exec(body);
  return m ? m[1]!.trim() : null;
};
const find = (test: (sel: string, body: string) => boolean): Array<[string, string]> =>
  all.filter(([s, b]) => test(s, b));

// ---- 1. the row is a grid, not a shrink-wrapped browser button ----

test("V74: every log row is one fixed grid, so twelve rows are one column", () => {
  const row = find((s, b) => /\.gc-call-log-row(?![-\w])/.test(s) && /display\s*:\s*grid/.test(b));
  assert.ok(row.length, "no rule makes .gc-call-log-row a grid — the browser's inline-block button wins");
  const body = row[0]![1];
  const cols = decl(body, "grid-template-columns");
  assert.ok(cols, "a grid without declared tracks still shrink-wraps to its own text");
  // mark | avatar | copy | clock — the copy column is the only elastic one, which is what makes a
  // long name shorten instead of widening the row.
  assert.match(cols!, /minmax\(\s*0\s*,\s*1fr\s*\)/, `the copy column must be the elastic one: ${cols}`);
  assert.equal(decl(body, "width"), "100%", "a row that is not full width cannot line up with its neighbours");
  assert.ok(decl(body, "min-height"), "rows of different heights read as separate cards, not a list");
});

test("V74: the row explicitly discards the user-agent button look", () => {
  const row = find((s, b) => /\.gc-call-log-row(?![-\w])/.test(s) && /display\s*:\s*grid/.test(b))[0]!;
  const body = row[1];
  // Measured defaults that produced the grey plates: border 2px, radius 0 and a grey background.
  assert.match(decl(body, "border") ?? "", /^0$/, "the 2px user-agent border must be zeroed");
  assert.match(decl(body, "background") ?? "", /none|transparent/, "the grey button fill must go");
  assert.equal(decl(body, "font"), "inherit", "a button that keeps the UA font shows 13.3px Arial next to 15px client text");
  assert.equal(decl(body, "text-align"), "start", "UA buttons centre their text; a list row is left-read");
});

test("V74: rows are separated by a hairline and the last one does not paint a dangling rule", () => {
  const row = find((s, b) => /\.gc-call-log-row(?![-\w])/.test(s) && /border-bottom\s*:\s*1px/.test(b));
  assert.ok(row.length, "no hairline between rows — the log reads as one paragraph");
  const last = find((s, b) => /\.gc-call-log-row:last-child/.test(s) && /border-bottom\s*:\s*0/.test(b));
  assert.ok(last.length, "the last row keeps a divider with nothing under it");
});

// ---- 2. the alert row ----

test("V74: only the missed row is alert-toned, and the tone is on the glyph and the name", () => {
  const arrow = find((s, b) => /\.gc-call-log-arrow\[data-dir="missed"\]/.test(s) && /--gc-danger/.test(b));
  assert.ok(arrow.length, "the missed glyph must carry the alert tone — that is what a log is scanned for");
  const name = find((s, b) => /\.gc-call-log-row-missed/.test(s) && /--gc-danger/.test(b));
  assert.ok(name.length, "the missed row's name must carry the tone too");
  // The whole plate must NOT be painted: a red band per missed call is noise, not signal.
  const plate = find((s, b) => /\.gc-call-log-row-missed(?![-\w])\s*\{?$/.test(s) && /background\s*:\s*[^;]*danger/.test(b));
  assert.equal(plate.length, 0, "a fully red row is a banner, not a list entry");
});

test("V74: an incoming and an outgoing call are told apart by tone as well as glyph", () => {
  const inbound = find((s, b) => /\.gc-call-log-arrow\[data-dir="in"\]/.test(s) && /color\s*:/.test(b));
  assert.ok(inbound.length, "the incoming mark has no tone of its own");
  assert.ok(
    screenSource.includes('"data-dir"'),
    "the screen must publish the direction as a data attribute — CSS cannot tone what markup does not say",
  );
});

// ---- 3. structure reads as structure ----

test("V74: the day label is demoted so it cannot be mistaken for a name", () => {
  const day = find((s, b) => /\.gc-call-log-day(?![-\w])/.test(s) && /font-size/.test(b))[0];
  assert.ok(day, "the day separator has no typography of its own (measured 15px, same as a name)");
  const size = decl(day![1], "font-size") ?? "";
  assert.match(size, /--gc-fs-1[12]|1[12]px/, `a day label must be smaller than a name: ${size}`);
  assert.ok(decl(day![1], "letter-spacing"), "tracking is what makes a small label read as structure");
  assert.match(decl(day![1], "color") ?? "", /muted|faint/, "a day label in body colour competes with data");
});

test("V74: the clock is tabular so times share a right edge", () => {
  const time = find((s, b) => /\.gc-call-log-time(?![-\w])/.test(s) && /tabular-nums/.test(b));
  assert.ok(time.length, "9:05 and 21:47 must align — proportional digits make the column ragged");
});

// ---- 4. the reclaimed lead ----

test("V74b: a first section does not restate the body's own top gutter", () => {
  const rule = find(
    (s, b) =>
      /:first-child/.test(s) &&
      /gc-calls-section|gc-finance-section/.test(s) &&
      /gc-calls-body|gc-finance-body/.test(s) &&
      /margin-top\s*:\s*0/.test(b),
  );
  assert.ok(rule.length, "the 20px separator margin is still applied above the first section (32px of air)");
  assert.match(decl(rule[0]![1], "padding-top") ?? "", /^0$/, "the section's own top padding stacks on the same gap");
});

test("V74b: the separation BETWEEN sections is untouched", () => {
  // The fix must be scoped to :first-child — a blanket margin:0 would glue the log to the People list.
  const blanket = find(
    (s, b) => /\.gc-calls-section(?![-\w])/.test(s) && !/:first-child/.test(s) && /margin-top\s*:\s*0(?:px)?\s*(?:;|$)/.test(b),
  );
  assert.equal(blanket.length, 0, `a rule zeroes the margin for ALL sections: ${blanket.map(([s]) => s).join(" | ")}`);
});

// ---- 5. the screen's own contract ----

test("V146: history failure stays local, but is never disguised as an empty log", () => {
  // A server without /v1/calls/history must not blank the People section. It must also not tell a
  // returning user that no calls exist: unknown and empty are different states.
  assert.doesNotMatch(
    screenSource,
    /calls\/history[^)]*\)\s*\.catch\(\(\)\s*=>\s*null\)/,
    "a failed history read must not be converted into the empty-page sentinel",
  );
  assert.match(screenSource, /historyFailure\s*=\s*\{\s*error:/, "the partial failure is retained explicitly");
  assert.match(
    screenSource,
    /section\.append\(failureState\(historyFailure\.error/,
    "the log section renders an honest retryable failure",
  );
  assert.match(
    screenSource,
    /body\.append\(renderLog\(\),\s*renderPeople\(chats\)\)/,
    "the independently loaded People section remains usable",
  );
});

test("V74: the empty log is a line inside its section, not the full-page V70 stage", () => {
  // V70 reserved `.gc-finance-empty:only-child { min-height: 100% }` for a screen with nothing at all.
  // Here the People section below is real content, so the empty log must stay small.
  assert.ok(screenSource.includes("gc-call-log-empty"), "the empty log must have its own class");
  const empty = find((s, b) => /\.gc-call-log-empty(?![-\w])/.test(s) && /padding/.test(b));
  assert.ok(empty.length, "the empty log has no styling of its own");
  const tall = find((s, b) => /\.gc-call-log-empty/.test(s) && /min-height\s*:\s*(100%|[2-9]\d\dpx)/.test(b));
  assert.equal(tall.length, 0, "the empty log must not reserve a stage above a section that has content");
});

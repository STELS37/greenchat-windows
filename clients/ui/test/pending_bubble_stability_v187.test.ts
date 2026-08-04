// V187 regression contract: an optimistic text bubble must not change geometry when the server echo
// replaces it. The delivery layer reserves the widest authoritative receipt state (double check),
// while the locale hook keeps the first and authoritative frames equivalent in both clock formats.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../../web/src/main.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../../web/src/message_delivery.css", import.meta.url), "utf8");

test("delivery geometry loads after the general feature styles", () => {
  const conference = main.indexOf('import "./conference.css";');
  const delivery = main.indexOf('import "./message_delivery.css";');
  const shortScreen = main.indexOf('import "./shortscreen.css";');
  assert.ok(conference >= 0, "the final general feature stylesheet must remain present");
  assert.ok(delivery > conference, "delivery geometry must load after general feature styles");
  assert.ok(shortScreen >= 0, "the independently guarded short-viewport correction layer must remain present");
});

test("document language follows both initial and runtime i18n locale", () => {
  assert.match(main, /document\.documentElement\.lang\s*=\s*locale/);
  assert.match(main, /applyDocumentLocale\(i18n\.locale\)/);
  assert.match(main, /i18n\.subscribe\(applyDocumentLocale\)/);
});

test("pending rows reserve the final time and check width without visible paint", () => {
  assert.match(css, /\.gc-bubble-row\[data-cmid\]\s+\.gc-bubble-body::after/);
  assert.match(css, /content:\s*"00:00 ✓✓"/);
  assert.match(css, /:root:lang\(en\)[\s\S]*content:\s*"00:00 PM ✓✓"/);
  assert.match(css, /visibility:\s*hidden/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.doesNotMatch(css, /transition\s*:/, "the fix must prevent reflow, not animate it away");
  assert.doesNotMatch(css, /animation\s*:/, "the fix must prevent reflow, not animate it away");
});

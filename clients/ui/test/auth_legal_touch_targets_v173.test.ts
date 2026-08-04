// V173 — the legal links inside the already finger-sized consent row were still tiny inline text.
//
// Chromium measurement on the real registration screen:
//   390x844, system text 130%: Terms 122.2x18 px, Privacy 101x18 px
//   320x568, system text 200%: Terms 155.2x38.3 px, Privacy 101x18 px
// The parent label was 44px, but the nested anchors own their own click action (open the legal
// document), so the checkbox row cannot donate its hit area to them. This guard pins the CSS shape;
// the rendered dimensions are independently checked by the Playwright evidence in the outbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const authSource = readFileSync(resolve(here, "../src/screens/auth_screen.ts"), "utf8");

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1]!.trim().replace(/\s+/g, " "), body: match[2]! }));
const anchorRules = rules.filter(({ selector }) => /\.gc-auth \.gc-check a(?![-\w])/.test(selector));

const lastDecl = (property: string): string | null => {
  let value: string | null = null;
  for (const { body } of anchorRules) {
    const hit = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(body);
    if (hit) value = hit[1]!.trim();
  }
  return value;
};

test("V173: each legal link owns a 44px touch target, not only its checkbox row", () => {
  assert.ok(anchorRules.length > 0, "the registration legal anchors must have a scoped rule");
  assert.equal(lastDecl("display"), "inline-flex", "the inline text must become a measurable atomic target");
  assert.equal(lastDecl("align-items"), "center", "the label stays vertically centred inside the enlarged target");
  const minHeight = Number(/([\d.]+)px/.exec(lastDecl("min-height") ?? "")?.[1]);
  assert.ok(Number.isFinite(minHeight) && minHeight >= 44, `legal link target is ${minHeight || 0}px; expected >=44px`);
});

test("V173: wrapped legal links never overlap each other's hit area", () => {
  // At 200% text the links wrap onto separate lines. Negative block margins make those 44px boxes
  // overlap, and the later Privacy link then steals the centre of the Terms link. Rendered geometry
  // is covered by the Playwright evidence; this source guard prevents reintroducing that cause.
  const margin = lastDecl("margin-block");
  assert.ok(margin === null || Number.parseFloat(margin) >= 0, `negative vertical margin overlaps legal targets: ${margin}`);
  assert.equal(lastDecl("vertical-align"), "middle", "each atomic target must stay centred in its own line box");
});


test("V173: the consent sentence gives both document links stable grid columns", () => {
  assert.match(authSource, /class: "gc-auth-legal-actions"/, "legal links need a dedicated layout wrapper");
  const actions = rules.find(({ selector }) => selector === ".gc-auth-legal-actions");
  assert.ok(actions, "the legal action wrapper must be styled");
  assert.match(actions.body, /display\s*:\s*grid/, "links should not depend on anonymous inline line boxes");
  assert.match(
    actions.body,
    /grid-template-columns\s*:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/,
    "Terms and Privacy need independent equal-width columns around the translated conjunction",
  );
});

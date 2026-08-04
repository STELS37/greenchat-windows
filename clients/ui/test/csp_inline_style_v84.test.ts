// clients/ui/test/csp_inline_style_v84.test.ts — V84 regression guard.
//
// Defect, measured on the running client (probe var/ux-audit/tools/m_csp2_v84.mjs, 2026-07-30,
// Chrome at 390x844): the server sends `style-src 'self'` (server/src/core/http.ts), which by spec
// also governs `style-src-attr`. Chrome therefore REFUSED every `style="…"` the client wrote —
// "Applying inline style violates the following Content Security Policy directive … The action has
// been blocked" — and dropped the declarations. Nine of them existed and every one was load-bearing:
//
//   .gc-reconsent-actions    two legal-gate buttons meant to be a 10px column → two touching buttons
//   .gc-reconsent-doc        the Terms meant to be a 30vh scroller → the whole document expanded
//   .gc-reconsent-doc-title  a heading left with the UA's default <h2> margins
//   .gc-forward-title ×4     FAQ / status / ticket-list titles kept the 12/16/10 sheet-header frame
//   .gc-support-actions      the ticket head stayed right-aligned under a footer rule
//
// The tenth was worse than cosmetic: text_zoom.ts styled its measuring probe with a style attribute,
// so the probe inherited the page's font size and the file measured the APP's font scale instead of
// the SYSTEM's — a user who enlarged text inside Green Chat would have been reported as a device at
// 1.25 system zoom, silently capping the navigation labels.
//
// The rule this locks: no client source may write a style ATTRIBUTE. CSSOM property writes
// (`el.style.width = …`) are not inline styles, are not blocked, and stay allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });

test("V84: no client source writes a style attribute — CSP refuses them", () => {
  const offenders: string[] = [];
  for (const file of sources(srcRoot)) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      // `el(tag, { style: "…" })` — the attribute path in dom.ts
      // Only the DOM path: `style` is also a legitimate key of Intl.NumberFormat/ListFormat options.
      if (/\bel\(/.test(line) && /\bstyle:\s*(?:`|")/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      // setAttribute("style", …), including the multi-line form
      if (/setAttribute\(\s*["']style["']/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      if (/\.cssText\s*=/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
    if (/setAttribute\(\s*\n\s*["']style["']/.test(text)) offenders.push(`${file}: multi-line setAttribute("style")`);
  }
  assert.deepEqual(offenders, [], `these declarations are silently dropped by style-src 'self':\n${offenders.join("\n")}`);
});

test("V84: the declarations live in the stylesheet instead", () => {
  // Comments name these selectors too; match against the declarations only.
  const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [selector, decl] of [
    [".gc-reconsent-actions", /flex-direction:\s*column/],
    [".gc-reconsent-doc-title", /margin:\s*0/],
    [".gc-reconsent-doc", /max-height:\s*30vh/],
    [".gc-support-actions-head", /justify-content:\s*space-between/],
  ] as Array<[string, RegExp]>) {
    // Every rule that mentions the selector, not just the first: `.x` and `.x > .y` both match.
    const bodies: string[] = [];
    const re = new RegExp(`([^{}]+)\\{([^{}]*)\\}`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      if (new RegExp(`\\${selector}(?![-\\w])`).test(m[1]!)) bodies.push(m[2]!);
    }
    assert.ok(bodies.length > 0, `${selector} must be a real rule now`);
    assert.ok(
      bodies.some((b) => decl.test(b)),
      `${selector} must keep the declaration the browser refused: ${bodies.join(" | ")}`,
    );
  }
  assert.match(
    css,
    /\.gc-faq > \.gc-forward-title[\s\S]{0,160}padding:\s*0/,
    "a section title inside a card carries no sheet-header frame",
  );
});

test("V84: the text-zoom probe is styled through the CSSOM, which CSP allows", () => {
  const src = readFileSync(resolve(here, "../src/text_zoom.ts"), "utf8");
  assert.doesNotMatch(src, /setAttribute\(\s*\n?\s*["']style["']/, "the attribute form is blocked");
  assert.match(src, /s\.fontSize = `\$\{TEXT_ZOOM_PROBE_PX\}px`/, "the probe must still declare its own size explicitly");
  assert.match(src, /s\.position = "fixed"/, "…and stay out of the flow while it is measured");
});

test("V84: the policy this guard exists for is still the policy the server sends", () => {
  const http = readFileSync(resolve(here, "../../../server/src/core/http.ts"), "utf8");
  assert.match(http, /style-src 'self'/, "if this ever gains 'unsafe-inline', revisit — do not relax it silently");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LEGAL_DOCS,
  LEGAL_OUT_DIR,
  buildLegalPages,
  renderLegalMarkdown,
  renderLegalPage,
} from "./build-legal-pages.mjs";

// The committed pages are a build artifact of docs/legal/*.md. If someone edits a legal text and
// forgets to regenerate, the published policy silently diverges from the document the API serves --
// which is exactly the mismatch a store review or a regulator would find.
test("committed legal pages match the markdown they are generated from", async () => {
  for (const page of await buildLegalPages()) {
    const outFile = join(LEGAL_OUT_DIR, page.doc.slug, "index.html");
    const committed = await readFile(outFile, "utf8");
    assert.equal(
      committed,
      page.html,
      "stale " + page.doc.slug + ": run node clients/scripts/build-legal-pages.mjs",
    );
  }
});

test("document text can never inject markup into the published page", () => {
  const html = renderLegalMarkdown('Оператор <script>alert("x")</script> & «кавычки»');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&amp;/);
});

test("markdown subset renders as real HTML structure", () => {
  const html = renderLegalMarkdown(
    ["# Заголовок", "", "## Раздел", "", "Абзац с **важным** и `кодом`.", "", "- пункт один", "  продолжение", "- пункт два"].join("\n"),
  );
  assert.match(html, /<h1>Заголовок<\/h1>/);
  assert.match(html, /<h2>Раздел<\/h2>/);
  assert.match(html, /<strong>важным<\/strong>/);
  assert.match(html, /<code>кодом<\/code>/);
  assert.match(html, /<li>пункт один продолжение<\/li>/);
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
});

test("an unreviewed markdown construct fails the build instead of leaking raw syntax", () => {
  for (const bad of ["| a | b |", "> цитата", "1. первый", "```js"]) {
    assert.throws(() => renderLegalMarkdown(bad), /unsupported markdown construct/);
  }
});

// A mirrored copy is served from an unknown base path. It may use only local relative assets,
// never inline CSS (blocked by production CSP), scripts or root-absolute app resources.
test("published page is CSP-safe and portable with its local stylesheet", () => {
  const doc = LEGAL_DOCS[0];
  const html = renderLegalPage(doc, "# Т\n\nтекст [Условия](tos.md).\n");
  assert.doesNotMatch(html, /<style(?:\s|>)/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="\/[a-z]/);
  assert.match(html, /href="\.\.\/\.\.\/public-page\.css"/);
  assert.match(html, /href="\.\.\/tos\/"/);
  assert.match(html, /<meta name="robots" content="index,follow"/);
  assert.match(html, /<link rel="canonical" href="https:\/\/greenchat\.globalsystem\.cc\/legal\/privacy\/"/);
});

test("thematic break separates the binding text from the English summary", () => {
  const html = renderLegalMarkdown("Русский текст.\n\n---\n\n## English summary\n");
  assert.match(html, /<hr \/>/);
  assert.doesNotMatch(html, /<p>---<\/p>/);
});

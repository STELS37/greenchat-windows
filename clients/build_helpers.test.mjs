// Contract tests for the shared web bundling options.
//
// These are the options every emitted app chunk inherits, so a silent change here moves the transfer
// size of the whole product. The bundle-budget gate in build.mjs measures the result; this file pins
// the inputs that make the measurement come out the way it does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WEB_SPLIT_OPTIONS, collectStaticOutputs, outputDependency } from "./build_helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("the web bundle is emitted as UTF-8, not as \\uXXXX escapes", () => {
  // esbuild's default is "ascii", which turns every Cyrillic character into a six-byte escape. With the
  // Russian interface catalogue bundled in, that cost 131 KB of raw output and 4.9 KB of gzip on HEAD.
  // Asserting the exact string rather than "not ascii" keeps a future "utf-8"/"UTF8" typo from passing:
  // esbuild rejects unknown values, but a test that accepts anything non-ascii would not say so here.
  assert.equal(WEB_SPLIT_OPTIONS.charset, "utf8");
});

test("the shared options still produce real dynamic-import chunks", () => {
  // Lazy loading is what keeps the initial closure under budget at all; charset must not be the only
  // thing this object is remembered for.
  assert.equal(WEB_SPLIT_OPTIONS.format, "esm");
  assert.equal(WEB_SPLIT_OPTIONS.splitting, true);
  assert.equal(WEB_SPLIT_OPTIONS.chunkNames, "chunk.[hash]");
  assert.ok(Object.isFrozen(WEB_SPLIT_OPTIONS), "the options must not be mutable at build time");
});

test("collectStaticOutputs stops at dynamic imports and follows CSS", () => {
  // The budget gate bills exactly what this function returns, so prove both halves of its job: a
  // dynamic-import edge is a boundary (otherwise lazy screens would be billed as initial), and a
  // cssBundle edge is not (otherwise the stylesheet would be billed as free).
  const outputs = {
    "dist/app.js": {
      imports: [
        { path: "dist/chunk.js", kind: "import-statement" },
        { path: "dist/lazy.js", kind: "dynamic-import" },
        { path: "https://cdn.example/x.js", kind: "import-statement", external: true },
      ],
      cssBundle: "dist/app.css",
    },
    "dist/chunk.js": { imports: [] },
    "dist/lazy.js": { imports: [] },
    "dist/app.css": { imports: [] },
  };
  const initial = collectStaticOutputs(outputs, "dist/app.js");
  assert.deepEqual([...initial].sort(), ["dist/app.css", "dist/app.js", "dist/chunk.js"]);
  assert.ok(!initial.has("dist/lazy.js"), "a dynamically imported chunk is not part of the initial load");
});

test("outputDependency resolves sibling-relative metafile paths", () => {
  // esbuild writes chunk references relative to the importer, so a naive lookup misses them and the
  // gate would under-count the initial closure.
  const outputs = { "dist/assets/app.js": {}, "dist/assets/chunk.js": {} };
  assert.equal(outputDependency(outputs, "dist/assets/app.js", "dist/assets/chunk.js"), "dist/assets/chunk.js");
  assert.equal(outputDependency(outputs, "dist/assets/app.js", "chunk.js"), "dist/assets/chunk.js");
  assert.throws(
    () => outputDependency(outputs, "dist/assets/app.js", "missing.js"),
    /metafile references missing output/,
  );
});

test("the app bundle really is loaded as a module, which is what makes UTF-8 safe", async () => {
  // charset: "utf8" is only unconditionally correct because module scripts are always decoded as UTF-8.
  // If someone ever swaps the dynamic import for a classic <script> injection, the guarantee weakens to
  // "correct as long as the Content-Type says so" -- fail here rather than let that pass silently.
  const loader = await readFile(join(here, "web", "public", "site-loader.js"), "utf8");
  assert.match(loader, /import\(entry\)/, "site-loader must load the entry as a module");
  const html = await readFile(join(here, "web", "index.html"), "utf8");
  assert.match(html, /<meta charset="utf-8"/i, "the shell must declare UTF-8");
});

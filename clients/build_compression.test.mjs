import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  PRODUCTION_GZIP_OPTIONS,
  productionGzip,
  productionGzipLength,
} from "./build_compression.mjs";

test("bundle budget measures the exact production gzip sidecar bytes", async () => {
  const payload = Buffer.from("GreenChat bundle budget alignment\n".repeat(20_000));
  const expected = gzipSync(payload, { level: 9 });

  assert.deepEqual(PRODUCTION_GZIP_OPTIONS, { level: 9 });
  assert.deepEqual(productionGzip(payload), expected);
  assert.equal(productionGzipLength(payload), expected.length);

  const source = await readFile(new URL("./build.mjs", import.meta.url), "utf8");
  assert.match(source, /productionGzipLength\(await readFile\(join\(outDir, rel\)\)\)/);
  assert.match(source, /const gz = productionGzip\(buf\);/);
  assert.doesNotMatch(source, /gzipSync\(/, "build.mjs must not drift to a different gzip configuration");
});

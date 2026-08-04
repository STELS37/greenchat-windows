import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { assertNoTelegramWebSecrets } from "./check-telegram-web-secrets.mjs";

test("web credential gate scans plain, source-map and compressed artifacts without echoing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "gc-telegram-gate-"));
  try {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "clean.js"), "console.log('greenchat')");
    await assert.doesNotReject(assertNoTelegramWebSecrets(root, {}));

    const sentinel = "0123456789abcdef0123456789abcdef";
    await writeFile(join(root, "assets", "leak.js.map"), JSON.stringify({ sourcesContent: [sentinel] }));
    await assert.rejects(
      assertNoTelegramWebSecrets(root, { GC_TELEGRAM_SECRET_SENTINEL: sentinel }),
      (error) => error instanceof Error && /release-gate sentinel/u.test(error.message) && !error.message.includes(sentinel),
    );
    await rm(join(root, "assets", "leak.js.map"));

    const field = ["api", "hash"].join("_");
    await writeFile(join(root, "assets", "sidecar.js.gz"), gzipSync(Buffer.from(field)));
    await assert.rejects(assertNoTelegramWebSecrets(root, {}), /decompressed/u);
    await rm(join(root, "assets", "sidecar.js.gz"));
    await writeFile(join(root, "assets", "sidecar.js.br"), brotliCompressSync(Buffer.from(field)));
    await assert.rejects(assertNoTelegramWebSecrets(root, {}), /decompressed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

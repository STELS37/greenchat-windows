import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { filterStoreProfileSource } from "./store_profile.mjs";

const run = promisify(execFile);
const root = dirname(fileURLToPath(import.meta.url));

function shouldCopy(source) {
  const path = relative(root, source).split(sep).join("/");
  if (path === "") return true;
  if (
    /(?:^|\/)\.env(?:\.|$)/.test(path) ||
    /\.(?:jks|key|keystore|p12|pem|pfx)$/i.test(path) ||
    /(?:^|\/)(?:credentials|secrets?)(?:\/|$)/i.test(path) ||
    /(?:^|\/)google-services\.json$/i.test(path)
  )
    return false;
  return !(
    path === "node_modules" ||
    path.startsWith("node_modules/") ||
    path.includes("/node_modules/") ||
    path.endsWith("/node_modules") ||
    path === "web/dist" ||
    path.startsWith("web/dist/") ||
    path === "mobile/www" ||
    path.startsWith("mobile/www/") ||
    path.includes("/build/") ||
    path.endsWith("/build") ||
    path.includes("/.gradle/") ||
    path.endsWith("/.gradle") ||
    path.includes("/target/") ||
    path.endsWith("/target") ||
    path === "e2e/artifacts" ||
    path.startsWith("e2e/artifacts/") ||
    path === "test-results" ||
    path.startsWith("test-results/") ||
    path === "playwright-report" ||
    path.startsWith("playwright-report/")
  );
}

async function transformTypescript(dir, distributionChannel) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      await transformTypescript(path, distributionChannel);
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      const source = await readFile(path, "utf8");
      const filtered = filterStoreProfileSource(
        source,
        distributionChannel,
        relative(dir, path),
      );
      if (filtered !== source) await writeFile(path, filtered, "utf8");
    }
  }
}

async function linkIfPresent(target, destination) {
  try {
    await lstat(target);
    await symlink(target, destination, "dir");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function typecheck(tsc, cwd, config) {
  try {
    await run(tsc, ["--noEmit", "-p", config], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(output || error?.message || "messenger typecheck failed");
  }
}

async function main() {
  for (const distributionChannel of [
    "messenger-direct-apk",
    "messenger-test-apk",
    "messenger-store-managed",
  ]) {
    const scratch = await mkdtemp(
      join(tmpdir(), `green-chat-${distributionChannel}-typecheck-`),
    );
    const copyRoot = join(scratch, "clients");
    try {
      await cp(root, copyRoot, { recursive: true, filter: shouldCopy });
      await linkIfPresent(
        join(root, "node_modules"),
        join(copyRoot, "node_modules"),
      );
      await linkIfPresent(
        join(root, "mobile", "node_modules"),
        join(copyRoot, "mobile", "node_modules"),
      );
      await transformTypescript(copyRoot, distributionChannel);

      await writeFile(
        join(copyRoot, "tsconfig.messenger.json"),
        JSON.stringify(
          {
            extends: "./tsconfig.json",
            include: [
              "web/src/main.ts",
              "web/src/tg_import.worker.ts",
              "web/src/pow.worker.ts",
            ],
          },
          null,
          2,
        ),
      );
      await writeFile(
        join(copyRoot, "mobile", "tsconfig.messenger.json"),
        JSON.stringify(
          {
            extends: "./tsconfig.json",
            include: ["bridge/index.ts", "capacitor.config.ts"],
          },
          null,
          2,
        ),
      );

      const tsc = join(root, "node_modules", ".bin", "tsc");
      await typecheck(tsc, copyRoot, "tsconfig.messenger.json");
      await typecheck(tsc, join(copyRoot, "mobile"), "tsconfig.messenger.json");
      console.log(
        `check:messenger OK (${distributionChannel} filtered web and mobile entry graphs)`,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error("check:messenger FAILED:", error);
  process.exitCode = 1;
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  deriveCleanReleaseIdentity,
  deriveMessengerReleaseIdentity,
} from "./release_identity.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "gc-release-identity-"));
  mkdirSync(join(root, "clients"));
  writeFileSync(join(root, "clients", "input.txt"), "one\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Green Chat test");
  git(root, "config", "user.email", "test@local");
  git(root, "add", "clients/input.txt");
  git(root, "commit", "--quiet", "-m", "fixture");
  return { root, clients: join(root, "clients"), head: git(root, "rev-parse", "HEAD") };
}

test("release identity is derived from the exact clean Git HEAD", (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));

  assert.deepEqual(
    deriveCleanReleaseIdentity({
      releaseRoot: fx.clients,
      suppliedBuildId: fx.head,
    }),
    { buildId: fx.head, repoRoot: fx.root },
  );
  assert.throws(
    () =>
      deriveCleanReleaseIdentity({
        releaseRoot: fx.clients,
        suppliedBuildId: "0".repeat(40),
      }),
    /does not match.*HEAD/i,
  );
});

test("release identity rejects dirty tracked and untracked release inputs", (t) => {
  const fx = fixture();
  t.after(() => rmSync(fx.root, { recursive: true, force: true }));

  writeFileSync(join(fx.clients, "input.txt"), "changed\n");
  assert.throws(
    () => deriveCleanReleaseIdentity({ releaseRoot: fx.clients }),
    /dirty release inputs.*input\.txt/i,
  );

  writeFileSync(join(fx.clients, "input.txt"), "one\n");
  writeFileSync(join(fx.clients, "new-input.txt"), "new\n");
  assert.throws(
    () => deriveCleanReleaseIdentity({ releaseRoot: fx.clients }),
    /dirty release inputs.*new-input\.txt/i,
  );
});

test("messenger identity accepts only an exact completed immutable snapshot marker", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gc-sealed-release-identity-"));
  const clients = join(root, "clients");
  mkdirSync(clients);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const buildId = "1".repeat(40);
  const manifestSha256 = "2".repeat(64);
  writeFileSync(
    join(root, ".gc-source-snapshot.complete.json"),
    `${JSON.stringify({
      schema_version: 1,
      complete: true,
      scope: [
        "clients/**",
        "config/client-release.json",
        "scripts/lib/client-release.mjs",
      ],
      source_commit: buildId,
      source_manifest_sha256: manifestSha256,
      file_count: 3,
      total_size_bytes: 42,
    })}\n`,
    { mode: 0o400 },
  );

  assert.deepEqual(
    deriveMessengerReleaseIdentity({
      releaseRoot: clients,
      suppliedBuildId: buildId,
      suppliedManifestSha256: manifestSha256,
    }),
    { buildId, repoRoot: root, sourceManifestSha256: manifestSha256 },
  );
  assert.throws(
    () =>
      deriveMessengerReleaseIdentity({
        releaseRoot: clients,
        suppliedBuildId: buildId,
        suppliedManifestSha256: "3".repeat(64),
      }),
    /manifest.*does not match/i,
  );
});

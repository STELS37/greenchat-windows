import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupE2eDir } from "../../e2e/harness.ts";

test("E2E teardown removes only its exact owned run directory", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-harness-test-"));
  const own = join(root, "green-chat-e2e-19001");
  const sibling = join(root, "green-chat-e2e-19002");
  const legacy = join(root, "gc-e2e-19003");
  mkdirSync(own);
  mkdirSync(sibling);
  mkdirSync(legacy);
  try {
    assert.equal(cleanupE2eDir(own, root), true);
    assert.equal(existsSync(own), false);
    assert.equal(existsSync(sibling), true, "a concurrent run must survive another run's teardown");
    assert.equal(existsSync(legacy), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E2E teardown rejects legacy, nested and out-of-root paths", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-harness-guard-"));
  const legacy = join(root, "gc-e2e-19101");
  const nested = join(root, "nested", "green-chat-e2e-19102");
  mkdirSync(legacy);
  mkdirSync(nested, { recursive: true });
  try {
    assert.equal(cleanupE2eDir(legacy, root), false);
    assert.equal(cleanupE2eDir(nested, root), false);
    assert.equal(cleanupE2eDir(join(root, "..", "green-chat-e2e-outside"), root), false);
    assert.equal(cleanupE2eDir(undefined, root), false);
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(nested), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

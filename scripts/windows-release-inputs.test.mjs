import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWindowsReleaseChanges,
  isWindowsReleaseInputPath,
  normalizedRepoPath,
} from "./windows-release-inputs.mjs";

test("normalizes Windows and repository path spellings", () => {
  assert.equal(normalizedRepoPath(".\\clients\\desktop\\src-tauri\\src\\lib.rs"), "clients/desktop/src-tauri/src/lib.rs");
  assert.equal(normalizedRepoPath("./clients/ui/src/app.ts"), "clients/ui/src/app.ts");
});

test("shared client, desktop, TDLib, versions and factory files invalidate Windows", () => {
  for (const path of [
    "clients/core/src/api.ts",
    "clients/ui/src/app.ts",
    "clients/web/index.html",
    "clients/desktop/src-tauri/src/lib.rs",
    "clients/third_party/tdlib/PINNED.env",
    "clients/third_party/tdlib/LICENSE_1_0.txt",
    "clients/third_party/tdlib/check.sh",
    "clients/package-lock.json",
    "config/client-release.json",
    ".github/workflows/windows-artifacts.yml",
    "scripts/build-windows-desktop.mjs",
    "scripts/windows-release-candidate.test.mjs",
    "scripts/windows-release-inputs.mjs",

    "scripts/windows-direct-builder.test.mjs",
    "infra/windows-builder/bootstrap.ps1",
    "infra/windows-builder/build.ps1",
    "infra/windows-builder/green-chat-windows-builder.sh",
    "infra/windows-builder/green-chat-windows-builder.service",
    "infra/windows-builder/green-chat-windows-builder.timer",
  ]) assert.equal(isWindowsReleaseInputPath(path), true, path);
});

test("unrelated iOS, server, docs and CI orchestration changes do not create false-red Windows builds", () => {
  for (const path of [
    ".github/workflows/ios-artifacts.yml",
    "clients/third_party/tdlib/build-macos.sh",
    "clients/third_party/tdlib/build-android.sh",
    "clients/third_party/tdlib/build-desktop.sh",
    "clients/mobile/ios-configure.mjs",
    "server/src/modules/messages.ts",
    "docs/CLIENTS.md",
    "infra/ci-executor/external-ci.sh",
    "scripts/ci-queue.mjs",
    "state/outbox/evidence.txt",
  ]) assert.equal(isWindowsReleaseInputPath(path), false, path);
});

test("classification deduplicates and separates relevant from ignored paths", () => {
  const result = classifyWindowsReleaseChanges([
    "server/src/index.ts",
    "clients/ui/src/app.ts",
    "clients\\ui\\src\\app.ts",
    ".github/workflows/ios-artifacts.yml",
    "clients/third_party/tdlib/build-macos.sh",
    "clients/third_party/tdlib/build-android.sh",
    "clients/third_party/tdlib/build-desktop.sh",
  ]);
  assert.deepEqual(result.relevant, ["clients/ui/src/app.ts"]);
  assert.deepEqual(result.ignored, [
    ".github/workflows/ios-artifacts.yml",
    "clients/third_party/tdlib/build-android.sh",
    "clients/third_party/tdlib/build-desktop.sh",
    "clients/third_party/tdlib/build-macos.sh",
    "server/src/index.ts",
  ]);
  assert.equal(result.invalidated, true);
});

test("path traversal and empty values never become release inputs", () => {
  assert.equal(isWindowsReleaseInputPath(""), false);
  assert.equal(isWindowsReleaseInputPath("../clients/ui/src/app.ts"), false);
  assert.equal(isWindowsReleaseInputPath("clients/ui/../server/file.ts"), false);
  assert.equal(isWindowsReleaseInputPath("clients/ui/\0bad"), false);
});

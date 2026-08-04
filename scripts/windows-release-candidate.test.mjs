import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assembleWindowsCandidate, validateWindowsLane } from "./windows-release-candidate.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function lane(root, arch, { version = "1.2.3", sourceSha = "a".repeat(40), signed = true } = {}) {
  mkdirSync(root, { recursive: true });
  const packageArch = arch === "x86_64" ? "x64" : "arm64";
  const contents = {
    setup: [`GreenChat-${version}-windows-${packageArch}-setup.exe`, Buffer.from(`setup-${arch}`)],
    msi: [`GreenChat-${version}-windows-${packageArch}.msi`, Buffer.from(`msi-${arch}`)],
    portable: [`GreenChat-${version}-windows-${packageArch}-portable.zip`, Buffer.from(`portable-${arch}`)],
    updater: [`GreenChat-${version}-windows-${packageArch}.nsis.zip`, Buffer.from(`updater-${arch}`)],
    updaterSignature: [`GreenChat-${version}-windows-${packageArch}.nsis.zip.sig`, Buffer.from(`trusted-signature-${arch}\n`)],
  };
  const files = [];
  for (const [name, bytes] of Object.values(contents)) {
    writeFileSync(join(root, name), bytes);
    files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const updateBytes = contents.updater[1];
  const manifest = {
    schema_version: 1,
    platform: "windows",
    architecture: arch,
    version,
    source_sha: sourceSha,
    signed,
    authenticode: {
      setup: { Status: "Valid", TimeSubject: "CN=Timestamp" },
      msi: { Status: "Valid", TimeSubject: "CN=Timestamp" },
      binary: { Status: "Valid", TimeSubject: "CN=Timestamp" },
    },
    tdlib: { bytes: 2_000_000, sha256: "b".repeat(64) },
    files,
    update_target: {
      key: `windows/${arch}`,
      version,
      url: contents.updater[0],
      sha256: sha256(updateBytes),
      signature: readFileSync(join(root, contents.updaterSignature[0]), "utf8").trim(),
      pub_date: "2026-08-03T00:00:00.000Z",
    },
  };
  const path = join(root, `windows-${packageArch}-release.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

test("assembles exact-SHA x64 and ARM64 lanes into updater and catalog candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-windows-candidate-"));
  const x64 = validateWindowsLane(lane(join(root, "x64"), "x86_64"));
  const arm64 = validateWindowsLane(lane(join(root, "arm64"), "aarch64"));
  const candidate = assembleWindowsCandidate([arm64, x64]);
  assert.equal(candidate.version, "1.2.3");
  assert.equal(candidate.source_sha, "a".repeat(40));
  assert.equal(candidate.catalog_candidate.status, "available");
  assert.match(candidate.catalog_candidate.url, /windows-x64-setup\.exe$/);
  assert.equal(candidate.native_update_manifest_patch.targets["windows/x86_64"].signature, "trusted-signature-x86_64");
  assert.equal(candidate.native_update_manifest_patch.targets["windows/aarch64"].signature, "trusted-signature-aarch64");
});

test("rejects unsigned Windows lanes", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-windows-unsigned-"));
  assert.throws(() => validateWindowsLane(lane(root, "x86_64", { signed: false })), /is unsigned/);
});

test("rejects mixed source SHAs and product versions", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-windows-mixed-"));
  const x64 = validateWindowsLane(lane(join(root, "x64"), "x86_64"));
  const otherSha = validateWindowsLane(lane(join(root, "arm64"), "aarch64", { sourceSha: "c".repeat(40) }));
  assert.throws(() => assembleWindowsCandidate([x64, otherSha]), /different source SHAs/);
  const otherVersion = validateWindowsLane(lane(join(root, "arm64v"), "aarch64", { version: "1.2.4" }));
  assert.throws(() => assembleWindowsCandidate([x64, otherVersion]), /different product versions/);
});

test("rejects updater bytes or signature that differ from the lane manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-windows-tamper-"));
  const path = lane(root, "x86_64");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.update_target.signature = "attacker-signature";
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => validateWindowsLane(path), /signature differs/);
});

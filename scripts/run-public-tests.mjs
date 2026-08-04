#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientsRoot = resolve(repoRoot, "clients");
const excludedTopLevel = new Set([
  "linux_download_page.test.mjs",
  "macos_bridge_runtime.test.mjs",
  "macos_release_contract.test.mjs",
  "public_pages.test.mjs",
  "store_profile.test.mjs",
]);
const excludedScriptTests = new Set([
  "build-legal-pages.test.mjs",
]);
const excludedPrivateIntegrationCore = new Set([
  "cache.test.ts",
  "config_verify.test.ts",
  "currency_live.test.ts",
  "diagnostics.test.ts",
  "encrypted_store.test.ts",
  "network_failover_ws_live.test.ts",
  "outbox.test.ts",
  "pow_gate.test.ts",
  "push.test.ts",
  "refresh.test.ts",
  "release_wiring.test.ts",
  "transport.test.ts",
  "upload.test.ts",
]);
const excludedPrivateIntegrationUi = new Set([
  "app_lock_hardware_proof_v113.test.ts",
  "call_capture_blocked_v111.test.ts",
  "csp_inline_style_v84.test.ts",
  "finance_error_text.test.ts",
  "onboarding_boundaries.test.ts",
  "session_native_persistence_contract.test.ts",
  "support_topics_v187.test.ts",
]);

function files(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => resolve(directory, entry.name))
    .sort();
}

function recursiveFiles(directory, predicate) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...recursiveFiles(path, predicate));
    else if (entry.isFile() && predicate(entry.name)) result.push(path);
  }
  return result.sort();
}

function requiresPrivateCoreIntegration(path) {
  const text = readFileSync(path, "utf8");
  return text.includes("startLiveServer")
    || text.includes("../../../server/dist/")
    || /join\(repo,\s*["']infra["']/.test(text);
}

function assertExactClassification(paths, expectedNames, label) {
  const actualNames = new Set(paths.map((path) => path.split(/[\\/]/).at(-1)));
  for (const name of actualNames) {
    if (!expectedNames.has(name)) throw new Error(`new ${label} test must be classified explicitly: ${name}`);
  }
  for (const name of expectedNames) {
    if (!actualNames.has(name)) throw new Error(`stale ${label} exclusion no longer matches a dependency: ${name}`);
  }
}

function run(args, label) {
  const result = spawnSync(process.execPath, args, { cwd: clientsRoot, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}`);
}

const topLevel = files(clientsRoot, (name) => name.endsWith(".test.mjs") && !excludedTopLevel.has(name));
const scriptTests = files(
  resolve(clientsRoot, "scripts"),
  (name) => name.endsWith(".test.mjs") && !excludedScriptTests.has(name),
);
const allCoreTests = recursiveFiles(resolve(clientsRoot, "core/test"), (name) => name.endsWith(".test.ts"));
const detectedPrivateCore = allCoreTests.filter(requiresPrivateCoreIntegration);
assertExactClassification(detectedPrivateCore, excludedPrivateIntegrationCore, "private-server core integration");
const coreTests = allCoreTests.filter((path) => !detectedPrivateCore.includes(path));
const allUiTests = recursiveFiles(resolve(clientsRoot, "ui/test"), (name) => name.endsWith(".test.ts"));
const detectedPrivateUi = allUiTests.filter((path) => excludedPrivateIntegrationUi.has(path.split(/[\\/]/).at(-1)));
assertExactClassification(detectedPrivateUi, excludedPrivateIntegrationUi, "private-tree UI contract");
for (const path of detectedPrivateUi) {
  const text = readFileSync(path, "utf8");
  if (!/\b(?:mobile|server)\b/.test(text)) {
    throw new Error(`private-tree UI exclusion has no auditable private path dependency: ${path}`);
  }
}
const uiTests = allUiTests.filter((path) => !detectedPrivateUi.includes(path));
run(["--test", ...topLevel, ...scriptTests], "public top-level tests");
run(["--test", "--test-concurrency=1", ...coreTests], "client-only core tests");
run(["--test", ...uiTests], "client-only UI tests");
console.log(
  `PUBLIC-TESTS: OK top-level=${topLevel.length + scriptTests.length} core=${coreTests.length} ui=${uiTests.length} `
  + `excluded-private-core=${detectedPrivateCore.length} excluded-private-ui=${detectedPrivateUi.length}`,
);

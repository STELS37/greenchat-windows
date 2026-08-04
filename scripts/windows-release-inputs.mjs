#!/usr/bin/env node
// Decide whether a newer master commit invalidates an in-flight GreenChat Windows artifact.
// Unrelated server, documentation, iOS or CI-control commits must not create false-red Windows builds,
// while any shared client, desktop shell, TDLib, version or Windows-factory change cancels the lane.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXACT_INPUTS = new Set([
  ".github/workflows/windows-artifacts.yml",
  "clients/package.json",
  "clients/package-lock.json",
  "config/client-release.json",
  "scripts/build-windows-desktop.mjs",
  "scripts/build-windows-desktop.test.mjs",
  "scripts/windows-release-candidate.mjs",
  "scripts/windows-release-candidate.test.mjs",
  "scripts/windows-release-inputs.mjs",
  "scripts/windows-release-inputs.test.mjs",

  "scripts/windows-direct-builder.test.mjs",
  "infra/windows-builder/bootstrap.ps1",
  "infra/windows-builder/build.ps1",
  "infra/windows-builder/green-chat-windows-builder.sh",
  "infra/windows-builder/green-chat-windows-builder.service",
  "infra/windows-builder/green-chat-windows-builder.timer",
  "clients/third_party/tdlib/PINNED.env",
  "clients/third_party/tdlib/LICENSE_1_0.txt",
  "clients/third_party/tdlib/OPENSSL_LICENSE.txt",
  "clients/third_party/tdlib/README.md",
  "clients/third_party/tdlib/check.sh",
]);
const PREFIX_INPUTS = [
  "clients/core/",
  "clients/ui/",
  "clients/web/",
  "clients/desktop/",
];
const SHA_RE = /^[a-f0-9]{40}$/;

function fail(message, code = 1) {
  const error = new Error(`WINDOWS-INPUTS: BLOCKED ${message}`);
  error.exitCode = code;
  throw error;
}

export function normalizedRepoPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isWindowsReleaseInputPath(value) {
  const path = normalizedRepoPath(value);
  if (!path || path.includes("\0") || path.startsWith("../") || path.includes("/../")) return false;
  if (EXACT_INPUTS.has(path)) return true;
  return PREFIX_INPUTS.some((prefix) => path.startsWith(prefix));
}

export function classifyWindowsReleaseChanges(paths) {
  const changed = [...new Set(paths.map(normalizedRepoPath).filter(Boolean))].sort();
  const relevant = changed.filter(isWindowsReleaseInputPath);
  return {
    relevant,
    ignored: changed.filter((path) => !relevant.includes(path)),
    invalidated: relevant.length > 0,
  };
}

function runGit(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail(`git ${args.join(" ")} failed: ${String(result.stderr ?? result.error?.message ?? "unknown error").trim()}`);
  }
  return result;
}

export function compareWindowsReleaseBoundary(source, latest) {
  if (!SHA_RE.test(String(source)) || !SHA_RE.test(String(latest))) fail("source and latest must be full Git SHAs", 64);
  if (source === latest) return { source, latest, relevant: [], ignored: [], invalidated: false };
  const ancestor = runGit(["merge-base", "--is-ancestor", source, latest], { allowFailure: true });
  if (ancestor.status !== 0) fail(`${source} is not an ancestor of ${latest}`, 75);
  const diff = runGit(["diff", "--name-only", "--diff-filter=ACMRD", `${source}..${latest}`]);
  const classification = classifyWindowsReleaseChanges(String(diff.stdout ?? "").split(/\r?\n/));
  return { source, latest, ...classification };
}

function parseArgs(argv) {
  let source = "";
  let latest = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--source") source = String(argv[++index] ?? "");
    else if (argv[index] === "--latest") latest = String(argv[++index] ?? "");
    else if (argv[index] === "--help") {
      console.log("Usage: node scripts/windows-release-inputs.mjs --source <sha> --latest <sha>");
      process.exit(0);
    } else fail(`unknown argument ${argv[index]}`, 64);
  }
  return { source, latest };
}

function main() {
  const { source, latest } = parseArgs(process.argv.slice(2));
  const result = compareWindowsReleaseBoundary(source, latest);
  console.log(JSON.stringify(result));
  if (result.invalidated) fail(`newer master changes Windows release inputs: ${result.relevant.join(", ")}`, 75);
  console.error(`WINDOWS-INPUTS: OK ${source} remains valid at ${latest}; ignored=${result.ignored.length}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 1);
  }
}

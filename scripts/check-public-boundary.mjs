#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const forbiddenRoots = [
  "server/",
  "infra/",
  "clients/mobile/",
  "clients/e2e/",
  "clients/sdk/",
  "state/",
  "var/",
  "keys/",
  "secrets/",
];
const ignoredRoots = [".git/", "node_modules/", "clients/node_modules/", "clients/web/dist/", "clients/desktop/src-tauri/target/"];

const allowedSharedPaths = new Set([
  "clients/mobile/bridge/reality_config.ts",
  "clients/mobile/bridge/reality_transport.ts",
  "clients/e2e/harness.ts",
]);
const secretExtensions = new Set([".pfx", ".p12", ".pem", ".key", ".jks", ".keystore"]);
const forbiddenBasenames = new Set([".env", "id_rsa", "id_ed25519", "credentials.json", "service-account.json"]);
const textExtensions = new Set([
  "", ".c", ".cc", ".cmd", ".conf", ".cpp", ".css", ".d.ts", ".env", ".h", ".html", ".ini", ".js", ".json",
  ".jsx", ".lock", ".md", ".mjs", ".mts", ".ps1", ".rs", ".sh", ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const secretPatterns = [
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/],
];

function normalize(path) {
  return path.split(sep).join("/");
}

function walk(root) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = resolve(root, entry.name);
    const path = normalize(relative(repoRoot, absolute));
    const prefix = entry.isDirectory() ? `${path}/` : path;
    if (ignoredRoots.some((ignored) => prefix === ignored || prefix.startsWith(ignored))) continue;
    if (entry.isDirectory()) paths.push(...walk(absolute));
    else if (entry.isFile()) paths.push({ absolute, path });
  }
  return paths;
}

const problems = [];
for (const { absolute, path } of walk(repoRoot)) {
  const lowerPath = path.toLowerCase();
  if (forbiddenRoots.some((root) => lowerPath.startsWith(root)) && !allowedSharedPaths.has(lowerPath)) {
    problems.push(`${path}: forbidden private-product path`);
  }
  const basename = lowerPath.split("/").at(-1) ?? "";
  if (forbiddenBasenames.has(basename) || basename.startsWith(".env.")) problems.push(`${path}: forbidden secret filename`);
  if (secretExtensions.has(extname(lowerPath))) problems.push(`${path}: forbidden secret-bearing extension`);
  const size = statSync(absolute).size;
  if (size > 5 * 1024 * 1024) continue;
  const extension = lowerPath.endsWith(".d.ts") ? ".d.ts" : extname(lowerPath);
  if (!textExtensions.has(extension)) continue;
  const text = readFileSync(absolute, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) problems.push(`${path}: detected ${label}`);
  }
}

const workflows = walk(resolve(repoRoot, ".github/workflows")).filter(({ path }) => /\.ya?ml$/i.test(path));
for (const { absolute, path } of workflows) {
  const text = readFileSync(absolute, "utf8");
  if (/runs-on\s*:\s*(?:\[[^\]]*\bself-hosted\b|self-hosted\b)/i.test(text)) {
    problems.push(`${path}: self-hosted runners are forbidden in the public signing chain`);
  }
}

const signingPolicy = readFileSync(resolve(repoRoot, "CODE_SIGNING_POLICY.md"), "utf8");
const attribution = "Free code signing provided by SignPath.io, certificate by SignPath Foundation.";
if (!signingPolicy.includes(attribution)) problems.push("CODE_SIGNING_POLICY.md: required SignPath attribution is missing");

if (problems.length) {
  console.error("PUBLIC-BOUNDARY: BLOCKED");
  for (const problem of problems.sort()) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`PUBLIC-BOUNDARY: OK files=${walk(repoRoot).length}`);

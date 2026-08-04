#!/usr/bin/env node
// Assemble independently signed Windows x64/ARM64 build lanes into one immutable release candidate.
// The output is deliberately not a public release by itself: the universal release conductor admits
// it only after the canonical client catalog and all platform gates agree on the same source SHA.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256_RE = /^[a-f0-9]{64}$/;
const ARCHES = ["x86_64", "aarch64"];

function fail(message) {
  throw new Error(`WINDOWS-CANDIDATE: BLOCKED ${message}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(root) {
  const files = [];
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

function safeName(value, label) {
  const name = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || basename(name) !== name || name.includes("..")) {
    fail(`${label} is not a safe artifact basename`);
  }
  return name;
}

function validateFileRecord(root, record, label) {
  if (!record || typeof record !== "object") fail(`${label} is missing`);
  const name = safeName(record.name, `${label}.name`);
  const path = join(root, name);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`${label} file is absent: ${path}`);
  const bytes = statSync(path).size;
  if (!Number.isSafeInteger(record.bytes) || record.bytes !== bytes) {
    fail(`${label} size ${bytes} differs from manifest ${String(record.bytes)}`);
  }
  const digest = sha256(path);
  if (!SHA256_RE.test(String(record.sha256)) || record.sha256 !== digest) {
    fail(`${label} SHA-256 differs from manifest`);
  }
  return { path, name, bytes, sha256: digest };
}

function artifactRecord(file) {
  return {
    artifact_filename: file.name,
    size_bytes: file.bytes,
    sha256: file.sha256,
  };
}

export function validateWindowsLane(manifestPath) {
  const root = dirname(resolve(manifestPath));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${manifestPath}: ${error.message}`);
  }
  if (manifest.schema_version !== 1 || manifest.platform !== "windows") fail(`${manifestPath} is not a Windows release manifest`);
  if (!ARCHES.includes(manifest.architecture)) fail(`${manifestPath} has unsupported architecture ${String(manifest.architecture)}`);
  if (manifest.signed !== true) fail(`${manifestPath} is unsigned`);
  if (!/^[a-f0-9]{40}$/.test(String(manifest.source_sha))) fail(`${manifestPath} has no exact source SHA`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version))) fail(`${manifestPath} has invalid SemVer`);
  for (const key of ["setup", "msi", "binary"]) {
    if (manifest.authenticode?.[key]?.Status !== "Valid") fail(`${manifestPath} ${key} Authenticode is not valid`);
    if (!String(manifest.authenticode?.[key]?.TimeSubject ?? "").trim()) fail(`${manifestPath} ${key} has no trusted timestamp`);
  }
  const records = new Map((manifest.files ?? []).map((entry) => [entry.name, entry]));
  const expected = {
    setup: [...records.keys()].find((name) => /-setup\.exe$/i.test(name)),
    msi: [...records.keys()].find((name) => /\.msi$/i.test(name)),
    portable: [...records.keys()].find((name) => /-portable\.zip$/i.test(name)),
    updater: [...records.keys()].find((name) => /\.nsis\.zip$/i.test(name)),
    updaterSignature: [...records.keys()].find((name) => /\.nsis\.zip\.sig$/i.test(name)),
  };
  for (const [kind, name] of Object.entries(expected)) {
    if (!name) fail(`${manifestPath} misses ${kind}`);
    expected[kind] = validateFileRecord(root, records.get(name), `${manifest.architecture}.${kind}`);
  }
  const target = manifest.update_target;
  if (!target || target.key !== `windows/${manifest.architecture}`) fail(`${manifestPath} has the wrong update target key`);
  if (target.version !== manifest.version) fail(`${manifestPath} update version differs from product version`);
  if (safeName(target.url, "update_target.url") !== expected.updater.name) fail(`${manifestPath} update URL is not its updater archive`);
  if (target.sha256 !== expected.updater.sha256) fail(`${manifestPath} updater SHA-256 differs`);
  const sidecar = readFileSync(expected.updaterSignature.path, "utf8").trim();
  if (!sidecar || target.signature !== sidecar) fail(`${manifestPath} updater signature differs from the signed sidecar`);
  if (Number(manifest.tdlib?.bytes) < 1024 * 1024 || !SHA256_RE.test(String(manifest.tdlib?.sha256))) {
    fail(`${manifestPath} carries no verified TDLib identity`);
  }
  return { root, manifest, artifacts: expected };
}

export function assembleWindowsCandidate(lanes) {
  if (!Array.isArray(lanes) || lanes.length !== ARCHES.length) fail("exactly x64 and ARM64 lanes are required");
  const byArch = new Map();
  for (const lane of lanes) {
    const arch = lane.manifest.architecture;
    if (byArch.has(arch)) fail(`duplicated ${arch} lane`);
    byArch.set(arch, lane);
  }
  for (const arch of ARCHES) if (!byArch.has(arch)) fail(`missing ${arch} lane`);
  const versions = new Set(lanes.map((lane) => lane.manifest.version));
  const commits = new Set(lanes.map((lane) => lane.manifest.source_sha));
  if (versions.size !== 1) fail("Windows architectures were built with different product versions");
  if (commits.size !== 1) fail("Windows architectures were built from different source SHAs");
  const version = lanes[0].manifest.version;
  const sourceSha = lanes[0].manifest.source_sha;
  const targets = {};
  const architectures = {};
  for (const arch of ARCHES) {
    const lane = byArch.get(arch);
    targets[`windows/${arch}`] = lane.manifest.update_target;
    architectures[arch] = {
      setup: artifactRecord(lane.artifacts.setup),
      msi: artifactRecord(lane.artifacts.msi),
      portable: artifactRecord(lane.artifacts.portable),
      updater: {
        ...artifactRecord(lane.artifacts.updater),
        signature: lane.manifest.update_target.signature,
      },
    };
  }
  return {
    schema_version: 1,
    release_id: `green-chat-${version}-windows`,
    platform: "windows",
    version,
    source_sha: sourceSha,
    generated_at: new Date().toISOString(),
    catalog_candidate: {
      status: "available",
      native_status: "available",
      version,
      url: `/v1/client/updates/artifact/${architectures.x86_64.setup.artifact_filename}`,
      min_os: "Windows 10 1903",
      min_supported: "0.0.0",
      architectures,
    },
    native_update_manifest_patch: {
      targets,
    },
  };
}

export function copyCandidateArtifacts(lanes, out) {
  mkdirSync(out, { recursive: true });
  const copied = [];
  for (const lane of lanes) {
    for (const file of Object.values(lane.artifacts)) {
      const target = join(out, file.name);
      if (existsSync(target) && sha256(target) !== file.sha256) fail(`${file.name} already exists with different bytes`);
      if (!existsSync(target)) copyFileSync(file.path, target);
      copied.push(target);
    }
  }
  return copied;
}

function parseArgs(argv) {
  const sources = [];
  let out = resolve(repoRoot, "var/release-artifacts/windows-candidate");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--from") sources.push(resolve(String(argv[++index] ?? "")));
    else if (argv[index] === "--out") out = resolve(String(argv[++index] ?? ""));
    else if (argv[index] === "--help") {
      console.log("Usage: node scripts/windows-release-candidate.mjs --from <artifact-root> [--from ...] --out <dir>");
      process.exit(0);
    } else fail(`unknown argument ${argv[index]}`);
  }
  if (sources.length === 0) fail("at least one --from directory is required");
  return { sources, out };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifests = options.sources.flatMap((root) => walk(root).filter((path) => /windows-(?:x64|arm64)-release\.json$/i.test(path)));
  if (manifests.length !== 2) fail(`expected two Windows release manifests, found ${manifests.length}`);
  const lanes = manifests.map(validateWindowsLane);
  const candidate = assembleWindowsCandidate(lanes);
  const files = copyCandidateArtifacts(lanes, options.out);
  const outputPath = join(options.out, "windows-release-candidate.json");
  writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`);
  const checksums = [...files, outputPath]
    .map((path) => `${sha256(path)}  ${basename(path)}`)
    .sort()
    .join("\n") + "\n";
  writeFileSync(join(options.out, "SHA256SUMS-windows-candidate.txt"), checksums);
  console.log(`WINDOWS-CANDIDATE: OK ${candidate.source_sha} ${candidate.version} ${options.out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

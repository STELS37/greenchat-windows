import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { canonicalCompare } from "./canonical_order.mjs";
import { parseDistributionChannel } from "./store_profile.mjs";

export const WEB_BUILD_ATTESTATION_FILE = ".gc-build-profile.json";
export const WEB_BUILD_ATTESTATION_SCHEMA = "green-chat-web-build-profile/v2";

const SHA256_RE = /^[a-f0-9]{64}$/;
const IGNORED_SUFFIXES = [".br", ".gz"];

export function isWebBuildSidecar(path) {
  return IGNORED_SUFFIXES.some((suffix) => String(path).endsWith(suffix));
}

export function npmPackageNameFromEsbuildInput(input) {
  const normalized = String(input).replaceAll("\\", "/");
  const marker = "node_modules/";
  const markerAt = normalized.lastIndexOf(marker);
  if (markerAt < 0) return null;
  const segments = normalized.slice(markerAt + marker.length).split("/");
  if (!segments[0]) return null;
  if (segments[0].startsWith("@"))
    return segments[1] ? `${segments[0]}/${segments[1]}` : null;
  return segments[0];
}

export function canonicalAttestationJson(value) {
  if (Array.isArray(value))
    return `[${value.map(canonicalAttestationJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => canonicalCompare(left, right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalAttestationJson(child)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function attestedPath(relative) {
  return (
    relative !== WEB_BUILD_ATTESTATION_FILE && !isWebBuildSidecar(relative)
  );
}

function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\")
  ) {
    throw new Error(
      `web build attestation has an unsafe path: ${JSON.stringify(path)}`,
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(
      `web build attestation has an unsafe path: ${JSON.stringify(path)}`,
    );
  }
  if (!attestedPath(path)) {
    throw new Error(
      `web build attestation must not list generated sidecars: ${path}`,
    );
  }
}

function sameFileState(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

async function readRegularFileNoFollow(absolute, relative) {
  let handle;
  try {
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error(`web build output contains a symlink: ${relative}`);
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile())
      throw new Error(
        `web build output contains a non-file entry: ${relative}`,
      );
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(before, after))
      throw new Error(`web build output changed while reading: ${relative}`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function collectFiles(root, current, include) {
  const directory = join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const rows = [];
  for (const entry of entries.sort((left, right) =>
    canonicalCompare(left.name, right.name),
  )) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (!include(relative)) continue;
    const absolute = join(root, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink())
      throw new Error(`web build output contains a symlink: ${relative}`);
    if (info.isDirectory()) {
      rows.push(...(await collectFiles(root, relative, include)));
      continue;
    }
    if (!info.isFile())
      throw new Error(
        `web build output contains a non-file entry: ${relative}`,
      );
    const bytes = await readRegularFileNoFollow(absolute, relative);
    rows.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
  }
  // Directory-tree walk order is not the flat path order the attestation
  // validator enforces ("app.js" precedes "app/x" because "." < "/"), so the
  // emitted list is sorted by full path. Producer and validator then obey the
  // same law and a nested name can never fail its own attestation.
  return rows.sort((left, right) => canonicalCompare(left.path, right.path));
}

export async function collectWebBuildFiles(root, current = "") {
  return collectFiles(root, current, attestedPath);
}

export async function verifyExactWebBuildFiles(root, expectedFiles) {
  if (!Array.isArray(expectedFiles) || expectedFiles.length === 0)
    throw new Error("expected staged web file inventory is empty");
  const actualFiles = await collectFiles(root, "", () => true);
  if (
    canonicalAttestationJson(actualFiles) !==
    canonicalAttestationJson(expectedFiles)
  ) {
    throw new Error(
      "staged web files do not match the expected SHA-256 inventory",
    );
  }
  return actualFiles;
}

function attestationPayload({
  profile,
  distributionChannel,
  buildId,
  files,
  bundledNpmPackages,
}) {
  return {
    algorithm: "sha256",
    build_id: buildId,
    bundled_npm_packages: bundledNpmPackages,
    distribution_channel: distributionChannel,
    files,
    profile,
    schema: WEB_BUILD_ATTESTATION_SCHEMA,
  };
}

export async function createWebBuildAttestation(
  root,
  { profile, distributionChannel, buildId, bundledNpmPackages = [] },
) {
  const channel = parseDistributionChannel(distributionChannel, profile);
  const payload = attestationPayload({
    profile,
    distributionChannel: channel,
    buildId,
    bundledNpmPackages: [...new Set(bundledNpmPackages)].sort((left, right) =>
      canonicalCompare(left, right),
    ),
    files: await collectWebBuildFiles(root),
  });
  return {
    ...payload,
    payload_sha256: sha256(canonicalAttestationJson(payload)),
  };
}

function validateAttestationShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("web build attestation must be an object");
  }
  if (
    value.schema !== WEB_BUILD_ATTESTATION_SCHEMA ||
    value.algorithm !== "sha256"
  ) {
    throw new Error("web build attestation schema or algorithm is unsupported");
  }
  if (value.profile !== "development" && value.profile !== "messenger") {
    throw new Error("web build attestation profile is invalid");
  }
  let distributionChannel;
  try {
    distributionChannel = parseDistributionChannel(
      value.distribution_channel,
      value.profile,
    );
  } catch {
    throw new Error("web build attestation distribution channel is invalid");
  }
  if (distributionChannel !== value.distribution_channel) {
    throw new Error("web build attestation distribution channel is invalid");
  }
  if (typeof value.build_id !== "string" || value.build_id.length === 0) {
    throw new Error("web build attestation build_id is invalid");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("web build attestation must list emitted files");
  }
  if (!Array.isArray(value.bundled_npm_packages)) {
    throw new Error("web build attestation must list bundled npm packages");
  }
  let previousPackage = "";
  for (const packageName of value.bundled_npm_packages) {
    if (
      typeof packageName !== "string" ||
      !/^(?:@[^/@]+\/[^/@]+|[^/@][^/]*)$/.test(packageName) ||
      (previousPackage && canonicalCompare(previousPackage, packageName) >= 0)
    ) {
      throw new Error(
        "web build attestation npm packages must be canonical, unique and sorted",
      );
    }
    previousPackage = packageName;
  }
  const seen = new Set();
  let previous = "";
  for (const row of value.files) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("web build attestation contains an invalid file row");
    }
    validateRelativePath(row.path);
    if (
      seen.has(row.path) ||
      (previous && canonicalCompare(previous, row.path) >= 0)
    ) {
      throw new Error("web build attestation paths must be unique and sorted");
    }
    if (
      !SHA256_RE.test(String(row.sha256 ?? "")) ||
      !Number.isSafeInteger(row.size) ||
      row.size < 0
    ) {
      throw new Error(
        `web build attestation metadata is invalid for ${row.path}`,
      );
    }
    seen.add(row.path);
    previous = row.path;
  }
  if (!SHA256_RE.test(String(value.payload_sha256 ?? ""))) {
    throw new Error("web build attestation payload_sha256 is invalid");
  }
}

export async function verifyWebBuildAttestation(
  root,
  { expectedProfile, expectedDistributionChannel, expectedBuildId },
) {
  let value;
  try {
    value = JSON.parse(
      await readFile(join(root, WEB_BUILD_ATTESTATION_FILE), "utf8"),
    );
  } catch (error) {
    throw new Error(
      `web build attestation is missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validateAttestationShape(value);
  if (value.profile !== expectedProfile) {
    throw new Error(
      `web build attestation profile=${value.profile}; expected ${expectedProfile}`,
    );
  }
  if (
    expectedDistributionChannel !== undefined &&
    value.distribution_channel !== expectedDistributionChannel
  ) {
    throw new Error(
      `web build attestation distribution channel=${value.distribution_channel}; expected ${expectedDistributionChannel}`,
    );
  }
  if (value.build_id !== expectedBuildId) {
    throw new Error(
      `web build attestation build_id=${value.build_id}; expected ${expectedBuildId}`,
    );
  }
  const payload = attestationPayload({
    profile: value.profile,
    distributionChannel: value.distribution_channel,
    buildId: value.build_id,
    bundledNpmPackages: value.bundled_npm_packages,
    files: value.files,
  });
  const payloadDigest = sha256(canonicalAttestationJson(payload));
  if (payloadDigest !== value.payload_sha256) {
    throw new Error("web build attestation payload SHA-256 does not match");
  }
  const actualFiles = await collectWebBuildFiles(root);
  if (
    canonicalAttestationJson(actualFiles) !==
    canonicalAttestationJson(value.files)
  ) {
    throw new Error(
      "web build files do not match the attested SHA-256 inventory",
    );
  }
  return value;
}

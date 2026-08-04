import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

export const CLIENT_RELEASE_PATH = "config/client-release.json";
export const SAFE_ARTIFACT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const REQUIRED_PLATFORMS = ["web", "android", "ios", "windows", "macos", "linux"];
const SUPPLEMENTAL_ARTIFACT_KINDS = new Set(["corresponding_source"]);
const GENERATED_PUBLIC_RELEASE_FILES = new Set(["manifest.json"]);

function fail(message) {
  throw new Error(`CLIENT-RELEASE: ${message}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function catalogRevision(catalog) {
  const value = catalog.catalog_revision ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("catalog_revision must be a non-negative integer when present");
  }
  return value;
}

export function canonicalReleaseId(catalog, android = catalog?.platforms?.android) {
  const base = `green-chat-${catalog.current_version}-android.${android.version_code}`;
  const revision = catalogRevision(catalog);
  return revision === 0 ? base : `${base}-rev.${revision}`;
}

function requireExactKeys(label, value, required, optional = []) {
  const allowedSet = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail(`${label}.${key} is not allowed`);
  }
  for (const key of required) {
    if (value[key] === undefined) fail(`${label}.${key} is required`);
  }
}

function validateArtifact(label, artifact) {
  if (!isObject(artifact)) fail(`${label} must be an object`);
  if (!SAFE_ARTIFACT_RE.test(String(artifact.artifact_filename ?? ""))) {
    fail(`${label}.artifact_filename must be a safe basename`);
  }
  if (!Number.isSafeInteger(artifact.size_bytes) || artifact.size_bytes <= 0) {
    fail(`${label}.size_bytes must be a positive integer`);
  }
  if (!SHA256_RE.test(String(artifact.sha256 ?? ""))) {
    fail(`${label}.sha256 must be a lowercase SHA-256 digest`);
  }
  if (artifact.signature !== undefined && typeof artifact.signature !== "string") {
    fail(`${label}.signature must be a string when present`);
  }
}

export function validateClientReleaseCatalog(catalog) {
  if (!isObject(catalog)) fail("catalog must be an object");
  if (catalog.schema_version !== 1) fail(`unsupported schema_version ${String(catalog.schema_version)}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{6,127}$/.test(String(catalog.release_id ?? ""))) {
    fail("release_id must be a stable safe identifier");
  }
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(String(catalog.channel ?? ""))) fail("channel is invalid");
  if (!SEMVER_RE.test(String(catalog.current_version ?? ""))) fail("current_version is not SemVer");
  const published = new Date(catalog.published_at);
  if (!catalog.published_at || Number.isNaN(published.getTime())) fail("published_at is invalid");
  if (!isObject(catalog.platforms)) fail("platforms object is required");
  for (const platform of REQUIRED_PLATFORMS) {
    if (!isObject(catalog.platforms[platform])) fail(`platforms.${platform} is required`);
  }

  for (const platform of ["web", "ios", "windows", "macos"]) {
    const row = catalog.platforms[platform];
    if (row.version !== undefined && !SEMVER_RE.test(String(row.version))) {
      fail(`platforms.${platform}.version is not SemVer`);
    }
    if (!new Set(["available", "web", "unavailable"]).has(row.status)) {
      fail(`platforms.${platform}.status is invalid`);
    }
    if (row.status !== "unavailable" && (typeof row.url !== "string" || !row.url.startsWith("/"))) {
      fail(`platforms.${platform}.url must be a same-origin absolute path`);
    }
  }

  const windows = catalog.platforms.windows;
  if (windows.status === "available") {
    validateArtifact("platforms.windows", windows);
    if (windows.arch !== "x86_64") fail("platforms.windows.arch must currently be x86_64");
    if (!String(windows.artifact_filename).endsWith(".exe")) {
      fail("platforms.windows.artifact_filename must end in .exe");
    }
    if (typeof windows.min_os !== "string" || !windows.min_os.trim()) {
      fail("platforms.windows.min_os is required");
    }
    if (!SEMVER_RE.test(String(windows.min_supported ?? "0.0.0"))) {
      fail("platforms.windows.min_supported is not SemVer");
    }
    if (windows.native_status !== "available") {
      fail("platforms.windows.native_status must be available for a published EXE");
    }
    if (typeof windows.signed !== "boolean") {
      fail("platforms.windows.signed must state whether Authenticode is present");
    }
  }

  const android = catalog.platforms.android;
  if (!new Set(["available", "unavailable"]).has(android.status)) fail("platforms.android.status is invalid");
  if (!Number.isSafeInteger(android.version_code) || android.version_code <= 0) {
    fail("platforms.android.version_code must be a positive integer");
  }
  const expectedReleaseId = canonicalReleaseId(catalog, android);
  if (catalog.release_id !== expectedReleaseId) {
    fail(`release_id must equal ${expectedReleaseId}`);
  }
  if (android.status === "available") validateArtifact("platforms.android", android);

  // A version code that Google Play has already swallowed cannot be reused, so the next code has to be
  // reserved (and stamped into build.gradle) BEFORE its APK exists. Measured 2026-08-02: writing that
  // reserved code straight into version_code/artifact_filename made the catalog claim an APK that was
  // never built — the update manifest generated from it advertised a missing file, the endpoint answered
  // url:null to every client, and check-client-release failed both ways ("published but missing" and
  // "stale or unregistered"). The reservation therefore lives in its own field: version_code always
  // describes bytes that exist.
  if (android.pending_version_code !== undefined) {
    if (!Number.isSafeInteger(android.pending_version_code) || android.pending_version_code <= 0) {
      fail("platforms.android.pending_version_code must be a positive integer");
    }
    if (android.pending_version_code <= android.version_code) {
      fail(
        `platforms.android.pending_version_code must exceed the published version_code ${android.version_code}`,
      );
    }
    if (android.status !== "available") {
      fail("platforms.android.pending_version_code requires a published Android release to build on top of");
    }
    if (typeof android.pending_reason !== "string" || !android.pending_reason.trim()) {
      fail("platforms.android.pending_reason is required whenever a version code is reserved");
    }
  } else if (android.pending_reason !== undefined) {
    fail("platforms.android.pending_reason requires platforms.android.pending_version_code");
  }

  if (android.contains_gpl_engine !== undefined && typeof android.contains_gpl_engine !== "boolean") {
    fail("platforms.android.contains_gpl_engine must be a boolean when present");
  }
  if (android.source !== undefined) {
    fail("platforms.android.source is obsolete; use supplemental_artifacts");
  }
  if (android.status !== "available" && android.contains_gpl_engine === true) {
    fail("platforms.android.contains_gpl_engine requires an available Android installer");
  }
  if (typeof android.min_os !== "string" || !android.min_os.trim()) fail("platforms.android.min_os is required");
  if (!SEMVER_RE.test(String(android.min_supported ?? "0.0.0"))) {
    fail("platforms.android.min_supported is not SemVer");
  }

  const linux = catalog.platforms.linux;
  if (!new Set(["available", "unavailable"]).has(linux.status)) fail("platforms.linux.status is invalid");
  if (linux.version !== undefined && !SEMVER_RE.test(String(linux.version))) {
    fail("platforms.linux.version is not SemVer");
  }
  if (linux.status === "available") {
    if (linux.arch !== "x86_64") fail("platforms.linux.arch must currently be x86_64");
    if (!isObject(linux.packages)) fail("platforms.linux.packages is required");
    validateArtifact("platforms.linux.packages.appimage", linux.packages.appimage);
    validateArtifact("platforms.linux.packages.deb", linux.packages.deb);
    if (linux.packages.rpm !== undefined) {
      validateArtifact("platforms.linux.packages.rpm", linux.packages.rpm);
    }
  }

  const supplemental = catalog.supplemental_artifacts;
  if (supplemental !== undefined) {
    if (!Array.isArray(supplemental) || supplemental.length > 16) {
      fail("supplemental_artifacts must be an array with at most 16 entries");
    }
    const installerNames = new Set(
      collectPublishedPlatformArtifactRows(catalog.platforms).map((row) => row.filename),
    );
    const ids = new Set();
    for (let index = 0; index < supplemental.length; index += 1) {
      const label = `supplemental_artifacts[${index}]`;
      const row = supplemental[index];
      if (!isObject(row)) fail(`${label} must be an object`);
      requireExactKeys(
        label,
        row,
        ["id", "kind", "for_artifact", "artifact_filename", "size_bytes", "sha256"],
        ["url"],
      );
      if (!/^[a-z][a-z0-9_-]{2,63}$/.test(String(row.id))) fail(`${label}.id is invalid`);
      if (ids.has(row.id)) fail(`${label}.id is duplicated`);
      ids.add(row.id);
      if (!SUPPLEMENTAL_ARTIFACT_KINDS.has(row.kind)) fail(`${label}.kind is unsupported`);
      if (!SAFE_ARTIFACT_RE.test(String(row.for_artifact))) fail(`${label}.for_artifact must be a safe basename`);
      if (!installerNames.has(row.for_artifact)) fail(`${label}.for_artifact is not a canonical installer`);
      validateArtifact(label, row);
      if (row.url !== undefined && row.url !== `/v1/client/updates/artifact/${row.artifact_filename}`) {
        fail(`${label}.url is not the canonical artifact route`);
      }
      if (row.kind === "corresponding_source" && !String(row.artifact_filename).endsWith(".tar.gz")) {
        fail(`${label}.artifact_filename must end in .tar.gz for corresponding source`);
      }
      if (row.artifact_filename === row.for_artifact) fail(`${label} cannot reuse its installer filename`);
    }
  }
  if (android.contains_gpl_engine === true) {
    const sources = (supplemental ?? []).filter((row) =>
      row?.kind === "corresponding_source" && row?.for_artifact === android.artifact_filename
    );
    if (sources.length !== 1) {
      fail("platforms.android.contains_gpl_engine requires exactly one supplemental corresponding source");
    }
  }
  return catalog;
}

export async function readClientReleaseCatalog(repoRoot, options = {}) {
  const file = resolve(options.catalogFile || join(repoRoot, CLIENT_RELEASE_PATH));
  let raw;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      fail(`release catalog must be a single-link regular non-symlink file: ${file}`);
    }
    if (info.size < 2 || info.size > 1024 * 1024) fail(`release catalog size is invalid: ${info.size}`);
    if (await realpath(file) !== file) fail(`release catalog must use its canonical path: ${file}`);
    raw = await readFile(file);
  } catch (error) {
    if (String(error?.message || "").startsWith("CLIENT-RELEASE:")) throw error;
    fail(`cannot read release catalog ${file}: ${error.message}`);
  }
  const expected = String(options.catalogSha256 || "").trim();
  if (expected) {
    if (!SHA256_RE.test(expected)) fail("release catalog expected SHA-256 is invalid");
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== expected) fail(`release catalog SHA-256=${actual}; expected=${expected}`);
  }
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch (error) { fail(`release catalog ${file} is invalid JSON: ${error.message}`); }
  return validateClientReleaseCatalog(parsed);
}

export async function sha256File(file) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export const RELEASE_FRESHNESS_FILES = ["downloads.json", "index.html", "en/index.html", "site-loader.js"];

async function collectPrecompressedSidecars(root, relative = "") {
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch (error) {
    fail(`cannot scan precompressed site directory ${join(root, relative)}: ${error.message}`);
  }
  const files = [];
  for (const entry of entries) {
    const child = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await collectPrecompressedSidecars(root, child));
    else if (entry.isFile() && (child.endsWith(".br") || child.endsWith(".gz"))) files.push(child);
  }
  return files;
}

async function readRequiredFile(file, label) {
  try {
    return await readFile(file);
  } catch (error) {
    fail(`${label} is missing or unreadable: ${file} (${error.message})`);
  }
}

function decompressSidecar(relative, bytes) {
  try {
    if (relative.endsWith(".br")) return brotliDecompressSync(bytes);
    if (relative.endsWith(".gz")) return gunzipSync(bytes);
  } catch (error) {
    fail(`invalid precompressed sidecar ${relative}: ${error.message}`);
  }
  fail(`unsupported precompressed sidecar ${relative}`);
}

export async function verifyPrecompressedSidecars(
  distRoot,
  { requiredFiles = RELEASE_FRESHNESS_FILES } = {},
) {
  const required = new Set();
  for (const relative of requiredFiles) {
    await readRequiredFile(join(distRoot, relative), `release-facing file ${relative}`);
    required.add(`${relative}.br`);
    required.add(`${relative}.gz`);
  }

  const sidecars = await collectPrecompressedSidecars(distRoot);
  const sidecarSet = new Set(sidecars);
  for (const relative of required) {
    if (!sidecarSet.has(relative)) fail(`required precompressed sidecar is missing: ${join(distRoot, relative)}`);
  }

  for (const relative of sidecars) {
    const sourceRelative = relative.slice(0, -3);
    const source = await readRequiredFile(
      join(distRoot, sourceRelative),
      `source for precompressed sidecar ${relative}`,
    );
    const compressed = await readRequiredFile(join(distRoot, relative), `precompressed sidecar ${relative}`);
    const decoded = decompressSidecar(relative, compressed);
    if (!decoded.equals(source)) {
      fail(`stale precompressed sidecar ${relative} does not match ${sourceRelative}`);
    }
  }
  return { checked: sidecars.length, required: required.size };
}

const PUBLIC_INSTALLER_RE = /\.(?:apk|aab|AppImage|deb|exe|msi|dmg|pkg|ipa)$/;

const LIBBOX_APK_ENTRIES = [
  "lib/armeabi-v7a/libbox.so",
  "lib/arm64-v8a/libbox.so",
  "lib/x86/libbox.so",
  "lib/x86_64/libbox.so",
];

async function androidPackageContainsLibbox(file) {
  const bytes = await readRequiredFile(file, "Android package for GPL engine audit");
  const minimumEocd = 22;
  const searchStart = Math.max(0, bytes.length - (0xffff + minimumEocd));
  let eocd = -1;
  for (let offset = bytes.length - minimumEocd; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + minimumEocd + commentLength === bytes.length) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("Android package has no valid ZIP end-of-central-directory record");
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail("Android package uses a multi-disk ZIP layout");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail("Android package ZIP64 layout is unsupported by the release audit");
  }
  const centralEnd = centralOffset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || centralOffset < 0 || centralEnd !== eocd) {
    fail("Android package central directory bounds are invalid");
  }
  const names = new Set();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      fail("Android package central directory entry is invalid");
    }
    const filenameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const next = cursor + 46 + filenameLength + extraLength + commentLength;
    if (filenameLength === 0 || next > centralEnd) fail("Android package ZIP entry bounds are invalid");
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + filenameLength);
    if (names.has(name)) fail(`Android package has a duplicate ZIP entry: ${name}`);
    names.add(name);
    cursor = next;
  }
  if (cursor !== centralEnd) fail("Android package central directory size is inconsistent");
  const present = LIBBOX_APK_ENTRIES.filter((entry) => names.has(entry));
  if (present.length === 0) return false;
  if (present.length !== LIBBOX_APK_ENTRIES.length) {
    fail(`Android package contains an incomplete libbox ABI set: ${present.sort().join(", ")}`);
  }
  return true;
}

function collectArtifactRows(value, label = "platforms", rows = []) {
  if (!isObject(value)) return rows;
  if (value.artifact_filename !== undefined) {
    const filename = String(value.artifact_filename);
    if (!SAFE_ARTIFACT_RE.test(filename)) fail(`${label}.artifact_filename must be a safe basename`);
    rows.push({ label, filename });
  }
  for (const [key, child] of Object.entries(value)) {
    if (isObject(child)) collectArtifactRows(child, `${label}.${key}`, rows);
  }
  return rows;
}

function collectPublishedPlatformArtifactRows(platforms) {
  const rows = [];
  for (const [platform, value] of Object.entries(platforms)) {
    if (value?.status === "available") collectArtifactRows(value, `platforms.${platform}`, rows);
  }
  return rows;
}

export function releaseArtifactFilenames(catalog) {
  const validated = validateClientReleaseCatalog(catalog);
  const rows = collectPublishedPlatformArtifactRows(validated.platforms);
  for (let index = 0; index < (validated.supplemental_artifacts ?? []).length; index += 1) {
    const artifact = validated.supplemental_artifacts[index];
    rows.push({ label: `supplemental_artifacts[${index}]`, filename: artifact.artifact_filename });
  }
  const owners = new Map();
  for (const row of rows) {
    if (owners.has(row.filename)) {
      fail(`artifact filename ${row.filename} is reused by ${owners.get(row.filename)} and ${row.label}`);
    }
    owners.set(row.filename, row.label);
  }
  return new Set(owners.keys());
}

export async function auditPublicReleaseDirectory(
  updatesDir,
  catalog,
  { requireDirectory = false } = {},
) {
  const expected = releaseArtifactFilenames(catalog);
  let entries;
  try {
    entries = await readdir(updatesDir, { withFileTypes: true });
  } catch (error) {
    if (!requireDirectory && error?.code === "ENOENT") {
      return { expected: [...expected].sort(), artifacts: [], installers: [], supplemental: [] };
    }
    fail(`cannot scan public release directory ${updatesDir}: ${error.message}`);
  }

  const supplementalNames = new Set(
    (validateClientReleaseCatalog(catalog).supplemental_artifacts ?? []).map((row) => row.artifact_filename),
  );
  const artifacts = [];
  const installers = [];
  const supplemental = [];
  const stale = [];
  for (const entry of entries) {
    if (GENERATED_PUBLIC_RELEASE_FILES.has(entry.name)) {
      if (!entry.isFile()) fail(`generated public release file must be regular: ${entry.name}`);
      continue;
    }
    if (!entry.isFile()) fail(`public release entry must be a regular file: ${entry.name}`);
    artifacts.push(entry.name);
    if (!expected.has(entry.name)) stale.push(entry.name);
    if (PUBLIC_INSTALLER_RE.test(entry.name)) installers.push(entry.name);
    if (supplementalNames.has(entry.name)) supplemental.push(entry.name);
  }
  if (stale.length > 0) {
    fail(`stale or unregistered public release artifact(s) in ${updatesDir}: ${stale.sort().join(", ")}`);
  }
  const present = new Set(artifacts);
  const missing = [...expected].filter((filename) => !present.has(filename));
  if (requireDirectory && missing.length > 0) {
    fail(`canonical public release artifact(s) missing from ${updatesDir}: ${missing.sort().join(", ")}`);
  }
  return {
    expected: [...expected].sort(),
    artifacts: artifacts.sort(),
    installers: installers.sort(),
    supplemental: supplemental.sort(),
  };
}

export async function stagePublicReleaseArtifacts({ repoRoot, sourceDir, targetDir, catalogFile, catalogSha256 }) {
  const repo = resolve(repoRoot);
  const sourceRoot = resolve(sourceDir);
  const targetRoot = resolve(targetDir);
  if (sourceRoot === targetRoot) fail("private artifact source and public staging target must differ");
  if (targetRoot === resolve("/")) fail("refusing to use the filesystem root as an artifact staging target");

  const sourceInfo = await lstat(sourceRoot).catch((error) => {
    fail(`private artifact source is missing or unreadable: ${sourceRoot} (${error.message})`);
  });
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory()) {
    fail(`private artifact source must be a real directory, not a symlink: ${sourceRoot}`);
  }

  const catalog = await readClientReleaseCatalog(repo, { catalogFile, catalogSha256 });

  const android = catalog.platforms.android;
  if (android.status === "available") {
    const androidSource = join(sourceRoot, android.artifact_filename);
    const packageInfo = await lstat(androidSource).catch((error) => {
      fail(`canonical Android artifact is missing from the private source: ${androidSource} (${error.message})`);
    });
    if (packageInfo.isSymbolicLink() || !packageInfo.isFile()) {
      fail(`canonical Android artifact must be a regular non-symlink file: ${androidSource}`);
    }
    const containsLibbox = await androidPackageContainsLibbox(androidSource);
    const matchingSources = (catalog.supplemental_artifacts ?? []).filter((row) =>
      row.kind === "corresponding_source" && row.for_artifact === android.artifact_filename
    );
    if (containsLibbox && (android.contains_gpl_engine !== true || matchingSources.length !== 1)) {
      fail("embedded GPL engine requires one catalogued supplemental Corresponding Source artifact");
    }
    if (!containsLibbox && android.contains_gpl_engine === true) {
      fail("release catalog declares the GPL engine, but the Android artifact lacks the complete libbox ABI set");
    }
  }
  const filenames = [...releaseArtifactFilenames(catalog)].sort();
  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true, mode: 0o755 });
  // mkdir's mode is masked by the caller's umask and copyFile inherits the PRIVATE source mode, so
  // without these two chmods the published bytes carry whatever permissions the operator's shell and
  // the build machine happened to have. Measured: staging from a umask 077 shell produced a 0700
  // directory holding a 0400 installer — the server runs as an unprivileged user and would have
  // answered every download with "not found" while the catalog kept advertising the file. Publication
  // permissions are a property of the public surface, not of whoever typed the deploy command.
  await chmod(targetRoot, 0o755);

  try {
    for (const filename of filenames) {
      const source = join(sourceRoot, filename);
      const info = await lstat(source).catch((error) => {
        fail(`canonical artifact is missing from the private source: ${source} (${error.message})`);
      });
      if (info.isSymbolicLink() || !info.isFile()) {
        fail(`canonical artifact must be a regular non-symlink file: ${source}`);
      }
      await copyFile(source, join(targetRoot, filename));
      await chmod(join(targetRoot, filename), 0o644);
    }

    const downloads = await materializePublicDownloads({
      repoRoot: repo,
      updatesDir: targetRoot,
      requireArtifacts: true,
      catalogFile,
      catalogSha256,
    });
    const audit = await auditPublicReleaseDirectory(targetRoot, downloads, { requireDirectory: true });
    return { catalog: downloads, ...audit };
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true });
    throw error;
  }
}

async function verifyArtifactFile(updatesDir, label, artifact, requireArtifacts) {
  const filename = String(artifact.artifact_filename);
  const file = join(updatesDir, filename);
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch {
    if (requireArtifacts) fail(`${label} is published but missing: ${file}`);
    return;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) fail(`${label} is not a regular non-symlink file: ${file}`);
  if (fileStat.size !== artifact.size_bytes) {
    fail(`${label} size=${fileStat.size}; catalog=${artifact.size_bytes}`);
  }
  const digest = await sha256File(file);
  if (digest !== artifact.sha256) fail(`${label} sha256=${digest}; catalog=${artifact.sha256}`);
}

export function assertAndroidSignerContinuity(currentDigests, nextDigests) {
  const normalize = (values, label) => {
    if (!Array.isArray(values) || values.length === 0) fail(`${label} APK has no verified signing certificate`);
    const normalized = [...new Set(values.map((value) => String(value).toLowerCase()))].sort();
    if (normalized.some((value) => !SHA256_RE.test(value))) {
      fail(`${label} APK signing certificate digest is invalid`);
    }
    return normalized;
  };
  const current = normalize(currentDigests, "current");
  const next = normalize(nextDigests, "candidate");
  if (canonicalJson(current) !== canonicalJson(next)) {
    fail("candidate Android APK signing certificate differs from the current release");
  }
  return next;
}

export function assertAndroidArtifactIdentity(
  catalog,
  { versionName, versionCode, applicationId },
  { expectedApplicationId = "app.greenchat" } = {},
) {
  const validated = validateClientReleaseCatalog(catalog);
  const android = validated.platforms.android;
  if (android.status !== "available") return validated;
  if (String(versionName) !== validated.current_version) {
    fail(`Android APK versionName=${String(versionName)}; catalog=${validated.current_version}`);
  }
  const code = String(versionCode);
  if (!/^[1-9][0-9]*$/.test(code) || code !== String(android.version_code)) {
    fail(`Android APK versionCode=${code}; catalog=${android.version_code}`);
  }
  if (String(applicationId) !== expectedApplicationId) {
    fail(`Android APK applicationId=${String(applicationId)}; expected=${expectedApplicationId}`);
  }
  return validated;
}

export async function verifyReleaseArtifacts(updatesDir, catalog, { requireArtifacts = true } = {}) {
  const validated = validateClientReleaseCatalog(catalog);
  const android = validated.platforms.android;
  if (android.status === "available") {
    await verifyArtifactFile(updatesDir, "android artifact", android, requireArtifacts);
  }
  const windows = validated.platforms.windows;
  if (windows.status === "available") {
    await verifyArtifactFile(updatesDir, "windows setup artifact", windows, requireArtifacts);
  }
  const linux = validated.platforms.linux;
  if (linux.status === "available") {
    for (const [kind, artifact] of Object.entries(linux.packages)) {
      await verifyArtifactFile(updatesDir, `linux ${kind} artifact`, artifact, requireArtifacts);
    }
  }
  for (let index = 0; index < (validated.supplemental_artifacts ?? []).length; index += 1) {
    const artifact = validated.supplemental_artifacts[index];
    await verifyArtifactFile(updatesDir, `supplemental artifact ${artifact.id}`, artifact, requireArtifacts);
  }
  return validated;
}

export async function materializePublicDownloads({
  repoRoot,
  updatesDir,
  requireArtifacts = false,
  catalogFile,
  catalogSha256,
}) {
  const catalog = clone(await readClientReleaseCatalog(repoRoot, { catalogFile, catalogSha256 }));
  const version = catalog.current_version;
  const downloads = catalog;
  downloads.updated_at = String(catalog.published_at).slice(0, 10);

  // Native artifacts may legitimately trail the web/Android marketing release. Never overwrite an
  // explicit platform version: doing so made the public Linux card claim beta.5 while both filenames
  // and verified bytes were beta.4. Rows without an explicit version inherit the release version.
  for (const row of Object.values(downloads.platforms)) row.version = row.version ?? version;

  const android = downloads.platforms.android;
  // Reservation metadata is internal release-control state. Exposing it in downloads.json made a
  // build number look published before its APK/Play transaction completed. Only bytes that exist are
  // public; the next reserved code remains in the tracked operator catalog.
  delete android.pending_version_code;
  delete android.pending_reason;
  if (android.status === "available") {
    await verifyArtifactFile(updatesDir, "android artifact", android, requireArtifacts);
    android.url = `/v1/client/updates/artifact/${android.artifact_filename}`;

  }

  const windows = downloads.platforms.windows;
  if (windows.status === "available") {
    await verifyArtifactFile(updatesDir, "windows setup artifact", windows, requireArtifacts);
    windows.url = `/v1/client/updates/artifact/${windows.artifact_filename}`;
  }

  const linux = downloads.platforms.linux;
  if (linux.status === "available") {
    for (const [kind, artifact] of Object.entries(linux.packages)) {
      await verifyArtifactFile(updatesDir, `linux ${kind} artifact`, artifact, requireArtifacts);
      artifact.url = `/v1/client/updates/artifact/${artifact.artifact_filename}`;
    }
    linux.url = linux.packages.appimage.url;
  }

  for (let index = 0; index < (downloads.supplemental_artifacts ?? []).length; index += 1) {
    const artifact = downloads.supplemental_artifacts[index];
    await verifyArtifactFile(updatesDir, `supplemental artifact ${artifact.id}`, artifact, requireArtifacts);
    artifact.url = `/v1/client/updates/artifact/${artifact.artifact_filename}`;
  }
  return downloads;
}

function updaterTarget(downloads, artifact, extra = {}) {
  return {
    version: downloads.current_version,
    url: artifact.artifact_filename,
    sha256: artifact.sha256,
    pub_date: downloads.published_at,
    notes: downloads.notes ?? null,
    ...extra,
    ...(typeof artifact.signature === "string" && artifact.signature ? { signature: artifact.signature } : {}),
  };
}

export function buildNativeUpdateManifest(downloads) {
  const targets = {};
  const android = downloads.platforms.android;
  if (android.status === "available") {
    targets["android/universal"] = updaterTarget(downloads, android, {
      min_supported: android.min_supported ?? "0.0.0",
      version_code: android.version_code,
    });
  }

  // Linux package managers are not interchangeable: an AppImage update must rewrite the AppImage,
  // while DEB and RPM installations must invoke dpkg/rpm. Advertise one signed target per installer
  // type and keep the old generic key as an AppImage-only compatibility fallback for earlier clients.
  const linux = downloads.platforms.linux;
  if (linux?.status === "available") {
    const linuxVersion = linux.version ?? downloads.current_version;
    for (const kind of ["appimage", "deb", "rpm"]) {
      const artifact = linux.packages?.[kind];
      if (typeof artifact?.signature !== "string" || !artifact.signature) continue;
      const target = updaterTarget(downloads, artifact, {
        version: linuxVersion,
        min_supported: linux.min_supported ?? "0.0.0",
      });
      targets[`linux/${linux.arch}/${kind}`] = target;
      if (kind === "appimage") targets[`linux/${linux.arch}`] = target;
    }
  }

  return {
    schema_version: 1,
    generated_from_release_id: downloads.release_id,
    default_channel: downloads.channel,
    channels: {
      [downloads.channel]: {
        min_supported: "0.0.0",
        targets,
      },
    },
  };
}


const ANDROID_RELEASE_EXACT_FILES = new Set([
  "clients/build.mjs",
  "clients/build_helpers.mjs",
  "clients/build_helpers.d.mts",
  "clients/config_signature_pin.mjs",
  "clients/build_attestation.mjs",
  "clients/release_identity.mjs",
  "clients/store_profile.mjs",
  "clients/package.json",
  "clients/package-lock.json",
  "clients/tsconfig.json",
  "clients/mobile/capacitor.config.ts",
  "clients/mobile/package.json",
  "clients/mobile/package-lock.json",
  "clients/mobile/prepare.mjs",
  "clients/mobile/tsconfig.json",
  "clients/mobile/android/app/build.gradle",
  "clients/mobile/android/app/capacitor.build.gradle",
  "clients/mobile/android/app/proguard-rules.pro",
  "clients/mobile/android/build.gradle",
  "clients/mobile/android/capacitor.settings.gradle",
  "clients/mobile/android/gradle.properties",
  "clients/mobile/android/gradlew",
  "clients/mobile/android/gradlew.bat",
  "clients/mobile/android/gradle/wrapper/gradle-wrapper.jar",
  "clients/mobile/android/gradle/wrapper/gradle-wrapper.properties",
  "clients/mobile/android/settings.gradle",
  "clients/mobile/android/variables.gradle",
  "clients/third_party/tdlib/PINNED.env",
  "clients/third_party/tdlib/build-android.sh",
]);

function normalizedRepoPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

export function isAndroidReleaseInputPath(value) {
  const file = normalizedRepoPath(value);
  if (!file || file.includes("\0")) return false;
  if (ANDROID_RELEASE_EXACT_FILES.has(file)) return true;
  if (file.startsWith("clients/core/src/")) return true;
  if (file.startsWith("clients/ui/src/")) return true;
  if (file.startsWith("clients/web/") && !file.endsWith("/README.md") && !file.endsWith("README.md")) return true;
  if (file.startsWith("clients/mobile/bridge/")) {
    return !/(?:^|\/)(?:test|tests|fixtures)\//.test(file)
      && !/\.(?:test|spec)\.[^.]+$/.test(file);
  }
  if (file.startsWith("clients/mobile/android/")) {
    if (/(?:^|\/)(?:test|tests|androidTest|fixtures|debug)(?:\/|$)/.test(file)) return false;
    if (/\.(?:test|spec)\.[^.]+$/.test(file)) return false;
    if (/(?:^|\/)README(?:\.[^/]*)?$/.test(file) || file.endsWith("/.gitignore")) return false;
    return true;
  }
  if (file.startsWith("clients/mobile/")) {
    const relative = file.slice("clients/mobile/".length);
    if (relative.includes("/") || relative.startsWith("ios-")) return false;
    if (relative === "README.md" || relative === "check.sh") return false;
    return !/\.(?:test|spec)\.[^.]+$/.test(relative);
  }
  return false;
}

function semverParts(value) {
  const text = String(value);
  if (!SEMVER_RE.test(text)) fail(`invalid transition SemVer ${text}`);
  const dash = text.indexOf("-");
  const core = dash < 0 ? text : text.slice(0, dash);
  const pre = dash < 0 ? "" : text.slice(dash + 1);
  return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.pre.length, b.pre.length);
  for (let index = 0; index < count; index += 1) {
    const av = a.pre[index];
    const bv = b.pre[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    const an = /^[0-9]+$/.test(av);
    const bn = /^[0-9]+$/.test(bv);
    if (an && bn) {
      if (av.length !== bv.length) return av.length < bv.length ? -1 : 1;
      return av < bv ? -1 : 1;
    }
    if (an !== bn) return an ? -1 : 1;
    return av < bv ? -1 : 1;
  }
  return 0;
}

function artifactMetadataMap(catalog) {
  const rows = new Map();
  const collect = (value, label = "platforms") => {
    if (!isObject(value)) return;
    if (value.artifact_filename !== undefined) {
      rows.set(String(value.artifact_filename), {
        label,
        size_bytes: value.size_bytes,
        sha256: value.sha256,
        signature: value.signature ?? null,
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (isObject(child)) collect(child, `${label}.${key}`);
    }
  };
  collect(catalog.platforms);
  for (let index = 0; index < (catalog.supplemental_artifacts ?? []).length; index += 1) {
    collect(catalog.supplemental_artifacts[index], `supplemental_artifacts[${index}]`);
  }
  return rows;
}

export function assertClientReleaseTransition({
  current,
  next,
  androidImpactingPaths = [],
}) {
  const before = validateClientReleaseCatalog(current);
  const after = validateClientReleaseCatalog(next);
  const impact = [...new Set(androidImpactingPaths.map(normalizedRepoPath).filter(Boolean))].sort();

  const previousArtifacts = artifactMetadataMap(before);
  const nextArtifacts = artifactMetadataMap(after);
  for (const [filename, previous] of previousArtifacts) {
    const candidate = nextArtifacts.get(filename);
    if (candidate && canonicalJson(previous) !== canonicalJson(candidate)) {
      fail(`artifact filename ${filename} is immutable and cannot be reused with different bytes or signature`);
    }
  }

  if (before.release_id === after.release_id) {
    if (canonicalJson(before) !== canonicalJson(after)) {
      fail(`release_id ${before.release_id} is immutable; create a new release_id for any catalog change`);
    }
    // Client source drift under an unchanged release_id is REPORTED, not refused. Measured
    // 2026-08-03: the commit that published Android 1000019 is also the live release commit, and
    // every commit after it touches clients/ui/src or clients/web/src, so this refusal made the
    // publishing commit the last deployable commit in the repository — no server fix, no payments
    // observability, no migration could ever ship again. The refusal cannot be discharged by a
    // deploy either: only a store publication mints a larger version_code.
    //
    // Nothing published is at risk when this branch is reached: the catalog was already proven
    // canonically identical above, artifact bytes and signatures were already proven immutable,
    // and clients/mobile/capacitor.config.ts sets `webDir: "www"` with no `server.url`, so an
    // installed APK executes its own bundled assets and a server/web deploy cannot change what it
    // runs. The installed base is guarded by the forced-upgrade floor `min_supported` in
    // server/src/modules/client_updates.ts and by the T-808 compatibility oracle — never by this
    // comparison. The drift itself is real and is handed back to the caller so the deploy log and
    // the release conductor can see how far the shipped APK now lags its sources.
    return { mode: "redeploy", androidImpactingPaths: impact };
  }

  const beforePublished = Date.parse(before.published_at);
  const afterPublished = Date.parse(after.published_at);
  if (!(afterPublished > beforePublished)) fail("new release published_at must be strictly later than the current release");
  if (compareSemver(after.current_version, before.current_version) < 0) {
    fail(`current_version cannot decrease from ${before.current_version} to ${after.current_version}`);
  }

  const previousAndroid = before.platforms.android;
  const nextAndroid = after.platforms.android;
  const previousRevision = catalogRevision(before);
  const nextRevision = catalogRevision(after);
  if (nextRevision < previousRevision) {
    fail(`catalog_revision cannot decrease from ${previousRevision} to ${nextRevision}`);
  }
  if (nextAndroid.version_code < previousAndroid.version_code) {
    fail(
      `Android version_code cannot decrease from ${previousAndroid.version_code}; `
      + `got ${nextAndroid.version_code}`,
    );
  }
  if (previousAndroid.status === "available" && nextAndroid.status !== "available") {
    fail("a published Android release cannot transition back to unavailable");
  }
  if (nextAndroid.version_code === previousAndroid.version_code) {
    if (nextRevision <= previousRevision) {
      fail(
        `a platform-only release with unchanged Android version_code requires catalog_revision greater than ${previousRevision}`,
      );
    }
    if (canonicalJson(previousAndroid) !== canonicalJson(nextAndroid)) {
      fail("platform-only release must keep the complete published Android row unchanged");
    }
    return { mode: "platform-release", androidImpactingPaths: impact };
  }
  if (previousAndroid.status === "available" && nextAndroid.status === "available") {
    if (nextAndroid.artifact_filename === previousAndroid.artifact_filename) {
      fail("new Android version_code requires a new immutable artifact filename");
    }
    if (nextAndroid.sha256 === previousAndroid.sha256) {
      fail("new Android version_code requires a newly built APK with a different SHA-256");
    }
  }

  return { mode: "new-release", androidImpactingPaths: impact };
}

export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

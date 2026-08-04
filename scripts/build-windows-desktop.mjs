#!/usr/bin/env node
// Reproducible GreenChat Windows desktop factory.
//
// Runs only on a native Windows runner. It builds the shared web client, compiles the pinned official
// TDLib tdjson.dll, embeds it into the Tauri host, creates NSIS/MSI/portable packages, verifies the
// Windows identity/session bridge, requires Authenticode + timestamp signatures for production and
// emits immutable release metadata. It does not publish artifacts by itself.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CANONICAL_SERVER_ORIGIN = "https://greenchat.globalsystem.cc";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const clientsRoot = join(repoRoot, "clients");
const desktopRoot = join(clientsRoot, "desktop");
const tauriRoot = join(desktopRoot, "src-tauri");
const windowsConfigPath = join(tauriRoot, "tauri.windows.conf.json");

function fail(message) {
  throw new Error(`WINDOWS-DESKTOP: BLOCKED ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const failure = result.error
      ? `${result.error.code || result.error.name}: ${result.error.message}`
      : result.signal
        ? `signal ${result.signal}`
        : `exit ${result.status}`;
    const output = options.capture
      ? [String(result.stdout ?? ""), String(result.stderr ?? "")].filter(Boolean).join("\n").trim()
      : "";
    fail(`${command} ${args.join(" ")} failed (${failure})${output ? `\n${output}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function runCommandScript(script, args, options = {}) {
  // .cmd files are command-processor scripts, not native PE executables. Invoking them directly
  // through CreateProcess can fail with EINVAL on Windows even though Get-Command finds them. Managed
  // shells can also override ComSpec with pwsh.exe, so normalize it for every npm-installed CLI.
  const commandProcessor = join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "cmd.exe");
  return run(commandProcessor, ["/d", "/c", "call", script, ...args], {
    ...options,
    env: { ...(options.env ?? {}), ComSpec: commandProcessor, COMSPEC: commandProcessor },
  });
}

function runNpm(args, options = {}) {
  return runCommandScript("npm.cmd", args, options);
}

function runTauri(args, options = {}) {
  return runCommandScript("tauri.cmd", args, options);
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

function newest(files) {
  return [...files].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

function copyImmutable(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (sha256(source) !== sha256(target)) fail(`${basename(target)} already exists with different bytes`);
    return;
  }
  copyFileSync(source, target);
}

export function canonicalVersions({ catalogText, tauriText, cargoText }) {
  const catalog = JSON.parse(catalogText);
  const tauri = JSON.parse(tauriText);
  const cargo = /^\s*version\s*=\s*"([^"]+)"\s*$/m.exec(cargoText)?.[1] ?? "";
  const values = {
    catalog: String(catalog.current_version ?? ""),
    tauri: String(tauri.version ?? ""),
    cargo,
  };
  if (!values.catalog || !values.tauri || !values.cargo) fail(`cannot determine version identity: ${JSON.stringify(values)}`);
  if (new Set(Object.values(values)).size !== 1) fail(`version identity diverged: ${JSON.stringify(values)}`);
  return values.catalog;
}

export function windowsArch(value) {
  const arch = String(value).toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(arch)) {
    return {
      node: "x64",
      rustTarget: "x86_64-pc-windows-msvc",
      public: "x86_64",
      package: "x64",
      cmake: "x64",
      vcpkg: "x64-windows-static-md",
      peMachine: 0x8664,
    };
  }
  if (["arm64", "aarch64"].includes(arch)) {
    return {
      node: "arm64",
      rustTarget: "aarch64-pc-windows-msvc",
      public: "aarch64",
      package: "arm64",
      cmake: "ARM64",
      vcpkg: "arm64-windows-static-md",
      peMachine: 0xaa64,
    };
  }
  fail(`unsupported Windows architecture ${value}`);
}

export function artifactNames(version, arch) {
  return {
    setup: `GreenChat-${version}-windows-${arch.package}-setup.exe`,
    msi: `GreenChat-${version}-windows-${arch.package}.msi`,
    portable: `GreenChat-${version}-windows-${arch.package}-portable.zip`,
    updater: `GreenChat-${version}-windows-${arch.package}.nsis.zip`,
    updaterSignature: `GreenChat-${version}-windows-${arch.package}.nsis.zip.sig`,
    manifest: `windows-${arch.package}-release.json`,
    checksums: `SHA256SUMS-windows-${arch.package}.txt`,
  };
}

// Windows Installer will not accept the application's own semver. Measured on the Windows worker on
// 2026-08-04, building 93560c77: the release binary linked, NSIS produced
// GreenChat_1.0.0-beta.5_x64-setup.exe, and then the MSI target refused the whole bundle with
//     failed to bundle project: `optional pre-release identifier in app version must be numeric-only
//                                and cannot be greater than 65535 for msi target`
// because our version is 1.0.0-beta.5: MSI allows at most ONE pre-release identifier and it must be
// numeric, while `beta.5` is two and the first is a word. MSI is not optional here — sourceContracts()
// requires both NSIS and MSI — and the version is not free either, canonicalVersions() pins it to the
// catalogue and to Cargo.toml. So the version is translated rather than changed.
//
// tauri-cli 2.11.4 config.schema.json, WixConfig.version:
//   "MSI installer version in the format `major.minor.patch.build` (build is optional). Because a
//    valid version is required for MSI installer, it will be derived from Config::version if this
//    field is not set. The first field is the major version and has a maximum value of 255. The
//    second field is the minor version and has a maximum value of 255. The third and fourth fields
//    have a maximum value of 65,535."
//
// HONEST LIMITATION, so nobody later reads more into the fourth field than Windows does: Windows
// Installer compares only the FIRST THREE fields of ProductVersion and ignores the fourth. So
// 1.0.0-beta.5 -> 1.0.0.5 and a future 1.0.0 -> 1.0.0.0 compare EQUAL, which is what protects the
// final release from looking like a downgrade to beta installations, and is also why one beta MSI
// over another is a reinstall rather than an upgrade. Beta-to-beta upgrades are the NSIS lane's job —
// NSIS carries the updater artifact (`.nsis.zip`), the MSI is the enterprise deployment copy.
export function msiProductVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim());
  if (!match) fail(`version ${version} is not semver, so no MSI ProductVersion can be derived from it`);
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major > 255) fail(`MSI major version must be <= 255, got ${major} from ${version}`);
  if (minor > 255) fail(`MSI minor version must be <= 255, got ${minor} from ${version}`);
  if (patch > 65535) fail(`MSI patch version must be <= 65535, got ${patch} from ${version}`);
  const base = `${major}.${minor}.${patch}`;
  if (!match[4]) return base;
  // `beta.5` -> 5, `rc.2` -> 2, `beta` -> refused. The last numeric identifier is the build number;
  // guessing one for a purely alphabetic pre-release would silently ship two different builds under
  // one ProductVersion, which is worse than failing the release.
  const numeric = match[4].split(".").filter((part) => /^\d+$/.test(part)).at(-1);
  if (numeric === undefined) {
    fail(`pre-release ${match[4]} in ${version} has no numeric identifier to become the MSI build number`);
  }
  const build = Number(numeric);
  if (build > 65535) fail(`MSI build number must be <= 65535, got ${build} from ${version}`);
  return `${base}.${build}`;
}

export function peMachine(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    fail("file is not an MZ executable");
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 6 > buffer.length || buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    fail("file has no valid PE header");
  }
  return buffer.readUInt16LE(peOffset + 4);
}

export function sourceContracts({ tauriBase, tauriWindows, rustSource, bridgeSource, workflowSource }) {
  const problems = [];
  const base = JSON.parse(tauriBase);
  const windows = JSON.parse(tauriWindows);
  const targets = new Set(windows?.bundle?.targets ?? []);
  if (!targets.has("nsis") || !targets.has("msi")) problems.push("Windows config must build NSIS and MSI");
  if (windows?.bundle?.createUpdaterArtifacts !== true) problems.push("Windows config must create updater artifacts");
  if (windows?.bundle?.windows?.allowDowngrades !== false) problems.push("Windows installer must reject downgrades");
  if (windows?.bundle?.windows?.nsis?.installMode !== "currentUser") problems.push("Windows NSIS must support admin-free per-user installation");
  // The MSI ProductVersion is DERIVED from the verified version at build time (writeSigningOverlay →
  // msiProductVersion). A literal here would be a second, unverified home for the version, free to
  // drift away from the catalogue that canonicalVersions() checks — and a stale ProductVersion is a
  // silent defect: Windows Installer would treat a new build as the same product and skip the upgrade.
  if (windows?.bundle?.windows?.wix?.version !== undefined) {
    problems.push("Windows WiX version must be derived from the canonical version, not written into the config");
  }
  if (windows?.plugins?.updater?.windows?.installMode !== "passive") problems.push("Windows updater must use passive installation");
  const resources = windows?.bundle?.resources ?? {};
  if (resources["resources/tdlib/"] !== null) problems.push("Windows config must remove the generic cross-platform TDLib directory");
  if (!Object.values(resources).includes("tdlib/tdjson.dll")) problems.push("Windows package does not embed tdjson.dll");
  const endpointText = JSON.stringify(windows?.plugins?.updater?.endpoints ?? []);
  if (!endpointText.includes(CANONICAL_SERVER_ORIGIN) || !endpointText.includes("{{target}}") || !endpointText.includes("{{arch}}")) {
    problems.push("Windows updater endpoint is not canonical and architecture-specific");
  }
  if (typeof base?.plugins?.updater?.pubkey !== "string" || !base.plugins.updater.pubkey.trim()) {
    problems.push("Tauri updater public key is missing");
  }
  for (const token of ["__GC_DESKTOP_OS__", "__GC_DESKTOP_ARCH__", "__GC_DESKTOP_VERSION__"]) {
    if (!rustSource.includes(token) || !bridgeSource.includes(token)) problems.push(`native identity token ${token} is not wired end-to-end`);
  }
  if (!rustSource.includes('"windows"') || !bridgeSource.includes('NATIVE_OS === "windows"')) {
    problems.push("Windows native identity is not implemented");
  }
  for (const header of ["x-gc-client", "x-device"]) {
    if (!bridgeSource.includes(header)) problems.push(`desktop bridge does not set ${header}`);
  }
  if (!workflowSource.includes("signpath/github-action-submit-signing-request@v2") || !workflowSource.includes("SIGNPATH_API_TOKEN")) {
    problems.push("Windows workflow does not submit GitHub-hosted artifacts to SignPath");
  }
  if (!workflowSource.includes("windows-x64") || !workflowSource.includes("windows-arm64")) {
    problems.push("Windows workflow does not build x64 and ARM64 separately");
  }
  return problems;
}

function parsePinnedEnv() {
  const text = readFileSync(join(clientsRoot, "third_party/tdlib/PINNED.env"), "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  for (const key of ["TDLIB_REPOSITORY", "TDLIB_COMMIT", "TDLIB_EXPECTED_VERSION"]) {
    if (!values[key]) fail(`PINNED.env misses ${key}`);
  }
  return values;
}

function parseArgs(argv) {
  const options = {
    out: process.env.GC_BUILD_ARTIFACT_DIR
      ? resolve(process.env.GC_BUILD_ARTIFACT_DIR)
      : join(repoRoot, "var/release-artifacts/windows"),
    arch: windowsArch(process.env.GC_WINDOWS_ARCH || process.arch),
    skipWeb: false,
    skipChecks: false,
    skipTdlib: false,
    reuseBundles: false,
    allowDirty: false,
    allowUnsigned: false,
    skipRuntimeSmoke: false,
    selfCheck: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") options.out = resolve(String(argv[++i] ?? ""));
    else if (arg === "--arch") options.arch = windowsArch(String(argv[++i] ?? ""));
    else if (arg === "--skip-web") options.skipWeb = true;
    else if (arg === "--skip-checks") options.skipChecks = true;
    else if (arg === "--skip-tdlib") options.skipTdlib = true;
    else if (arg === "--reuse-bundles") options.reuseBundles = true;
    else if (arg === "--allow-dirty") options.allowDirty = true;
    else if (arg === "--allow-unsigned") options.allowUnsigned = true;
    else if (arg === "--skip-runtime-smoke") options.skipRuntimeSmoke = true;
    else if (arg === "--self-check") options.selfCheck = true;
    else if (arg === "--help") {
      console.log("Usage: node scripts/build-windows-desktop.mjs [--out DIR] [--arch x64|arm64] [--skip-web] [--skip-checks] [--skip-tdlib] [--reuse-bundles] [--allow-dirty] [--allow-unsigned] [--skip-runtime-smoke] [--self-check]");
      process.exit(0);
    } else fail(`unknown argument ${arg}`);
  }
  return options;
}

function sourceState() {
  return {
    sha: run("git", ["rev-parse", "HEAD"], { capture: true }),
    dirty: run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true }).length > 0,
  };
}

function verifySourceContracts() {
  const source = (path) => readFileSync(join(repoRoot, path), "utf8");
  const version = canonicalVersions({
    catalogText: source("config/client-release.json"),
    tauriText: source("clients/desktop/src-tauri/tauri.conf.json"),
    cargoText: source("clients/desktop/src-tauri/Cargo.toml"),
  });
  const workflowPath = join(repoRoot, ".github/workflows/windows-artifacts.yml");
  const problems = sourceContracts({
    tauriBase: source("clients/desktop/src-tauri/tauri.conf.json"),
    tauriWindows: source("clients/desktop/src-tauri/tauri.windows.conf.json"),
    rustSource: source("clients/desktop/src-tauri/src/lib.rs"),
    bridgeSource: source("clients/desktop/src-tauri/src/bridge.js"),
    workflowSource: existsSync(workflowPath) ? readFileSync(workflowPath, "utf8") : "",
  });
  if (problems.length) fail(problems.join("; "));
  return version;
}

// Windows PowerShell 5.1 and PowerShell 7 are different runtimes that do not share modules.
// `Microsoft.PowerShell.Security` is a binary module compiled against the runtime that owns it, so
// when powershell.exe 5.1 finds PowerShell 7's copy first it cannot load it and
// Get-AuthenticodeSignature dies with CouldNotAutoloadMatchingModule -- at the very last step, after
// the Rust build has already cost seven minutes.
//
// Measured on the Windows worker inside the real chain (pwsh 7 -> cmd -> VsDevCmd -> node ->
// powershell.exe), one variable changed and nothing else:
//   PSModulePath as inherited from pwsh 7      -> exit 1, CouldNotAutoloadMatchingModule
//   PSModulePath with the pwsh entries removed -> exit 0, "Valid"
// Compress-Archive, Start-Process, Import-PfxCertificate and Get-Command load either way, so this is
// not a blanket incompatibility: exactly one module is affected, and the cause is the search path.
//
// The builder is reached over SSH through pwsh 7, and pwsh is also the default shell on GitHub's
// windows runners, so every powershell.exe started from here inherits that path. Filter it rather
// than overwrite it, so an operator's own module directory survives and only PowerShell Core's trees
// are dropped. `WindowsPowerShell` and `PowerShell` are distinct path elements, which is precisely
// what separates the two shells' module roots.
export function windowsPowerShellModulePath(value) {
  return String(value ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.split(/[\\/]+/).some((element) => element.toLowerCase() === "powershell"))
    .join(";");
}

// Windows environment names are case-insensitive but a spawned environment block is a plain list, so
// a stray PSMODULEPATH would survive next to the name we set and win by accident. runCommandScript
// already pays this tax for ComSpec; pay it here too instead of assuming the case we happened to see.
export function windowsPowerShellEnvironment(source) {
  const sanitized = windowsPowerShellModulePath(source.PSModulePath ?? source.PSMODULEPATH);
  const patch = { PSModulePath: sanitized };
  for (const key of Object.keys(source)) {
    if (key !== "PSModulePath" && key.toLowerCase() === "psmodulepath") patch[key] = sanitized;
  }
  return patch;
}

function powershell(script, env = {}, capture = false) {
  return run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env: { ...windowsPowerShellEnvironment(process.env), ...env },
    capture,
  });
}

function requireWindowsTool(command) {
  powershell(`$ErrorActionPreference='Stop'; (Get-Command '${command}' -ErrorAction Stop).Source | Write-Output`, {}, true);
}

export function normalizeCertificateThumbprint(value) {
  const normalized = String(value ?? "").replace(/\s+/g, "").toUpperCase();
  if (!normalized) return "";
  if (!/^[A-F0-9]{40}$/.test(normalized)) {
    fail("WINDOWS_CERTIFICATE_THUMBPRINT must contain exactly 40 hexadecimal characters");
  }
  return normalized;
}

function validateInstalledSigningCertificate(thumbprint) {
  const output = powershell(
    "$ErrorActionPreference='Stop'; " +
    "$path='Cert:\\CurrentUser\\My\\'+$env:GC_CERT_THUMBPRINT; " +
    "$cert=Get-Item -LiteralPath $path -ErrorAction Stop; " +
    "if(-not $cert.HasPrivateKey){throw 'certificate has no accessible private key'}; " +
    "$eku=@($cert.EnhancedKeyUsageList | ForEach-Object {$_.ObjectId.Value}); " +
    "if($eku -notcontains '1.3.6.1.5.5.7.3.3'){throw 'certificate is not valid for Code Signing'}; " +
    "$now=Get-Date; if($cert.NotBefore -gt $now){throw 'certificate is not valid yet'}; " +
    "if($cert.NotAfter -le $now){throw 'certificate has expired'}; " +
    "[pscustomobject]@{Thumbprint=[string]$cert.Thumbprint;Subject=[string]$cert.Subject;NotAfter=$cert.NotAfter.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress",
    { GC_CERT_THUMBPRINT: thumbprint },
    true,
  );
  const record = JSON.parse(output.split(/\r?\n/).filter(Boolean).at(-1) || "{}");
  const actual = normalizeCertificateThumbprint(record.Thumbprint);
  if (actual !== thumbprint) fail("installed code-signing certificate thumbprint changed during validation");
  return actual;
}

function importSigningCertificate() {
  const encoded = process.env.WINDOWS_CERTIFICATE || "";
  const password = process.env.WINDOWS_CERTIFICATE_PASSWORD || "";
  if (!encoded || !password) return "";
  const temp = mkdtempSync(join(tmpdir(), "greenchat-windows-cert-"));
  const pfx = join(temp, "certificate.pfx");
  try {
    const bytes = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    if (bytes.length < 256) fail("WINDOWS_CERTIFICATE is not a plausible Base64-encoded PFX");
    writeFileSync(pfx, bytes, { mode: 0o600 });
    const result = powershell(
      "$ErrorActionPreference='Stop'; " +
      "$secure=ConvertTo-SecureString $env:GC_PFX_PASSWORD -AsPlainText -Force; " +
      "$cert=Import-PfxCertificate -FilePath $env:GC_PFX_PATH -CertStoreLocation Cert:\\CurrentUser\\My -Password $secure -Exportable:$false; " +
      "if(-not $cert.HasPrivateKey){throw 'certificate has no private key'}; " +
      "$eku=@($cert.EnhancedKeyUsageList | ForEach-Object {$_.ObjectId.Value}); " +
      "if($eku -notcontains '1.3.6.1.5.5.7.3.3'){throw 'certificate is not valid for Code Signing'}; " +
      "$now=Get-Date; if($cert.NotBefore -gt $now -or $cert.NotAfter -le $now){throw 'certificate is outside its validity period'}; " +
      "$cert.Thumbprint | Write-Output",
      { GC_PFX_PATH: pfx, GC_PFX_PASSWORD: password },
      true,
    ).split(/\r?\n/).filter(Boolean).at(-1)?.trim();
    return normalizeCertificateThumbprint(result);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function resolveSigningCertificate(allowUnsigned) {
  // Validation artifacts are intentionally unsigned even when a service account happens to expose
  // production credentials. This prevents an "unsigned" lane from consuming a hardware token,
  // creating updater artifacts or emitting a manifest whose stated trust differs from its bytes.
  if (allowUnsigned) return "";
  const installed = normalizeCertificateThumbprint(process.env.WINDOWS_CERTIFICATE_THUMBPRINT);
  const hasPfxBytes = Boolean(process.env.WINDOWS_CERTIFICATE);
  const hasPfxPassword = Boolean(process.env.WINDOWS_CERTIFICATE_PASSWORD);
  if (hasPfxBytes !== hasPfxPassword) {
    fail("WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be configured together");
  }
  const hasPfx = hasPfxBytes && hasPfxPassword;
  if (installed && hasPfx) {
    fail("configure either WINDOWS_CERTIFICATE_THUMBPRINT or the PFX credential pair, not both");
  }
  if (installed) return validateInstalledSigningCertificate(installed);
  const imported = importSigningCertificate();
  if (imported) return imported;
  fail("production installers require WINDOWS_CERTIFICATE_THUMBPRINT for a CurrentUser code-signing certificate, or WINDOWS_CERTIFICATE plus WINDOWS_CERTIFICATE_PASSWORD for a PFX");
}

// Split out of writeSigningOverlay so the overlay's SHAPE is testable on Linux without a certificate
// store, a temp directory or a Windows worker: this is the object `tauri build --config` is handed.
export function windowsOverlayConfig(configText, { thumbprint, allowUnsigned, version }) {
  const config = JSON.parse(configText);
  if (thumbprint) config.bundle.windows.certificateThumbprint = thumbprint;
  if (allowUnsigned) config.bundle.createUpdaterArtifacts = false;
  // Derived here rather than committed into tauri.windows.conf.json: a literal in the checked-in
  // config would be a second place the version lives, and canonicalVersions() — which refuses a build
  // when the catalogue, tauri.conf.json and Cargo.toml disagree — cannot see a WiX field. Deriving it
  // means the MSI ProductVersion cannot drift from the version that was actually verified. The merge
  // is a spread, not a replacement, because bundle.windows.wix already carries `language: ru-RU`.
  config.bundle.windows.wix = { ...(config.bundle.windows.wix ?? {}), version: msiProductVersion(version) };
  return config;
}

function writeSigningOverlay(thumbprint, allowUnsigned, version) {
  const config = windowsOverlayConfig(readFileSync(windowsConfigPath, "utf8"), { thumbprint, allowUnsigned, version });
  const temp = mkdtempSync(join(tmpdir(), "greenchat-tauri-windows-"));
  const path = join(temp, "tauri.windows.generated.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { path, temp };
}

// The Windows bundle configuration declares the TDLib license files as Tauri resources,
// but they are generated artefacts excluded from Git (clients/desktop/.gitignore).
// The Linux/macOS TDLib build scripts stage them explicitly; the Windows lane must do the
// same, otherwise `cargo test`/`tauri build` aborts with
// "resource path `resources\tdlib\OPENSSL_LICENSE.txt` doesn't exist".
function stageTdlibLicenses(resourceDir) {
  const licenseRoot = join(repoRoot, "clients/third_party/tdlib");
  const pairs = [
    ["LICENSE_1_0.txt", "TDLIB_LICENSE_1_0.txt"],
    ["OPENSSL_LICENSE.txt", "OPENSSL_LICENSE.txt"],
  ];
  mkdirSync(resourceDir, { recursive: true });
  for (const [source, target] of pairs) {
    const from = join(licenseRoot, source);
    if (!existsSync(from)) fail(`TDLib license file is absent: ${from}`);
    copyFileSync(from, join(resourceDir, target));
  }
}

function ensurePinnedTdlib(arch, skipTdlib) {
  const resourceDir = join(tauriRoot, "resources/tdlib");
  const destination = join(resourceDir, "tdjson.dll");
  const manifestPath = join(resourceDir, "BUILD-MANIFEST.windows.txt");
  stageTdlibLicenses(resourceDir);
  if (skipTdlib) {
    if (!existsSync(destination)) fail("--skip-tdlib requested but resources/tdlib/tdjson.dll is absent");
    if (peMachine(readFileSync(destination)) !== arch.peMachine) fail("existing tdjson.dll has the wrong architecture");
    return { path: destination, bytes: statSync(destination).size, sha256: sha256(destination), reused: true };
  }
  const pinned = parsePinnedEnv();
  const buildRoot = resolve(process.env.GC_TDLIB_BUILD_DIR || join(repoRoot, "var/build/tdlib", pinned.TDLIB_COMMIT, `windows-${arch.package}`));
  const sourceRoot = join(buildRoot, "td-src");
  const binaryRoot = join(buildRoot, "td-build");
  mkdirSync(buildRoot, { recursive: true });
  if (!existsSync(join(sourceRoot, ".git"))) {
    rmSync(sourceRoot, { recursive: true, force: true });
    run("git", ["clone", "--filter=blob:none", "--no-checkout", pinned.TDLIB_REPOSITORY, sourceRoot]);
  }
  const head = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  const current = head.status === 0 ? String(head.stdout ?? "").trim() : "";
  if (current !== pinned.TDLIB_COMMIT) {
    run("git", ["-C", sourceRoot, "fetch", "--depth", "1", "origin", pinned.TDLIB_COMMIT]);
    run("git", ["-C", sourceRoot, "checkout", "--detach", "FETCH_HEAD"]);
  }
  if (run("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { capture: true }) !== pinned.TDLIB_COMMIT) {
    fail("TDLib checkout does not match PINNED.env");
  }

  const vcpkgRoot = resolve(process.env.GC_VCPKG_ROOT || "C:/vcpkg");
  const vcpkg = join(vcpkgRoot, "vcpkg.exe");
  const toolchain = join(vcpkgRoot, "scripts/buildsystems/vcpkg.cmake");
  if (!existsSync(vcpkg) || !existsSync(toolchain)) fail(`vcpkg is unavailable at ${vcpkgRoot}`);
  run(vcpkg, ["install", `openssl:${arch.vcpkg}`, `zlib:${arch.vcpkg}`, "--clean-after-build"]);
  mkdirSync(binaryRoot, { recursive: true });
  run("cmake.exe", [
    "-S", sourceRoot,
    "-B", binaryRoot,
    "-A", arch.cmake,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    `-DVCPKG_TARGET_TRIPLET=${arch.vcpkg}`,
    "-DTD_ENABLE_JNI=OFF",
    "-DTD_ENABLE_DOTNET=OFF",
    "-DTD_ENABLE_LTO=ON",
  ]);
  run("cmake.exe", ["--build", binaryRoot, "--config", "Release", "--target", "tdjson", "--parallel", process.env.GC_BUILD_JOBS || "2"]);
  const dll = newest(walk(binaryRoot).filter((path) => basename(path).toLowerCase() === "tdjson.dll"));
  if (!dll || statSync(dll).size < 1024 * 1024) fail("TDLib build produced no usable tdjson.dll");
  if (peMachine(readFileSync(dll)) !== arch.peMachine) fail("TDLib DLL architecture does not match the release target");
  const dump = run("dumpbin.exe", ["/nologo", "/exports", dll], { capture: true });
  for (const symbol of ["td_create_client_id", "td_send", "td_receive", "td_execute"]) {
    if (!dump.includes(symbol)) fail(`tdjson.dll misses export ${symbol}`);
  }
  mkdirSync(resourceDir, { recursive: true });
  copyFileSync(dll, destination);
  const details = {
    provider: "official-tdlib",
    repository: pinned.TDLIB_REPOSITORY,
    commit: pinned.TDLIB_COMMIT,
    version: pinned.TDLIB_EXPECTED_VERSION,
    platform: "windows",
    arch: arch.public,
    sha256: sha256(destination),
    bytes: statSync(destination).size,
  };
  writeFileSync(manifestPath, Object.entries(details).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
  return { path: destination, bytes: details.bytes, sha256: details.sha256, reused: false, ...details };
}

function verifyAuthenticode(path, allowUnsigned) {
  const output = powershell(
    "$ErrorActionPreference='Stop'; " +
    "$sig=Get-AuthenticodeSignature -LiteralPath $env:GC_SIGNED_FILE; " +
    "[pscustomobject]@{Status=[string]$sig.Status;Subject=[string]$sig.SignerCertificate.Subject;Thumbprint=[string]$sig.SignerCertificate.Thumbprint;TimeSubject=[string]$sig.TimeStamperCertificate.Subject}|ConvertTo-Json -Compress",
    { GC_SIGNED_FILE: path },
    true,
  );
  const line = output.split(/\r?\n/).filter(Boolean).at(-1) || "{}";
  const result = JSON.parse(line);
  if (!allowUnsigned && result.Status !== "Valid") fail(`${basename(path)} Authenticode status is ${result.Status || "unknown"}`);
  if (!allowUnsigned && !result.TimeSubject) fail(`${basename(path)} has no timestamp signature`);
  return result;
}

function createPortableZip(binary, tdlibPath, destination) {
  const temp = mkdtempSync(join(tmpdir(), "greenchat-portable-"));
  try {
    const root = join(temp, "GreenChat");
    mkdirSync(join(root, "tdlib"), { recursive: true });
    copyFileSync(binary, join(root, "GreenChat.exe"));
    copyFileSync(tdlibPath, join(root, "tdlib/tdjson.dll"));
    copyFileSync(join(tauriRoot, "resources/tdlib/TDLIB_LICENSE_1_0.txt"), join(root, "tdlib/TDLIB_LICENSE_1_0.txt"));
    copyFileSync(join(tauriRoot, "resources/tdlib/OPENSSL_LICENSE.txt"), join(root, "tdlib/OPENSSL_LICENSE.txt"));
    writeFileSync(join(root, "README.txt"), "GreenChat portable for Windows. Run GreenChat.exe. Session secrets are stored in Windows DPAPI/Credential Manager.\r\n");
    rmSync(destination, { force: true });
    powershell("$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath $env:GC_PORTABLE_ROOT -DestinationPath $env:GC_PORTABLE_ZIP -CompressionLevel Optimal", {
      GC_PORTABLE_ROOT: root,
      GC_PORTABLE_ZIP: destination,
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runtimeSmoke(binary, arch, skip) {
  if (skip || arch.node !== process.arch) return { skipped: true, reason: skip ? "explicit" : "cross-architecture" };
  const script = [
    "$ErrorActionPreference='Stop'",
    "$p=Start-Process -FilePath $env:GC_APP -PassThru",
    "Start-Sleep -Seconds 8",
    "if($p.HasExited){throw ('GreenChat exited during smoke test with code '+$p.ExitCode)}",
    "Stop-Process -Id $p.Id -Force",
    "'ok'",
  ].join("; ");
  powershell(script, { GC_APP: binary }, true);
  return { skipped: false };
}

function buildWindows(options) {
  if (process.platform !== "win32") fail("native Windows runner is required");
  for (const tool of ["git.exe", "node.exe", "npm.cmd", "cmd.exe", "rustup.exe", "cargo.exe", "tauri.cmd", "cmake.exe", "dumpbin.exe", "powershell.exe"]) {
    requireWindowsTool(tool);
  }
  const version = verifySourceContracts();
  const state = sourceState();
  const expectedSha = String(process.env.GC_SOURCE_SHA || "").trim();
  if (expectedSha && expectedSha !== state.sha) fail(`HEAD ${state.sha} does not match GC_SOURCE_SHA ${expectedSha}`);
  if (state.dirty && !options.allowDirty) fail("Git tree is dirty; production artifacts require an exact source snapshot");
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !options.allowUnsigned) {
    fail("TAURI_SIGNING_PRIVATE_KEY is mandatory for signed updater artifacts");
  }
  const thumbprint = resolveSigningCertificate(options.allowUnsigned);
  run("rustup.exe", ["target", "add", options.arch.rustTarget]);

  // Fail fast on the JavaScript dependency graph before spending close to an hour compiling TDLib.
  if (!options.skipWeb) {
    runNpm(["ci"], { cwd: clientsRoot });
    if (!options.skipChecks) {
      runNpm(["run", "check"], { cwd: clientsRoot });
      run("node.exe", ["--test", join(repoRoot, "scripts/build-windows-desktop.test.mjs")]);
    }
    runNpm(["run", "build:web"], { cwd: clientsRoot });
  }

  const tdlib = ensurePinnedTdlib(options.arch, options.skipTdlib);
  if (!options.skipWeb && !options.skipChecks) {
    const rustGate = options.arch.node === process.arch ? "test" : "check";
    run("rustup.exe", ["run", "stable", "cargo", rustGate, "--quiet", "--target", options.arch.rustTarget], { cwd: tauriRoot });
  }

  const signing = writeSigningOverlay(thumbprint, options.allowUnsigned, version);
  try {
    const tauriArgs = [
      "build",
      "--target", options.arch.rustTarget,
      "--bundles", "nsis,msi",
      "--config", signing.path,
    ];
    runTauri(tauriArgs, {
      cwd: desktopRoot,
      env: {
        GC_SERVER: process.env.GC_SERVER || CANONICAL_SERVER_ORIGIN,
        GC_TELEGRAM_API_ID: process.env.GC_TELEGRAM_API_ID || "",
        GC_TELEGRAM_API_HASH: process.env.GC_TELEGRAM_API_HASH || "",
      },
    });
  } finally {
    rmSync(signing.temp, { recursive: true, force: true });
  }

  const targetRoot = join(tauriRoot, "target", options.arch.rustTarget, "release");
  const files = walk(targetRoot);
  const setup = newest(files.filter((path) => /-setup\.exe$/i.test(path) && path.includes(`${join("bundle", "nsis")}`)));
  const msi = newest(files.filter((path) => /\.msi$/i.test(path) && path.includes(`${join("bundle", "msi")}`)));
  const binary = newest(files.filter((path) => basename(path).toLowerCase() === "green-chat-desktop.exe" && dirname(path) === targetRoot));
  const updater = newest(files.filter((path) => /\.nsis\.zip$/i.test(path)));
  if (!setup || !msi || !binary || (!options.allowUnsigned && !updater)) {
    fail("Tauri did not produce the expected EXE, MSI, binary and signed updater archive");
  }
  if (peMachine(readFileSync(binary)) !== options.arch.peMachine) {
    fail(`${basename(binary)} has the wrong PE architecture`);
  }
  const signatures = {
    setup: verifyAuthenticode(setup, options.allowUnsigned),
    msi: verifyAuthenticode(msi, options.allowUnsigned),
    binary: verifyAuthenticode(binary, options.allowUnsigned),
  };
  runtimeSmoke(binary, options.arch, options.skipRuntimeSmoke);

  const names = artifactNames(version, options.arch);
  const out = resolve(options.out, options.arch.package);
  mkdirSync(out, { recursive: true });
  const publicPaths = {
    setup: join(out, names.setup),
    msi: join(out, names.msi),
    updater: updater ? join(out, names.updater) : null,
    updaterSignature: updater ? join(out, names.updaterSignature) : null,
    portable: join(out, names.portable),
  };
  copyImmutable(setup, publicPaths.setup);
  copyImmutable(msi, publicPaths.msi);
  if (updater && publicPaths.updater) copyImmutable(updater, publicPaths.updater);
  const updaterSig = updater ? `${updater}.sig` : null;
  if (updaterSig && (!existsSync(updaterSig) || !readFileSync(updaterSig, "utf8").trim())) {
    if (!options.allowUnsigned) fail("Tauri updater signature is absent");
  } else if (updaterSig && publicPaths.updaterSignature) {
    copyImmutable(updaterSig, publicPaths.updaterSignature);
  }
  createPortableZip(binary, tdlib.path, publicPaths.portable);

  const releaseFiles = Object.values(publicPaths).filter((path) => path && existsSync(path)).map((path) => ({
    name: basename(path),
    bytes: statSync(path).size,
    sha256: sha256(path),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    schema_version: 1,
    release_id: `green-chat-${version}-windows-${options.arch.package}`,
    version,
    source_sha: state.sha,
    built_at: new Date().toISOString(),
    platform: "windows",
    architecture: options.arch.public,
    rust_target: options.arch.rustTarget,
    server_origin: process.env.GC_SERVER || CANONICAL_SERVER_ORIGIN,
    dirty_source: state.dirty,
    signed: !options.allowUnsigned,
    authenticode: signatures,
    tdlib: { version: tdlib.version ?? parsePinnedEnv().TDLIB_EXPECTED_VERSION, bytes: tdlib.bytes, sha256: tdlib.sha256 },
    update_target: publicPaths.updater && publicPaths.updaterSignature
      ? {
          key: `windows/${options.arch.public}`,
          version,
          url: basename(publicPaths.updater),
          sha256: sha256(publicPaths.updater),
          signature: readFileSync(publicPaths.updaterSignature, "utf8").trim(),
          pub_date: new Date().toISOString(),
        }
      : null,
    session_identity: {
      client_header: `desktop/${version}`,
      device_header: `GreenChat Desktop Windows ${options.arch.public} ${version}`,
      secure_store: "Windows DPAPI / Credential Manager",
    },
    files: releaseFiles,
  };
  writeFileSync(join(out, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(out, names.checksums), releaseFiles.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n");
  console.log(`WINDOWS-DESKTOP: OK ${out}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const version = verifySourceContracts();
    if (options.selfCheck) {
      console.log(`WINDOWS-DESKTOP-SELF-CHECK: OK ${version}`);
    } else {
      buildWindows(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_SERVER_ORIGIN,
  artifactNames,
  canonicalVersions,
  msiProductVersion,
  normalizeCertificateThumbprint,
  windowsOverlayConfig,
  peMachine,
  sourceContracts,
  tdlibBuildPlan,
  windowsArch,
  windowsPowerShellEnvironment,
  windowsPowerShellModulePath,
} from "./build-windows-desktop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (path) => readFileSync(join(root, path), "utf8");

function fakePe(machine) {
  const buffer = Buffer.alloc(256);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(128, 0x3c);
  buffer.write("PE\0\0", 128, "ascii");
  buffer.writeUInt16LE(machine, 132);
  return buffer;
}

test("canonicalVersions accepts one version and blocks platform drift", () => {
  assert.equal(canonicalVersions({
    catalogText: '{"current_version":"1.2.3"}',
    tauriText: '{"version":"1.2.3"}',
    cargoText: '[package]\nversion = "1.2.3"\n',
  }), "1.2.3");
  assert.throws(() => canonicalVersions({
    catalogText: '{"current_version":"1.2.3"}',
    tauriText: '{"version":"1.2.4"}',
    cargoText: '[package]\nversion = "1.2.3"\n',
  }), /version identity diverged/);
});

test("Windows x64 and ARM64 use deterministic independent targets and filenames", () => {
  assert.deepEqual(windowsArch("x64"), {
    node: "x64",
    rustTarget: "x86_64-pc-windows-msvc",
    public: "x86_64",
    package: "x64",
    cmake: "x64",
    vcpkg: "x64-windows-static-md",
    peMachine: 0x8664,
  });
  assert.deepEqual(windowsArch("arm64"), {
    node: "arm64",
    rustTarget: "aarch64-pc-windows-msvc",
    public: "aarch64",
    package: "arm64",
    cmake: "ARM64",
    vcpkg: "arm64-windows-static-md",
    peMachine: 0xaa64,
  });
  assert.deepEqual(artifactNames("1.2.3", windowsArch("x64")), {
    setup: "GreenChat-1.2.3-windows-x64-setup.exe",
    msi: "GreenChat-1.2.3-windows-x64.msi",
    portable: "GreenChat-1.2.3-windows-x64-portable.zip",
    updater: "GreenChat-1.2.3-windows-x64.nsis.zip",
    updaterSignature: "GreenChat-1.2.3-windows-x64.nsis.zip.sig",
    manifest: "windows-x64-release.json",
    checksums: "SHA256SUMS-windows-x64.txt",
  });
});

test("ARM64 TDLib runs native generators before a true cross-compile", () => {
  const x64 = tdlibBuildPlan(windowsArch("x64"), {
    sourceRoot: "C:/td-src",
    binaryRoot: "C:/build/td-target",
    toolchain: "C:/vcpkg/toolchain.cmake",
  });
  assert.equal(x64.native, null);
  assert.equal(x64.target.configure.includes("-DCMAKE_SYSTEM_NAME=Windows"), false);

  const arm64 = tdlibBuildPlan(windowsArch("arm64"), {
    sourceRoot: "C:/td-src",
    binaryRoot: "C:/build/td-target",
    toolchain: "C:/vcpkg/toolchain.cmake",
  });
  assert.ok(arm64.native);
  assert.deepEqual(arm64.native.configure.slice(4, 6), ["-A", "x64"]);
  assert.ok(arm64.native.configure.includes("-DTD_GENERATE_SOURCE_FILES=ON"));
  assert.ok(arm64.native.build.includes("prepare_cross_compiling"));
  assert.ok(arm64.target.configure.includes("ARM64"));
  assert.ok(arm64.target.configure.includes("-DCMAKE_SYSTEM_NAME=Windows"));
  assert.ok(arm64.target.configure.includes("-DCMAKE_SYSTEM_PROCESSOR=ARM64"));
});

test("certificate thumbprints are canonical and malformed identities fail closed", () => {
  assert.equal(normalizeCertificateThumbprint(" ab cd ef 0123456789abcdef0123456789abcdef01 "), "ABCDEF0123456789ABCDEF0123456789ABCDEF01");
  assert.equal(normalizeCertificateThumbprint(""), "");
  assert.throws(() => normalizeCertificateThumbprint("ABC"), /exactly 40 hexadecimal/);
  assert.throws(() => normalizeCertificateThumbprint("G".repeat(40)), /exactly 40 hexadecimal/);
});

test("PE parser distinguishes x64, ARM64 and malformed binaries", () => {
  assert.equal(peMachine(fakePe(0x8664)), 0x8664);
  assert.equal(peMachine(fakePe(0xaa64)), 0xaa64);
  assert.throws(() => peMachine(Buffer.from("not-pe")), /not an MZ executable/);
  const broken = fakePe(0x8664);
  broken.write("NOPE", 128, "ascii");
  assert.throws(() => peMachine(broken), /no valid PE header/);
});

test("checked-in Windows release contract requires installers, TDLib, updater and both signatures", () => {
  const problems = sourceContracts({
    tauriBase: source("clients/desktop/src-tauri/tauri.conf.json"),
    tauriWindows: source("clients/desktop/src-tauri/tauri.windows.conf.json"),
    rustSource: source("clients/desktop/src-tauri/src/lib.rs"),
    bridgeSource: source("clients/desktop/src-tauri/src/bridge.js"),
    workflowSource: source(".github/workflows/windows-artifacts.yml"),
  });
  assert.deepEqual(problems, []);
  const windows = JSON.parse(source("clients/desktop/src-tauri/tauri.windows.conf.json"));
  assert.equal(windows.bundle.windows.allowDowngrades, false);
  assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(windows.plugins.updater.windows.installMode, "passive");
  assert.match(JSON.stringify(windows), new RegExp(CANONICAL_SERVER_ORIGIN.replaceAll(".", "\\.")));
});

test("contract fails closed when Windows has no SignPath submission or ships no tdjson.dll", () => {
  const unsignedWorkflow = "windows-x64 windows-arm64 SIGNPATH_API_TOKEN";
  const noTdlib = JSON.stringify({
    bundle: { targets: ["nsis", "msi"], createUpdaterArtifacts: true, resources: {}, windows: { allowDowngrades: false, nsis: { installMode: "currentUser" } } },
    plugins: { updater: { endpoints: [`${CANONICAL_SERVER_ORIGIN}/{{target}}/{{arch}}`], windows: { installMode: "passive" } } },
  });
  const problems = sourceContracts({
    tauriBase: '{"plugins":{"updater":{"pubkey":"key"}}}',
    tauriWindows: noTdlib,
    rustSource: '__GC_DESKTOP_OS__ __GC_DESKTOP_ARCH__ __GC_DESKTOP_VERSION__ "windows" x-gc-client x-device',
    bridgeSource: '__GC_DESKTOP_OS__ __GC_DESKTOP_ARCH__ __GC_DESKTOP_VERSION__ NATIVE_OS === "windows" x-gc-client x-device',
    workflowSource: unsignedWorkflow,
  });
  assert.ok(problems.some((value) => value.includes("tdjson.dll")));
  assert.ok(problems.some((value) => value.includes("SignPath")));
});

test("Windows installed application creates a recognisable independent session and stores it natively", async () => {
  const invocations = [];
  let fetched = null;
  const storage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
    removeItem(key) { this.values.delete(key); },
  };
  function FakeWebSocket() {}
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  FakeWebSocket.prototype = {};
  const window = {
    __TAURI__: { core: { invoke: async (command, payload) => { invocations.push({ command, payload }); return null; } } },
    fetch: async (input, init) => { fetched = { input, init }; return { ok: true }; },
    WebSocket: FakeWebSocket,
    localStorage: storage,
    location: { href: "tauri://localhost/", origin: "tauri://localhost" },
  };
  window.window = window;
  const navigator = {};
  const document = {
    readyState: "loading",
    hasFocus: () => true,
    addEventListener: () => {},
    body: { appendChild: () => {} },
  };
  const context = vm.createContext({
    window,
    navigator,
    document,
    URL,
    Request,
    Headers,
    Promise,
    console,
    setTimeout,
    clearTimeout,
  });
  const bridge = source("clients/desktop/src-tauri/src/bridge.js")
    .replace("__GC_SESSION_SEED__", "null")
    .replace("__GC_SERVER_ORIGIN__", JSON.stringify(CANONICAL_SERVER_ORIGIN))
    .replace("__GC_DESKTOP_OS__", JSON.stringify("windows"))
    .replace("__GC_DESKTOP_ARCH__", JSON.stringify("x86_64"))
    .replace("__GC_DESKTOP_VERSION__", JSON.stringify("1.2.3"));
  vm.runInContext(bridge, context);

  await window.fetch("/v1/auth/login", { method: "POST", headers: { "x-gc-client": "web/1.2.3" } });
  const headers = new Headers(fetched.init.headers);
  assert.equal(String(fetched.input), `${CANONICAL_SERVER_ORIGIN}/v1/auth/login`);
  assert.equal(headers.get("x-gc-client"), "desktop/1.2.3");
  assert.equal(headers.get("x-device"), "GreenChat Desktop Windows x86_64 1.2.3");
  assert.equal(window.__GC_NATIVE.os, "windows");
  assert.equal(window.__GC_NATIVE.deviceLabel, "GreenChat Desktop Windows x86_64 1.2.3");

  window.localStorage.setItem("gc.session", '{"refresh":"secret"}');
  await window.__gcFlushSessionStorage();
  assert.ok(invocations.some((entry) => entry.command === "keyring_set" && entry.payload.value.includes("secret")));
  assert.equal(storage.values.has("gc.session"), false, "refresh token must not remain in WebView localStorage");
});

test("public workflow keeps unsigned builds separate and signs only GitHub-hosted artifacts", () => {
  const workflow = source(".github/workflows/windows-artifacts.yml");
  const unsignedIndex = workflow.indexOf("Build unsigned reproducible candidate");
  const uploadIndex = workflow.indexOf("Upload unsigned GitHub artifact for origin verification");
  const signIndex = workflow.indexOf("Submit signing request to SignPath");
  const verifyIndex = workflow.indexOf("Verify SignPath publisher and assemble release");
  const publishIndex = workflow.indexOf("publish-release:");

  assert.match(workflow, /source-validation:[\s\S]*runs-on: ubuntu-22\.04/);
  assert.match(workflow, /build-unsigned:[\s\S]*runs-on: windows-latest[\s\S]*--allow-unsigned/);
  assert.match(workflow, /windows-x64/);
  assert.match(workflow, /windows-arm64/);
  assert.match(workflow, /signpath\/github-action-submit-signing-request@v2/);
  assert.match(workflow, /api-token: \$\{\{ secrets\.SIGNPATH_API_TOKEN \}\}/);
  assert.match(workflow, /github-artifact-id: \$\{\{ steps\.upload-unsigned-artifact\.outputs\.artifact-id \}\}/);
  assert.match(workflow, /if: vars\.SIGNPATH_ENABLED == '1'/);
  assert.match(workflow, /publish_release && vars\.SIGNPATH_ENABLED == '1'/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v7/);
  assert.match(workflow, /@tauri-apps\/cli@2\.11\.4/);
  const vcpkgLine = workflow.split(/\r?\n/).find((line) => line.includes("GC_VCPKG_ROOT:"));
  assert.match(vcpkgLine ?? "", /^  GC_VCPKG_ROOT: C:\\+vcpkg$/);
  assert.doesNotMatch(workflow, /runs-on:\s*\[[^\]]*self-hosted/i);
  assert.doesNotMatch(workflow, /WINDOWS_CERTIFICATE/);
  assert.doesNotMatch(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.ok(unsignedIndex >= 0 && unsignedIndex < uploadIndex && uploadIndex < signIndex && signIndex < verifyIndex && verifyIndex < publishIndex);

  const factory = source("scripts/build-windows-desktop.mjs");
  assert.match(factory, /runTauri\(tauriArgs/);
  assert.match(factory, /process\.env\.GC_VCPKG_ROOT/);
  assert.match(factory, /function runNpm/);
  assert.match(factory, /function runTauri/);
  assert.match(factory, /runCommandScript\("tauri\.cmd"/);
  assert.match(factory, /process\.env\.SystemRoot/);
  assert.match(factory, /run\(commandProcessor, \["\/d", "\/c", "call", script/);
  assert.match(factory, /runCommandScript\("npm\.cmd"/);
  assert.match(factory, /ComSpec: commandProcessor, COMSPEC: commandProcessor/);
  assert.doesNotMatch(factory, /run\("npm\.cmd"/);
  assert.doesNotMatch(factory, /process\.env\.(?:ComSpec|COMSPEC)/);
  assert.ok(factory.indexOf('runNpm(["ci"]') < factory.indexOf("const tdlib = ensurePinnedTdlib"));
  assert.match(factory, /failed \(\$\{failure\}\)/);
});

test("every PNG frame inside the Windows app icon is 8-bit, which is all the ICO reader accepts", () => {
  // Regression guard for the 2026-08-04 Windows worker failure. `tauri::generate_context!` reads
  // clients/desktop/src-tauri/icons/icon.ico through the `ico` crate, whose src/image.rs rejects
  // anything else outright:
  //     if info.bit_depth != png::BitDepth::Eight {
  //         // TODO: Support other bit depths.
  //         invalid_data!("Unsupported PNG bit depth: {:?}", info.bit_depth);
  // The 256x256 frame was a 16-bit-per-channel RGBA PNG, so the proc macro panicked and
  // `cargo test --target x86_64-pc-windows-msvc` died with exit 101 before a single line of the
  // application was compiled. It is a compile-time read, so no packaging step can catch it, and it
  // is Windows-only: the same file rode through every Linux desktop bundle untouched, because
  // generate_context! only reaches for the ICO on Windows.
  const ico = readFileSync(join(root, "clients/desktop/src-tauri/icons/icon.ico"));
  assert.equal(ico.readUInt16LE(0), 0, "ICO reserved field must be zero");
  assert.equal(ico.readUInt16LE(2), 1, "icon.ico must be an ICO, not a CUR");
  const count = ico.readUInt16LE(4);
  assert.ok(count > 0, "icon.ico declares no frames");
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let pngFrames = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + 16 * index;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + size <= ico.length, `frame ${index} runs past the end of icon.ico`);
    const frame = ico.subarray(offset, offset + size);
    if (!frame.subarray(0, 8).equals(PNG_MAGIC)) continue; // a BMP/DIB frame carries no PNG header
    pngFrames += 1;
    assert.equal(frame.toString("ascii", 12, 16), "IHDR", `frame ${index} has no IHDR`);
    const width = frame.readUInt32BE(16);
    const height = frame.readUInt32BE(20);
    const bitDepth = frame.readUInt8(24);
    assert.ok(width >= 1 && height >= 1, `frame ${index} has a degenerate size`);
    assert.equal(
      bitDepth,
      8,
      `frame ${index} (${width}x${height}) is a ${bitDepth}-bit PNG; the ico crate accepts only 8, ` +
        "so tauri::generate_context! will panic on the Windows target",
    );
  }
  assert.ok(pngFrames > 0, "icon.ico has no PNG frame at all; this test stopped measuring anything");
});

test("every declared Windows bundle resource is staged or tracked", () => {
  // Regression guard for the 2026-08-03 Windows worker failure: tauri.windows.conf.json
  // declared resources/tdlib/OPENSSL_LICENSE.txt, the file is Git-ignored, and the Windows
  // build script never staged it, so cargo test aborted before any packaging happened.
  const conf = JSON.parse(source("clients/desktop/src-tauri/tauri.windows.conf.json"));
  const declared = Object.entries(conf.bundle.resources)
    .filter(([, target]) => target !== null)
    .map(([path]) => path);
  assert.ok(declared.length > 0, "Windows bundle declares no resources");
  const provided = new Set([
    "resources/tdlib/tdjson.dll", // built by ensurePinnedTdlib
    "resources/tdlib/BUILD-MANIFEST.windows.txt", // written by ensurePinnedTdlib
    "resources/tdlib/TDLIB_LICENSE_1_0.txt", // staged by stageTdlibLicenses
    "resources/tdlib/OPENSSL_LICENSE.txt", // staged by stageTdlibLicenses
    "resources/tdlib/README.md", // tracked in Git
  ]);
  for (const path of declared) {
    assert.ok(provided.has(path), `declared resource is never staged on Windows: ${path}`);
  }
  const script = source("scripts/build-windows-desktop.mjs");
  // the call must exist, not merely the declaration
  assert.match(script, /\n\s+stageTdlibLicenses\(resourceDir\);/);
  assert.match(script, /\["LICENSE_1_0\.txt", "TDLIB_LICENSE_1_0\.txt"\]/);
  assert.match(script, /\["OPENSSL_LICENSE\.txt", "OPENSSL_LICENSE\.txt"\]/);
  for (const name of ["LICENSE_1_0.txt", "OPENSSL_LICENSE.txt"]) {
    assert.ok(
      existsSync(join(root, "clients/third_party/tdlib", name)),
      `upstream license source is missing: ${name}`,
    );
  }
});

test("the MSI ProductVersion is derived from the application version, and refuses what MSI cannot express", () => {
  // Regression guard for the Windows release failure measured on 2026-08-04 building 93560c77: the
  // Rust library linked, `cargo test` passed 26/26 and NSIS produced its installer, and only then the
  // MSI target rejected the whole bundle with
  //     `optional pre-release identifier in app version must be numeric-only and cannot be greater
  //      than 65535 for msi target`
  // The shipping version is 1.0.0-beta.5, and MSI accepts at most one pre-release identifier which
  // must be numeric. So it is translated, not changed — the version itself is pinned by
  // canonicalVersions() to the catalogue, tauri.conf.json and Cargo.toml.
  assert.equal(msiProductVersion("1.0.0-beta.5"), "1.0.0.5", "the shipping version must survive the MSI target");
  assert.equal(msiProductVersion("1.0.0"), "1.0.0", "a final release needs no build field");
  assert.equal(msiProductVersion("2.3.4-rc.2"), "2.3.4.2");
  assert.equal(msiProductVersion("1.0.0-beta.5+build.7"), "1.0.0.5", "semver build metadata is not part of ProductVersion");

  // The field limits are Windows Installer's own (tauri-cli 2.11.4 config.schema.json, WixConfig.version:
  // major <= 255, minor <= 255, patch and build <= 65535). Exceeding them must fail here, on Linux, in
  // milliseconds — not on the Windows worker after a seven-minute release link.
  assert.throws(() => msiProductVersion("256.0.0"), /major version must be <= 255/);
  assert.throws(() => msiProductVersion("1.256.0"), /minor version must be <= 255/);
  assert.throws(() => msiProductVersion("1.0.65536"), /patch version must be <= 65535/);
  assert.throws(() => msiProductVersion("1.0.0-beta.65536"), /build number must be <= 65535/);
  // A purely alphabetic pre-release has no build number to take. Inventing one (0, say) would let two
  // different builds ship under one ProductVersion, which Windows would then refuse to upgrade between.
  assert.throws(() => msiProductVersion("1.0.0-beta"), /no numeric identifier/);
  assert.throws(() => msiProductVersion("nightly"), /is not semver/);
});

test("the Windows config leaves the MSI version to the build, so it cannot drift from the catalogue", () => {
  // canonicalVersions() refuses a build when the catalogue, tauri.conf.json and Cargo.toml disagree,
  // but it cannot see a WiX field. A version literal in the checked-in config would therefore be an
  // unverified fourth copy — and a stale ProductVersion is silent: Windows Installer would consider a
  // new build the same product and skip the upgrade entirely.
  const windows = JSON.parse(source("clients/desktop/src-tauri/tauri.windows.conf.json"));
  assert.equal(windows.bundle.windows.wix.version, undefined, "the shipped config must not pin an MSI version");
  const withLiteral = structuredClone(windows);
  withLiteral.bundle.windows.wix.version = "1.0.0.5";
  const problems = sourceContracts({
    tauriBase: source("clients/desktop/src-tauri/tauri.conf.json"),
    tauriWindows: JSON.stringify(withLiteral),
    rustSource: source("clients/desktop/src-tauri/src/lib.rs"),
    bridgeSource: source("clients/desktop/src-tauri/src/bridge.js"),
    workflowSource: source(".github/workflows/windows-artifacts.yml"),
  });
  assert.deepEqual(problems, ["Windows WiX version must be derived from the canonical version, not written into the config"]);
});

test("the generated build overlay carries the derived MSI version and keeps the rest of the WiX block", () => {
  // This is the exact object handed to `tauri build --config`, so it is where the 2026-08-04 MSI
  // failure would reappear. Two things are asserted, because the fix has two ways to go wrong: the
  // version can be missing (MSI derives it from 1.0.0-beta.5 again and refuses), or the merge can
  // replace the WiX block instead of extending it and silently drop the Russian installer language.
  const configText = source("clients/desktop/src-tauri/tauri.windows.conf.json");
  const version = canonicalVersions({
    catalogText: JSON.stringify({ current_version: JSON.parse(source("clients/desktop/src-tauri/tauri.conf.json")).version }),
    tauriText: source("clients/desktop/src-tauri/tauri.conf.json"),
    cargoText: source("clients/desktop/src-tauri/Cargo.toml"),
  });
  const overlay = windowsOverlayConfig(configText, { thumbprint: "", allowUnsigned: true, version });
  assert.equal(overlay.bundle.windows.wix.version, msiProductVersion(version));
  assert.match(overlay.bundle.windows.wix.version, /^\d+\.\d+\.\d+(\.\d+)?$/, "MSI accepts only major.minor.patch[.build]");
  assert.equal(overlay.bundle.windows.wix.language, JSON.parse(configText).bundle.windows.wix.language,
    "extending the WiX block must not drop the installer language");
  assert.equal(overlay.bundle.createUpdaterArtifacts, false, "--allow-unsigned still suppresses updater artifacts");
  assert.equal(overlay.bundle.windows.certificateThumbprint, undefined, "no thumbprint means no certificate field");

  const signed = windowsOverlayConfig(configText, { thumbprint: "A".repeat(40), allowUnsigned: false, version });
  assert.equal(signed.bundle.windows.certificateThumbprint, "A".repeat(40));
  assert.equal(signed.bundle.createUpdaterArtifacts, true, "a signed build still produces updater artifacts");
  assert.equal(signed.bundle.windows.wix.version, msiProductVersion(version), "the release path derives the same version");
});

// The value below is not invented: it is the PSModulePath the Windows worker actually hands to
// powershell.exe, captured inside the real chain (SSH -> pwsh 7 -> cmd -> VsDevCmd -> node). With it
// unchanged Get-AuthenticodeSignature exits 1 with CouldNotAutoloadMatchingModule; with the pwsh
// entries removed it exits 0 and reports "Valid". Nothing else differed between the two runs.
const WORKER_PSMODULEPATH = [
  "C:\\Users\\1\\Documents\\PowerShell\\Modules",
  "C:\\Program Files\\PowerShell\\Modules",
  "c:\\program files\\powershell\\7\\Modules",
  "C:\\Program Files\\WindowsPowerShell\\Modules",
  "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
].join(";");

test("Windows PowerShell 5.1 never inherits PowerShell 7's module trees", () => {
  const sanitized = windowsPowerShellModulePath(WORKER_PSMODULEPATH);

  assert.deepEqual(sanitized.split(";"), [
    "C:\\Program Files\\WindowsPowerShell\\Modules",
    "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
  ], "only the Windows PowerShell roots may remain, and in their original order");
  assert.ok(!/[\\/]powershell[\\/]/i.test(sanitized.replace(/windowspowershell/gi, "")),
    "no PowerShell Core module root may survive the filter");

  // WindowsPowerShell is a different path element from PowerShell; the filter must not confuse them.
  assert.equal(windowsPowerShellModulePath("C:\\Program Files\\WindowsPowerShell\\Modules"),
    "C:\\Program Files\\WindowsPowerShell\\Modules");
  assert.equal(windowsPowerShellModulePath("C:\\Program Files\\PowerShell\\7\\Modules"), "");

  // An operator's own module directory is a dependency of somebody's tooling and is preserved.
  assert.equal(
    windowsPowerShellModulePath("D:\\ops\\modules;C:\\Program Files\\PowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules"),
    "D:\\ops\\modules;C:\\Program Files\\WindowsPowerShell\\Modules",
  );

  // Shapes the real world produces: forward slashes, repeated separators, blanks, nothing at all.
  assert.equal(windowsPowerShellModulePath("C:/Program Files/PowerShell/7/Modules;;  ;D:/mods"), "D:/mods");
  assert.equal(windowsPowerShellModulePath(undefined), "");
  assert.equal(windowsPowerShellModulePath(""), "");
});

test("a differently-cased PSModulePath cannot slip past the sanitizer", () => {
  // Windows resolves environment names case-insensitively, but a spawned environment block is a flat
  // list: setting PSModulePath while PSMODULEPATH is still present leaves the poisoned one in play.
  const patch = windowsPowerShellEnvironment({ PSMODULEPATH: WORKER_PSMODULEPATH, PATH: "C:\\Windows" });
  const expected = windowsPowerShellModulePath(WORKER_PSMODULEPATH);
  for (const [key, value] of Object.entries(patch)) {
    assert.equal(key.toLowerCase(), "psmodulepath", "the patch must touch nothing but the module path");
    assert.equal(value, expected, `${key} must carry the sanitized value`);
  }
  assert.ok(Object.keys(patch).includes("PSMODULEPATH"), "the inherited spelling must be overwritten too");
  assert.ok(Object.keys(patch).includes("PSModulePath"), "the canonical spelling must always be set");
  assert.equal(Object.keys(windowsPowerShellEnvironment({})).join(","), "PSModulePath",
    "an environment without the variable still gets a defined, empty one");
});

test("every powershell.exe the factory starts goes through the sanitizing helper", () => {
  const text = source("scripts/build-windows-desktop.mjs");
  const spawns = text.match(/run\(\s*"powershell\.exe"/g) || [];
  assert.equal(spawns.length, 1, "one choke point only, or a new call site can inherit the broken path");
  const helper = text.match(/function powershell\([\s\S]*?\n}/)?.[0] || "";
  assert.match(helper, /windowsPowerShellEnvironment\(process\.env\)/,
    "the single choke point must sanitize the module search path");
  assert.match(helper, /\.\.\.windowsPowerShellEnvironment\(process\.env\),\s*\.\.\.env/,
    "an explicit per-call override must still win over the sanitized default");

  // The cause was the environment, so the cure is the environment. Signature verification stays
  // strict: a release build that cannot read its own Authenticode status must never ship quietly.
  const verify = text.match(/function verifyAuthenticode\([\s\S]*?\n}/)?.[0] || "";
  assert.match(verify, /if \(!allowUnsigned && result\.Status !== "Valid"\) fail\(/);
  assert.match(verify, /if \(!allowUnsigned && !result\.TimeSubject\) fail\(/);
  assert.ok(!/catch/.test(verify), "verification must not swallow its own failures");
});


test("unsigned validation never consumes production Windows signing credentials", () => {
  const text = source("scripts/build-windows-desktop.mjs");
  const resolver = text.match(/function resolveSigningCertificate\([\s\S]*?\n}/)?.[0] || "";
  assert.match(resolver, /if \(allowUnsigned\) return "";/);
  assert.match(resolver, /WINDOWS_CERTIFICATE_THUMBPRINT/);
  assert.match(resolver, /WINDOWS_CERTIFICATE and WINDOWS_CERTIFICATE_PASSWORD must be configured together/);
  assert.match(resolver, /configure either WINDOWS_CERTIFICATE_THUMBPRINT or the PFX credential pair/);
  assert.match(text, /Cert:\\\\CurrentUser\\\\My/);
  assert.match(text, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
});

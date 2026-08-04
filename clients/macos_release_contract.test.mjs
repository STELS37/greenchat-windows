import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(resolve(root, path), "utf8");
const workflow = read("../.github/workflows/desktop-artifacts.yml");
const config = JSON.parse(read("desktop/src-tauri/tauri.macos.conf.json"));
const info = read("desktop/src-tauri/Info.plist");
const entitlements = read("desktop/src-tauri/Entitlements.plist");

const cargo = read("desktop/src-tauri/Cargo.toml");
const rustHost = read("desktop/src-tauri/src/lib.rs");
const bridge = read("desktop/src-tauri/src/bridge.js");
const appShell = read("ui/src/screens/app.ts");
const tdlibBuilder = read("third_party/tdlib/build-macos.sh");

function hasPlistKey(text, key) {
  return new RegExp(`<key>${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}</key>`).test(text);
}

test("QA-MAC-001 macOS config is hardened, universal-ready and uses native Apple metadata", () => {
  assert.equal(config.bundle.macOS.minimumSystemVersion, "12.0");
  assert.equal(config.bundle.macOS.hardenedRuntime, true);
  assert.equal(config.bundle.macOS.entitlements, "./Entitlements.plist");
  assert.equal(config.bundle.macOS.infoPlist, "./Info.plist");
  assert.ok(config.bundle.icon.includes("icons/icon.icns"));
  assert.deepEqual(config.bundle.macOS.dmg.windowSize, { width: 660, height: 400 });
});

test("QA-MAC-002 privacy strings cover calls and self-hosted local-network access", () => {
  for (const key of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSLocalNetworkUsageDescription"]) {
    assert.equal(hasPlistKey(info, key), true, `${key} is required`);
  }
  assert.match(info, /public\.app-category\.social-networking/);
});

test("QA-MAC-003 release entitlements are least-privilege and never debug-sign the app", () => {
  assert.equal(hasPlistKey(entitlements, "com.apple.security.device.audio-input"), true);
  assert.equal(hasPlistKey(entitlements, "com.apple.security.device.camera"), true);
  assert.equal(hasPlistKey(entitlements, "com.apple.security.get-task-allow"), false);
  assert.equal(hasPlistKey(entitlements, "com.apple.security.cs.disable-library-validation"), false);
  assert.equal(hasPlistKey(entitlements, "com.apple.security.app-sandbox"), false);
});

test("QA-MAC-004 workflow builds one exact-SHA universal signed and notarized artifact", () => {
  assert.match(workflow, /runs-on:\s*\$\{\{\s*matrix\.platform\s*\}\}/);
  assert.match(workflow, /platform:\s*macos-15/);
  assert.match(workflow, /node-version:\s*['"]22\.22\.0['"]/);
  assert.match(workflow, /Xcode 16\.4/);
  assert.match(workflow, /universal-apple-darwin/);
  assert.match(workflow, /aarch64-apple-darwin,x86_64-apple-darwin/);
  assert.match(workflow, /APPLE_CERTIFICATE/);
  assert.match(workflow, /APPLE_API_ISSUER/);
  assert.match(workflow, /APPLE_API_KEY_PATH/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /codesign --verify --deep --strict/);
  assert.match(workflow, /spctl --assess --type execute/);
  assert.match(workflow, /xcrun stapler validate/);
  assert.match(workflow, /hdiutil verify/);
  assert.match(workflow, /lipo -archs/);
  assert.match(workflow, /artifact was superseded while it was building/);
  assert.match(workflow, /GC_BUILD_ID:\s*\$\{\{\s*inputs\.source_sha \|\| github\.sha\s*\}\}/);
  assert.ok(
    workflow.indexOf("Build and test the shared web bundle") < workflow.indexOf("Validate Apple signing and notarization prerequisites"),
    "the macOS compile gate must run before owner-only credentials are required",
  );
  assert.doesNotMatch(workflow, /xcodebuild -version \| head/);
});


test("QA-MAC-005 macOS network proxy and native Telegram runtime are mandatory release capabilities", () => {
  assert.match(cargo, /features = \[[^\]]*"macos-proxy"/);
  assert.match(tdlibBuilder, /libtdjson\.dylib/);
  assert.match(tdlibBuilder, /arm64/);
  assert.match(tdlibBuilder, /x86_64/);
  assert.match(tdlibBuilder, /lipo -create/);
  assert.match(tdlibBuilder, /TDLIB_EXPECTED_VERSION/);
  assert.match(tdlibBuilder, /libssl\|libcrypto/);
  assert.match(tdlibBuilder, /make -j"\$JOBS" >&2/);
  assert.match(tdlibBuilder, /cmake --build "\$build" --target tdjson -j"\$JOBS" >&2/);
  const plan = JSON.parse(execFileSync("bash", [resolve(root, "third_party/tdlib/build-macos.sh"), "--self-check"], { encoding: "utf8" }));
  assert.deepEqual(plan.architectures, ["arm64", "x86_64"]);
  assert.equal(plan.library, "libtdjson.dylib");
  assert.equal(plan.minimum_macos, "12.0");
});

test("QA-MAC-006 CI proves Keychain, both executable slices and packaged universal TDLib before admission", () => {
  assert.match(workflow, /Build pinned universal TDLib runtime/);
  assert.match(workflow, /build-macos\.sh/);
  assert.match(workflow, /keychain_smoke/);
  assert.match(workflow, /aarch64-apple-darwin/);
  assert.match(workflow, /x86_64-apple-darwin/);
  assert.match(workflow, /Contents\/Resources\/tdlib\/libtdjson\.dylib/);
  assert.match(workflow, /TDLib arm64 slice missing/);
  assert.match(workflow, /TDLib x86_64 slice missing/);
  assert.match(workflow, /codesign --verify --strict --verbose=2 "\$tdlib"/);
});


test("QA-MAC-007 desktop notifications are permission-honest, privacy-safe and clickable", () => {
  assert.match(cargo, /notify-rust\s*=\s*\{[^}]*preview-macos-un/);
  assert.match(cargo, /mac-usernotifications\s*=\s*"0\.3\.1"/);
  assert.match(rustHost, /get_notification_settings/);
  assert.match(rustHost, /request_auth/);
  assert.match(rustHost, /wait_for_response/);
  assert.match(rustHost, /gc:\/\/navigate/);
  assert.match(rustHost, /notification_chat_hash/);
  assert.match(rustHost, /"Новое сообщение"/);
  assert.doesNotMatch(rustHost, /sender_name|message_text|chat_title/);
  assert.match(bridge, /gc\.desktop\.notifications\.enabled/);
  assert.match(bridge, /pendingNotificationChatId = null/);
  assert.match(bridge, /notify_unread", \{ count: c, chatId: chatId \}/);
  assert.match(appShell, /event\.type !== "message\.new"/);
  assert.match(appShell, /senderId !== selfId/);
  assert.match(appShell, /notifications\?\.markChat\(chatId\)/);
  assert.match(appShell, /stopDesktopNotificationTarget\?\.\(\)/);
});

test("QA-MAC-008 autostart is an explicit local operating-system setting", () => {
  assert.match(rustHost, /app\.autolaunch\(\)\.is_enabled/);
  assert.match(rustHost, /app\.autolaunch\(\)\.enable/);
  assert.match(rustHost, /app\.autolaunch\(\)\.disable/);
  assert.match(bridge, /getAutostart/);
  assert.match(bridge, /setAutostart/);
});

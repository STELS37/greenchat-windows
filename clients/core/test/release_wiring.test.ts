// Release-stack wiring contract: T-531/T-604 must remain connected to the real web/UI shell.
// These modules previously passed isolated unit tests while their ports were not supplied by main.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clients = join(here, "..", "..");
const repo = join(clients, "..");
const main = readFileSync(join(clients, "web", "src", "main.ts"), "utf8");

const buildScript = readFileSync(join(clients, "build.mjs"), "utf8");
const productionUnit = readFileSync(join(repo, "infra", "green-chat.service"), "utf8");

const packageVersion = JSON.parse(readFileSync(join(clients, "package.json"), "utf8")).version as string;
const app = readFileSync(join(clients, "ui", "src", "screens", "app.ts"), "utf8");
const chatList = readFileSync(join(clients, "ui", "src", "screens", "chat_list_screen.ts"), "utf8");
const feed = readFileSync(join(clients, "ui", "src", "screens", "feed_screen.ts"), "utf8");

const reportOverlay = readFileSync(join(clients, "ui", "src", "screens", "report_overlay.ts"), "utf8");
const coreIndex = readFileSync(join(clients, "core", "src", "index.ts"), "utf8");

const importScreen = readFileSync(join(clients, "ui", "src", "screens", "import_screen.ts"), "utf8");
const tgImport = readFileSync(join(clients, "core", "src", "tg_import.ts"), "utf8");

const styles = readFileSync(join(clients, "web", "src", "styles.css"), "utf8");
const ru = readFileSync(join(clients, "ui", "src", "locales", "ru.ts"), "utf8");
const en = readFileSync(join(clients, "ui", "src", "locales", "en.ts"), "utf8");

test("release shell contains no merge markers or duplicated critical imports", () => {
  assert.doesNotMatch(main, /^(?:<<<<<<<|=======|>>>>>>>)/m);
  for (const source of [
    "./session_storage.ts",
    "./local_data.ts",
    "./diag_store.ts",
    "./notify_mode.ts",

    "./screen_privacy.ts",
    "./app_lock.ts",
  ]) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const imports = main.match(new RegExp(`from ["']${escaped}["'];`, "g")) ?? [];
    assert.equal(imports.length, 1, `${source} must be imported exactly once`);
  }
  assert.ok(main.includes(`const CLIENT_ID = "web/${packageVersion}";`));
  assert.ok(main.includes(`const APP_VERSION = "${packageVersion}";`));
  assert.doesNotMatch(main, /welcome_hook|maybeShowWelcomeHint|hideWelcomeHint/,
    "the authentication shell must not mount first-visit onboarding chrome");
  assert.doesNotMatch(styles, /\.gc-welcome-hint/,
    "removed onboarding chrome must not leave production CSS behind");
});

test("T-531 notification mode is threaded from web storage into the real Settings screen", () => {
  assert.match(main, /import \{ webNotifyModePort \} from "\.\/notify_mode\.ts";/);
  assert.match(main, /notifyMode:\s*webNotifyModePort\(\)/);
  assert.match(app, /notifyMode\?:\s*NotifyModePort/);
  assert.match(app, /deps\.notifyMode \? \{ notifyMode: deps\.notifyMode \}/);
});

test("T-530 screen privacy is a native-only local preference threaded into the real Settings screen", () => {
  assert.match(main, /import \{ webScreenPrivacyPort \} from "\.\/screen_privacy\.ts";/);
  assert.match(main, /const screenPrivacy = webScreenPrivacyPort\(\)/);
  assert.match(main, /screenPrivacy \? \{ screenPrivacy \}/);
  assert.match(app, /screenPrivacy\?:\s*ScreenPrivacyPort/);
  assert.match(app, /deps\.screenPrivacy \? \{ screenPrivacy: deps\.screenPrivacy \}/);
});

test("T-604 server policy drives ConnectionManager instead of a dead standalone module", () => {
  assert.match(coreIndex, /createConnectionManager/);
  assert.match(main, /connectionManager\s*=\s*createConnectionManager\(/);
  assert.match(main, /await connectionManager\.applyConfigVerified\(cfg, prepareRealityConfig\)/);
  assert.match(main, /if \(seq !== configSyncSeq \|\| !networkConfigApplied\) return;/);
  assert.match(main, /connectionManager\.connect\(\)/);
  assert.match(main, /connectionManager\?\.recheckDirect\(\)/);
  assert.doesNotMatch(main, /connectionManager\?\.applyConfig\(cfg\)/,
    "the shell must not use the asynchronous legacy wrapper and race connect before verification");
  assert.doesNotMatch(main, /endpoints\.setAdvertisedEndpoints\(/,
    "main.ts must not bypass policy/kill-switch parsing with direct endpoint replacement");
});

test("NR-03 config refresh is single-flight and explicit server switch cancels the old epoch", () => {
  assert.match(main, /let configSyncInFlight:\s*Promise<void> \| null = null;/);
  assert.match(main, /if \(configSyncInFlight !== null\) return configSyncInFlight;/,
    "ordinary timer/boot overlap must coalesce instead of invalidating a trusted native preparation");
  assert.match(main, /const cancelServerConfigSync = async \(\): Promise<void> => \{[\s\S]*configSyncSeq \+= 1;[\s\S]*connectionManager\.invalidateConfigVerification\(\);[\s\S]*await inFlight/);
  assert.match(main, /await cancelServerConfigSync\(\);[\s\S]{0,500}await realityTransport\.stop\(\);[\s\S]{0,300}endpoints\.setPrimary\(next\)/,
    "server switch must drain the old config transaction before clearing proxy and changing origin");
});

test("T-605 signed config prepares Android REALITY before atomic route commit", () => {
  assert.match(main, /import \{ createRealityTransportController \} from "\.\/reality_transport_controller\.ts";/);
  assert.match(main, /__gcRealityTransport\?:\s*RealityTransportBridge/);
  assert.match(main, /createRealityTransportController\(\{ bridge: nativeRealityTransport \}\)/);
  assert.match(main, /const prepareRealityConfig = CONFIG_SIGNATURE_PIN === ""[\s\S]*async \(verifiedConfig/,
    "untrusted development config must not enter native orchestration");
  assert.match(main, /realityTransport\.applySignedEndpoints\(verifiedConfig\.endpoints\)/);
  const start = main.indexOf("const runServerConfigSync = async (seq: number): Promise<void> => {");
  const end = main.indexOf("\n  const syncServerConfig", start);
  assert.ok(start >= 0 && end > start, "transactional config sync block must exist");
  const block = main.slice(start, end);
  const fetchConfig = block.indexOf("await api.get<");
  const verifiedPrepareApply = block.indexOf("await connectionManager.applyConfigVerified(cfg, prepareRealityConfig)");
  const connect = block.indexOf("connectionManager.connect()");
  assert.ok(fetchConfig >= 0 && verifiedPrepareApply > fetchConfig && connect > verifiedPrepareApply,
    "signature verification, native preparation and route commit must complete before probes");
  assert.doesNotMatch(main, /realityTransport\.invalidate\(\)/,
    "an unverified or failed refresh must preserve the last trusted engine");
});

test("NR-03 production wiring has one build-time Ed25519 root of trust", () => {
  assert.match(buildScript, /resolveConfigSignaturePin\(\{[\s\S]*explicitPin: process\.env\.GC_CONFIG_SIGNATURE_PIN,[\s\S]*keyFile: process\.env\.GC_CONFIG_SIGN_KEY_FILE,[\s\S]*required: process\.env\.GC_CONFIG_REQUIRE_SIGNATURE === "1"/);
  assert.match(buildScript, /__GC_CONFIG_SIGNATURE_PIN__:\s*JSON\.stringify\(configSignaturePin\)/);
  assert.match(main, /declare const __GC_CONFIG_SIGNATURE_PIN__: string;/);
  assert.match(main, /typeof __GC_CONFIG_SIGNATURE_PIN__ === "string" \? __GC_CONFIG_SIGNATURE_PIN__ : ""/);
  assert.doesNotMatch(main, /test\(__GC_CONFIG_SIGNATURE_PIN__\)[\s\S]{0,80}\? __GC_CONFIG_SIGNATURE_PIN__ : ""/,
    "a malformed non-empty build pin must fail verification, never degrade to unsigned mode");
  assert.match(main, /configSignaturePin:\s*CONFIG_SIGNATURE_PIN/);
  assert.match(productionUnit, /EnvironmentFile=-\/etc\/green-chat\/release\.env[\s\S]*Environment=GC_CONFIG_REQUIRE_SIGNATURE=1/);
});

test("T-604 sticky route never persists before the encrypted container is unlocked", () => {
  assert.match(main, /if \(!appLock\.controller\.isUnlocked\) return memory;/);
  assert.match(main, /if \(appLock\.controller\.isUnlocked\) await store\.put\("meta", `nr\.\$\{key\}`/);
  assert.match(main, /if \(appLock\.controller\.isUnlocked\) await store\.delete\("meta", `nr\.\$\{key\}`/);
});

test("T-604 exposes only a quiet backup-route indicator and localises it", () => {
  assert.match(main, /className = "gc-route-indicator"/);
  assert.match(main, /onStatusChange: \(status\) => \{/);
  assert.match(main, /routeIndicator\.hidden = status\.tier !== "backup"/);
  assert.match(styles, /\.gc-route-indicator\s*\{/);
  assert.match(styles, /pointer-events:\s*none/);
  assert.match(ru, /"server\.backupActive": "Подключение через резервный маршрут"/);
  assert.match(en, /"server\.backupActive": "Connected through a backup route"/);
});

test("T-453B retries protected Telegram account restore on online and visible transitions", () => {
  assert.match(
    main,
    /const recoverTelegramAccounts = \(\): void => \{[\s\S]*?if \(!session\.isAuthed\(\) \|\| !appLockAllowsData\(\)\) return;[\s\S]*?bindTelegramAccount\(user\.id\)/,
  );
  assert.match(main, /await currentController\.initialize\(\)\.catch\(\(\) => undefined\);[\s\S]*?currentController\.retryPushRecovery\(\)/);
  assert.match(
    main,
    /addEventListener\("online", \(\) => \{[\s\S]*?recoverTelegramAccounts\(\);[\s\S]*?connectionManager\?\.connect\(\)/,
  );
  assert.match(
    main,
    /document\.addEventListener\("visibilitychange", \(\) => \{[\s\S]*?document\.visibilityState === "visible"\) recoverTelegramAccounts\(\)/,
  );
});

test("T-453C relays only the native Android FCM token into protected Telegram accounts", () => {
  assert.match(main, /type PushToken/);
  assert.match(main, /const telegramPushBridge = \(window as[\s\S]*?__gcPushBridge/);
  assert.match(main, /token\?\.platform === "fcm" \? token\.endpoint : null/);
  assert.match(main, /telegramController\?\.setPushToken\(next\)/);
  assert.match(main, /await controller\.setPushToken\(telegramFcmToken\)/);
  assert.doesNotMatch(main, /processPushNotification|getPushReceiverId|pushPayload/,
    "encrypted Telegram push payloads must remain in the native Android boundary");
});

test("config refresh timer is installed exactly once", () => {
  const timers = main.match(/setInterval\(\(\) => \{ void syncServerConfig\(\); \}, 60 \* 60 \* 1000\);/g) ?? [];
  assert.equal(timers.length, 1);
});


test("Session invalidates every account-owned writer before local auth/data wipe", () => {
  assert.match(main, /let invalidateAccountOperations = \(\): void => \{\};/);
  assert.match(main, /let finalizeAccountClear = async \(\): Promise<void> => \{\};/);
  assert.match(main, /onBeforeClear: \(\) => invalidateAccountOperations\(\)/);
  assert.match(main, /onAfterClear: \(\) => finalizeAccountClear\(\)/);
  assert.match(
    main,
    /invalidateAccountOperations = \(\) => \{[\s\S]*?stopDataPlane\(\);[\s\S]*?stopPush\(\);[\s\S]*?supportController\.reset\(\);[\s\S]*?uploader\.reset\(\);[\s\S]*?mediaSettings\.reset\(\);[\s\S]*?void cache\.reset\(\)\.catch\(\(\) => undefined\);[\s\S]*?void mediaCache\.reset\(\)\.catch\(\(\) => undefined\);[\s\S]*?localCachePolicy\.resetMemory\(\);[\s\S]*?\};/,
  );
  assert.match(main, /session\.subscribe\(\(user\) => \{\s*if \(!user\) return;/);
  assert.match(
    main,
    /finalizeAccountClear = async \(\) => \{[\s\S]*?await Promise\.allSettled\(\[cache\.reset\(\), mediaCache\.reset\(\)\]\);[\s\S]*?\};/,
  );
});


test("full resync is wired as an awaited cache + mounted-screen barrier", () => {
  assert.match(main, /onResync:\s*async \(\) => \{/);
  assert.match(main, /await cache\.reset\(\)/);
  assert.match(main, /type:\s*"sync\.resync"/);
  assert.match(main, /await Promise\.all\(\[\.\.\.eventListeners\]/);
  assert.match(chatList, /evt\.type === "sync\.resync"\) return load\(true\)/);
  assert.match(feed, /evt\.type === "sync\.resync"/);
  assert.match(feed, /loadNewest\(true\)/);
  assert.match(feed, /loadTitle\(true\)/);
});

test("MediaCache fire-and-forget policy changes cannot leak reset rejections", () => {
  assert.match(main, /setCacheLimit: \(bytes\) => \{ void mediaCache\.setLimit\(bytes\)\.catch\(\(\) => undefined\); \}/);
  assert.match(main, /onCurrentSettled: \(\) => mediaCache\.setLimit\(cacheLimitBytes\(liteMode\(\)\)\)\.catch\(\(\) => undefined\)/);
});

test("account-scoped media settings are loaded and reset through the real web shell", () => {
  assert.match(main, /const mediaSettings = createAccountMediaSettings\(\{/);
  assert.match(main, /policy: \(\) => mediaSettings\.policy\(\)/);
  assert.match(main, /void mediaSettings\.load\(\);/);
  assert.match(main, /mediaSettings\.reset\(\);/);
  assert.doesNotMatch(main, /let settingsMap:/, "a page-global account settings map would leak across logins");
});


test("Telegram import cancellation is wired from screen destroy through uploader/core driver", () => {
  assert.match(importScreen, /destroy\(\) \{\s*disposed = true;\s*model\.reset\(\);\s*unsub\(\);/s);
  assert.match(main, /drive: async \(parsed, source, importId, onProgress, signal\) => \{/);
  assert.match(main, /uploader\.upload\(data, uploadSignal \? \{ name, mime, signal: uploadSignal \} : \{ name, mime \}\)/);
  assert.match(main, /\}, \{ signal \}\);/);
  assert.match(tgImport, /throwIfImportAborted\(signal\);/);
  assert.match(tgImport, /ports\.upload\(blob\.bytes, blob\.name, blob\.mime, signal\)/);
});


test("account-scoped unread badge invalidates stale requests on every data-plane stop", () => {
  assert.match(main, /const badgeRefresh = createBadgeRefreshController\(\{/);
  assert.match(main, /allowed: \(\) => session\.isAuthed\(\) && appLockAllowsData\(\)/);
  assert.match(main, /const refreshBadge = \(\): void => badgeRefresh\.request\(\);/);
  assert.match(main, /const stopDataPlane = \(\): void => \{[\s\S]*?badgeRefresh\.reset\(\);[\s\S]*?\};/);
  assert.match(main, /else badgeRefresh\.reset\(\);/);
  assert.doesNotMatch(main, /let badgeTimer:/, "page-global badge timers cannot guard in-flight account requests");
});


test("diagnostics consent is fail-closed and synchronized across tabs", () => {

  assert.match(buildScript, /__GC_BUILD_ID__:\s*JSON\.stringify\(buildId\)/);
  assert.match(main, /const QUALITY_APP_VERSION = `\$\{APP_VERSION\}\+\$\{BUILD_ID\}`/);
  assert.match(main, /createSessionQuality\(\{[\s\S]*appVersion: QUALITY_APP_VERSION/);

  assert.match(main, /createSessionQuality\(\{[\s\S]*exclusive: browserOutboxExclusive\(\)/);
  assert.match(main, /from "\.\/diagnostics_consent_sync\.ts"/);
  assert.match(main, /const diagnosticsConsent = createDiagnosticsConsentCoordinator\(\{[\s\S]*diagnostics: diag,[\s\S]*sessions: sessionQuality,[\s\S]*signal: diagnosticsConsentSignal\(\)/);
  assert.match(main, /addEventListener\("storage", onStorage\)/);
  assert.match(main, /set: \(on\) => diagnosticsConsent\.set\(on\)/);
  assert.doesNotMatch(
    main,
    /await diag\.setConsent\(on\);\s*await sessionQuality\.setConsent\(on\)/s,
    "the shell must not leave a sequential opt-out window between the two telemetry controllers",
  );
});


test("rotating refresh credentials have one authoritative writer under the cross-tab lock", () => {
  assert.match(main, /refreshCoordinator: browserRefreshCoordinator\(tokens, storage\)/);
  assert.doesNotMatch(
    main,
    /pagehide[\s\S]{0,240}storage\.save\(\{ refresh: tokens\.refresh/,
    "an unloading tab must never overwrite a newer refresh credential rotated by another tab",
  );
  assert.match(
    main,
    /Never copy the realm-local token again on pagehide:[\s\S]*prev_refresh_hash/,
  );
});


test("web session delegates refresh persistence to the origin-wide coordinator", () => {
  assert.match(
    main,
    /new Session\(\{[\s\S]*storage,[\s\S]*refreshStorageManaged: true,[\s\S]*localData:/,
  );
});


test("security reload waits behind the same origin-wide refresh lock", () => {
  assert.match(main, /import \{ browserRefreshBarrier, browserRefreshCoordinator \} from "\.\/refresh_lock\.ts";/);
  assert.match(main, /void browserRefreshBarrier\(reload\)\.catch\(reload\)/);
  assert.match(
    main,
    /handleExternalAppLockSnapshot = \(\): void => \{[\s\S]*?stopDataPlane\(\);[\s\S]*?stopPush\(\);[\s\S]*?reloadAfterRefreshBarrier\(\);[\s\S]*?\};/,
  );
  assert.doesNotMatch(
    main,
    /handleExternalAppLockSnapshot = \(\): void => \{[\s\S]*?location\.reload\(\)[\s\S]*?\};/,
    "critical snapshot handling must not interrupt a rotating refresh directly",
  );
});


test("non-critical data-plane startup failures are absorbed before the global crash handler", () => {
  assert.match(main, /const noteBackgroundFailure = \(operation: string\): void => \{/);
  assert.match(main, /void outbox\.resume\(\)\.catch\(\(\) => noteBackgroundFailure\("outbox\.resume"\)\);/);
  assert.match(main, /void localCachePolicy\.prune\(\)\.catch\(\(\) => noteBackgroundFailure\("localCachePolicy\.prune"\)\);/);
  assert.doesNotMatch(main, /void outbox\.resume\(\);/);
  assert.doesNotMatch(main, /void localCachePolicy\.prune\(\);/);
});

test("report overlay invalidates search and submit callbacks on close", () => {
  assert.match(reportOverlay, /const lifecycle = createReportOverlayEpoch\(\);/);
  assert.match(reportOverlay, /const token = lifecycle\.begin\(\);/);
  const guards = reportOverlay.match(/if \(!lifecycle\.isCurrent\(token\)\)/g) ?? [];
  assert.ok(guards.length >= 4, "search, report and error paths must reject stale work");
  assert.match(reportOverlay, /if \(lifecycle\.isCurrent\(token\)\) setBusy\(false\);/);
  assert.match(reportOverlay, /if \(!lifecycle\.close\(\)\) return;/);
});

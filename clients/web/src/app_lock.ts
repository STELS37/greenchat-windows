// clients/web/src/app_lock.ts — browser/native-shell app-lock persistence and security callbacks (T-523..T-526).
//
// Only wrapped crypto-container metadata is stored in localStorage. Message/chat/media plaintext stays in
// IndexedDB/CacheStorage behind EncryptedStore/MediaCache and becomes inaccessible when K_db/K_files leave RAM.
import {
  APP_LOCK_WIPE_DEFAULT,
  AppLockController,
  COLLECTIONS,
  argon2idUserSecret,
  estimateAppCode,
  normalizeAppLockSnapshot,
  PLATFORM_CLASSES,
  secureKeyHardwareSecret,
  secureKeyBiometricSecret,
  type AppLockMigrationKeys,
  type AppLockSnapshot,

  type DuressAction,
  type ClientStore,
  type KekFactors,
  type PlatformClass,
  type PlatformSignals,
  type SecureKey,
} from "../../core/src/index.ts";
import type { AppLockUiPort } from "../../ui/src/screens/index.ts";
import { hardwareKeyProven } from "./native_shell.ts";

const STORAGE_KEY = "gc.app_lock.v1";
const LOCK_SIGNAL_KEY = "gc.app_lock.lock-signal.v1";
const MEDIA_CACHE = "gc-media-v1";

interface WindowWithSecureKey extends Window {
  __gcSecureKey?: SecureKey;

  __gcDeviceBootMarker?: string;
  __gcAppLockScreenOff?: () => void;
}

export interface WebAppLock {
  controller: AppLockController;
  port: AppLockUiPort;
  destroy(): void;
}

export interface WebAppLockOptions {
  store: ClientStore;
  platform: "web" | "android" | "ios" | "desktop";
  storage?: Storage;

  /** Atomic/idempotent rewrite of legacy plaintext DB + media rows. */
  migrateLocalData: (keys: AppLockMigrationKeys) => Promise<void>;

  /** Clear auth immediately and continue best-effort network duress actions in the background. */
  onDuress?: (action: DuressAction) => void | Promise<void>;

  /** Another same-origin tab changed the durable crypto snapshot. Stop its data plane before reload. */
  onExternalSnapshotChange?: () => void;
}

export interface PendingResetTokens {
  access: string | null;
  refresh: string | null;
  accessExpiresAt: number | null;
}

export interface PendingResetSessionStorage {
  clear(): void;
}

/** Complete a crash-interrupted local reset before Session.restore() or first paint. */
export async function recoverPendingLocalReset(
  controller: AppLockController,
  tokens: PendingResetTokens,
  session: PendingResetSessionStorage,
): Promise<void> {
  if (!controller.localResetPending) return;
  // Async functions execute this section synchronously before their first await.
  tokens.access = null;
  tokens.refresh = null;
  tokens.accessExpiresAt = null;
  try { session.clear(); } catch { /* storage adapter is best-effort */ }
  await controller.completeLocalReset();
}

function recoveryTombstone(requirePassphrase: boolean): AppLockSnapshot {
  return normalizeAppLockSnapshot({
    container: { magic: "gc-crypto-store-wiped", version: 1 },
    policy: { wipeAfter: APP_LOCK_WIPE_DEFAULT, requirePassphrase },
    localResetPending: true,
  });
}

function parseSnapshotValue(raw: string | null, requirePassphrase: boolean): AppLockSnapshot | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const snapshot = normalizeAppLockSnapshot(parsed as Partial<AppLockSnapshot>);
    if (!snapshot.container) snapshot.policy.requirePassphrase = requirePassphrase;
    return snapshot;
  } catch {
    return null;
  }
}

function externalSnapshotRequiresReload(
  oldRaw: string | null,
  newRaw: string | null,
  requirePassphrase: boolean,
): boolean {
  const oldSnapshot = parseSnapshotValue(oldRaw, requirePassphrase);
  const newSnapshot = parseSnapshotValue(newRaw, requirePassphrase);
  if (!oldSnapshot || !newSnapshot) return true;

  // Successful unlock updates only recovery counters/cold-entry metadata. Reloading every peer for that
  // benign metadata creates a multi-tab unlock ping-pong. Any key/policy/wrap/migration/reset change still
  // invalidates the realm. Increasing failure/lockout counters is also security-significant and reloads.
  const criticalContainer = (container: AppLockSnapshot["container"]): unknown => {
    if (container && "header" in container && "wrap" in container) {
      // meta.lastOpenAt is intentionally unauthenticated convenience metadata and advances after every
      // successful unlock. Header + WRAP remain the complete cryptographic posture of a live container.
      return { header: container.header, wrap: container.wrap };
    }
    return container;
  };
  const critical = (snapshot: AppLockSnapshot): string => JSON.stringify({
    container: criticalContainer(snapshot.container),
    policy: snapshot.policy,
    migration: snapshot.migration,
    biometric: { enabled: snapshot.biometric.enabled, wrap: snapshot.biometric.wrap },
    localResetPending: snapshot.localResetPending,
  });
  if (critical(oldSnapshot) !== critical(newSnapshot)) return true;
  if (newSnapshot.attempts.failures > oldSnapshot.attempts.failures) return true;
  if (newSnapshot.attempts.blockedUntil > oldSnapshot.attempts.blockedUntil) return true;
  if (newSnapshot.biometric.failures > oldSnapshot.biometric.failures) return true;
  return false;
}

function readSnapshot(storage: Storage | undefined, requirePassphrase: boolean): AppLockSnapshot {
  let raw: string | null = null;
  try { raw = storage?.getItem(STORAGE_KEY) ?? null; } catch { /* unavailable storage: session-only mode */ }

  let snapshot: AppLockSnapshot;
  if (raw === null || raw === "") {
    snapshot = normalizeAppLockSnapshot(null);
  } else {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("app_lock: snapshot must be an object");
      }
      snapshot = normalizeAppLockSnapshot(parsed as Partial<AppLockSnapshot>);
    } catch {
      // A present-but-unreadable snapshot may have been tampered with or partially written. Treating it
      // as DISABLED would expose an authenticated shell over ciphertext from an unknown key posture.
      // Replace the corrupt bytes synchronously, before browser listeners and async reset work start.
      // This gives every later reload one stable authoritative tombstone instead of re-entering the
      // corruption path and retriggering cross-tab invalidation indefinitely.
      snapshot = recoveryTombstone(requirePassphrase);
      try { storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* best-effort durable receipt */ }
    }
  }
  // The platform rule is selected at first setup. Existing containers keep their original policy/header.
  if (!snapshot.container) {
    snapshot.policy.requirePassphrase = requirePassphrase;
    snapshot.policy.wipeAfter = APP_LOCK_WIPE_DEFAULT;
  }
  return snapshot;
}

function browserSignals(): PlatformSignals & { destroy(): void } {
  const background = new Set<() => void>();
  const foreground = new Set<() => void>();
  const screenOff = new Set<() => void>();

  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") {
      for (const callback of [...background]) callback();
    } else if (document.visibilityState === "visible") {
      for (const callback of [...foreground]) callback();
    }
  };
  const onScreenOffEvent = (): void => {
    for (const callback of [...screenOff]) callback();
  };
  const win = window as WindowWithSecureKey;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("gc-screen-off", onScreenOffEvent as EventListener);
  // Capacitor/native shells can call this when the OS reports a real screen-off event. Browser tabs use
  // visibilitychange for their 30-second background lock; pagehide is handled locally by the adapter.
  win.__gcAppLockScreenOff = () => window.dispatchEvent(new Event("gc-screen-off"));

  return {
    onBackground(callback) {
      background.add(callback);
      return () => { background.delete(callback); };
    },
    onForeground(callback) {
      foreground.add(callback);
      return () => { foreground.delete(callback); };
    },
    onScreenOff(callback) {
      screenOff.add(callback);
      return () => { screenOff.delete(callback); };
    },
    destroy() {
      background.clear();
      foreground.clear();
      screenOff.clear();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("gc-screen-off", onScreenOffEvent as EventListener);
      if (win.__gcAppLockScreenOff) delete win.__gcAppLockScreenOff;
    },
  };
}

function isAppOwnedStorageKey(key: string): boolean {
  return key.startsWith("gc.") || key.startsWith("gc-");
}

function clearAppOwnedStorage(area: Storage | undefined, preserveKey?: string): void {
  if (!area) return;
  try {
    for (let index = area.length - 1; index >= 0; index--) {
      const key = area.key(index);
      if (key && key !== preserveKey && isAppOwnedStorageKey(key)) area.removeItem(key);
    }
  } catch {
    // Storage may be disabled or become unavailable during a WebView lifecycle transition.
  }
}

async function clearLocalCache(store: ClientStore, storage?: Storage): Promise<void> {
  for (const collection of COLLECTIONS) {
    try { await store.clear(collection); } catch { /* continue: crypto key destruction remains authoritative */ }
  }
  try {
    if (typeof caches !== "undefined") await caches.delete(MEDIA_CACHE);
  } catch {
    /* CacheStorage may be unavailable in private mode/native WebView. */
  }
  // Keep only the neutral app-lock snapshot until pending cleanup is durably completed.
  clearAppOwnedStorage(storage, STORAGE_KEY);
  try { clearAppOwnedStorage(sessionStorage); } catch { /* no sessionStorage in this host */ }
}

/**
 * The class of an ALREADY created container, or null when this device has none yet.
 *
 * container.ts refuses to open a container with a provider of a different class, so the stored class
 * is not advice — it is the only class this install may use until the container is rebuilt. Read
 * with a private parser: a corrupt snapshot is handled by readSnapshot()/recoveryTombstone() and must
 * not be able to throw here, where the answer only ever narrows the choice below.
 */
function storedContainerClass(storage: Storage | undefined): PlatformClass | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? null;
    if (raw === null || raw === "") return null;
    const parsed = JSON.parse(raw) as { container?: { header?: { platformClass?: unknown } } };
    const value = parsed?.container?.header?.platformClass;
    return PLATFORM_CLASSES.includes(value as PlatformClass) ? (value as PlatformClass) : null;
  } catch {
    return null;
  }
}

function chooseFactors(
  platform: WebAppLockOptions["platform"],
  existingClass: PlatformClass | null,
): {
  platformClass: PlatformClass;
  requirePassphrase: boolean;
  factors: KekFactors;
  biometricFactor: ReturnType<typeof secureKeyBiometricSecret> | null;
  resetBiometric?: () => Promise<void>;
  enableBiometricByDefault: boolean;
} {
  const secureKey = (window as WindowWithSecureKey).__gcSecureKey;
  // Two different questions, deliberately kept apart (see native_shell.ts):
  //  * "am I an Android/iOS shell" is a LABEL, and the shell installs the SecureKey proxy whether or
  //    not the device can actually create the key;
  //  * "does a hardware-backed key work here" is a FACT, and only a completed native key operation
  //    establishes it. Measured on the signed APK (versionCode 1000013, redroid 15): the proxy was
  //    present and SecureKey.ensure() rejected, because the emulator has no TEE/StrongBox and no
  //    secure lock screen. Trusting the label there would have written a "max" container the device
  //    cannot open, so the fact is what decides.
  // An existing container overrides both verdicts: its own class is the only one that can open it.
  const nativeShell = platform === "android" || platform === "ios";
  const useHardwareSecret = existingClass === null
    ? nativeShell && secureKey !== undefined && hardwareKeyProven(window)
    : existingClass === "max";
  if (useHardwareSecret && secureKey) {
    return {
      platformClass: "max",
      requirePassphrase: false,
      factors: { user: argon2idUserSecret(), hw: secureKeyHardwareSecret(secureKey) },
      biometricFactor: secureKeyBiometricSecret(secureKey),
      resetBiometric: () => secureKey.resetBiometric(),
      enableBiometricByDefault: true,
    };
  }
  // Fail closed whenever no hardware secret is proven — including an Android/iOS shell whose device
  // cannot back the key. User-only Argon2id cannot make a six-digit PIN resistant to an offline
  // filesystem dump, so a passphrase is mandatory until WebAuthn PRF / desktop keyring / native
  // SecureKey supplies S_hw.
  return {
    platformClass: "web-user-only",
    requirePassphrase: true,
    factors: { user: argon2idUserSecret(), hw: null },
    biometricFactor: null,
    enableBiometricByDefault: false,
  };
}

export function createWebAppLock(options: WebAppLockOptions): WebAppLock {
  const signals = browserSignals();
  const storage = options.storage ?? (() => {
    try { return localStorage; } catch { return undefined; }
  })();
  const selected = chooseFactors(options.platform, storedContainerClass(storage));
  let memorySnapshot = readSnapshot(storage, selected.requirePassphrase);

  const controller = new AppLockController({
    snapshot: memorySnapshot,
    factors: selected.factors,
    platformClass: selected.platformClass,

    biometricFactor: selected.biometricFactor,
    ...(selected.resetBiometric ? { resetBiometric: selected.resetBiometric } : {}),
    enableBiometricByDefault: selected.enableBiometricByDefault,

    currentBootId: (window as WindowWithSecureKey).__gcDeviceBootMarker ?? null,
    signals,
    persistence: {
      save(snapshot) {
        memorySnapshot = structuredClone(snapshot);
        try { storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* session-only fallback */ }
      },
    },
    migrateLocalData: options.migrateLocalData,
    wipeLocalData: () => clearLocalCache(options.store, storage),

    ...(options.onDuress ? { onDuress: options.onDuress } : {}),
  });

  // A page leaving the active document must zeroize its own keys immediately (including BFCache), but
  // navigation/reload is not a device screen-off and must never lock peer tabs. The background reason
  // is deliberately local and LOCKED carries no durable snapshot mutation.
  const onPageHide = (): void => {
    if (controller.state === "UNLOCKED") controller.lock("background");
  };
  window.addEventListener("pagehide", onPageHide);

  // Durable snapshot changes already invalidate stale tabs. Manual lock and screen-off are origin-wide,
  // so publish a content-free nonce for those reasons. Background lock stays local to the hidden tab:
  // every hidden tab owns its own 30 s timer, while an actively used peer must not be locked merely because
  // another tab remained hidden. When all tabs are hidden they still all lock independently.
  let lockSignalSequence = 0;
  let applyingExternalLock = false;
  const unsubscribeLockSignal = controller.onLock((reason) => {
    if (applyingExternalLock || (reason !== "manual" && reason !== "screen_off")) return;
    lockSignalSequence += 1;
    try {
      const random = crypto.getRandomValues(new Uint8Array(16));
      const nonce = Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("");
      storage?.setItem(LOCK_SIGNAL_KEY, `${lockSignalSequence.toString(36)}-${nonce}`);
    } catch { /* storage denied: this tab still locked fail-closed */ }
  });

  let externalSnapshotHandled = false;
  const onExternalStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== LOCK_SIGNAL_KEY && event.key !== null) return;
    if (event.storageArea !== null && storage !== undefined && event.storageArea !== storage) return;
    if (event.oldValue === event.newValue) return;

    if (event.key === LOCK_SIGNAL_KEY) {
      // Manual/screen-off lock is memory-only and carries no new cryptographic snapshot. Apply it live
      // in this realm so plaintext disappears without navigation. Suppress re-broadcast: the peer that
      // originated the nonce is already locked, and echoing it would create a cross-tab signal storm.
      if (controller.state !== "UNLOCKED") return;
      applyingExternalLock = true;
      try { controller.lock(); }
      finally { applyingExternalLock = false; }
      return;
    }

    if (!externalSnapshotRequiresReload(event.oldValue, event.newValue, selected.requirePassphrase)) return;
    if (externalSnapshotHandled) return;
    externalSnapshotHandled = true;
    // A durable wrap/policy snapshot can invalidate this realm's in-memory key posture. The shell callback
    // stops account writers synchronously and reloads from the authoritative encrypted snapshot.
    options.onExternalSnapshotChange?.();
  };
  window.addEventListener("storage", onExternalStorage);

  const port: AppLockUiPort = {
    get state() { return controller.state; },
    get enabled() { return controller.enabled; },
    get policy() { return controller.policy; },
    get attempts() { return controller.attempts; },

    get biometric() { return controller.biometric; },

    get cold() { return controller.cold; },

    get duress() { return controller.duress; },
    retryAfterSeconds: () => controller.retryAfterSeconds(),
    estimate: (code) => estimateAppCode(code, controller.policy.requirePassphrase),
    subscribe: (listener) => controller.subscribe(listener),
    unlock: (code) => controller.unlock(code),

    unlockBiometric: () => controller.unlockBiometric(),
    enable: (code, policy) => controller.enable(code, policy),
    changeCode: (currentCode, newCode) => controller.changeCode(currentCode, newCode),
    setWipeAfter: (value) => controller.setWipeAfter(value),

    setProfile: (profile) => controller.setProfile(profile),

    configureDuress: (currentCode, duressCode, trustedUsername) =>
      controller.configureDuress(currentCode, duressCode, trustedUsername),
    disableDuress: (currentCode) => controller.disableDuress(currentCode),

    setBiometricEnabled: (enabled) => controller.setBiometricEnabled(enabled),
    disableAndWipe: (code) => controller.disableAndWipe(code),
    resetAfterWipe: () => controller.resetAfterWipe(),
    lock: () => {
      if (controller.state === "UNLOCKED") controller.lock();
    },
  };

  return {
    controller,
    port,
    destroy() {
      window.removeEventListener("storage", onExternalStorage);
      window.removeEventListener("pagehide", onPageHide);
      unsubscribeLockSignal();
      controller.dispose();
      signals.destroy();
    },
  };
}

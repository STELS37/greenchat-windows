// crypto_store/app_lock.ts — application lock, migration, biometrics, cold-entry and duress policy (T-523..T-526).
//
// Turns the T-522 LockMachine into a user-facing application lock:
// - PIN >= 6 digits or passphrase >= 8 characters;
// - conservative strength estimate;
// - exponential retry delay 1,2,4,...300 seconds, persisted across reloads;
// - optional wipe-after-N failures (default 10, allowed 5..20 or disabled);
// - synchronous K_db provider for EncryptedStore and K_files provider for MediaCache.
//
// The controller is DOM/storage agnostic and never persists the application code.
import {
  createContainer,

  COLD_AFTER_SECONDS,
  isWipedTombstone,
  unlockContainer,
  WrongCodeError,
  type KekFactors,

  type DuressAction,
  type WipedContainerTombstone,
} from "./container.ts";
import {
  InvalidLockTransitionError,
  LockMachine,
  type LockClock,
  type LockReason,
  type LockState,
  type ManualLockReason,
  type PlatformSignals,
  type WipeReason,
} from "./lock_machine.ts";
import { parseWrappedContainer } from "./format.ts";

import {
  BiometricWrapInvalidatedError,
  InvalidBiometricWrapError,
  parseBiometricWrap,
  unlockBiometricWrap,
  type BiometricWrap,
} from "./biometric_wrap.ts";
import { zeroize } from "./primitives.ts";
import type { HardwareSecretProvider, PlatformClass, WrappedContainer } from "./types.ts";

export const APP_LOCK_WIPE_DEFAULT = 10;
export const APP_LOCK_WIPE_MIN = 5;
export const APP_LOCK_WIPE_MAX = 20;
export const APP_LOCK_DELAY_CAP_SECONDS = 5 * 60;

export const APP_LOCK_BIOMETRIC_FAILURE_LIMIT = 5;
export const APP_LOCK_PARANOID_INACTIVITY_SECONDS = 72 * 60 * 60;
export const APP_LOCK_PARANOID_REAUTH_SECONDS = 48 * 60 * 60;

export type AppLockProfile = "default" | "paranoid";
export type AppColdReason = "reboot" | "inactivity" | "biometric_failures" | "periodic_reauth";

export type AppLockState = "DISABLED" | LockState;
export type AppCodeKind = "pin" | "passphrase";
export type AppCodeProblem =
  | "empty"
  | "pin_too_short"
  | "passphrase_too_short"
  | "passphrase_required";
export type AppCodeStrength = 0 | 1 | 2 | 3 | 4;

export interface AppCodeEstimate {
  kind: AppCodeKind;
  valid: boolean;
  problem: AppCodeProblem | null;
  score: AppCodeStrength;
  /** Conservative comparison aid, not a promise of real cracking cost. */
  estimatedBits: number;
  words: number;
  length: number;
}

export interface AppLockPolicy {
  /** null means failed attempts never trigger automatic local crypto-wipe. */
  wipeAfter: number | null;
  /** Desktop environments without hardware throttling may require a passphrase. */
  requirePassphrase: boolean;

  /** Default never asks periodically; paranoid is an explicit opt-in profile. */
  profile?: AppLockProfile;

  /** T-528: opt-in panic-wipe trigger (§13.2 — every harsh feature is explicit opt-in). */
  panic?: boolean;
}

export interface AppLockAttempts {
  failures: number;
  blockedUntil: number;
}

export interface AppLockMigrationState {
  version: 1;
  state: "pending";
}

export interface AppLockMigrationKeys {
  /** Session-owned buffers. Migration code may read but MUST NOT mutate or zeroize them. */
  dbKey: Uint8Array;
  filesKey: Uint8Array;
}

export type AppBiometricProblem =
  | "disabled"
  | "unavailable"
  | "cancelled"
  | "busy"
  | "failed"
  | "lockout"
  | "code_required";

export interface AppBiometricSnapshot {
  /** User preference. A null wrap while enabled means one successful code unlock must rebuild it. */
  enabled: boolean;
  wrap: BiometricWrap | null;
  /** Consecutive OS biometric failures; never mixed with code attempts. */
  failures: number;
}

export interface AppColdSnapshot {
  /** Last successful application-code unlock; biometric unlock deliberately does not update it. */
  lastCodeUnlockAt: number;
  /** Stable non-PII identifier of the OS boot confirmed by the application code. */
  bootId: string | null;
}

export interface AppColdStatus {
  profile: AppLockProfile;
  codeRequired: boolean;
  reason: AppColdReason | null;
}

export interface AppDuressStatus {
  enabled: boolean;
  /** Username stays encrypted; UI may reveal only whether an optional signal is configured. */
  signal: boolean;
}

export interface AppBiometricStatus {
  available: boolean;
  enabled: boolean;
  ready: boolean;
  codeRequired: boolean;
  failures: number;
}

export interface AppLockSnapshot {
  container: WrappedContainer | WipedContainerTombstone | null;
  policy: AppLockPolicy;
  attempts: AppLockAttempts;
  /** Durable two-phase marker: container persisted, local plaintext rewrite not yet committed. */
  migration: AppLockMigrationState | null;
  biometric: AppBiometricSnapshot;

  cold: AppColdSnapshot;
  /** Generic crash-recovery marker: finish local/auth cleanup before any session restore. */
  localResetPending: boolean;
}

export interface AppLockPersistence {
  save(snapshot: AppLockSnapshot): void | Promise<void>;
}

export interface AppLockControllerOptions {
  snapshot?: Partial<AppLockSnapshot> | null;
  factors: KekFactors;
  platformClass: PlatformClass;
  /** Separate auth-bound factor. Never reuse it as the code/recovery hardware factor. */
  biometricFactor?: HardwareSecretProvider | null;
  /** Deletes only the auth-bound native key before rebuilding WRAP_bio. */
  resetBiometric?: () => void | Promise<void>;
  /** Native shells offer the fast door automatically on first lock setup. */
  enableBiometricByDefault?: boolean;

  /** Stable non-PII identifier of the current OS boot (native shells only). */
  currentBootId?: string | null;
  persistence: AppLockPersistence;
  clock?: LockClock;
  signals?: PlatformSignals;
  backgroundLockSeconds?: number;
  /**
   * Rewrite all legacy DB/media rows in one atomic lower-store transaction. Called only after a
   * durable migration=pending snapshot exists and session keys have been derived, while the public
   * controller posture remains fail-closed. Must be idempotent for crash recovery.
   */
  migrateLocalData: (keys: AppLockMigrationKeys) => void | Promise<void>;
  /** Best-effort physical cleanup after authoritative WRAP destruction. */
  wipeLocalData?: () => void | Promise<void>;

  /** Clears the authenticated shell and starts best-effort network actions after local crypto-erasure. */
  onDuress?: (action: DuressAction) => void | Promise<void>;

  /** T-528: same contract as onDuress for the overt panic trigger (network revoke is best-effort). */
  onPanic?: () => void | Promise<void>;
}

export class InvalidAppCodeError extends Error {
  readonly problem: AppCodeProblem;
  constructor(problem: AppCodeProblem) {
    super(`app_lock: invalid application code (${problem})`);
    this.name = "InvalidAppCodeError";
    this.problem = problem;
  }
}

export class AppLockThrottledError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(`app_lock: retry after ${retryAfterSeconds}s`);
    this.name = "AppLockThrottledError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AppLockFailedError extends WrongCodeError {
  readonly failures: number;
  readonly retryAfterSeconds: number;
  constructor(failures: number, retryAfterSeconds: number, cause?: unknown) {
    super(cause);
    this.name = "AppLockFailedError";
    this.failures = failures;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AppLockWipedError extends Error {
  constructor() {
    super("app_lock: local encrypted storage was wiped after failed attempts");
    this.name = "AppLockWipedError";
  }
}

export class AppLockMigrationError extends Error {
  override readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("app_lock: local encryption migration did not complete");
    this.name = "AppLockMigrationError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class AppBiometricError extends Error {
  readonly problem: AppBiometricProblem;
  override readonly cause?: unknown;

  constructor(problem: AppBiometricProblem, cause?: unknown) {
    super(`app_lock: biometric unlock failed (${problem})`);
    this.name = "AppBiometricError";
    this.problem = problem;
    if (cause !== undefined) this.cause = cause;
  }
}

function defaultClock(): LockClock {
  return {
    nowSeconds: () => Math.floor(Date.now() / 1000),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
  };
}

function safeInt(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : fallback;
}

function safeBootId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

export function normalizeWipeAfter(value: unknown): number | null {
  if (value === null || value === false || value === 0 || value === "off") return null;
  if (!Number.isInteger(value) || Number(value) < APP_LOCK_WIPE_MIN || Number(value) > APP_LOCK_WIPE_MAX) {
    throw new Error(`app_lock: wipeAfter must be null or ${APP_LOCK_WIPE_MIN}..${APP_LOCK_WIPE_MAX}`);
  }
  return Number(value);
}

export function normalizeAppLockSnapshot(value?: Partial<AppLockSnapshot> | null): AppLockSnapshot {
  let container: AppLockSnapshot["container"] = null;
  const raw = value?.container;
  if (raw !== undefined && raw !== null) {
    container = isWipedTombstone(raw)
      ? { magic: "gc-crypto-store-wiped", version: 1 }
      : parseWrappedContainer(raw);
  }

  let wipeAfter: number | null = APP_LOCK_WIPE_DEFAULT;
  try {
    wipeAfter = normalizeWipeAfter(value?.policy?.wipeAfter ?? APP_LOCK_WIPE_DEFAULT);
  } catch {
    // Corrupt local metadata must not weaken the safe default.
  }

  const migration =
    container !== null &&
    !isWipedTombstone(container) &&
    value?.migration?.version === 1 &&
    value.migration.state === "pending"
      ? { version: 1, state: "pending" } as const
      : null;

  let biometricWrap: BiometricWrap | null = null;
  try {
    const candidate = value?.biometric?.wrap;
    if (candidate !== undefined && candidate !== null) biometricWrap = parseBiometricWrap(candidate);
  } catch {
    // Corrupt/tampered WRAP_bio can only disable the fast door; WRAP_code remains authoritative.
  }
  const biometricEnabled =
    container !== null && !isWipedTombstone(container) && value?.biometric?.enabled === true;

  return {
    container,
    policy: {
      wipeAfter,
      requirePassphrase: value?.policy?.requirePassphrase === true,
      profile: value?.policy?.profile === "paranoid" ? "paranoid" : "default",
      panic: value?.policy?.panic === true,
    },
    attempts: {
      failures: safeInt(value?.attempts?.failures, 0, 0, 1_000_000),
      blockedUntil: safeInt(value?.attempts?.blockedUntil, 0, 0),
    },
    migration,
    biometric: {
      enabled: biometricEnabled,
      wrap: biometricEnabled ? biometricWrap : null,
      failures: biometricEnabled ? safeInt(value?.biometric?.failures, 0, 0, 1_000_000) : 0,
    },
    cold: {
      lastCodeUnlockAt: safeInt(value?.cold?.lastCodeUnlockAt, 0, 0),
      bootId: safeBootId(value?.cold?.bootId),
    },
    localResetPending: value?.localResetPending === true,
  };
}

function isSequentialPin(code: string): boolean {
  if (code.length < 4) return false;
  return "01234567890123456789".includes(code) || "98765432109876543210".includes(code);
}

function characterClasses(code: string): number {
  let count = 0;
  if (/[a-z]/.test(code)) count++;
  if (/[A-Z]/.test(code)) count++;
  if (/\d/.test(code)) count++;
  if (/[^A-Za-z\d\s]/.test(code)) count++;
  if (/[^\x00-\x7f]/.test(code)) count++;
  return count;
}

export function estimateAppCode(code: string, requirePassphrase = false): AppCodeEstimate {
  const length = [...code].length;
  const isPin = /^\d+$/.test(code);
  const kind: AppCodeKind = isPin ? "pin" : "passphrase";
  const words = code.trim() === "" ? 0 : code.trim().split(/\s+/u).length;

  if (length === 0 || code.trim() === "") {
    return { kind, valid: false, problem: "empty", score: 0, estimatedBits: 0, words, length };
  }
  if (requirePassphrase && isPin) {
    return { kind, valid: false, problem: "passphrase_required", score: 0, estimatedBits: 0, words, length };
  }
  if (isPin) {
    if (length < 6) {
      return {
        kind,
        valid: false,
        problem: "pin_too_short",
        score: 0,
        estimatedBits: Math.floor(length * Math.log2(10)),
        words,
        length,
      };
    }
    let bits = Math.floor(length * Math.log2(10));
    if (/^(\d)\1+$/.test(code)) bits = Math.min(bits, 4);
    else if (isSequentialPin(code)) bits = Math.min(bits, 7);
    else if (/^(\d{2,4})\1+$/.test(code)) bits = Math.min(bits, 12);
    // A six-digit PIN deliberately remains "weak": protection depends on hardware/app throttling.
    const score: AppCodeStrength = bits < 10 ? 1 : length <= 6 ? 1 : length <= 8 ? 2 : length <= 10 ? 3 : 4;
    return { kind, valid: true, problem: null, score, estimatedBits: bits, words, length };
  }

  if (length < 8) {
    return {
      kind,
      valid: false,
      problem: "passphrase_too_short",
      score: 0,
      estimatedBits: Math.max(0, length * 2),
      words,
      length,
    };
  }

  let bits = Math.floor(
    length * 2.2 + Math.max(0, words - 1) * 6 + Math.max(0, characterClasses(code) - 1) * 5,
  );
  if (/^(.)\1+$/u.test(code)) bits = Math.min(bits, 5);
  if (/^(password|qwerty|letmein|пароль|12345678)$/iu.test(code.trim())) bits = Math.min(bits, 5);
  const score: AppCodeStrength = bits < 20 ? 1 : bits < 35 ? 2 : bits < 55 ? 3 : 4;
  return { kind, valid: true, problem: null, score, estimatedBits: bits, words, length };
}

export function assertValidAppCode(code: string, requirePassphrase = false): AppCodeEstimate {
  const estimate = estimateAppCode(code, requirePassphrase);
  if (!estimate.valid) throw new InvalidAppCodeError(estimate.problem ?? "empty");
  return estimate;
}

export function appLockDelaySeconds(failures: number): number {
  if (!Number.isInteger(failures) || failures <= 0) return 0;
  return Math.min(APP_LOCK_DELAY_CAP_SECONDS, 2 ** Math.min(30, failures - 1));
}

function biometricErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.toLowerCase();
  return String(error).toLowerCase();
}

function biometricProblem(error: unknown): AppBiometricProblem {
  if (error instanceof BiometricWrapInvalidatedError || error instanceof InvalidBiometricWrapError) {
    return "code_required";
  }
  const text = biometricErrorText(error);
  if (
    text.includes("key_invalidated") ||
    text.includes("permanentlyinvalidated") ||
    text.includes("item not found") ||
    text.includes("errsecitemnotfound") ||
    text.includes("osstatus -25300")
  ) return "code_required";
  if (text.includes("auth_busy") || text.includes("busy")) return "busy";

  if (
    text.includes("auth_lockout") ||
    text.includes("biometric_lockout") ||
    text.includes("auth_error_7") ||
    text.includes("auth_error_9")
  ) return "lockout";
  if (
    text.includes("auth_failed") ||
    text.includes("authentication failed") ||
    text.includes("osstatus -25293")
  ) return "failed";
  if (
    text.includes("auth_cancelled") ||
    text.includes("user canceled") ||
    text.includes("user cancelled") ||
    text.includes("cancel") ||
    text.includes("osstatus -128")
  ) return "cancelled";
  return "unavailable";
}

export class AppLockController {
  readonly #factors: KekFactors;
  readonly #platformClass: PlatformClass;
  readonly #biometricFactor: HardwareSecretProvider | null;
  readonly #resetBiometric: (() => void | Promise<void>) | undefined;
  readonly #enableBiometricByDefault: boolean;

  readonly #currentBootId: string | null;
  readonly #persistence: AppLockPersistence;
  readonly #clock: LockClock;
  readonly #signals: PlatformSignals | undefined;
  readonly #backgroundLockSeconds: number | undefined;
  readonly #migrateLocalData: (keys: AppLockMigrationKeys) => void | Promise<void>;
  readonly #wipeLocalData: (() => void | Promise<void>) | undefined;

  readonly #onDuress: ((action: DuressAction) => void | Promise<void>) | undefined;
  readonly #onPanic: (() => void | Promise<void>) | undefined;
  // T-526 duress and T-528 panic share the same silent-erasure discipline: while true, the persist
  // layer atomically replaces the WIPED tombstone with a fresh-install snapshot and observers stay mute.
  #freshWipeInProgress = false;
  readonly #listeners = new Set<(state: AppLockState) => void>();

  readonly #lockListeners = new Set<(reason: LockReason) => void>();
  #snapshot: AppLockSnapshot;
  #machine: LockMachine | null = null;
  #dbKey: Uint8Array | null = null;

  // Transient but security-relevant: from the FIRST synchronous enable step until a durable
  // container+pending marker exists. While true, passthrough is forbidden and subscribers see LOCKED,
  // so KDF/chunk-load latency cannot leave Sync/Outbox writing new plaintext behind the migration.
  #enabling = false;
  #operation: Promise<void> = Promise.resolve();

  constructor(options: AppLockControllerOptions) {
    this.#snapshot = normalizeAppLockSnapshot(options.snapshot);
    this.#factors = options.factors;
    this.#platformClass = options.platformClass;
    this.#biometricFactor = options.biometricFactor ?? null;
    this.#resetBiometric = options.resetBiometric;
    this.#enableBiometricByDefault = options.enableBiometricByDefault === true;

    this.#currentBootId = safeBootId(options.currentBootId);
    this.#persistence = options.persistence;
    this.#clock = options.clock ?? defaultClock();
    this.#signals = options.signals;
    this.#backgroundLockSeconds = options.backgroundLockSeconds;
    this.#migrateLocalData = options.migrateLocalData;
    this.#wipeLocalData = options.wipeLocalData;

    this.#onDuress = options.onDuress;
    this.#onPanic = options.onPanic;
    this.#installMachine();
  }

  get state(): AppLockState {

    if (this.#enabling) return "LOCKED";
    if (this.#machine) {
      // During the two-phase migration the LockMachine temporarily owns keys, but no caller outside
      // the migration callback may observe an unlocked posture or start the data plane.
      if (this.#snapshot.migration?.state === "pending" && this.#machine.state === "UNLOCKED") {
        return "LOCKED";
      }
      return this.#machine.state;
    }
    return isWipedTombstone(this.#snapshot.container) ? "WIPED" : "DISABLED";
  }

  get policy(): AppLockPolicy {
    return { ...this.#snapshot.policy };
  }

  get attempts(): AppLockAttempts {
    return { ...this.#snapshot.attempts };
  }

  get biometric(): AppBiometricStatus {
    const available = this.#biometricFactor !== null;
    const enabled = available && this.#snapshot.biometric.enabled;
    const codeRequired = enabled && (
      this.#snapshot.biometric.wrap === null ||
      this.#coldReason() !== null
    );
    return {
      available,
      enabled,
      ready: enabled && !codeRequired,
      codeRequired,
      failures: this.#snapshot.biometric.failures,
    };
  }

  get cold(): AppColdStatus {
    const reason = this.#coldReason();
    return {
      profile: this.#snapshot.policy.profile ?? "default",
      codeRequired: reason !== null,
      reason,
    };
  }

  get duress(): AppDuressStatus {
    const container = this.#snapshot.container;
    if (!container || isWipedTombstone(container)) return { enabled: false, signal: false };
    const envelope = parseWrappedContainer(container).header.duress;
    return {
      enabled: envelope !== undefined,
      signal: envelope?.signal === true,
    };
  }

  get localResetPending(): boolean {
    return this.#snapshot.localResetPending;
  }

  get enabled(): boolean {
    return this.#enabling || this.#machine !== null;
  }

  get isUnlocked(): boolean {
    return (
      this.#snapshot.migration === null &&
      this.#machine?.state === "UNLOCKED" &&
      this.#machine.session !== null
    );
  }

  /** Synchronous provider used by EncryptedStore. Buffer ownership stays with CryptoSession. */
  get currentDbKey(): Uint8Array | null {
    return this.isUnlocked ? this.#dbKey : null;
  }

  get container(): WrappedContainer | WipedContainerTombstone | null {
    const value = this.#snapshot.container;
    if (value === null) return null;
    return isWipedTombstone(value) ? { ...value } : parseWrappedContainer(value);
  }

  /** Passthrough is allowed only before a user opts into the application lock. */
  passthroughAllowed(): boolean {
    return this.state === "DISABLED";
  }

  subscribe(listener: (state: AppLockState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Reason-aware lock subscription for same-origin shell coordination. */
  onLock(listener: (reason: LockReason) => void): () => void {
    this.#lockListeners.add(listener);
    return () => { this.#lockListeners.delete(listener); };
  }

  retryAfterSeconds(): number {
    return Math.max(0, this.#snapshot.attempts.blockedUntil - this.#clock.nowSeconds());
  }

  /** Structural MediaKeyProvider implementation for MediaCache. */
  async domainKey(domain: "files"): Promise<Uint8Array> {
    const session = this.#machine?.session;
    if (!this.isUnlocked || !session) throw new Error("app_lock: locked — K_files unavailable");
    return session.domainKey(domain);
  }

  enable(code: string, policy: Partial<AppLockPolicy> = {}): Promise<void> {
    // This boundary MUST be synchronous. #serial() schedules its callback in a microtask, which is too
    // late: realtime/cache work queued by the same click could otherwise persist another plaintext row.
    if (this.state !== "DISABLED") {
      return Promise.reject(new InvalidLockTransitionError(this.state as LockState, "enable"));
    }
    const nextPolicy: AppLockPolicy = {
      wipeAfter: normalizeWipeAfter(policy.wipeAfter ?? this.#snapshot.policy.wipeAfter),
      requirePassphrase: policy.requirePassphrase ?? this.#snapshot.policy.requirePassphrase,
      profile: policy.profile === "paranoid" ? "paranoid" : "default",
      panic: (policy.panic ?? this.#snapshot.policy.panic) === true,
    };
    try {
      assertValidAppCode(code, nextPolicy.requirePassphrase);
    } catch (error) {
      return Promise.reject(error);
    }

    const previous = normalizeAppLockSnapshot(this.#snapshot);
    this.#enabling = true;
    this.#emit(); // closes passthrough/data-plane before this method returns its Promise

    return this.#serial(async () => {
      let created: Awaited<ReturnType<typeof createContainer>> | null = null;
      try {
        created = await createContainer({
          code,
          platformClass: this.#platformClass,
          factors: this.#factors,
        });
        this.#snapshot = {
          container: created.container,
          policy: nextPolicy,
          attempts: { failures: 0, blockedUntil: 0 },
          migration: { version: 1, state: "pending" },
          biometric: { enabled: false, wrap: null, failures: 0 },
          cold: { lastCodeUnlockAt: this.#clock.nowSeconds(), bootId: this.#currentBootId },
          localResetPending: false,
        };
        await this.#save();
      } catch (error) {
        // No durable pending marker exists: restoring DISABLED is safe and resumes the data-plane.
        this.#snapshot = previous;
        this.#enabling = false;
        this.#emit();
        throw error;
      } finally {
        if (created) zeroize(created.mk);
      }


      this.#installMachine();
      this.#enabling = false;
      this.#emit(); // COLD/pending; migration still keeps public key providers fail-closed
      await this.#unlockInside(code);
      if (this.#enableBiometricByDefault && this.#biometricFactor !== null) {
        try {
          await this.#setBiometricEnabledInside(true);
        } catch {
          // App-lock setup must succeed even when the user cancels the optional biometric prompt.
        }
      }
    });
  }

  async unlock(code: string): Promise<void> {
    return this.#serial(() => this.#unlockInside(code));
  }

  async unlockBiometric(): Promise<void> {
    return this.#serial(() => this.#unlockBiometricInside());
  }

  async setBiometricEnabled(enabled: boolean): Promise<void> {
    return this.#serial(() => this.#setBiometricEnabledInside(enabled));
  }

  lock(reason: ManualLockReason = "manual"): void {
    if (!this.#machine) throw new Error("app_lock: lock is disabled");
    this.#machine.lock(reason);
  }

  async changeCode(currentCode: string, newCode: string): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      if (!machine.session) throw new InvalidLockTransitionError(machine.state, "changeCode");
      assertValidAppCode(newCode, this.#snapshot.policy.requirePassphrase);

      // An open screen is not enough authority to replace the code. Verify the current code first.
      const verified = await unlockContainer({
        code: currentCode,
        container: machine.container,
        factors: this.#factors,
      });
      zeroize(verified);

      const next = await machine.changeCode(newCode);
      const refreshBiometric = this.#snapshot.biometric.enabled && this.#biometricFactor !== null;
      this.#snapshot = {
        ...this.#snapshot,
        container: next,
        biometric: {
          ...this.#snapshot.biometric,
          ...(refreshBiometric ? { wrap: null } : {}),
          failures: 0,
        },
        cold: { lastCodeUnlockAt: this.#clock.nowSeconds(), bootId: this.#currentBootId },
      };
      await this.#save();
      if (refreshBiometric) {
        try {
          await this.#setBiometricEnabledInside(true);
        } catch {
          // The code change is authoritative. A cancelled biometric re-wrap leaves one-code recovery.
          this.#emit();
        }
      } else {
        this.#emit();
      }
    });
  }

  async setWipeAfter(value: number | null): Promise<void> {
    return this.#serial(async () => {
      this.#snapshot = {
        ...this.#snapshot,
        policy: { ...this.#snapshot.policy, wipeAfter: normalizeWipeAfter(value) },
      };
      await this.#save();
      this.#emit();
    });
  }

  async setProfile(profile: AppLockProfile): Promise<void> {
    return this.#serial(async () => {
      if (profile !== "default" && profile !== "paranoid") {
        throw new Error("app_lock: unknown cold profile");
      }
      this.#snapshot = {
        ...this.#snapshot,
        policy: { ...this.#snapshot.policy, profile },
      };
      await this.#save();
      this.#emit();
    });
  }

  async configureDuress(
    currentCode: string,
    duressCode: string,
    trustedUsername?: string | null,
  ): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      if (!machine.session) throw new InvalidLockTransitionError(machine.state, "configureDuress");
      assertValidAppCode(currentCode, this.#snapshot.policy.requirePassphrase);
      assertValidAppCode(duressCode, this.#snapshot.policy.requirePassphrase);
      if (currentCode === duressCode) throw new Error("app_lock: duress code must differ from app code");
      const next = await machine.configureDuress(currentCode, duressCode, trustedUsername);
      await this.#adoptHeaderMutation(next);
    });
  }

  async disableDuress(currentCode: string): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      if (!machine.session) throw new InvalidLockTransitionError(machine.state, "disableDuress");
      assertValidAppCode(currentCode, this.#snapshot.policy.requirePassphrase);
      const next = await machine.disableDuress(currentCode);
      await this.#adoptHeaderMutation(next);
    });
  }

  /** Disable safely: verify code, remove bio recovery, destroy WRAP, then return to passthrough mode. */
  async disableAndWipe(code: string): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      const verified = await unlockContainer({
        code,
        container: machine.container,
        factors: this.#factors,
      });
      zeroize(verified);

      // Clear and persist WRAP_bio before the main tombstone can ever be written. A crash at any later
      // point cannot leave a surviving biometric recovery path to an otherwise wiped MK.
      await this.#clearBiometricFastPath();
      if (machine.state === "UNLOCKED") machine.lock("manual");
      await machine.wipe("wipe");
      await this.#bestEffortLocalWipe();
      machine.dispose();
      this.#machine = null;
      this.#dbKey = null;
      this.#snapshot = {
        container: null,
        policy: { ...this.#snapshot.policy },
        attempts: { failures: 0, blockedUntil: 0 },
        migration: null,
        biometric: { enabled: false, wrap: null, failures: 0 },
        cold: { lastCodeUnlockAt: 0, bootId: this.#currentBootId },
        localResetPending: false,
      };
      await this.#save();
      this.#emit();
    });
  }

  async wipe(reason: WipeReason = "wipe"): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      await this.#clearBiometricFastPath();
      await machine.wipe(reason);
      await this.#bestEffortLocalWipe();
      this.#emit();
    });
  }

  /**
   * T-528 (DS-10): overt panic-wipe. One deliberate trigger performs LOCK + cryptographic erasure
   * of the local container with NO confirmation dialog and NO animation. MK/domain keys are
   * zeroized synchronously inside machine.wipe() before any await (I-DS-1), destroyWrap replaces
   * WRAP, and the persist layer atomically lands the same fresh-install snapshot a duress unlock
   * leaves behind (T-526): container:null, observers see only DISABLED, never a WIPED receipt.
   * Network revoke (onPanic) is fire-and-forget strictly AFTER the authoritative local erasure.
   * The policy.panic flag only governs UI visibility of the trigger; like wipe(), the method
   * itself is not additionally gated — destroying local data is never a privilege escalation.
   */
  async panic(): Promise<void> {
    return this.#serial(async () => {
      const machine = this.#requireMachine();
      await this.#freshInstallWipe(machine, "panic");
      try {
        const pending = this.#onPanic?.();
        if (pending) void Promise.resolve(pending).catch(() => {});
      } catch {
        // Local cryptographic erasure is already authoritative.
      }
      this.#emit();
    });
  }

  /** T-528: opt-in visibility of the panic trigger (§13.2 — every harsh feature defaults OFF). */
  async setPanicEnabled(enabled: boolean): Promise<void> {
    return this.#serial(async () => {
      this.#snapshot = {
        ...this.#snapshot,
        policy: { ...this.#snapshot.policy, panic: enabled === true },
      };
      await this.#save();
      this.#emit();
    });
  }

  /** After an automatic wipe, forget the tombstone and allow a fresh local setup. No old data survives. */
  async resetAfterWipe(): Promise<void> {
    return this.#serial(async () => {
      if (this.state !== "WIPED") throw new Error("app_lock: resetAfterWipe requires WIPED state");
      await this.#bestEffortLocalWipe();
      this.#machine?.dispose();
      this.#machine = null;
      this.#snapshot = {
        container: null,
        policy: { ...this.#snapshot.policy },
        attempts: { failures: 0, blockedUntil: 0 },
        migration: null,
        biometric: { enabled: false, wrap: null, failures: 0 },
        cold: { lastCodeUnlockAt: 0, bootId: this.#currentBootId },
        localResetPending: false,
      };
      await this.#save();
      this.#emit();
    });
  }

  async completeLocalReset(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#snapshot.localResetPending) return;
      // Marker remains durable until best-effort physical cleanup has run. A crash retries on next boot.
      await this.#bestEffortLocalWipe();
      this.#snapshot = { ...this.#snapshot, localResetPending: false };
      await this.#save();
      this.#emit();
    });
  }

  dispose(): void {
    this.#machine?.dispose();
    this.#machine = null;
    this.#dbKey = null;
    this.#listeners.clear();

    this.#lockListeners.clear();
  }

  async #setBiometricEnabledInside(enabled: boolean): Promise<void> {
    const factor = this.#biometricFactor;
    if (!factor) throw new AppBiometricError("unavailable");
    const machine = this.#requireMachine();
    const session = machine.session;
    if (!session) throw new InvalidLockTransitionError(machine.state, "setBiometricEnabled");

    if (!enabled) {
      this.#snapshot = {
        ...this.#snapshot,
        biometric: { enabled: false, wrap: null, failures: 0 },
      };
      await this.#save();
      try { await this.#resetBiometric?.(); } catch { /* preference is already safely disabled */ }
      this.#emit();
      return;
    }

    if (this.#snapshot.biometric.enabled && this.#snapshot.biometric.wrap !== null) return;
    try {
      // A stale auth-bound key must be removed without touching deviceHmac/signing keys.
      await this.#resetBiometric?.();
      const wrap = await session.createBiometricWrap(factor);
      this.#snapshot = {
        ...this.#snapshot,
        biometric: { enabled: true, wrap, failures: 0 },
      };
      await this.#save();
      this.#emit();
    } catch (error) {
      throw new AppBiometricError(biometricProblem(error), error);
    }
  }

  async #unlockBiometricInside(): Promise<void> {
    const machine = this.#requireMachine();
    const factor = this.#biometricFactor;
    if (!factor || !this.#snapshot.biometric.enabled) {
      throw new AppBiometricError("disabled");
    }
    if (this.#coldReason() !== null) {
      throw new AppBiometricError("code_required");
    }
    const wrap = this.#snapshot.biometric.wrap;
    if (!wrap) throw new AppBiometricError("code_required");

    try {
      const mk = await unlockBiometricWrap(wrap, factor, machine.container);
      await machine.unlockWithMasterKey(mk); // ownership transfers; all failure paths zeroize MK
      const session = machine.session;
      if (!session) throw new Error("app_lock: missing CryptoSession after biometric unlock");
      this.#dbKey = await session.domainKey("db");
      this.#snapshot = {
        ...this.#snapshot,
        container: machine.container,
        attempts: { failures: 0, blockedUntil: 0 },
        biometric: { ...this.#snapshot.biometric, failures: 0 },
      };
      await this.#save();
      this.#emit();
    } catch (error) {
      if (machine.state === "UNLOCKED") machine.lock("manual");
      const problem = biometricProblem(error);
      let reported: AppBiometricProblem = problem;
      if (problem === "code_required") {
        // Enrollment/key replacement invalidates only the secondary wrap. It is not a biometric miss.
        this.#snapshot = {
          ...this.#snapshot,
          biometric: {
            enabled: true,
            wrap: null,
            failures: this.#snapshot.biometric.failures,
          },
        };
        await this.#save();
        this.#emit();
      } else if (problem === "failed" || problem === "lockout") {
        const failures = problem === "lockout"
          ? APP_LOCK_BIOMETRIC_FAILURE_LIMIT
          : Math.min(APP_LOCK_BIOMETRIC_FAILURE_LIMIT, this.#snapshot.biometric.failures + 1);
        this.#snapshot = {
          ...this.#snapshot,
          biometric: { ...this.#snapshot.biometric, failures },
        };
        await this.#save();
        this.#emit();
        if (failures >= APP_LOCK_BIOMETRIC_FAILURE_LIMIT) reported = "code_required";
      }
      // Biometric failures never mutate code attempts and therefore never trigger wipe-after-N.
      throw new AppBiometricError(reported, error);
    }

  }

  async #unlockInside(code: string): Promise<void> {
    const machine = this.#requireMachine();
    const retry = this.retryAfterSeconds();
    if (retry > 0) throw new AppLockThrottledError(retry);

    try {
      const duressAction = await machine.unlockOrDuress(code);
      if (duressAction) {
        await this.#triggerDuress(machine, duressAction);
        return;
      }
      const session = machine.session;
      if (!session) throw new Error("app_lock: missing CryptoSession after unlock");

      const dbKey = await session.domainKey("db");
      if (this.#snapshot.migration?.state === "pending") {
        const filesKey = await session.domainKey("files");
        try {
          // Phase 2: caller prepares every ciphertext first, then commits all stores in one batch.
          // Public state/currentDbKey stay fail-closed until both this callback and the marker clear save.
          await this.#migrateLocalData({ dbKey, filesKey });
        } catch (error) {
          if (machine.state === "UNLOCKED") machine.lock("manual");
          throw new AppLockMigrationError(error);
        }
      }

      const priorMigration = this.#snapshot.migration;
      this.#snapshot = {
        ...this.#snapshot,
        container: machine.container,
        attempts: { failures: 0, blockedUntil: 0 },
        migration: null,
        biometric: { ...this.#snapshot.biometric, failures: 0 },
        cold: { lastCodeUnlockAt: this.#clock.nowSeconds(), bootId: this.#currentBootId },
      };
      this.#dbKey = dbKey;
      try {
        // Clearing pending is the commit marker exposed to the rest of the app. If this persistence
        // fails, re-lock and restore pending; encrypted rows are safe and the next unlock retries.
        await this.#save();
      } catch (error) {
        this.#snapshot = { ...this.#snapshot, migration: priorMigration };
        this.#dbKey = null;
        if (machine.state === "UNLOCKED") machine.lock("manual");
        throw new AppLockMigrationError(error);
      }
      this.#emit();

      // If enrollment change invalidated WRAP_bio, exactly one successful code entry repairs it.
      // A cancelled repair prompt never rolls back the already successful code unlock.
      if (
        this.#snapshot.biometric.enabled &&
        this.#snapshot.biometric.wrap === null &&
        this.#biometricFactor !== null
      ) {
        try { await this.#setBiometricEnabledInside(true); } catch { /* code recovery remains authoritative */ }
      }
    } catch (error) {
      if (error instanceof AppLockMigrationError) throw error;
      if (!(error instanceof WrongCodeError)) throw error;
      const failures = this.#snapshot.attempts.failures + 1;
      const wipeAfter = this.#snapshot.policy.wipeAfter;

      if (wipeAfter !== null && failures >= wipeAfter) {
        this.#snapshot = {
          ...this.#snapshot,
          attempts: { failures, blockedUntil: 0 },
        };
        await this.#save();
        await this.#clearBiometricFastPath();
        await machine.wipe("wipe");
        await this.#bestEffortLocalWipe();
        this.#emit();
        throw new AppLockWipedError();
      }


      const delay = appLockDelaySeconds(failures);
      this.#snapshot = {
        ...this.#snapshot,
        attempts: {
          failures,
          blockedUntil: this.#clock.nowSeconds() + delay,
        },
      };
      await this.#save();
      this.#emit();
      throw new AppLockFailedError(failures, delay, error);
    }
  }

  #installMachine(): void {
    this.#machine?.dispose();
    this.#machine = null;
    this.#dbKey = null;
    const container = this.#snapshot.container;
    if (!container || isWipedTombstone(container)) return;

    const machine = new LockMachine({
      container,
      factors: this.#factors,
      persist: async (value) => {
        if (this.#freshWipeInProgress && isWipedTombstone(value)) {
          // Null is authoritative WRAP destruction, written together with removal of every local trace.
          this.#snapshot = {
            container: null,
            policy: {
              wipeAfter: APP_LOCK_WIPE_DEFAULT,
              requirePassphrase: this.#snapshot.policy.requirePassphrase,
              profile: "default",
              panic: false,
            },
            attempts: { failures: 0, blockedUntil: 0 },
            migration: null,
            biometric: { enabled: false, wrap: null, failures: 0 },
            cold: { lastCodeUnlockAt: 0, bootId: this.#currentBootId },
            localResetPending: true,
          };
        } else {
          this.#snapshot = {
            ...this.#snapshot,
            container: value,
            migration: isWipedTombstone(value) ? null : this.#snapshot.migration,
          };
        }
        await this.#save();
      },
      clock: this.#clock,
      ...(this.#signals ? { signals: this.#signals } : {}),
      ...(this.#backgroundLockSeconds !== undefined
        ? { backgroundLockSeconds: this.#backgroundLockSeconds }
        : {}),
    });
    machine.onLock((reason: LockReason) => {
      // CryptoSession zeroized this shared buffer before invoking onLock. LOCKED itself is memory-only:
      // unlock/code/policy/attempt transitions already persist before publishing state. Re-saving here
      // could let a stale tab overwrite a newer peer snapshot during pagehide/navigation.
      this.#dbKey = null;
      if (this.#freshWipeInProgress) return;
      this.#emit();
      for (const listener of [...this.#lockListeners]) listener(reason);
    });
    this.#machine = machine;
  }

  #requireMachine(): LockMachine {
    if (!this.#machine) {
      if (this.state === "WIPED") throw new AppLockWipedError();
      throw new Error("app_lock: lock is disabled");
    }
    if (this.#machine.state === "WIPED") throw new AppLockWipedError();
    return this.#machine;
  }

  #coldReason(): AppColdReason | null {
    const machine = this.#machine;
    if (!machine || !this.#snapshot.biometric.enabled) return null;
    if (this.#snapshot.biometric.failures >= APP_LOCK_BIOMETRIC_FAILURE_LIMIT) {
      return "biometric_failures";
    }
    if (this.#currentBootId !== null && this.#snapshot.cold.bootId !== this.#currentBootId) {
      return "reboot";
    }
    const profile = this.#snapshot.policy.profile ?? "default";
    const inactivitySeconds = profile === "paranoid"
      ? APP_LOCK_PARANOID_INACTIVITY_SECONDS
      : COLD_AFTER_SECONDS;
    if (machine.coldEntryRequired(inactivitySeconds)) return "inactivity";
    if (
      profile === "paranoid" &&
      (
        this.#snapshot.cold.lastCodeUnlockAt <= 0 ||
        this.#clock.nowSeconds() - this.#snapshot.cold.lastCodeUnlockAt >= APP_LOCK_PARANOID_REAUTH_SECONDS
      )
    ) return "periodic_reauth";
    return null;
  }

  async #adoptHeaderMutation(next: WrappedContainer): Promise<void> {
    const refreshBiometric = this.#snapshot.biometric.enabled && this.#biometricFactor !== null;
    this.#snapshot = {
      ...this.#snapshot,
      container: next,
      biometric: {
        ...this.#snapshot.biometric,
        ...(refreshBiometric ? { wrap: null } : {}),
        failures: 0,
      },
    };
    await this.#save();
    if (refreshBiometric) {
      try {
        await this.#setBiometricEnabledInside(true);
        return;
      } catch {
        // Header mutation is authoritative. One ordinary code entry can rebuild WRAP_bio.
      }
    }
    this.#emit();
  }

  async #triggerDuress(machine: LockMachine, action: DuressAction): Promise<void> {
    await this.#freshInstallWipe(machine, "duress");
    try {
      const pending = this.#onDuress?.(action);
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch {
      // Local cryptographic erasure is already authoritative.
    }
    this.#emit();
  }

  /**
   * Shared silent-erasure core (duress T-526, panic T-528). The persist callback atomically
   * translates the WIPED tombstone into a fresh-install snapshot, so no receipt is ever written
   * and observers never see state:WIPED. Best-effort physical deletion follows the authoritative
   * WRAP destruction; SecureKey biometric material is invalidated once the snapshot is clean.
   */
  async #freshInstallWipe(machine: LockMachine, reason: WipeReason): Promise<void> {
    this.#freshWipeInProgress = true;
    try {
      await machine.wipe(reason);
      try { await this.#resetBiometric?.(); } catch { /* no WRAP_bio survived the fresh snapshot */ }
      await this.#bestEffortLocalWipe();
      machine.dispose();
      this.#machine = null;
      this.#dbKey = null;
    } finally {
      this.#freshWipeInProgress = false;
    }
  }

  async #clearBiometricFastPath(): Promise<void> {
    this.#snapshot = {
      ...this.#snapshot,
      biometric: { enabled: false, wrap: null, failures: 0 },
    };
    // Persist the removal first. Even if native key deletion fails or the process dies, no surviving
    // WRAP_bio blob remains next to the future tombstone.
    await this.#save();
    try { await this.#resetBiometric?.(); } catch { /* persisted wrap removal is authoritative */ }
  }

  async #bestEffortLocalWipe(): Promise<void> {
    try {
      await this.#wipeLocalData?.();
    } catch {
      // WRAP destruction is already authoritative; physical deletion is defense in depth.
    }
  }

  async #save(): Promise<void> {
    await this.#persistence.save({
      container: this.container,
      policy: this.policy,
      attempts: this.attempts,
      migration: this.#snapshot.migration ? { ...this.#snapshot.migration } : null,
      biometric: {
        enabled: this.#snapshot.biometric.enabled,
        wrap: this.#snapshot.biometric.wrap
          ? parseBiometricWrap(this.#snapshot.biometric.wrap)
          : null,
        failures: this.#snapshot.biometric.failures,
      },
      cold: {
        lastCodeUnlockAt: this.#snapshot.cold.lastCodeUnlockAt,
        bootId: this.#snapshot.cold.bootId,
      },
      localResetPending: this.#snapshot.localResetPending,
    });
  }

  #emit(): void {
    const state = this.state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operation.then(operation, operation);
    this.#operation = run.then(
      () => {},
      () => {},
    );
    return run;
  }
}

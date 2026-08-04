// clients/core/src/telegram_accounts.ts — protected multi-account Telegram registry (T-453A/T-453B).
//
// A Telegram user id is unknown until authorization completes, so it cannot safely be the pre-login vault
// selector. GreenChat allocates an unpredictable stable local slot, stores the slot catalogue only in the
// OS-protected Connector Vault, and binds each slot to its own cv1.* account scope. T-453B keeps every
// authorized slot live while the application process is alive, bounded by the hard eight-account limit and
// one native receive loop. Only activeSlot is allowed to execute user mutations or expose auth controls.

import {
  createNativeScopedConnectorVault,
  deriveConnectorVaultScope,
  type ConnectorVaultScopeIdentity,
  type NativeConnectorSecretVault,
} from "./connector_vault.ts";
import {
  ConnectorEventGate,
  type ConnectorEvent,
  type ConnectorLoginState,
  type ScopedConnectorVault,
} from "./connectors.ts";
import {
  createTelegramConnectionController,
  type TelegramConnectionController,
  type TelegramConnectionReason,
  type TelegramConnectionSnapshot,
} from "./telegram_connection.ts";
import type { TelegramConnectorOptions, TelegramTdlibBridge } from "./telegram_tdlib.ts";

export const TELEGRAM_LEGACY_ACCOUNT_SLOT = "primary" as const;
export const TELEGRAM_ACCOUNT_CATALOG_SLOT = "catalog.v1" as const;
export const TELEGRAM_MAX_LOCAL_ACCOUNTS = 8 as const;
const CATALOG_A = "telegram.accounts.catalog.a.v1";
const CATALOG_B = "telegram.accounts.catalog.b.v1";
const CATALOG_KEYS = [CATALOG_A, CATALOG_B] as const;
const SLOT = /^(?:primary|slot\.[0-9a-f]{36})$/u;
const TELEGRAM_ACCOUNT_ID = /^[1-9][0-9]{0,20}$/u;
const MAX_UNREAD_COUNT = 2_147_483_647;

interface CatalogAccount {
  slot: string;
  accountId?: string;
}

interface CatalogV1 {
  version: 1;
  revision: number;
  activeSlot: string | null;
  accounts: CatalogAccount[];
}

interface AccountRuntime {
  vault: ScopedConnectorVault;
  controller: TelegramConnectionController;
  detachState: () => void;
  detachEvents: () => void;
  snapshot: TelegramConnectionSnapshot;
  eventGate: ConnectorEventGate;
  unreadByChat: Map<string, number>;
  unreadCount: number;
  globalUnreadKnown: boolean;
  lastEventAt?: string;
  registeredPushToken: string | null | undefined;
  registeredPushOtherIds: string | null;
}

export type TelegramAccountSyncState =
  | "active"
  | "background"
  | "connecting"
  | "paused"
  | "disconnected"
  | "error";

export interface TelegramAccountEvent {
  /** Internal random selector; callers must never render or persist it outside the protected connector flow. */
  slot: string;
  event: ConnectorEvent;
}

export interface TelegramAccountSummary {
  /** Random local slot; it is safe for internal selection but must never be displayed to the user. */
  slot: string;
  /** Provider account id, retained only inside OS-protected storage and masked by UI. */
  accountId?: string;
  login: ConnectorLoginState;
  syncState: TelegramAccountSyncState;
  unreadCount: number;
  lastEventAt?: string;
}

/** Active-account view plus the protected account selector and process-alive background state. */
export interface TelegramAccountsSnapshot extends TelegramConnectionSnapshot {
  activeSlot: string | null;
  accounts: readonly TelegramAccountSummary[];
  canAddAccount: boolean;
  totalUnreadCount: number;
  backgroundReadyCount: number;
}

export interface TelegramAccountsController {
  snapshot(): TelegramAccountsSnapshot;
  subscribe(listener: (snapshot: TelegramAccountsSnapshot) => void): () => void;
  subscribeEvents(listener: (event: TelegramAccountEvent) => void): () => void;
  initialize(): Promise<void>;
  addAccount(): Promise<string>;
  selectAccount(slot: string): Promise<void>;
  connectQr(): Promise<void>;
  connectPhone(phone: string): Promise<void>;
  submitCode(code: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  /** Apply the native Android FCM token to every authorized Telegram slot; null revokes it. */
  setPushToken(token: string | null): Promise<void>;
  /** Retry native encrypted-push draining for every already-open authorized slot. */
  retryPushRecovery(): void;
  disconnect(): Promise<void>;
  remove(): Promise<void>;
  suspend(): void;
  close(): Promise<void>;
  wipe(): Promise<void>;
}

export interface TelegramAccountsControllerOptions {
  bridge: TelegramTdlibBridge;
  nativeVault: NativeConnectorSecretVault;
  serverId: string;
  greenChatUserId: ConnectorVaultScopeIdentity["greenChatUserId"];
  platform: TelegramTdlibBridge["platform"];
  config: Omit<TelegramConnectorOptions, "bridge"> | null;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  onDiagnostic?: (event: { level: "debug" | "info" | "warn" | "error"; code: string }) => void;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  if (!globalThis.crypto?.getRandomValues) throw new Error("secure Telegram account slot randomness is unavailable");
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function newAccountSlot(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(18);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 18) {
    throw new Error("Telegram account slot random source returned invalid bytes");
  }
  return `slot.${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function validSlot(value: unknown): value is string {
  return typeof value === "string" && SLOT.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unreadValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_UNREAD_COUNT
    ? value
    : null;
}

function parseCatalog(bytes: Uint8Array | null): CatalogV1 | null {
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) return null;
  if (raw.activeSlot !== null && !validSlot(raw.activeSlot)) return null;
  if (!Array.isArray(raw.accounts) || raw.accounts.length > TELEGRAM_MAX_LOCAL_ACCOUNTS) return null;
  const accounts: CatalogAccount[] = [];
  const slots = new Set<string>();
  const ids = new Set<string>();
  for (const item of raw.accounts) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (!validSlot(entry.slot) || slots.has(entry.slot)) return null;
    const accountId = entry.accountId;
    if (accountId !== undefined && (typeof accountId !== "string" || !TELEGRAM_ACCOUNT_ID.test(accountId) || ids.has(accountId))) {
      return null;
    }
    slots.add(entry.slot);
    if (typeof accountId === "string") ids.add(accountId);
    accounts.push({ slot: entry.slot, ...(typeof accountId === "string" ? { accountId } : {}) });
  }
  if (raw.activeSlot !== null && !slots.has(raw.activeSlot)) return null;
  return {
    version: 1,
    revision: Number(raw.revision),
    activeSlot: raw.activeSlot as string | null,
    accounts,
  };
}

function encodeCatalog(catalog: CatalogV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(catalog));
}

function catalogCanonical(catalog: CatalogV1): string {
  return new TextDecoder().decode(encodeCatalog(catalog));
}

function nextCatalogRevision(catalog: CatalogV1): number {
  if (catalog.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Telegram account catalogue revision exhausted");
  return catalog.revision + 1;
}

function disconnected(configured: boolean, reason?: TelegramConnectionReason): TelegramConnectionSnapshot {
  return {
    available: configured,
    configured,
    busy: false,
    login: { status: "revoked", reason: "not_connected" },
    ...(!configured || reason ? { reason: reason ?? "not_configured" } : {}),
  };
}

class AccountsController implements TelegramAccountsController {
  private readonly options: TelegramAccountsControllerOptions;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly listeners = new Set<(snapshot: TelegramAccountsSnapshot) => void>();
  private readonly eventListeners = new Set<(event: TelegramAccountEvent) => void>();
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly pendingIdentity = new Set<string>();
  private catalogVault: ScopedConnectorVault | null = null;
  private catalog: CatalogV1 | null = null;
  private info: Awaited<ReturnType<TelegramTdlibBridge["info"]>> | null = null;
  private state: TelegramAccountsSnapshot;
  private initTask: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private pushToken: string | null | undefined;
  private pushRevision = 0;
  private suspended = false;
  private disposed = false;

  constructor(options: TelegramAccountsControllerOptions) {
    this.options = options;
    this.randomBytes = options.randomBytes ?? defaultRandomBytes;
    this.state = this.compose(disconnected(false));
  }

  snapshot(): TelegramAccountsSnapshot { return this.state; }

  subscribe(listener: (snapshot: TelegramAccountsSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  subscribeEvents(listener: (event: TelegramAccountEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  initialize(): Promise<void> {
    this.assertOpen();
    this.suspended = false;
    if (this.initTask) return this.initTask;
    this.initTask = this.enqueue(() => this.initializeOnce()).finally(() => { this.initTask = null; });
    return this.initTask;
  }

  async addAccount(): Promise<string> {
    await this.initialize();
    return this.enqueue(async () => {
      this.requireUsableRuntime();
      const catalog = this.requireCatalog();
      if (catalog.accounts.length >= TELEGRAM_MAX_LOCAL_ACCOUNTS) throw new Error("Telegram account limit reached");
      let slot = newAccountSlot(this.randomBytes);
      for (let attempt = 0; catalog.accounts.some((entry) => entry.slot === slot) && attempt < 3; attempt += 1) {
        slot = newAccountSlot(this.randomBytes);
      }
      if (catalog.accounts.some((entry) => entry.slot === slot)) throw new Error("Telegram account slot collision");
      const previousSlot = catalog.activeSlot;
      const next: CatalogV1 = {
        ...catalog,
        revision: nextCatalogRevision(catalog),
        activeSlot: slot,
        accounts: [...catalog.accounts, { slot }],
      };
      await this.saveCatalog(next);
      try {
        await this.activate(slot);
      } catch (error) {
        try {
          await this.saveCatalog({ ...next, revision: nextCatalogRevision(next), activeSlot: previousSlot });
          if (previousSlot) await this.activate(previousSlot).catch(() => undefined);
        } catch {
          this.options.onDiagnostic?.({ level: "error", code: "telegram.accounts.add_rollback_failed" });
        }
        throw error;
      }
      return slot;
    });
  }

  async selectAccount(slotValue: string): Promise<void> {
    await this.initialize();
    const slot = this.requireSlot(slotValue);
    await this.enqueue(async () => {
      const catalog = this.requireCatalog();
      if (!catalog.accounts.some((entry) => entry.slot === slot)) throw new Error("unknown Telegram account slot");
      if (catalog.activeSlot === slot) {
        await this.activate(slot);
        return;
      }
      // Prepare the target while the previous selected account remains live. A failed target restore cannot
      // strand the user or alter durable selection; activeSlot is persisted only after initialization returns.
      await this.activate(slot);
      const next = { ...catalog, revision: nextCatalogRevision(catalog), activeSlot: slot };
      await this.saveCatalog(next);
    });
  }

  async connectQr(): Promise<void> { await (await this.activeController()).connectQr(); }
  async connectPhone(phone: string): Promise<void> { await (await this.activeController()).connectPhone(phone); }
  async submitCode(code: string): Promise<void> { await (await this.activeController()).submitCode(code); }
  async submitPassword(password: string): Promise<void> { await (await this.activeController()).submitPassword(password); }

  async setPushToken(token: string | null): Promise<void> {
    if (!this.catalog || !this.info) await this.initialize();
    const normalized = token === null ? null : token.trim();
    if (normalized !== null && (
      normalized.length === 0 || normalized.length > 4096 || !/^[\u0021-\u007e]+$/u.test(normalized)
    )) {
      throw new TypeError("invalid Telegram FCM token");
    }
    await this.enqueue(async () => {
      this.pushToken = normalized;
      this.pushRevision += 1;
      await this.reconcilePushRegistrations();
    });
  }

  retryPushRecovery(): void {
    if (this.disposed || this.suspended) return;
    for (const runtime of this.runtimes.values()) runtime.controller.retryPushRecovery();
  }

  async disconnect(): Promise<void> { await (await this.activeController()).disconnect(); }

  async remove(): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const catalog = this.requireCatalog();
      const slot = catalog.activeSlot;
      if (!slot) return;
      const runtime = await this.ensureRuntime(slot);
      await runtime.controller.remove();
      await runtime.controller.close();
      this.dropRuntime(slot);
      const accounts = catalog.accounts.filter((entry) => entry.slot !== slot);
      const next: CatalogV1 = {
        ...catalog,
        revision: nextCatalogRevision(catalog),
        activeSlot: accounts[0]?.slot ?? null,
        accounts,
      };
      await this.saveCatalog(next);
      if (next.activeSlot) await this.activate(next.activeSlot);
      else this.publish();
    });
  }

  suspend(): void {
    if (this.disposed) return;
    this.suspended = true;
    for (const runtime of this.runtimes.values()) runtime.controller.suspend();
    this.publish();
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.suspended = true;
    await this.operationTail.catch(() => undefined);
    const runtimes = [...this.runtimes.entries()];
    this.runtimes.clear();
    for (const [, runtime] of runtimes) {
      runtime.detachState();
      runtime.detachEvents();
    }
    await Promise.allSettled(runtimes.map(([, runtime]) => runtime.controller.close()));
    await this.catalogVault?.dispose?.().catch(() => undefined);
    this.catalogVault = null;
    this.listeners.clear();
    this.eventListeners.clear();
  }

  async wipe(): Promise<void> {
    this.assertOpen();
    await this.enqueue(async () => {
      await this.ensureCatalog();
      const catalog = this.requireCatalog();
      const failures: unknown[] = [];
      for (const entry of catalog.accounts) {
        try {
          const runtime = await this.ensureRuntime(entry.slot);
          await runtime.controller.wipe();
          await runtime.controller.close();
          this.dropRuntime(entry.slot);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        this.publish();
        throw new AggregateError(failures, "Telegram multi-account wipe was incomplete");
      }
      await this.catalogVault?.wipe();
      this.catalog = { version: 1, revision: nextCatalogRevision(catalog), activeSlot: null, accounts: [] };
      this.publish();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operationTail.then(operation, operation);
    this.operationTail = task.then(() => undefined, () => undefined);
    return task;
  }

  private async initializeOnce(): Promise<void> {
    try {
      await this.ensureCatalog();
    } catch {
      this.info = null;
      this.setState(this.compose({
        available: false,
        configured: Boolean(this.options.config),
        busy: false,
        login: { status: "error", code: "TELEGRAM_ACCOUNT_CATALOG_INVALID", retryable: false, message: "Telegram account catalogue is unavailable" },
        reason: "vault_unavailable",
      }));
      return;
    }
    try {
      this.info = await this.options.bridge.info();
    } catch {
      this.info = null;
      this.setState(this.compose({
        available: false,
        configured: Boolean(this.options.config),
        busy: false,
        login: { status: "error", code: "TDLIB_INFO_FAILED", retryable: true, message: "Telegram runtime check failed" },
        reason: "runtime_unavailable",
      }));
      return;
    }
    if (!this.options.config || !this.info.configured) {
      this.publish(disconnected(false));
      return;
    }
    if (!this.info.available) {
      this.publish({
        available: false,
        configured: true,
        busy: false,
        login: { status: "error", code: "TDLIB_UNAVAILABLE", retryable: false, message: "Telegram runtime is unavailable" },
        reason: "runtime_unavailable",
        ...(this.info.version ? { runtimeVersion: this.info.version } : {}),
      });
      return;
    }
    const activeSlot = this.catalog?.activeSlot ?? null;
    if (activeSlot) {
      try {
        await this.activate(activeSlot);
      } catch {
        this.publish({
          available: true,
          configured: true,
          busy: false,
          login: { status: "error", code: "TELEGRAM_RESTORE_FAILED", retryable: true, message: "Telegram session could not be restored" },
          reason: "connection_failed",
          ...(this.info.version ? { runtimeVersion: this.info.version } : {}),
        });
      }
    } else {
      this.publish(disconnected(true));
    }
    await this.restoreBackgroundAccounts(activeSlot);
  }

  private async restoreBackgroundAccounts(activeSlot: string | null): Promise<void> {
    const catalog = this.requireCatalog();
    for (const entry of catalog.accounts) {
      if (this.suspended || this.disposed) return;
      if (entry.slot === activeSlot) continue;
      try {
        const runtime = await this.ensureRuntime(entry.slot);
        await runtime.controller.initialize();
        runtime.snapshot = runtime.controller.snapshot();
      } catch {
        this.options.onDiagnostic?.({ level: "warn", code: "telegram.accounts.background_restore_failed" });
      }
      this.publish();
    }
  }

  private async ensureCatalog(): Promise<void> {
    if (this.catalog && this.catalogVault) return;
    const scope = await this.scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
    const vault = await createNativeScopedConnectorVault(this.options.nativeVault, scope);
    try {
      const replicas = await Promise.all(CATALOG_KEYS.map((key) => vault.read(key)));
      const parsed = replicas.map(parseCatalog);
      const valid = parsed.filter((item): item is CatalogV1 => item !== null);
      let catalog: CatalogV1 | null = null;
      const anyReplica = replicas.some((item) => item !== null);
      if (valid.length > 0) {
        const newestRevision = Math.max(...valid.map((item) => item.revision));
        const newest = valid.filter((item) => item.revision === newestRevision);
        const canonical = new Set(newest.map(catalogCanonical));
        if (canonical.size !== 1) throw new Error("Telegram account catalogue replicas conflict");
        catalog = newest[0] ?? null;
      }
      if (!catalog && anyReplica) throw new Error("Telegram account catalogue is corrupt");
      if (!catalog) {
        catalog = {
          version: 1,
          revision: 1,
          activeSlot: TELEGRAM_LEGACY_ACCOUNT_SLOT,
          accounts: [{ slot: TELEGRAM_LEGACY_ACCOUNT_SLOT }],
        };
        await vault.write(CATALOG_A, encodeCatalog(catalog));
        await vault.write(CATALOG_B, encodeCatalog(catalog));
      } else {
        const authoritative = catalogCanonical(catalog);
        const repair = await Promise.allSettled(CATALOG_KEYS.map((key, index) =>
          parsed[index] && catalogCanonical(parsed[index]) === authoritative
            ? Promise.resolve()
            : vault.write(key, encodeCatalog(catalog as CatalogV1)),
        ));
        if (repair.some((result) => result.status === "rejected")) {
          this.options.onDiagnostic?.({ level: "warn", code: "telegram.accounts.catalog_repair_failed" });
        }
      }
      this.catalogVault = vault;
      this.catalog = catalog;
      this.publish();
    } catch (error) {
      await vault.dispose?.().catch(() => undefined);
      throw error;
    }
  }

  private async saveCatalog(next: CatalogV1): Promise<void> {
    const vault = this.catalogVault;
    if (!vault) throw new Error("Telegram account catalogue is unavailable");
    const key = next.revision % 2 === 0 ? CATALOG_A : CATALOG_B;
    await vault.write(key, encodeCatalog(next));
    this.catalog = next;
    this.publish();
    this.schedulePushReconcile();
  }

  private async activate(slot: string): Promise<void> {
    if (this.suspended) throw new Error("Telegram accounts are suspended");
    const runtime = await this.ensureRuntime(slot);
    await runtime.controller.initialize();
    runtime.snapshot = runtime.controller.snapshot();
    this.publish();
  }

  private async ensureRuntime(slot: string): Promise<AccountRuntime> {
    const existing = this.runtimes.get(slot);
    if (existing) return existing;
    const catalog = this.requireCatalog();
    if (!catalog.accounts.some((entry) => entry.slot === slot)) throw new Error("unknown Telegram account slot");
    if (this.runtimes.size >= TELEGRAM_MAX_LOCAL_ACCOUNTS) throw new Error("Telegram runtime limit reached");
    const scope = await this.scope(slot);
    const vault = await createNativeScopedConnectorVault(this.options.nativeVault, scope);
    try {
      const controller = createTelegramConnectionController({
        bridge: this.options.bridge,
        vault,
        platform: this.options.platform,
        config: this.options.config,
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      });
      const runtime: AccountRuntime = {
        vault,
        controller,
        snapshot: controller.snapshot(),
        detachState: () => {},
        detachEvents: () => {},
        eventGate: new ConnectorEventGate(4096),
        unreadByChat: new Map<string, number>(),
        unreadCount: 0,
        globalUnreadKnown: false,
        registeredPushToken: undefined,
        registeredPushOtherIds: null,
      };
      this.runtimes.set(slot, runtime);
      runtime.detachState = controller.subscribe((snapshot) => {
        runtime.snapshot = snapshot;
        this.publish();
        if (snapshot.login.status === "ready") {
          this.scheduleIdentity(slot, snapshot.login.account.accountId);
          this.schedulePushReconcile();
        } else {
          runtime.registeredPushToken = undefined;
          runtime.registeredPushOtherIds = null;
        }
      });
      runtime.detachEvents = controller.subscribeEvents((event) => this.handleRuntimeEvent(slot, runtime, event));
      return runtime;
    } catch (error) {
      this.runtimes.delete(slot);
      await vault.dispose?.().catch(() => undefined);
      throw error;
    }
  }

  private handleRuntimeEvent(slot: string, runtime: AccountRuntime, event: ConnectorEvent): void {
    const entry = this.catalog?.accounts.find((candidate) => candidate.slot === slot);
    if (!entry || this.runtimes.get(slot) !== runtime) return;
    if (entry.accountId && event.account.accountId !== entry.accountId) {
      this.options.onDiagnostic?.({ level: "error", code: "telegram.accounts.cross_slot_event_blocked" });
      return;
    }
    let verdict: ReturnType<ConnectorEventGate["accept"]>;
    try { verdict = runtime.eventGate.accept(event); } catch {
      this.options.onDiagnostic?.({ level: "warn", code: "telegram.accounts.invalid_event_blocked" });
      return;
    }
    if (verdict !== "apply") return;
    runtime.lastEventAt = event.occurredAt;
    this.applyUnreadEvent(runtime, event);
    this.publish();
    const scoped = { slot, event } as const;
    for (const listener of [...this.eventListeners]) {
      try { listener(scoped); } catch { /* connector event consumers are isolated */ }
    }
  }

  private applyUnreadEvent(runtime: AccountRuntime, event: ConnectorEvent): void {
    const total = unreadValue(event.payload.totalUnreadCount);
    if (total !== null) {
      runtime.globalUnreadKnown = true;
      runtime.unreadCount = total;
      return;
    }
    if (runtime.globalUnreadKnown) return;
    const chat = asRecord(event.payload.chat);
    const ref = asRecord(chat?.ref) ?? asRecord(event.payload.ref);
    const update = asRecord(event.payload.update);
    const chatId = typeof ref?.chatId === "string"
      ? ref.chatId
      : typeof event.payload.chatId === "string"
        ? event.payload.chatId
        : typeof update?.chat_id === "string"
          ? update.chat_id
          : null;
    const count = unreadValue(chat?.unreadCount) ?? unreadValue(update?.unread_count);
    if (!chatId || count === null) return;
    runtime.unreadByChat.set(chatId, count);
    runtime.unreadCount = Math.min(
      MAX_UNREAD_COUNT,
      [...runtime.unreadByChat.values()].reduce((sum, value) => sum + value, 0),
    );
  }

  private dropRuntime(slot: string): void {
    const runtime = this.runtimes.get(slot);
    if (!runtime) return;
    runtime.detachState();
    runtime.detachEvents();
    this.runtimes.delete(slot);
  }

  private scheduleIdentity(slot: string, accountId: string): void {
    if (!TELEGRAM_ACCOUNT_ID.test(accountId)) return;
    const key = `${slot}:${accountId}`;
    if (this.pendingIdentity.has(key)) return;
    this.pendingIdentity.add(key);
    void this.enqueue(async () => {
      try {
        const catalog = this.requireCatalog();
        const own = catalog.accounts.find((entry) => entry.slot === slot);
        if (!own || own.accountId === accountId) return;
        const duplicate = catalog.accounts.find((entry) => entry.slot !== slot && entry.accountId === accountId);
        if (duplicate) {
          // Duplicate login must never revoke the retained provider session. Crypto-erase only the redundant
          // local TDLib scope, then remove its protected catalogue entry and select the retained live runtime.
          const runtime = await this.ensureRuntime(slot);
          await runtime.controller.wipe();
          await runtime.controller.close();
          this.dropRuntime(slot);
          const next: CatalogV1 = {
            ...catalog,
            revision: nextCatalogRevision(catalog),
            activeSlot: duplicate.slot,
            accounts: catalog.accounts.filter((entry) => entry.slot !== slot),
          };
          await this.saveCatalog(next);
          await this.activate(duplicate.slot);
          return;
        }
        const next: CatalogV1 = {
          ...catalog,
          revision: nextCatalogRevision(catalog),
          accounts: catalog.accounts.map((entry) => entry.slot === slot ? { ...entry, accountId } : entry),
        };
        await this.saveCatalog(next);
      } finally {
        this.pendingIdentity.delete(key);
      }
    }).catch(() => { this.pendingIdentity.delete(key); });
  }

  private schedulePushReconcile(): void {
    if (this.disposed || this.suspended) return;
    void this.enqueue(() => this.reconcilePushRegistrations()).catch(() => {
      this.options.onDiagnostic?.({ level: "warn", code: "telegram.accounts.push_reconcile_failed" });
    });
  }

  private async reconcilePushRegistrations(): Promise<void> {
    if (this.disposed || this.suspended) return;
    const catalog = this.requireCatalog();
    const token = this.pushToken;
    if (token === undefined) return;
    const revision = this.pushRevision;
    for (const entry of catalog.accounts) {
      if (revision !== this.pushRevision || this.disposed || this.suspended) return;
      if (!entry.accountId) continue;
      const runtime = this.runtimes.get(entry.slot);
      if (!runtime || runtime.snapshot.login.status !== "ready") continue;
      const otherIds = token === null ? [] : catalog.accounts
        .map((candidate) => candidate.accountId)
        .filter((id): id is string => Boolean(id) && id !== entry.accountId);
      const otherIdsKey = otherIds.join(",");
      if (runtime.registeredPushToken === token && runtime.registeredPushOtherIds === otherIdsKey) continue;
      try {
        await runtime.controller.setPushToken(token, otherIds);
        if (this.runtimes.get(entry.slot) !== runtime || revision !== this.pushRevision) return;
        runtime.registeredPushToken = token;
        runtime.registeredPushOtherIds = otherIdsKey;
      } catch {
        this.options.onDiagnostic?.({ level: "warn", code: "telegram.accounts.push_registration_failed" });
      }
    }
  }

  private async activeController(): Promise<TelegramConnectionController> {
    await this.initialize();
    return this.enqueue(async () => {
      this.requireUsableRuntime();
      const slot = this.requireCatalog().activeSlot;
      if (!slot) throw new Error("No Telegram account is selected");
      const runtime = await this.ensureRuntime(slot);
      return runtime.controller;
    });
  }

  private requireUsableRuntime(): void {
    if (!this.options.config || !this.info?.configured) throw new Error("Telegram connector is not configured");
    if (!this.info.available) throw new Error("Telegram runtime is unavailable");
    if (this.suspended) throw new Error("Telegram accounts are suspended");
  }

  private requireCatalog(): CatalogV1 {
    if (!this.catalog) throw new Error("Telegram account catalogue is unavailable");
    return this.catalog;
  }

  private requireSlot(value: string): string {
    if (!validSlot(value)) throw new TypeError("invalid Telegram account slot");
    return value;
  }

  private scope(slot: string): Promise<string> {
    return deriveConnectorVaultScope({
      serverId: this.options.serverId,
      greenChatUserId: this.options.greenChatUserId,
      provider: "telegram",
      externalAccountId: slot,
    });
  }

  private publish(override?: TelegramConnectionSnapshot): void {
    this.setState(this.compose(override));
  }

  private syncState(slot: string, login: ConnectorLoginState): TelegramAccountSyncState {
    if (this.suspended || login.status === "suspended") return "paused";
    if (slot === this.catalog?.activeSlot) return "active";
    if (login.status === "ready") return "background";
    if (login.status === "starting") return "connecting";
    if (login.status === "error") return "error";
    return "disconnected";
  }

  private compose(override?: TelegramConnectionSnapshot): TelegramAccountsSnapshot {
    const catalog = this.catalog;
    const activeSlot = catalog?.activeSlot ?? null;
    const active = activeSlot ? this.runtimes.get(activeSlot)?.snapshot : null;
    const fallback = this.info?.available && this.info.configured && this.options.config
      ? disconnected(true)
      : disconnected(false, this.info && !this.info.available ? "runtime_unavailable" : undefined);
    const base = override ?? active ?? fallback;
    const accounts = (catalog?.accounts ?? []).map((entry): TelegramAccountSummary => {
      const runtime = this.runtimes.get(entry.slot);
      const login = runtime?.snapshot.login
        ?? (this.suspended ? { status: "suspended" as const } : { status: "revoked" as const, reason: "not_connected" });
      return {
        slot: entry.slot,
        ...(entry.accountId ? { accountId: entry.accountId } : {}),
        login,
        syncState: this.syncState(entry.slot, login),
        unreadCount: runtime?.unreadCount ?? 0,
        ...(runtime?.lastEventAt ? { lastEventAt: runtime.lastEventAt } : {}),
      };
    });
    const totalUnreadCount = Math.min(
      MAX_UNREAD_COUNT,
      accounts.reduce((sum, account) => sum + account.unreadCount, 0),
    );
    return {
      ...base,
      activeSlot,
      accounts,
      canAddAccount: Boolean(this.info?.available && this.info.configured && this.options.config)
        && accounts.length < TELEGRAM_MAX_LOCAL_ACCOUNTS,
      totalUnreadCount,
      backgroundReadyCount: accounts.filter((account) => account.syncState === "background").length,
    };
  }

  private setState(next: TelegramAccountsSnapshot): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch { /* UI listeners are isolated */ }
    }
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error("Telegram accounts controller is closed");
  }
}

export function createTelegramAccountsController(
  options: TelegramAccountsControllerOptions,
): TelegramAccountsController {
  return new AccountsController(options);
}

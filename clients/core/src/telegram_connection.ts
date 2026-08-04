// clients/core/src/telegram_connection.ts — local Telegram account lifecycle controller (T-452).
//
// It turns the low-level TDLib adapter into a small UI/lifecycle port: availability probe, persisted
// opt-in restore, QR/phone/code/2FA transitions, subscriptions, suspension and fail-closed account wipe.

import type {
  ConnectorEvent,
  ConnectorLoginState,
  ScopedConnectorVault,
} from "./connectors.ts";
import {
  createTelegramTdlibAdapter,
  TELEGRAM_CONNECTION_ENABLED_KEY,
  wipeTelegramTdlibLocal,
  type TelegramConnectorOptions,
  type TelegramTdlibBridge,
  type TelegramTdlibSessionPort,
} from "./telegram_tdlib.ts";


export type TelegramConnectionReason =
  | "not_configured"
  | "runtime_unavailable"
  | "vault_unavailable"
  | "connection_failed";

export interface TelegramConnectionSnapshot {
  available: boolean;
  configured: boolean;
  busy: boolean;
  login: ConnectorLoginState;
  reason?: TelegramConnectionReason;
  runtimeVersion?: string;
}

export interface TelegramConnectionController {
  snapshot(): TelegramConnectionSnapshot;
  subscribe(listener: (snapshot: TelegramConnectionSnapshot) => void): () => void;
  subscribeEvents(listener: (event: ConnectorEvent) => void): () => void;
  initialize(): Promise<void>;
  connectQr(): Promise<void>;
  connectPhone(phone: string): Promise<void>;
  submitCode(code: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  setPushToken(token: string | null, otherUserIds: readonly string[]): Promise<void>;
  retryPushRecovery(): void;
  disconnect(): Promise<void>;
  remove(): Promise<void>;
  suspend(): void;
  close(): Promise<void>;
  wipe(): Promise<void>;
}

export interface TelegramConnectionControllerOptions {
  bridge: TelegramTdlibBridge;
  vault: ScopedConnectorVault;
  platform: TelegramTdlibBridge["platform"];
  config: Omit<TelegramConnectorOptions, "bridge"> | null;
  now?: () => Date;
  onDiagnostic?: (event: { level: "debug" | "info" | "warn" | "error"; code: string }) => void;
}

async function vaultFlag(vault: ScopedConnectorVault): Promise<boolean> {
  const value = await vault.read(TELEGRAM_CONNECTION_ENABLED_KEY);
  return value !== null && new TextDecoder().decode(value) === "1";
}

async function setVaultFlag(vault: ScopedConnectorVault): Promise<void> {
  await vault.write(TELEGRAM_CONNECTION_ENABLED_KEY, new TextEncoder().encode("1"));
}

function disconnected(configured: boolean): TelegramConnectionSnapshot {
  return {
    available: configured,
    configured,
    busy: false,
    login: { status: "revoked", reason: "not_connected" },
    ...(configured ? {} : { reason: "not_configured" as const }),
  };
}

class Controller implements TelegramConnectionController {
  private readonly options: TelegramConnectionControllerOptions;
  private readonly listeners = new Set<(snapshot: TelegramConnectionSnapshot) => void>();
  private readonly eventListeners = new Set<(event: ConnectorEvent) => void>();
  private readonly retired = new Set<TelegramTdlibSessionPort>();
  private current: TelegramTdlibSessionPort | null = null;
  private detachCurrent: (() => void) | null = null;
  private state: TelegramConnectionSnapshot;
  private initTask: Promise<void> | null = null;
  private openTask: Promise<TelegramTdlibSessionPort> | null = null;
  private generation = 0;
  private suspended = false;
  private lifecycleBarrier: Promise<void> = Promise.resolve();

  constructor(options: TelegramConnectionControllerOptions) {
    this.options = options;
    // Native credential readiness is learned from bridge.info(); shared JS never receives application secret.
    this.state = disconnected(false);
  }

  snapshot(): TelegramConnectionSnapshot { return this.state; }

  subscribe(listener: (snapshot: TelegramConnectionSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  subscribeEvents(listener: (event: ConnectorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  initialize(): Promise<void> {
    // initialize() is the explicit unlock/resume edge. In-flight work still checks generation/suspended.
    this.suspended = false;
    if (this.initTask) return this.initTask;
    this.initTask = this.initializeOnce().finally(() => { this.initTask = null; });
    return this.initTask;
  }

  async connectQr(): Promise<void> {
    const session = await this.openOptedIn();
    this.setBusy(true);
    try {
      await session.submitAuth({ kind: "qr_refresh" });
      this.pullSession(session);
    } finally {
      this.setBusy(false);
    }
  }

  async connectPhone(phone: string): Promise<void> {
    const session = await this.openOptedIn();
    this.setBusy(true);
    try {
      await session.submitAuth({ kind: "phone", phone });
      this.pullSession(session);
    } finally {
      this.setBusy(false);
    }
  }

  async submitCode(code: string): Promise<void> {
    await this.submitCurrent({ kind: "code", code });
  }

  async submitPassword(password: string): Promise<void> {
    await this.submitCurrent({ kind: "password", password });
  }

  async setPushToken(token: string | null, otherUserIds: readonly string[]): Promise<void> {
    await this.initialize();
    const session = this.current;
    if (!session || session.loginState().status !== "ready") {
      throw new Error("Telegram connector is not ready for push registration");
    }
    await session.setPushToken(token, otherUserIds);
  }

  retryPushRecovery(): void {
    this.current?.retryPushRecovery();
  }

  async disconnect(): Promise<void> {
    // Disable automatic restore before revoking the external session. Keep encrypted local data until the
    // user separately confirms a destructive wipe; this makes disconnect and device-data deletion explicit.
    let vaultFailed = false;
    try { await this.options.vault.remove(TELEGRAM_CONNECTION_ENABLED_KEY); } catch { vaultFailed = true; }
    const sessions = await this.takeAllSessions();
    this.setState(disconnected(this.state.configured));
    const results = await Promise.allSettled(sessions.map(async (session) => {
      try {
        // Best-effort provider deregistration before logOut. A failed unregister must not keep the
        // external session alive; native wipe/remove still destroys its local receiver mapping.
        await session.setPushToken(null, []).catch(() => undefined);
        await session.revoke();
      } finally {
        await session.close();
      }
    }));
    if (vaultFailed || results.some((result) => result.status === "rejected")) {
      throw new Error("Telegram disconnect was incomplete");
    }
  }

  async remove(): Promise<void> {
    // User-confirmed destructive removal: revoke when possible, but always erase local TDLib data and keys.
    await this.options.vault.remove(TELEGRAM_CONNECTION_ENABLED_KEY).catch(() => undefined);
    const sessions = await this.takeAllSessions();
    this.setState(disconnected(this.state.configured));
    await Promise.allSettled(sessions.map(async (session) => {
      try { await session.revoke(); } finally { await session.wipeLocal(); }
    }));
    await wipeTelegramTdlibLocal(this.options.bridge, this.options.vault);
  }

  suspend(): void {
    this.suspended = true;
    this.generation += 1;
    const session = this.current;
    const opening = this.openTask;
    const previousBarrier = this.lifecycleBarrier;
    this.current = null;
    this.detachCurrent?.();
    this.detachCurrent = null;
    this.openTask = null;
    // A closed native runtime can never remain authoritative `ready`. Preserve only availability/configuration
    // metadata; initialize() is the sole edge that may restore a live session and publish `ready` again.
    this.setState({ ...this.state, busy: false, login: { status: "suspended" } });
    const closing: Promise<unknown>[] = [previousBarrier];
    if (session) {
      this.retired.add(session);
      closing.push(session.close().catch(() => {}).finally(() => { this.retired.delete(session); }));
    }
    if (opening) closing.push(opening.catch(() => undefined));
    this.lifecycleBarrier = Promise.allSettled(closing).then(() => undefined);
  }

  async close(): Promise<void> {
    const sessionsTask = this.takeAllSessions();
    // Explicit close is also a synchronous renderer-retention boundary. A QR token or provider account
    // must not remain observable through the outer controller while native shutdown acknowledgement waits.
    this.setState({ ...this.state, busy: false, login: { status: "suspended" } });
    const sessions = await sessionsTask;
    const results = await Promise.allSettled(sessions.map((session) => session.close()));
    let disposeFailure: unknown = null;
    try { await this.options.vault.dispose?.(); } catch (error) { disposeFailure = error; }
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (disposeFailure !== null) failures.push(disposeFailure);
    this.eventListeners.clear();
    if (failures.length > 0) throw new AggregateError(failures, "Telegram connector close was incomplete");
  }

  async wipe(): Promise<void> {
    const sessions = await this.takeAllSessions();
    await Promise.allSettled(sessions.map((session) => session.wipeLocal()));
    await wipeTelegramTdlibLocal(this.options.bridge, this.options.vault);
    this.setState(disconnected(this.state.configured));
  }

  private async initializeOnce(): Promise<void> {
    if (!this.options.config) {
      this.setState(disconnected(false));
      return;
    }
    this.setState({ ...this.state, busy: true, login: { status: "starting" } });
    let info;
    try {
      info = await this.options.bridge.info();
    } catch {
      this.setState({
        available: false, configured: true, busy: false,
        login: { status: "error", code: "TDLIB_INFO_FAILED", retryable: true, message: "Telegram runtime check failed" },
        reason: "runtime_unavailable",
      });
      return;
    }
    if (!info.configured) {
      this.setState({
        ...disconnected(false),
        available: info.available,
        ...(info.version ? { runtimeVersion: info.version } : {}),
      });
      return;
    }
    if (!info.available) {
      this.setState({
        available: false, configured: true, busy: false,
        login: { status: "error", code: "TDLIB_UNAVAILABLE", retryable: false, message: "Telegram runtime is unavailable" },
        reason: "runtime_unavailable",
        ...(info.version ? { runtimeVersion: info.version } : {}),
      });
      return;
    }
    let enabled = false;
    try {
      enabled = await vaultFlag(this.options.vault);
    } catch {
      this.setState({
        available: false, configured: true, busy: false,
        login: { status: "error", code: "CONNECTOR_VAULT_UNAVAILABLE", retryable: true, message: "Secure connector storage is unavailable" },
        reason: "vault_unavailable",
        ...(info.version ? { runtimeVersion: info.version } : {}),
      });
      return;
    }
    if (!enabled) {
      this.setState({
        ...disconnected(true),
        available: true,
        ...(info.version ? { runtimeVersion: info.version } : {}),
      });
      return;
    }
    try {
      const session = await this.ensureOpen();
      this.pullSession(session, info.version);
    } catch {
      this.setState({
        available: true, configured: true, busy: false,
        login: { status: "error", code: "TELEGRAM_RESTORE_FAILED", retryable: true, message: "Telegram session could not be restored" },
        reason: "connection_failed",
        ...(info.version ? { runtimeVersion: info.version } : {}),
      });
    }
  }

  private async openOptedIn(): Promise<TelegramTdlibSessionPort> {
    if (!this.options.config) throw new Error("Telegram connector is not configured");
    await this.initialize();
    if (this.suspended) throw new Error("Telegram connector is suspended");
    if (!this.state.configured) throw new Error("Telegram application credentials are not configured");
    if (!this.state.available) throw new Error("Telegram runtime is unavailable");
    await setVaultFlag(this.options.vault);
    if (this.suspended) throw new Error("Telegram connector is suspended");
    return this.ensureOpen();
  }

  private ensureOpen(): Promise<TelegramTdlibSessionPort> {
    if (this.suspended) return Promise.reject(new Error("Telegram connector is suspended"));
    if (this.current) return Promise.resolve(this.current);
    if (this.openTask) return this.openTask;
    const config = this.options.config;
    if (!config) return Promise.reject(new Error("Telegram connector is not configured"));
    const generation = ++this.generation;
    const barrier = this.lifecycleBarrier;
    this.setState({ ...this.state, available: true, configured: true, busy: true, login: { status: "starting" } });
    const adapter = createTelegramTdlibAdapter({ bridge: this.options.bridge, ...config });
    let task!: Promise<TelegramTdlibSessionPort>;
    task = (async () => {
      await barrier;
      if (this.suspended || generation !== this.generation) throw new Error("Telegram open superseded");
      const session = await adapter.open({
        platform: this.options.platform,
        vault: this.options.vault,
        ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.onDiagnostic ? { onDiagnostic: this.options.onDiagnostic } : {}),
      });
      if (this.suspended || generation !== this.generation) {
        await session.close().catch(() => {});
        throw new Error("Telegram open superseded");
      }
      this.current = session;
      this.detachCurrent = session.subscribe((event) => {
        if (session !== this.current) return;
        this.pullSession(session);
        for (const listener of [...this.eventListeners]) {
          try { listener(event); } catch { /* provider event consumers are isolated */ }
        }
      });
      this.pullSession(session);
      return session;
    })().finally(() => {
      if (this.openTask === task) this.openTask = null;
    });
    this.openTask = task;
    return task;
  }

  private async submitCurrent(input: { kind: "code"; code: string } | { kind: "password"; password: string }): Promise<void> {
    const session = this.current;
    if (!session) throw new Error("Telegram connector is not open");
    this.setBusy(true);
    try {
      await session.submitAuth(input);
      this.pullSession(session);
    } finally {
      this.setBusy(false);
    }
  }

  private pullSession(session: TelegramTdlibSessionPort, runtimeVersion = this.state.runtimeVersion): void {
    if (session !== this.current) return;
    this.setState({
      available: true,
      configured: true,
      busy: false,
      login: session.loginState(),
      ...(runtimeVersion ? { runtimeVersion } : {}),
    });
  }

  private setBusy(busy: boolean): void {
    this.setState({ ...this.state, busy });
  }

  private setState(next: TelegramConnectionSnapshot): void {
    this.state = next;
    for (const listener of [...this.listeners]) {
      try { listener(next); } catch { /* UI listeners are isolated */ }
    }
  }

  private async takeAllSessions(): Promise<TelegramTdlibSessionPort[]> {
    this.suspended = true;
    this.generation += 1;
    this.detachCurrent?.();
    this.detachCurrent = null;
    const sessions = [...this.retired];
    this.retired.clear();
    if (this.current) sessions.push(this.current);
    this.current = null;
    const opening = this.openTask;
    this.openTask = null;
    await Promise.allSettled([this.lifecycleBarrier, ...(opening ? [opening] : [])]);
    return [...new Set(sessions)];
  }
}

export function createTelegramConnectionController(
  options: TelegramConnectionControllerOptions,
): TelegramConnectionController {
  return new Controller(options);
}

import assert from "node:assert/strict";
import test from "node:test";

import { createTelegramConnectionController } from "../src/telegram_connection.ts";
import {
  TELEGRAM_CONNECTION_ENABLED_KEY,
  parseTdJsonLossless,
  stringifyTdJson,
  tdInt64,
} from "../src/telegram_tdlib.ts";
import type { ScopedConnectorVault } from "../src/connectors.ts";
import type {
  TelegramTdlibBridge,
  TelegramTdlibBridgeClient,
  TelegramTdlibBridgeInfo,
  TelegramTdlibBridgeOpenOptions,
} from "../src/telegram_tdlib.ts";

class MemoryVault implements ScopedConnectorVault {
  readonly data = new Map<string, Uint8Array>();
  wipes = 0;
  async read(name: string): Promise<Uint8Array | null> { return this.data.get(name)?.slice() ?? null; }
  async write(name: string, value: Uint8Array): Promise<void> { this.data.set(name, value.slice()); }
  async remove(name: string): Promise<void> { this.data.delete(name); }
  async wipe(): Promise<void> { this.wipes += 1; this.data.clear(); }
}


class FailingRemoveVault extends MemoryVault {
  failRemove = false;
  override async remove(name: string): Promise<void> {
    if (this.failRemove) throw new Error("secure storage unavailable");
    await super.remove(name);
  }
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

class LifecycleBridge implements TelegramTdlibBridge {
  readonly platform = "android" as const;
  readonly listeners = new Map<string, Set<(json: string) => void>>();
  readonly wipes: Array<string | undefined> = [];
  creates = 0;
  closes = 0;
  logOuts = 0;
  readonly pushTokens: string[] = [];
  readonly teardownOperations: string[] = [];
  failLogOut = false;
  failClose = false;
  ready = false;
  available = true;
  createGate: Promise<void> | null = null;
  closeGate: Promise<void> | null = null;

  configured = true;

  async info(): Promise<TelegramTdlibBridgeInfo> {
    return this.available
      ? { available: true, configured: this.configured, version: "1.8.66" }
      : { available: false, configured: this.configured, reason: "missing" };
  }

  async create(_options: TelegramTdlibBridgeOpenOptions): Promise<TelegramTdlibBridgeClient> {
    this.creates += 1;
    if (this.createGate) await this.createGate;
    return { clientId: `tdc.${String(this.creates).padStart(48, "0")}` };
  }

  async send(clientId: string, json: string): Promise<void> {
    const request = rec(parseTdJsonLossless(json));
    const extra = rec(request["@extra"]);
    const respond = (value: Record<string, unknown>): void => queueMicrotask(() => this.emit(clientId, stringifyTdJson({ ...value, "@extra": extra } as never)));
    const auth = (value: Record<string, unknown>): void => queueMicrotask(() => this.emit(clientId, stringifyTdJson({
      "@type": "updateAuthorizationState", authorization_state: value,
    } as never)));
    switch (String(request["@type"])) {
      case "getAuthorizationState":
        respond({ "@type": this.ready ? "authorizationStateReady" : "authorizationStateWaitTdlibParameters" });
        break;
      case "setTdlibParameters":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitPhoneNumber" });
        break;
      case "requestQrCodeAuthentication":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=abc" });
        break;
      case "setAuthenticationPhoneNumber":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitCode", code_info: { phone_number: "+49••42" } });
        break;
      case "checkAuthenticationCode":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitPassword", password_hint: "hint" });
        break;
      case "checkAuthenticationPassword":
        this.ready = true;
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateReady" });
        break;
      case "getMe":
        respond({ "@type": "user", id: tdInt64("9007199254740993") } as never);
        break;
      case "registerDevice": {
        const token = String(rec(request.device_token).token ?? "");
        this.pushTokens.push(token);
        this.teardownOperations.push(`push:${token.length === 0 ? "revoke" : "register"}`);
        respond({ "@type": "pushReceiverId", id: tdInt64("9007199254741999") } as never);
        break;
      }
      case "logOut":
        this.teardownOperations.push("logout");
        this.logOuts += 1;
        this.ready = false;
        if (this.failLogOut) throw new Error("provider logout failed");
        respond({ "@type": "ok" });
        break;
      default:
        respond({ "@type": "ok" });
    }
  }

  onMessage(clientId: string, listener: (responseJson: string) => void): () => void {
    const set = this.listeners.get(clientId) ?? new Set<(json: string) => void>();
    set.add(listener);
    this.listeners.set(clientId, set);
    return () => { set.delete(listener); };
  }

  async close(): Promise<void> {
    this.closes += 1;
    if (this.closeGate) await this.closeGate;
    if (this.failClose) throw new Error("native close failed");
  }
  async wipe(vaultCapability?: string): Promise<void> { this.wipes.push(vaultCapability); }

  emit(clientId: string, json: string): void {
    for (const listener of this.listeners.get(clientId) ?? []) listener(json);
  }
}

const config = {
  applicationVersion: "test",
  requestTimeoutMs: 1_000,
};

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition not reached");
}



test("controller drives phone/code/2FA to ready and preserves lossless Telegram account id", async () => {
  const bridge = new LifecycleBridge();
  const controller = createTelegramConnectionController({
    bridge, vault: new MemoryVault(), platform: "android", config,
    now: () => new Date("2026-07-17T12:00:00.000Z"),
  });
  await controller.initialize();
  assert.equal(controller.snapshot().login.status, "revoked");
  await controller.connectPhone("+491234567890");
  await waitFor(() => controller.snapshot().login.status === "awaiting_code");
  await controller.submitCode("12345");
  await waitFor(() => controller.snapshot().login.status === "awaiting_password");
  await controller.submitPassword("secret");
  await waitFor(() => controller.snapshot().login.status === "ready");
  const login = controller.snapshot().login;
  assert.equal(login.status, "ready");
  if (login.status === "ready") assert.equal(login.account.accountId, "9007199254740993");
  await controller.close();
});

test("current-session events are forwarded once and suspend synchronously detaches delivery", async () => {
  const bridge = new LifecycleBridge();
  bridge.ready = true;
  const vault = new MemoryVault();
  await vault.write(TELEGRAM_CONNECTION_ENABLED_KEY, new TextEncoder().encode("1"));
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  const events: Array<{ kind: string; total: unknown }> = [];
  controller.subscribeEvents((event) => events.push({
    kind: event.kind,
    total: event.payload.totalUnreadCount,
  }));

  await controller.initialize();
  await waitFor(() => controller.snapshot().login.status === "ready");
  const clientId = [...bridge.listeners.keys()][0];
  assert.ok(clientId);
  const update = stringifyTdJson({ "@type": "updateUnreadMessageCount", unread_count: 5 } as never);
  bridge.emit(clientId, update);
  await waitFor(() => events.length === 1);
  assert.deepEqual(events[0], { kind: "read.updated", total: 5 });

  controller.suspend();
  bridge.emit(clientId, stringifyTdJson({ "@type": "updateUnreadMessageCount", unread_count: 9 } as never));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(events.length, 1, "retired native sessions cannot deliver after the lock boundary");
  await controller.close();
});

test("disconnect revokes without erasing, while explicit wipe removes native files and connector vault", async () => {
  const bridge = new LifecycleBridge();
  const vault = new MemoryVault();
  const first = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await first.initialize();
  await first.connectQr();
  await waitFor(() => first.snapshot().login.status === "awaiting_qr");
  first.suspend();
  await waitFor(() => bridge.closes >= 1);

  bridge.ready = true;
  const restored = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await restored.initialize();
  await waitFor(() => restored.snapshot().login.status === "ready");
  await restored.setPushToken("fcm-token-before-disconnect", []);
  await restored.disconnect();
  assert.deepEqual(bridge.teardownOperations.slice(-2), ["push:revoke", "logout"],
    "provider push registration is revoked before the Telegram session is logged out");
  assert.equal(vault.wipes, 0, "disconnect keeps encrypted local data until separate confirmation");
  assert.equal(vault.data.has("telegram.connection.enabled.v1"), false, "automatic restore is disabled");
  assert.equal(vault.data.size, 0,
    "native TDLib directory/key metadata is intentionally absent from the renderer-visible vault");
  assert.equal(bridge.wipes.length, 0);
  assert.equal(restored.snapshot().login.status, "revoked");

  await restored.remove();
  assert.equal(vault.wipes >= 1, true);
  assert.equal(vault.data.size, 0);
  assert.equal(bridge.wipes.length >= 1, true);
});

test("runtime unavailability is fail-closed and never creates a TDLib client", async () => {
  const bridge = new LifecycleBridge();
  bridge.available = false;
  const controller = createTelegramConnectionController({ bridge, vault: new MemoryVault(), platform: "android", config });
  await controller.initialize();
  assert.equal(controller.snapshot().reason, "runtime_unavailable");
  assert.equal(controller.snapshot().available, false);
  assert.equal(bridge.creates, 0);
});


test("initialize is coalesced and suspend-unlock restore creates one replacement client", async () => {
  const bridge = new LifecycleBridge();
  const vault = new MemoryVault();
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await controller.connectQr();
  await waitFor(() => controller.snapshot().login.status === "awaiting_qr");
  assert.equal(bridge.creates, 1);

  let releaseClose!: () => void;
  bridge.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  controller.suspend();
  assert.equal(controller.snapshot().login.status, "suspended", "closed native runtime is never reported ready");
  await waitFor(() => bridge.closes >= 1);
  const restoring = Promise.all([controller.initialize(), controller.initialize(), controller.initialize()]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(bridge.creates, 1, "unlock waits until the previous TDLib client is fully closed");
  releaseClose();
  bridge.closeGate = null;
  await restoring;
  assert.equal(bridge.creates, 2, "one receive-loop client is restored after unlock");
  assert.equal(bridge.wipes.length, 0, "lock/unlock never erases provider data");
  await controller.close();
});

test("panic wipe is local, idempotent and does not wait for provider logout", async () => {
  const bridge = new LifecycleBridge();
  const vault = new MemoryVault();
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await controller.connectQr();
  await waitFor(() => controller.snapshot().login.status === "awaiting_qr");
  await controller.wipe();
  await controller.wipe();
  assert.equal(bridge.logOuts, 0, "duress/local wipe performs no external network-dependent logout");
  assert.equal(vault.data.size, 0);
  assert.equal(vault.wipes >= 2, true);
  assert.equal(bridge.wipes.length >= 1, true, "repeat wipe is a no-op after scope metadata is gone");
  assert.equal(controller.snapshot().login.status, "revoked");
});


test("panic wipe waits for a superseded in-flight open before deleting native storage", async () => {
  let releaseCreate!: () => void;
  const bridge = new LifecycleBridge();
  bridge.createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const vault = new MemoryVault();
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  const connecting = controller.connectQr();
  await waitFor(() => bridge.creates === 1);

  controller.suspend();
  const wiping = controller.wipe();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(bridge.wipes.length, 0, "storage is not deleted while adapter.open can still recreate files");

  releaseCreate();
  bridge.createGate = null;
  await assert.rejects(connecting, /superseded|suspended|closed/u);
  await wiping;
  assert.equal(bridge.closes >= 1, true);
  assert.equal(bridge.wipes.length >= 1, true);
  assert.equal(vault.data.size, 0);
});


test("disconnect reports incomplete secure-storage cleanup but still revokes and closes the provider session", async () => {
  const bridge = new LifecycleBridge();
  const vault = new FailingRemoveVault();
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await controller.connectQr();
  await waitFor(() => controller.snapshot().login.status === "awaiting_qr");
  vault.failRemove = true;

  await assert.rejects(controller.disconnect(), /disconnect was incomplete/u);
  assert.equal(bridge.logOuts, 1, "provider logout is attempted even when secure storage is unavailable");
  assert.equal(bridge.closes >= 1, true);
  assert.equal(controller.snapshot().login.status, "revoked");
});

test("explicit close reports native shutdown failure after scrubbing the renderer session", async () => {
  const bridge = new LifecycleBridge();
  const controller = createTelegramConnectionController({ bridge, vault: new MemoryVault(), platform: "android", config });
  await controller.connectQr();
  await waitFor(() => controller.snapshot().login.status === "awaiting_qr");
  bridge.failClose = true;

  await assert.rejects(controller.close(), /close was incomplete/u);
  assert.equal(bridge.closes, 1);
  assert.equal(controller.snapshot().login.status, "suspended",
    "outer controller scrubs QR/auth state before native shutdown acknowledgement");
});

test("disconnect closes the native client and reports provider logout failure", async () => {
  const bridge = new LifecycleBridge();
  const vault = new MemoryVault();
  const controller = createTelegramConnectionController({ bridge, vault, platform: "android", config });
  await controller.connectQr();
  await waitFor(() => controller.snapshot().login.status === "awaiting_qr");
  bridge.failLogOut = true;

  await assert.rejects(controller.disconnect(), /disconnect was incomplete/u);
  assert.equal(bridge.logOuts, 1);
  assert.equal(bridge.closes >= 1, true, "native TDLib closes even when provider logout fails");
  assert.equal(vault.data.has("telegram.connection.enabled.v1"), false);
});

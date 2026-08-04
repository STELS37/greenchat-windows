import assert from "node:assert/strict";
import test from "node:test";

import {
  TELEGRAM_ACCOUNT_CATALOG_SLOT,
  TELEGRAM_LEGACY_ACCOUNT_SLOT,
  createTelegramAccountsController,
} from "../src/telegram_accounts.ts";
import { deriveConnectorVaultScope, type NativeConnectorSecretVault } from "../src/connector_vault.ts";
import {
  TELEGRAM_CONNECTION_ENABLED_KEY,
  parseTdJsonLossless,
  stringifyTdJson,
  tdInt64,
} from "../src/telegram_tdlib.ts";
import type {
  TelegramTdlibBridge,
  TelegramTdlibBridgeClient,
  TelegramTdlibBridgeInfo,
  TelegramTdlibBridgeOpenOptions,
} from "../src/telegram_tdlib.ts";
import type { ConnectorEvent } from "../src/connectors.ts";

class NativeMemoryVault implements NativeConnectorSecretVault {
  readonly values = new Map<string, Map<string, string>>();
  readonly wiped: string[] = [];
  readonly failWriteNames = new Set<string>();
  private readonly scopeByLease = new Map<string, string>();
  private readonly leaseByScope = new Map<string, string>();
  private sequence = 0;

  async claim(scope: string): Promise<string> {
    if (this.leaseByScope.has(scope)) throw new Error("scope already claimed");
    const lease = `lease.${String(++this.sequence).padStart(48, "0")}`;
    this.scopeByLease.set(lease, scope);
    this.leaseByScope.set(scope, lease);
    return lease;
  }

  async read(lease: string, name: string): Promise<string | null> {
    return this.values.get(this.scopeFor(lease))?.get(name) ?? null;
  }

  async write(lease: string, name: string, valueBase64: string): Promise<void> {
    if (this.failWriteNames.has(name)) throw new Error("protected catalogue write failed");
    const scope = this.scopeFor(lease);
    const scoped = this.values.get(scope) ?? new Map<string, string>();
    scoped.set(name, valueBase64);
    this.values.set(scope, scoped);
  }

  async remove(lease: string, name: string): Promise<void> {
    this.values.get(this.scopeFor(lease))?.delete(name);
  }

  async wipe(lease: string): Promise<void> {
    const scope = this.scopeFor(lease);
    this.wiped.push(scope);
    this.values.delete(scope);
  }

  async release(lease: string): Promise<void> {
    const scope = this.scopeByLease.get(lease);
    if (!scope) return;
    this.scopeByLease.delete(lease);
    this.leaseByScope.delete(scope);
  }

  scopeFor(lease: string): string {
    const scope = this.scopeByLease.get(lease);
    if (!scope) throw new Error("invalid lease");
    return scope;
  }

  seed(scope: string, name: string, bytes: Uint8Array): void {
    const scoped = this.values.get(scope) ?? new Map<string, string>();
    scoped.set(name, Buffer.from(bytes).toString("base64"));
    this.values.set(scope, scoped);
  }

  decoded(scope: string, name: string): string | null {
    const value = this.values.get(scope)?.get(name);
    return value ? Buffer.from(value, "base64").toString("utf8") : null;
  }
}

interface ClientState {
  scope: string;
  ready: boolean;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

class MultiAccountBridge implements TelegramTdlibBridge {
  readonly platform = "android" as const;
  readonly clients = new Map<string, ClientState>();
  readonly listeners = new Map<string, Set<(json: string) => void>>();
  readonly accountByScope = new Map<string, string>();
  readonly createdScopes: string[] = [];
  readonly wipedScopes: string[] = [];
  readonly closedScopes: string[] = [];
  readonly failCloseScopes = new Set<string>();
  readonly failCreateScopes = new Set<string>();
  readonly loggedOutScopes: string[] = [];
  readonly pushRegistrations: Array<{ scope: string; request: Record<string, unknown> }> = [];
  nextAccountIds: string[] = [];
  private clientSequence = 0;
  private readonly vault: NativeMemoryVault;

  constructor(vault: NativeMemoryVault) { this.vault = vault; }

  async info(): Promise<TelegramTdlibBridgeInfo> {
    return { available: true, configured: true, version: "1.8.66" };
  }

  async create(options: TelegramTdlibBridgeOpenOptions): Promise<TelegramTdlibBridgeClient> {
    assert.ok(options.vaultCapability);
    const scope = this.vault.scopeFor(options.vaultCapability);
    if (this.failCreateScopes.has(scope)) throw new Error("native create failed");
    const clientId = `tdc.${String(++this.clientSequence).padStart(48, "0")}`;
    this.clients.set(clientId, { scope, ready: this.accountByScope.has(scope) });
    this.createdScopes.push(scope);
    return { clientId };
  }

  async send(clientId: string, json: string): Promise<void> {
    const client = this.clients.get(clientId);
    assert.ok(client);
    const request = record(parseTdJsonLossless(json));
    const extra = record(request["@extra"]);
    const respond = (value: Record<string, unknown>): void => queueMicrotask(() => this.emit(clientId, stringifyTdJson({
      ...value,
      "@extra": extra,
    } as never)));
    const auth = (value: Record<string, unknown>): void => queueMicrotask(() => this.emit(clientId, stringifyTdJson({
      "@type": "updateAuthorizationState",
      authorization_state: value,
    } as never)));

    switch (String(request["@type"])) {
      case "getAuthorizationState":
        respond({ "@type": client.ready ? "authorizationStateReady" : "authorizationStateWaitTdlibParameters" });
        break;
      case "setTdlibParameters":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitPhoneNumber" });
        break;
      case "requestQrCodeAuthentication":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=test-token" });
        break;
      case "setAuthenticationPhoneNumber":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitCode", code_info: { phone_number: "+49••42" } });
        break;
      case "checkAuthenticationCode":
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateWaitPassword", password_hint: "hint" });
        break;
      case "checkAuthenticationPassword": {
        const accountId = this.nextAccountIds.shift() ?? "9007199254740993";
        client.ready = true;
        this.accountByScope.set(client.scope, accountId);
        respond({ "@type": "ok" });
        auth({ "@type": "authorizationStateReady" });
        break;
      }
      case "getMe":
        respond({ "@type": "user", id: tdInt64(this.accountByScope.get(client.scope) ?? "9007199254740993") } as never);
        break;
      case "registerDevice":
        this.pushRegistrations.push({ scope: client.scope, request });
        respond({ "@type": "pushReceiverId", id: tdInt64("9007199254741999") } as never);
        break;
      case "logOut":
        this.loggedOutScopes.push(client.scope);
        client.ready = false;
        this.accountByScope.delete(client.scope);
        respond({ "@type": "ok" });
        break;
      default:
        respond({ "@type": "ok" });
    }
  }

  onMessage(clientId: string, listener: (responseJson: string) => void): () => void {
    const listeners = this.listeners.get(clientId) ?? new Set<(json: string) => void>();
    listeners.add(listener);
    this.listeners.set(clientId, listeners);
    return () => { listeners.delete(listener); };
  }

  async close(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (client) this.closedScopes.push(client.scope);
    if (client && this.failCloseScopes.has(client.scope)) throw new Error("native close failed");
    this.clients.delete(clientId);
    this.listeners.delete(clientId);
  }

  async wipe(vaultCapability?: string): Promise<void> {
    assert.ok(vaultCapability);
    const scope = this.vault.scopeFor(vaultCapability);
    this.wipedScopes.push(scope);
    this.accountByScope.delete(scope);
  }

  emitUpdateForScope(scope: string, update: Record<string, unknown>): void {
    for (const [clientId, client] of this.clients) {
      if (client.scope === scope) this.emit(clientId, stringifyTdJson(update as never));
    }
  }

  liveClientsForScope(scope: string): number {
    return [...this.clients.values()].filter((client) => client.scope === scope).length;
  }

  private emit(clientId: string, json: string): void {
    for (const listener of this.listeners.get(clientId) ?? []) listener(json);
  }
}

const identity = {
  serverId: "https://greenchat.example",
  greenChatUserId: 42,
  provider: "telegram",
} as const;
const config = { applicationVersion: "test", requestTimeoutMs: 1_000 };

async function scope(slot: string): Promise<string> {
  return deriveConnectorVaultScope({ ...identity, externalAccountId: slot });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition not reached");
}

function manager(vault: NativeMemoryVault, bridge: MultiAccountBridge, randomByte = 0x11) {
  return createTelegramAccountsController({
    bridge,
    nativeVault: vault,
    serverId: identity.serverId,
    greenChatUserId: identity.greenChatUserId,
    platform: "android",
    config,
    randomBytes: (length) => new Uint8Array(length).fill(randomByte),
  });
}

async function seedAuthorizedCatalog(
  vault: NativeMemoryVault,
  bridge: MultiAccountBridge,
  accounts: Array<{ slot: string; accountId: string }>,
  activeSlot: string,
): Promise<void> {
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const catalog = JSON.stringify({ version: 1, revision: 11, activeSlot, accounts });
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode(catalog));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode(catalog));
  for (const account of accounts) {
    const accountScope = await scope(account.slot);
    bridge.accountByScope.set(accountScope, account.accountId);
    vault.seed(accountScope, TELEGRAM_CONNECTION_ENABLED_KEY, new TextEncoder().encode("1"));
  }
}

test("T-453A bootstraps a dual-replica protected catalogue around the legacy primary slot", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  const snapshot = accounts.snapshot();
  assert.equal(snapshot.activeSlot, TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.deepEqual(snapshot.accounts.map((entry) => entry.slot), [TELEGRAM_LEGACY_ACCOUNT_SLOT]);
  assert.equal(snapshot.canAddAccount, true);
  assert.equal(bridge.createdScopes.length, 0, "disabled legacy session does not open TDLib");

  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const first = vault.decoded(catalogScope, "telegram.accounts.catalog.a.v1");
  const second = vault.decoded(catalogScope, "telegram.accounts.catalog.b.v1");
  assert.ok(first);
  assert.equal(first, second, "first boot writes two recoverable catalogue replicas");
  assert.equal(first.includes(identity.serverId), false, "raw server identity is absent from protected catalogue data");
  assert.equal(first.includes(String(identity.greenChatUserId)), false, "GreenChat user id is absent from catalogue data");
  await accounts.close();
});

test("T-453A assigns a random stable slot, persists provider identity and restores it after restart", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  bridge.nextAccountIds.push("9007199254740993");
  const first = manager(vault, bridge, 0x23);

  await first.initialize();
  const added = await first.addAccount();
  assert.equal(added, `slot.${"23".repeat(18)}`);
  assert.equal(first.snapshot().activeSlot, added);
  await first.connectPhone("+491234567890");
  await waitFor(() => first.snapshot().login.status === "awaiting_code");
  await first.submitCode("12345");
  await waitFor(() => first.snapshot().login.status === "awaiting_password");
  await first.submitPassword("secret");
  await waitFor(() => first.snapshot().accounts.some((entry) => entry.slot === added && entry.accountId === "9007199254740993"));
  assert.equal(first.snapshot().login.status, "ready");
  const accountScope = await scope(added);
  assert.ok(bridge.createdScopes.includes(accountScope));
  await first.close();

  const restored = manager(vault, bridge, 0x44);
  await restored.initialize();
  await waitFor(() => restored.snapshot().login.status === "ready");
  assert.equal(restored.snapshot().activeSlot, added);
  assert.equal(restored.snapshot().accounts.find((entry) => entry.slot === added)?.accountId, "9007199254740993");
  assert.ok(bridge.createdScopes.filter((value) => value === accountScope).length >= 2, "same protected slot is reopened after restart");

  await restored.selectAccount(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.equal(restored.snapshot().activeSlot, TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.equal(bridge.wipedScopes.includes(accountScope), false, "account switching closes but never wipes another slot");
  await restored.close();
});

test("T-453A heals a stale or corrupt replica from the newest unambiguous catalogue", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const authoritative = JSON.stringify({
    version: 1, revision: 7, activeSlot: TELEGRAM_LEGACY_ACCOUNT_SLOT,
    accounts: [{ slot: TELEGRAM_LEGACY_ACCOUNT_SLOT }],
  });
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode(authoritative));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode("corrupt"));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(accounts.snapshot().activeSlot, TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.equal(vault.decoded(catalogScope, "telegram.accounts.catalog.b.v1"), authoritative);
  await accounts.close();
});

test("T-453A equal-revision split-brain fails closed rather than choosing an arbitrary account list", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const other = `slot.${"c".repeat(36)}`;
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode(JSON.stringify({
    version: 1, revision: 9, activeSlot: TELEGRAM_LEGACY_ACCOUNT_SLOT,
    accounts: [{ slot: TELEGRAM_LEGACY_ACCOUNT_SLOT }],
  })));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode(JSON.stringify({
    version: 1, revision: 9, activeSlot: other,
    accounts: [{ slot: TELEGRAM_LEGACY_ACCOUNT_SLOT }, { slot: other }],
  })));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(accounts.snapshot().reason, "vault_unavailable");
  assert.equal(bridge.createdScopes.length, 0);
  await accounts.close();
});

test("T-453A enforces the eight-account limit before mutating the active runtime", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const slots = [TELEGRAM_LEGACY_ACCOUNT_SLOT, ...Array.from({ length: 7 }, (_, index) =>
    `slot.${(index + 1).toString(16).padStart(2, "0").repeat(18)}`)];
  const catalog = JSON.stringify({
    version: 1, revision: 8, activeSlot: TELEGRAM_LEGACY_ACCOUNT_SLOT,
    accounts: slots.map((slot) => ({ slot })),
  });
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode(catalog));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode(catalog));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(accounts.snapshot().canAddAccount, false);
  const closesBefore = bridge.closedScopes.length;
  await assert.rejects(accounts.addAccount(), /account limit reached/u);
  assert.equal(accounts.snapshot().accounts.length, 8);
  assert.equal(accounts.snapshot().activeSlot, TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.equal(bridge.closedScopes.length, closesBefore, "limit rejection does not retire the selected runtime");
  await accounts.close();
});

test("T-453A rejects exhausted catalogue revision before closing or persisting another slot", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  const catalog = JSON.stringify({
    version: 1, revision: Number.MAX_SAFE_INTEGER, activeSlot: TELEGRAM_LEGACY_ACCOUNT_SLOT,
    accounts: [{ slot: TELEGRAM_LEGACY_ACCOUNT_SLOT }],
  });
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode(catalog));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode(catalog));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  const closesBefore = bridge.closedScopes.length;
  await assert.rejects(accounts.addAccount(), /revision exhausted/u);
  assert.equal(accounts.snapshot().activeSlot, TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.equal(bridge.closedScopes.length, closesBefore);
  assert.equal(vault.decoded(catalogScope, "telegram.accounts.catalog.a.v1"), catalog);
  assert.equal(vault.decoded(catalogScope, "telegram.accounts.catalog.b.v1"), catalog);
  await accounts.close();
});

test("T-453A serializes concurrent account allocation and never loses a catalogue entry", async () => {
  let random = 0x41;
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const accounts = createTelegramAccountsController({
    bridge, nativeVault: vault, serverId: identity.serverId, greenChatUserId: identity.greenChatUserId,
    platform: "android", config, randomBytes: (length) => new Uint8Array(length).fill(random++),
  });
  await accounts.initialize();
  const [first, second] = await Promise.all([accounts.addAccount(), accounts.addAccount()]);
  assert.notEqual(first, second);
  assert.equal(accounts.snapshot().accounts.length, 3);
  assert.deepEqual(new Set(accounts.snapshot().accounts.map((entry) => entry.slot)).size, 3);
  assert.ok(accounts.snapshot().accounts.some((entry) => entry.slot === first));
  assert.ok(accounts.snapshot().accounts.some((entry) => entry.slot === second));
  await accounts.close();
});

test("T-453B selection reuses live runtimes and never depends on closing the previous account", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const second = `slot.${"52".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254740993" },
    { slot: second, accountId: "9007199254740994" },
  ], TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  const primaryScope = await scope(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const secondScope = await scope(second);
  assert.equal(bridge.liveClientsForScope(primaryScope), 1);
  assert.equal(bridge.liveClientsForScope(secondScope), 1);
  bridge.failCloseScopes.add(primaryScope);

  await accounts.selectAccount(second);
  assert.equal(accounts.snapshot().activeSlot, second);
  assert.equal(bridge.liveClientsForScope(primaryScope), 1, "previous selection remains a live background runtime");
  assert.equal(bridge.liveClientsForScope(secondScope), 1, "target runtime is reused rather than duplicated");
  assert.equal(bridge.closedScopes.length, 0, "account selection performs no native shutdown");
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === TELEGRAM_LEGACY_ACCOUNT_SLOT)?.syncState, "background");
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === second)?.syncState, "active");
  bridge.failCloseScopes.clear();
  await accounts.close();
});

test("T-453A restores the previous selection when protected catalogue persistence fails", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const accounts = manager(vault, bridge, 0x63);
  await accounts.initialize();
  const added = await accounts.addAccount(); // revision 2 writes replica A
  vault.failWriteNames.add("telegram.accounts.catalog.b.v1"); // selection back to primary would be revision 3

  await assert.rejects(accounts.selectAccount(TELEGRAM_LEGACY_ACCOUNT_SLOT), /catalogue write failed/u);
  assert.equal(accounts.snapshot().activeSlot, added);
  assert.ok(accounts.snapshot().accounts.some((entry) => entry.slot === added));
  vault.failWriteNames.clear();
  await accounts.close();
});

test("T-453A collapses duplicate provider login only after wiping the redundant random slot", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  bridge.nextAccountIds.push("9007199254740993", "9007199254740993");
  const accounts = manager(vault, bridge, 0x74);
  await accounts.initialize();
  const retained = await accounts.addAccount();
  await accounts.connectPhone("+491234567890");
  await waitFor(() => accounts.snapshot().login.status === "awaiting_code");
  await accounts.submitCode("11111");
  await waitFor(() => accounts.snapshot().login.status === "awaiting_password");
  await accounts.submitPassword("first");
  await waitFor(() => accounts.snapshot().accounts.some((entry) => entry.slot === retained && entry.accountId));

  await accounts.selectAccount(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  await accounts.connectPhone("+491234567891");
  await waitFor(() => accounts.snapshot().login.status === "awaiting_code");
  await accounts.submitCode("22222");
  await waitFor(() => accounts.snapshot().login.status === "awaiting_password");
  await accounts.submitPassword("second");
  await waitFor(() => accounts.snapshot().accounts.length === 1
    && accounts.snapshot().activeSlot === retained
    && accounts.snapshot().login.status === "ready");

  assert.deepEqual(accounts.snapshot().accounts.map((entry) => entry.slot), [retained]);
  assert.equal(accounts.snapshot().login.status, "ready");
  const redundantScope = await scope(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  assert.ok(bridge.wipedScopes.includes(redundantScope),
    "redundant TDLib storage is crypto-erased before its catalogue entry disappears");
  assert.equal(bridge.loggedOutScopes.includes(redundantScope), false,
    "duplicate collapse never revokes the retained provider account");
  await accounts.close();
});

test("T-453B restores all authorized slots serially and bounds live runtimes by the catalogue", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const second = `slot.${"81".repeat(18)}`;
  const third = `slot.${"82".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254741001" },
    { slot: second, accountId: "9007199254741002" },
    { slot: third, accountId: "9007199254741003" },
  ], second);
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(bridge.clients.size, 3);
  assert.equal(accounts.snapshot().backgroundReadyCount, 2);
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === second)?.syncState, "active");
  assert.deepEqual(
    accounts.snapshot().accounts.filter((entry) => entry.slot !== second).map((entry) => entry.syncState),
    ["background", "background"],
  );
  assert.equal(bridge.closedScopes.length, 0);
  await accounts.close();
});

test("T-453C reconciles one encrypted FCM registration per authorized slot without duplicate churn", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const second = `slot.${"87".repeat(18)}`;
  const third = `slot.${"88".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254741101" },
    { slot: second, accountId: "9007199254741102" },
    { slot: third, accountId: "9007199254741103" },
  ], TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(bridge.pushRegistrations.length, 0, "unknown native token never revokes an existing provider registration");
  await accounts.setPushToken("fcm-token-a");
  assert.equal(bridge.pushRegistrations.length, 3);
  for (const registration of bridge.pushRegistrations) {
    const token = record(registration.request.device_token);
    assert.equal(token["@type"], "deviceTokenFirebaseCloudMessaging");
    assert.equal(token.token, "fcm-token-a");
    assert.equal(token.encrypt, true);
    const own = bridge.accountByScope.get(registration.scope);
    assert.ok(own);
    assert.deepEqual(
      new Set(registration.request.other_user_ids as string[]),
      new Set(["9007199254741101", "9007199254741102", "9007199254741103"].filter((id) => id !== own)),
    );
  }

  await accounts.setPushToken("fcm-token-a");
  assert.equal(bridge.pushRegistrations.length, 3, "same token/catalogue fingerprint is not re-registered");
  await accounts.setPushToken("fcm-token-b");
  assert.equal(bridge.pushRegistrations.length, 6);
  await accounts.setPushToken(null);
  assert.equal(bridge.pushRegistrations.length, 9);
  assert.ok(bridge.pushRegistrations.slice(-3).every((entry) => record(entry.request.device_token).token === ""));

  assert.ok(bridge.pushRegistrations.slice(-3).every((entry) =>
    Array.isArray(entry.request.other_user_ids) && entry.request.other_user_ids.length === 0,
  ));
  await accounts.close();
});

test("T-453B inactive account events are deduplicated and update only metadata unread totals", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const second = `slot.${"83".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254741011" },
    { slot: second, accountId: "9007199254741012" },
  ], TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const accounts = manager(vault, bridge);
  const delivered: Array<{ slot: string; event: ConnectorEvent }> = [];
  accounts.subscribeEvents((item) => delivered.push(item));
  await accounts.initialize();
  const secondScope = await scope(second);
  const update = { "@type": "updateUnreadMessageCount", unread_count: 7 };

  bridge.emitUpdateForScope(secondScope, update);
  bridge.emitUpdateForScope(secondScope, update);
  await waitFor(() => accounts.snapshot().accounts.find((entry) => entry.slot === second)?.unreadCount === 7);
  assert.equal(delivered.length, 1, "same raw TDLib update is applied once despite a higher local sequence");
  assert.equal(accounts.snapshot().totalUnreadCount, 7);
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === second)?.syncState, "background");

  const canary = "message text canary T453B";
  bridge.emitUpdateForScope(secondScope, {
    "@type": "updateNewMessage",
    message: {
      "@type": "message", id: 101, chat_id: 42, date: 1_750_000_000,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: canary, entities: [] },
      },
    },
  });
  await waitFor(() => delivered.length === 2);
  assert.ok(JSON.stringify(delivered[1]?.event.payload).includes(canary),
    "provider event callback can consume the normalized message while the process is alive");
  assert.equal(JSON.stringify(accounts.snapshot()).includes(canary), false,
    "aggregate account snapshot retains metadata only, never message text");

  const internal = accounts as unknown as {
    runtimes: Map<string, unknown>;
    handleRuntimeEvent(slot: string, runtime: unknown, event: ConnectorEvent): void;
  };
  const runtime = internal.runtimes.get(second);
  assert.ok(runtime);
  internal.handleRuntimeEvent(second, runtime, {
    sequence: "999",
    dedupeKey: "cross-account-canary",
    account: { provider: "telegram", accountId: "9007199254741999" },
    kind: "read.updated",
    occurredAt: "2026-07-21T00:00:00.000Z",
    payload: { totalUnreadCount: 999 },
  });
  assert.equal(delivered.length, 2, "cross-account event is blocked before publication");
  assert.equal(accounts.snapshot().totalUnreadCount, 7, "cross-account event cannot mutate unread metadata");

  bridge.emitUpdateForScope(secondScope, { "@type": "updateUnreadMessageCount", unread_count: 3 });
  await waitFor(() => accounts.snapshot().totalUnreadCount === 3);
  assert.equal(delivered.length, 3);
  await accounts.close();
});

test("T-453B lock suspends every slot and one unlock restores exactly one client per account", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const second = `slot.${"84".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254741021" },
    { slot: second, accountId: "9007199254741022" },
  ], TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(bridge.clients.size, 2);
  accounts.suspend();
  assert.ok(accounts.snapshot().accounts.every((entry) => entry.syncState === "paused"));
  await waitFor(() => bridge.clients.size === 0);
  await Promise.all([accounts.initialize(), accounts.initialize()]);
  assert.equal(bridge.clients.size, 2);
  assert.equal(bridge.createdScopes.length, 4, "two initial clients plus one replacement per slot");
  for (const slot of [TELEGRAM_LEGACY_ACCOUNT_SLOT, second]) {
    assert.equal(bridge.liveClientsForScope(await scope(slot)), 1);
  }
  await accounts.close();
});

test("T-453B a failed background slot never poisons the active or another background account", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const failed = `slot.${"85".repeat(18)}`;
  const healthy = `slot.${"86".repeat(18)}`;
  await seedAuthorizedCatalog(vault, bridge, [
    { slot: TELEGRAM_LEGACY_ACCOUNT_SLOT, accountId: "9007199254741031" },
    { slot: failed, accountId: "9007199254741032" },
    { slot: healthy, accountId: "9007199254741033" },
  ], TELEGRAM_LEGACY_ACCOUNT_SLOT);
  bridge.failCreateScopes.add(await scope(failed));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(accounts.snapshot().login.status, "ready");
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === healthy)?.syncState, "background");
  assert.equal(accounts.snapshot().accounts.find((entry) => entry.slot === failed)?.syncState, "error");
  assert.equal(accounts.snapshot().backgroundReadyCount, 1);
  assert.equal(bridge.liveClientsForScope(await scope(TELEGRAM_LEGACY_ACCOUNT_SLOT)), 1);
  assert.equal(bridge.liveClientsForScope(await scope(healthy)), 1);
  await accounts.close();
});

test("T-453A corruption of both protected catalogue replicas fails closed before TDLib opens", async () => {
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  vault.seed(catalogScope, "telegram.accounts.catalog.a.v1", new TextEncoder().encode("not-json"));
  vault.seed(catalogScope, "telegram.accounts.catalog.b.v1", new TextEncoder().encode('{"version":1,"revision":0}'));
  const accounts = manager(vault, bridge);

  await accounts.initialize();
  assert.equal(accounts.snapshot().reason, "vault_unavailable");
  assert.equal(accounts.snapshot().login.status, "error");
  assert.equal(bridge.createdScopes.length, 0);
  await accounts.close();
});

test("T-453A panic wipe enumerates every slot before erasing the protected catalogue", async () => {
  let random = 0x31;
  const vault = new NativeMemoryVault();
  const bridge = new MultiAccountBridge(vault);
  const accounts = createTelegramAccountsController({
    bridge,
    nativeVault: vault,
    serverId: identity.serverId,
    greenChatUserId: identity.greenChatUserId,
    platform: "android",
    config,
    randomBytes: (length) => new Uint8Array(length).fill(random++),
  });

  await accounts.initialize();
  const second = await accounts.addAccount();
  await accounts.selectAccount(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const third = await accounts.addAccount();
  assert.notEqual(second, third);
  await accounts.wipe();

  const primaryScope = await scope(TELEGRAM_LEGACY_ACCOUNT_SLOT);
  const secondScope = await scope(second);
  const thirdScope = await scope(third);
  const catalogScope = await scope(TELEGRAM_ACCOUNT_CATALOG_SLOT);
  for (const expected of [primaryScope, secondScope, thirdScope]) {
    assert.ok(bridge.wipedScopes.includes(expected), `native TDLib storage wiped for ${expected}`);
    assert.ok(vault.wiped.includes(expected), `account vault wiped for ${expected}`);
  }
  assert.ok(vault.wiped.includes(catalogScope), "catalogue is erased only after all account scopes succeed");
  assert.equal(accounts.snapshot().accounts.length, 0);
  assert.equal(accounts.snapshot().activeSlot, null);
  await accounts.close();
});

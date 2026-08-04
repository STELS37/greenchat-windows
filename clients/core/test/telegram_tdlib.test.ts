import assert from "node:assert/strict";
import test from "node:test";

import {
  createTelegramTdlibAdapter,
  parseTdJsonLossless,
  TELEGRAM_CONNECTION_ENABLED_KEY,
  wipeTelegramTdlibLocal,
  stringifyTdJson,
  tdInt64,
  type TelegramTdlibBridge,
  type TelegramTdlibBridgeClient,
  type TelegramTdlibBridgeInfo,
  type TelegramTdlibBridgeOpenOptions,
} from "../src/telegram_tdlib.ts";
import type {
  ConnectorEvent,
  ConnectorOpenContext,
  ScopedConnectorVault,
} from "../src/connectors.ts";

class MemoryVault implements ScopedConnectorVault {
  readonly values = new Map<string, Uint8Array>();
  wipes = 0;

  async read(name: string): Promise<Uint8Array | null> {
    return this.values.get(name)?.slice() ?? null;
  }

  async write(name: string, value: Uint8Array): Promise<void> {
    this.values.set(name, value.slice());
  }

  async remove(name: string): Promise<void> {
    this.values.delete(name);
  }

  async wipe(): Promise<void> {
    this.wipes += 1;
    this.values.clear();
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as JsonRecord;
}

function typeOf(value: unknown): string {
  return String(record(value)["@type"] ?? "");
}

class FakeTdlibBridge implements TelegramTdlibBridge {
  readonly platform = "android" as const;
  readonly sent: string[] = [];
  readonly creates: TelegramTdlibBridgeOpenOptions[] = [];
  readonly closes: string[] = [];
  readonly wipes: Array<string | undefined> = [];
  readonly drains: string[] = [];
  sendMessageCalls = 0;
  available = true;
  failWipe = false;
  closeGate: Promise<void> | null = null;
  drainGate: Promise<void> | null = null;
  private listeners = new Map<string, Set<(json: string) => void>>();
  private sequence = 0;

  async info(): Promise<TelegramTdlibBridgeInfo> {
    return this.available
      ? { available: true, configured: true, version: "1.8.66" }
      : { available: false, configured: true, reason: "missing_tdjson" };
  }

  async create(options: TelegramTdlibBridgeOpenOptions): Promise<TelegramTdlibBridgeClient> {
    this.creates.push(options);
    this.sequence += 1;
    return { clientId: `tdc.${String(this.sequence).padStart(48, "0")}` };
  }

  async drainPushes(clientId: string): Promise<{ processed: number; pending: number }> {
    this.drains.push(clientId);
    if (this.drainGate) await this.drainGate;
    return { processed: 0, pending: 0 };
  }

  async send(clientId: string, requestJson: string): Promise<void> {
    this.sent.push(requestJson);
    const request = record(parseTdJsonLossless(requestJson));
    const extra = record(request["@extra"]);
    const reply = (body: JsonRecord): void => {
      queueMicrotask(() => this.emit(clientId, stringifyTdJson({
        ...body,
        "@extra": extra,
      } as never)));
    };
    const updateAuth = (state: JsonRecord): void => {
      queueMicrotask(() => this.emit(clientId, stringifyTdJson({
        "@type": "updateAuthorizationState",
        authorization_state: state,
      } as never)));
    };

    switch (typeOf(request)) {
      case "getAuthorizationState":
        reply({ "@type": "authorizationStateWaitTdlibParameters" });
        break;
      case "setTdlibParameters":
        reply({ "@type": "ok" });
        updateAuth({ "@type": "authorizationStateWaitPhoneNumber" });
        break;
      case "requestQrCodeAuthentication":
        reply({ "@type": "ok" });
        updateAuth({ "@type": "authorizationStateWaitOtherDeviceConfirmation", link: "tg://login?token=abc" });
        break;
      case "setAuthenticationPhoneNumber":
        reply({ "@type": "ok" });
        updateAuth({
          "@type": "authorizationStateWaitCode",
          code_info: { "@type": "authenticationCodeInfo", phone_number: "+49•••42" },
        });
        break;
      case "checkAuthenticationCode":
        reply({ "@type": "ok" });
        updateAuth({ "@type": "authorizationStateWaitPassword", password_hint: "hint" });
        break;
      case "checkAuthenticationPassword":
        reply({ "@type": "ok" });
        updateAuth({ "@type": "authorizationStateReady" });
        break;
      case "getMe":
        reply({ "@type": "user", id: tdInt64("9007199254740993"), first_name: "Alice" } as never);
        break;
      case "registerDevice":
        reply({ "@type": "pushReceiverId", id: tdInt64("9007199254741999") } as never);
        break;
      case "sendMessage":
        this.sendMessageCalls += 1;
        reply({
          "@type": "message",
          id: tdInt64("9007199254740995"),
          chat_id: request.chat_id,
          date: 1_700_000_000,
          content: request.input_message_content,
        } as never);
        break;
      case "getChats":
        reply({ "@type": "chats", total_count: 1, chat_ids: [tdInt64("-1009007199254740")] } as never);
        break;
      case "getChatHistory":
        reply({
          "@type": "messages",
          total_count: 1,
          messages: [{
            "@type": "message",
            id: tdInt64("9007199254740994"),
            chat_id: request.chat_id,
            date: 1_700_000_000,
            content: { "@type": "messageText", text: { "@type": "formattedText", text: "history", entities: [] } },
          }],
        } as never);
        break;
      default:
        reply({ "@type": "ok" });
    }
  }

  onMessage(clientId: string, listener: (responseJson: string) => void): () => void {
    let set = this.listeners.get(clientId);
    if (!set) {
      set = new Set();
      this.listeners.set(clientId, set);
    }
    set.add(listener);
    return () => { set?.delete(listener); };
  }

  async close(clientId: string): Promise<void> {
    this.closes.push(clientId);
    if (this.closeGate) await this.closeGate;
    this.listeners.delete(clientId);
  }

  async wipe(vaultCapability?: string): Promise<void> {
    this.wipes.push(vaultCapability);
    if (this.failWipe) throw new Error("native wipe failed");
  }

  emit(clientId: string, json: string): void {
    for (const listener of this.listeners.get(clientId) ?? []) listener(json);
  }
}

function context(vault: ScopedConnectorVault): ConnectorOpenContext {
  return {
    platform: "android",
    vault,
    now: () => new Date("2026-07-17T12:00:00.000Z"),
  };
}

function adapter(bridge: FakeTdlibBridge) {
  return createTelegramTdlibAdapter({
    bridge,
    applicationVersion: "1.0.0-test",
    requestTimeoutMs: 1_000,
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  assert.fail("condition was not reached");
}

async function authorize(bridge: FakeTdlibBridge, vault = new MemoryVault()) {
  const session = await adapter(bridge).open(context(vault));
  await waitFor(() => session.loginState().status === "awaiting_phone");
  await session.submitAuth({ kind: "phone", phone: "+491234567890" });
  await waitFor(() => session.loginState().status === "awaiting_code");
  await session.submitAuth({ kind: "code", code: "12345" });
  await waitFor(() => session.loginState().status === "awaiting_password");
  await session.submitAuth({ kind: "password", password: "correct horse battery staple" });
  await waitFor(() => session.loginState().status === "ready");
  return { session, vault };
}

test("TDLib integer wrapper rejects unsafe JavaScript numbers and accepts lossless string or bigint ids", () => {
  assert.throws(() => tdInt64(Number.MAX_SAFE_INTEGER + 1), /safe integer/u);
  assert.equal(tdInt64("9007199254740993").value, "9007199254740993");
  assert.equal(tdInt64(9007199254740993n).value, "9007199254740993");
  assert.equal(tdInt64(-42).value, "-42");
});

test("lossless TDLib JSON preserves int53 identifiers and emits wrapped IDs as raw numbers", () => {
  const encoded = stringifyTdJson({
    "@type": "getMessage",
    chat_id: tdInt64("-1009007199254740993"),
    message_id: tdInt64("9007199254740995"),
    limit: 100,
  });
  assert.match(encoded, /"chat_id":-1009007199254740993/u);
  assert.match(encoded, /"message_id":9007199254740995/u);
  assert.doesNotMatch(encoded, /"9007199254740995"/u);
  assert.deepEqual(parseTdJsonLossless(encoded), {
    "@type": "getMessage",
    chat_id: "-1009007199254740993",
    message_id: "9007199254740995",
    limit: "100",
  });
});

test("TDLib adapter initializes encrypted private storage and supports QR, phone, code and 2FA", async () => {
  const bridge = new FakeTdlibBridge();
  const vault = new MemoryVault();
  const session = await adapter(bridge).open(context(vault));
  await waitFor(() => session.loginState().status === "awaiting_phone");

  assert.equal(bridge.creates.length, 1);
  assert.deepEqual(bridge.creates[0], { logVerbosity: 2 });
  assert.equal(Object.hasOwn(bridge.creates[0] ?? {}, "storageScope"), false,
    "renderer JavaScript never receives or selects the native TDLib directory scope");
  const params = bridge.sent.map((raw) => record(parseTdJsonLossless(raw))).find((value) => typeOf(value) === "setTdlibParameters");
  assert.ok(params);
  assert.equal(params.database_directory, undefined, "private TDLib paths are injected only by the native shell");
  assert.equal(params.files_directory, undefined, "private TDLib paths never enter shared JavaScript");
  assert.equal(params.database_encryption_key, undefined, "database key never enters shared JavaScript");

  assert.equal(params.api_id, undefined, "api_id is injected only by the native shell");
  assert.equal(params.api_hash, undefined, "api_hash never enters shared JavaScript");

  await session.submitAuth({ kind: "qr_refresh" });
  await waitFor(() => session.loginState().status === "awaiting_qr");
  assert.deepEqual(session.loginState(), {
    status: "awaiting_qr",
    qrPayload: "tg://login?token=abc",
    expiresAt: "2026-07-17T12:01:00.000Z",
  });

  await session.submitAuth({ kind: "phone", phone: "+491234567890" });
  await waitFor(() => session.loginState().status === "awaiting_code");
  await session.submitAuth({ kind: "code", code: "12345" });
  await waitFor(() => session.loginState().status === "awaiting_password");
  await session.submitAuth({ kind: "password", password: "secret" });
  await waitFor(() => session.loginState().status === "ready");
  assert.deepEqual(session.account(), { provider: "telegram", accountId: "9007199254740993" });
  await session.close();
});

test("T-453C registers encrypted FCM with lossless companion ids and revokes with an empty token", async () => {
  const bridge = new FakeTdlibBridge();
  const { session } = await authorize(bridge);
  assert.equal(bridge.drains.length, 1, "native queued payloads are drained after the protected session opens");

  await new Promise<void>((resolve) => setImmediate(resolve));
  let releaseDrain!: () => void;
  bridge.drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  session.retryPushRecovery();
  session.retryPushRecovery();
  await waitFor(() => bridge.drains.length === 2);
  assert.equal(bridge.drains.length, 2, "overlapping foreground recovery signals share one native drain");
  releaseDrain();
  await new Promise<void>((resolve) => setImmediate(resolve));
  bridge.drainGate = null;
  session.retryPushRecovery();
  await waitFor(() => bridge.drains.length === 3);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const clientId = `tdc.${String(1).padStart(48, "0")}`;
  bridge.emit(clientId, stringifyTdJson({
    "@type": "updateConnectionState",
    state: { "@type": "connectionStateReady" },
  }));
  await waitFor(() => bridge.drains.length === 4);

  await session.setPushToken("fcm-token-123", [
    "9007199254740993",
    "9007199254741001",
    "9007199254741001",
    "9007199254741002",
  ]);
  const registrations = bridge.sent
    .map((raw) => record(parseTdJsonLossless(raw)))
    .filter((value) => typeOf(value) === "registerDevice");
  const registered = registrations.at(-1);
  assert.ok(registered);
  assert.deepEqual(registered.device_token, {
    "@type": "deviceTokenFirebaseCloudMessaging",
    token: "fcm-token-123",
    encrypt: true,
  });
  assert.deepEqual(registered.other_user_ids, ["9007199254741001", "9007199254741002"]);

  await session.setPushToken(null, []);
  const revoked = bridge.sent
    .map((raw) => record(parseTdJsonLossless(raw)))
    .filter((value) => typeOf(value) === "registerDevice")
    .at(-1);
  assert.deepEqual(revoked?.device_token, {
    "@type": "deviceTokenFirebaseCloudMessaging",
    token: "",
    encrypt: true,
  });
  assert.deepEqual(revoked?.other_user_ids, []);
  await assert.rejects(session.setPushToken("bad\ntoken", []), /invalid Telegram FCM token/u);

  await assert.rejects(session.setPushToken("bad token", []), /invalid Telegram FCM token/u);
  await assert.rejects(
    session.setPushToken(null, ["9007199254741001"]),
    /revoke cannot include companion accounts/u,
  );
  await session.close();
});

test("TDLib live updates normalize chats/messages and keep ordered resumable connector events", async () => {
  const bridge = new FakeTdlibBridge();
  const { session } = await authorize(bridge);
  const received: ConnectorEvent[] = [];
  const detach = session.subscribe((event) => received.push(event));
  const clientId = bridge.creates.length === 1 ? `tdc.${String(1).padStart(48, "0")}` : "";

  bridge.emit(clientId, stringifyTdJson({
    "@type": "updateNewChat",
    chat: {
      "@type": "chat",
      id: tdInt64("-1009007199254740993"),
      title: "Project",
      type: { "@type": "chatTypeSupergroup", supergroup_id: tdInt64("9007199254740100"), is_channel: false },
      unread_count: 7,
      last_message: null,
    },
  }));
  bridge.emit(clientId, stringifyTdJson({
    "@type": "updateNewMessage",
    message: {
      "@type": "message",
      id: tdInt64("9007199254740994"),
      chat_id: tdInt64("-1009007199254740993"),
      date: 1_700_000_000,
      sender_id: { "@type": "messageSenderUser", user_id: tdInt64("9007199254740993") },
      content: { "@type": "messageText", text: { "@type": "formattedText", text: "hello", entities: [] } },
    },
  }));

  await waitFor(() => received.length === 2);
  assert.equal(received[0]?.kind, "chat.upserted");
  assert.equal(record(record(received[0]?.payload).chat).ref && record(record(record(received[0]?.payload).chat).ref).chatId, "-1009007199254740993");
  assert.equal(received[1]?.kind, "message.upserted");
  assert.equal(record(record(received[1]?.payload).message).text, "hello");

  const first = await session.sync({ limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.hasMore, true);
  const second = await session.sync({ cursor: first.cursor, limit: 10 });
  assert.equal(second.events.length >= 1, true);
  assert.equal(second.hasMore, false);
  detach();
  await session.close();
});

test("TDLib commands preserve large IDs, return provider refs and deduplicate mutating retries", async () => {
  const bridge = new FakeTdlibBridge();
  const { session } = await authorize(bridge);
  const account = session.account();
  assert.ok(account);
  const command = {
    operation: "message.send" as const,
    account,
    chat: { ...account, chatId: "-1009007199254740993" },
    idempotencyKey: "send-1",
    payload: { text: "hello" },
  };
  const first = await session.execute(command);
  const second = await session.execute(command);
  assert.equal(bridge.sendMessageCalls, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(first.providerRef, {
    provider: "telegram",
    accountId: "9007199254740993",
    chatId: "-1009007199254740993",
    messageId: "9007199254740995",
  });
  const raw = bridge.sent.find((value) => typeOf(parseTdJsonLossless(value)) === "sendMessage") ?? "";
  assert.match(raw, /"chat_id":-1009007199254740993/u);
  await session.close();
});

test("TDLib file.send rejects renderer-controlled local paths before native send", async () => {
  const bridge = new FakeTdlibBridge();
  const vault = new MemoryVault();
  const { session } = await authorize(bridge, vault);
  const account = session.account();
  assert.ok(account);
  const before = bridge.sendMessageCalls;
  await assert.rejects(
    session.execute({
      operation: "file.send",
      account,
      chat: { ...account, chatId: "-100123" },
      idempotencyKey: "local-path-denied-1",
      payload: {
        inputMessageContent: {
          "@type": "inputMessageDocument",
          document: { "@type": "inputFileLocal", path: "/etc/passwd" },
          caption: { "@type": "formattedText", text: "", entities: [] },
        },
      },
    }),
    /trusted native picker capability/u,
  );
  assert.equal(bridge.sendMessageCalls, before, "unsafe content never reaches the native bridge");

  await assert.rejects(
    session.execute({
      operation: "file.send",
      account,
      chat: { ...account, chatId: "-100123" },
      idempotencyKey: "generated-path-denied-1",
      payload: {
        inputMessageContent: {
          "@type": "inputMessageDocument",
          document: { "@type": "inputFileGenerated", original_path: "/private/data", conversion: "copy" },
        },
      },
    }),
    /trusted native picker capability/u,
  );
  assert.equal(bridge.sendMessageCalls, before);
  await session.close();
});

test("TDLib history maps messages and wipe removes native files plus connector vault", async () => {
  const bridge = new FakeTdlibBridge();
  const { session, vault } = await authorize(bridge);
  const account = session.account();
  assert.ok(account);
  const result = await session.execute({
    operation: "history.sync",
    account,
    chat: { ...account, chatId: "-1009007199254740993" },
    payload: { limit: 50 },
  });
  const messages = record(result.payload).messages;
  assert.ok(Array.isArray(messages));
  assert.equal(record(messages[0]).text, "history");

  await session.wipeLocal();
  assert.equal(bridge.wipes.length, 1);
  assert.equal(vault.wipes, 1);
  assert.equal(vault.values.size, 0);
});

test("TDLib adapter fails closed when the official native runtime is absent", async () => {
  const bridge = new FakeTdlibBridge();
  bridge.available = false;
  await assert.rejects(
    adapter(bridge).open(context(new MemoryVault())),
    /TDLib is unavailable: missing_tdjson/u,
  );
});


test("failed native wipe preserves native metadata for retry and disables automatic restore", async () => {
  const bridge = new FakeTdlibBridge();
  const vault = new MemoryVault();
  await vault.write(TELEGRAM_CONNECTION_ENABLED_KEY, new TextEncoder().encode("1"));

  bridge.failWipe = true;
  await assert.rejects(wipeTelegramTdlibLocal(bridge, vault), /native wipe failed/u);
  assert.equal(vault.values.has(TELEGRAM_CONNECTION_ENABLED_KEY), false);
  assert.equal(vault.wipes, 0, "generic vault remains available while native cleanup needs retry");
  assert.equal(bridge.wipes.length, 1);
  assert.equal(bridge.wipes[0], undefined, "plain memory vault exposes no native capability");

  bridge.failWipe = false;
  await wipeTelegramTdlibLocal(bridge, vault);
  assert.equal(bridge.wipes.length, 2);
  assert.equal(vault.values.size, 0);
  assert.equal(vault.wipes, 1);
});

test("shared adapter never reads, writes or forwards the native TDLib storage binding", async () => {
  const bridge = new FakeTdlibBridge();
  const vault = new MemoryVault();
  const rendererVisibleSentinel = "telegram.tdlib.storage-scope.v1";
  await vault.write(rendererVisibleSentinel, new TextEncoder().encode("../wallet"));

  const session = await adapter(bridge).open(context(vault));
  await waitFor(() => session.loginState().status === "awaiting_phone");
  assert.deepEqual(bridge.creates[0], { logVerbosity: 2 });
  assert.equal(Object.hasOwn(bridge.creates[0] ?? {}, "storageScope"), false);
  assert.equal(new TextDecoder().decode(vault.values.get(rendererVisibleSentinel)), "../wallet",
    "shared core treats this renderer value as unrelated metadata and never uses it as native authority");
  const params = bridge.sent.map((raw) => record(parseTdJsonLossless(raw)))
    .find((value) => typeOf(value) === "setTdlibParameters");
  assert.ok(params);
  assert.equal(params.database_encryption_key, undefined);
  assert.equal(params.database_directory, undefined);
  assert.equal(params.files_directory, undefined);
  await session.close();
});


test("TDLib close synchronously scrubs sensitive memory before native acknowledgement", async () => {
  const bridge = new FakeTdlibBridge();
  const { session } = await authorize(bridge);
  const account = session.account();
  assert.ok(account);
  const delivered: ConnectorEvent[] = [];
  session.subscribe((event) => delivered.push(event));
  await session.execute({
    operation: "message.send",
    account,
    chat: { ...account, chatId: "-1009007199254740993" },
    idempotencyKey: "memory-scrub-1",
    payload: { text: "sensitive message" },
  });

  const internals = session as unknown as {
    events: unknown[];
    operationCache: Map<string, unknown>;
    listeners: Set<unknown>;
    pending: Map<string, unknown>;
  };
  assert.equal(internals.events.length > 0, true);
  assert.equal(internals.operationCache.size, 1);
  assert.equal(internals.listeners.size, 1);

  let releaseClose!: () => void;
  bridge.closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const closing = session.close();

  assert.equal(session.account(), null, "account identity is cleared synchronously");
  assert.equal(session.loginState().status, "suspended", "live-ready authority is removed synchronously");
  assert.equal(internals.events.length, 0, "message/event payload cache is cleared before native close ack");
  assert.equal(internals.operationCache.size, 0, "idempotency results are cleared before native close ack");
  assert.equal(internals.listeners.size, 0, "consumer closures are detached before native close ack");
  assert.equal(internals.pending.size, 0, "pending RPC payload closures are cleared before native close ack");
  assert.equal(bridge.closes.length, 1, "native close is pending");

  const deliveredBeforeLateEvent = delivered.length;
  const clientId = `tdc.${String(1).padStart(48, "0")}`;
  bridge.emit(clientId, stringifyTdJson({
    "@type": "updateNewMessage",
    message: {
      "@type": "message",
      id: tdInt64("9007199254740999"),
      chat_id: tdInt64("-1009007199254740993"),
      date: 1_700_000_001,
      content: {
        "@type": "messageText",
        text: { "@type": "formattedText", text: "late secret", entities: [] },
      },
    },
  }));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(delivered.length, deliveredBeforeLateEvent, "late native events are ignored after close starts");
  await assert.rejects(
    session.execute({
      operation: "chats.list",
      account,
      payload: { limit: 1 },
    }),
    /closed/u,
  );

  releaseClose();
  bridge.closeGate = null;
  await closing;
});

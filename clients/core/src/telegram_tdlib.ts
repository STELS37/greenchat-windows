// clients/core/src/telegram_tdlib.ts — official TDLib JSON connector (T-452).
//
// The core speaks only the official TDLib JSON protocol. Native shells own the tdjson binary, private
// filesystem paths and the single receive loop. The adapter owns authorization, @extra correlation,
// lossless int53 identifiers, capability negotiation and normalization into the Connector SDK.

import {
  resolveConnectorCapabilities,
  validateConnectorCommand,
} from "./connectors.ts";
import { nativeConnectorVaultCapability } from "./connector_vault.ts";
import type {
  ConnectorAccountRef,
  ConnectorAdapter,
  ConnectorAuthInput,
  ConnectorCapabilityMatrix,
  ConnectorCapabilityOverrides,
  ConnectorChat,
  ConnectorChatRef,
  ConnectorCommand,
  ConnectorCommandResult,
  ConnectorDiagnostic,
  ConnectorEvent,
  ConnectorEventKind,
  ConnectorLoginState,
  ConnectorManifest,
  ConnectorMessage,
  ConnectorMessageRef,
  ConnectorOpenContext,
  ConnectorPlatform,
  ConnectorSession,
  ConnectorSyncPage,
  ConnectorSyncRequest,
  ScopedConnectorVault,
} from "./connectors.ts";

export const TELEGRAM_PROVIDER_ID = "telegram" as const;
export const TELEGRAM_CONNECTION_ENABLED_KEY = "telegram.connection.enabled.v1" as const;
const MAX_EVENT_LOG = 10_000;
const MAX_IDEMPOTENCY_CACHE = 4_096;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_QR_TTL_SECONDS = 60;
const INT_TOKEN = /^-?(0|[1-9][0-9]*)$/u;

export interface TdInt64 {
  readonly __tdInt64: true;
  readonly value: string;
}

export type TdJsonValue =
  | null
  | boolean
  | number
  | string
  | TdInt64
  | readonly TdJsonValue[]
  | { readonly [key: string]: TdJsonValue | undefined };

export function tdInt64(value: string | number | bigint): TdInt64 {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new TypeError("TDLib integer number must be a safe integer; use string or bigint for lossless ids");
  }
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!INT_TOKEN.test(normalized)) throw new TypeError("TDLib int53 must be a canonical signed integer");
  return Object.freeze({ __tdInt64: true, value: normalized });
}

function isTdInt64(value: unknown): value is TdInt64 {
  return typeof value === "object" && value !== null && (value as { __tdInt64?: unknown }).__tdInt64 === true;
}

/** JSON encoder which can emit TDLib int53 values without converting them through JS Number. */
export function stringifyTdJson(value: TdJsonValue): string {
  const encode = (input: TdJsonValue | undefined): string => {
    if (input === null) return "null";
    if (isTdInt64(input)) return input.value;
    if (typeof input === "string") return JSON.stringify(input);
    if (typeof input === "boolean") return input ? "true" : "false";
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new TypeError("TDLib JSON numbers must be finite");
      if (Number.isInteger(input) && !Number.isSafeInteger(input)) {
        throw new TypeError("unsafe integer must be wrapped with tdInt64()");
      }
      return String(input);
    }
    if (Array.isArray(input)) return `[${input.map((item) => encode(item)).join(",")}]`;
    if (typeof input === "object") {
      const fields: string[] = [];
      for (const [key, field] of Object.entries(input)) {
        if (field === undefined) continue;
        fields.push(`${JSON.stringify(key)}:${encode(field)}`);
      }
      return `{${fields.join(",")}}`;
    }
    throw new TypeError("unsupported TDLib JSON value");
  };
  return encode(value);
}

/**
 * Lossless JSON parser for TDLib. Every integer token is kept as its canonical string; fractions and
 * exponents remain numbers. This prevents int53 chat/message/user identifiers from crossing Number.
 */
export function parseTdJsonLossless(text: string): unknown {
  class Parser {
    private indexValue = 0;
    private readonly input: string;

    constructor(input: string) {
      this.input = input;
    }

    parse(): unknown {
      const value = this.value();
      this.space();
      if (this.indexValue !== this.input.length) throw new SyntaxError("unexpected trailing JSON data");
      return value;
    }

    private space(): void {
      while (/\s/u.test(this.input[this.indexValue] ?? "")) this.indexValue += 1;
    }

    private value(): unknown {
      this.space();
      const char = this.input[this.indexValue];
      if (char === "{") return this.object();
      if (char === "[") return this.array();
      if (char === "\"") return this.string();
      if (char === "t" && this.input.slice(this.indexValue, this.indexValue + 4) === "true") {
        this.indexValue += 4;
        return true;
      }
      if (char === "f" && this.input.slice(this.indexValue, this.indexValue + 5) === "false") {
        this.indexValue += 5;
        return false;
      }
      if (char === "n" && this.input.slice(this.indexValue, this.indexValue + 4) === "null") {
        this.indexValue += 4;
        return null;
      }
      return this.number();
    }

    private string(): string {
      const start = this.indexValue;
      this.indexValue += 1;
      let escaped = false;
      while (this.indexValue < this.input.length) {
        const char = this.input[this.indexValue];
        this.indexValue += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === "\"") return JSON.parse(this.input.slice(start, this.indexValue)) as string;
      }
      throw new SyntaxError("unterminated JSON string");
    }

    private number(): string | number {
      const rest = this.input.slice(this.indexValue);
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(rest);
      if (!match) throw new SyntaxError(`invalid JSON token at ${this.indexValue}`);
      const token = match[0];
      this.indexValue += token.length;
      if (!/[.eE]/u.test(token)) return token;
      const value = Number(token);
      if (!Number.isFinite(value)) throw new SyntaxError("non-finite JSON number");
      return value;
    }

    private array(): unknown[] {
      const out: unknown[] = [];
      this.indexValue += 1;
      this.space();
      if (this.input[this.indexValue] === "]") {
        this.indexValue += 1;
        return out;
      }
      while (true) {
        out.push(this.value());
        this.space();
        const char = this.input[this.indexValue];
        this.indexValue += 1;
        if (char === "]") return out;
        if (char !== ",") throw new SyntaxError("expected ',' or ']' in JSON array");
      }
    }

    private object(): Record<string, unknown> {
      const out: Record<string, unknown> = {};
      this.indexValue += 1;
      this.space();
      if (this.input[this.indexValue] === "}") {
        this.indexValue += 1;
        return out;
      }
      while (true) {
        this.space();
        if (this.input[this.indexValue] !== "\"") throw new SyntaxError("expected JSON object key");
        const key = this.string();
        this.space();
        if (this.input[this.indexValue] !== ":") throw new SyntaxError("expected ':' after JSON key");
        this.indexValue += 1;
        out[key] = this.value();
        this.space();
        const char = this.input[this.indexValue];
        this.indexValue += 1;
        if (char === "}") return out;
        if (char !== ",") throw new SyntaxError("expected ',' or '}' in JSON object");
      }
    }
  }

  return new Parser(text).parse();
}

export interface TelegramTdlibBridgeInfo {
  available: boolean;
  /** Native shell has a GreenChat-owned Telegram application credentials pair ready for injection. */
  configured: boolean;
  version?: string;
  reason?: string;
}

export interface TelegramTdlibBridgeOpenOptions {
  logVerbosity: number;
  /** Opaque process-local lease proving ownership of the account-bound native vault scope. */
  vaultCapability?: string;
}

export interface TelegramTdlibBridgeClient {
  /** Opaque native handle. The underlying TDLib numeric client id and filesystem paths never enter JS. */
  clientId: string;
}

/** Native host seam. It must own exactly one receive loop per client and preserve message order. */
export interface TelegramTdlibBridge {
  readonly platform: Exclude<ConnectorPlatform, "web">;
  info(): Promise<TelegramTdlibBridgeInfo>;
  create(options: TelegramTdlibBridgeOpenOptions): Promise<TelegramTdlibBridgeClient>;
  send(clientId: string, requestJson: string): Promise<void>;
  onMessage(clientId: string, listener: (responseJson: string) => void): () => void;
  /** Process native-encrypted push payloads queued while the WebView/process was unavailable. */
  drainPushes?(clientId: string): Promise<{ processed: number; pending: number }>;
  close(clientId: string): Promise<void>;
  wipe(vaultCapability?: string): Promise<void>;
}

export interface TelegramConnectorOptions {
  bridge: TelegramTdlibBridge;
  /** application credentials are injected by the native bridge and never enter shared JavaScript. */
  applicationVersion: string;
  systemLanguageCode?: string;
  deviceModel?: string;
  systemVersion?: string;
  useTestDc?: boolean;
  useFileDatabase?: boolean;
  useChatInfoDatabase?: boolean;
  useMessageDatabase?: boolean;
  useSecretChats?: boolean;
  requestTimeoutMs?: number;
  qrTtlSeconds?: number;
  logVerbosity?: number;
}

/** TDLib session extension used only by the protected Telegram account manager. */
export interface TelegramTdlibSessionPort extends ConnectorSession {
  /** Register or revoke the current native FCM token with Telegram for this exact account. */
  setPushToken(token: string | null, otherUserIds: readonly string[]): Promise<void>;
  /** Retry the native encrypted-push queue without reopening the TDLib client. */
  retryPushRecovery(): void;
}

/** Typed adapter seam; generic connector callers may still use it as ConnectorAdapter. */
export interface TelegramTdlibAdapterPort extends ConnectorAdapter {
  open(context: ConnectorOpenContext): Promise<TelegramTdlibSessionPort>;
}

const TELEGRAM_CAPABILITIES: ConnectorCapabilityOverrides = Object.freeze({
  "chats.read": { state: "supported" },
  "history.read": { state: "supported" },
  "messages.receive": { state: "supported" },
  "messages.send": { state: "supported" },
  "messages.edit": { state: "supported" },
  "messages.delete": { state: "supported" },
  "messages.reply": { state: "supported" },
  "messages.forward": { state: "supported" },
  reactions: { state: "supported" },
  typing: { state: "supported" },
  read_receipts: { state: "supported" },
  files: { state: "supported" },
  groups: { state: "supported" },
  channels: { state: "supported" },
  threads: { state: "conditional", reason: "topic_ui_pending" },
  polls: { state: "conditional", reason: "poll_ui_pending" },
  stories: { state: "conditional", reason: "story_ui_pending" },
  calls: { state: "conditional", reason: "native_call_stack_pending" },
  secret_chats: { state: "conditional", reason: "device_bound_session" },
});

export const TELEGRAM_TDLIB_MANIFEST: ConnectorManifest = Object.freeze({
  provider: TELEGRAM_PROVIDER_ID,
  displayName: "Telegram",
  implementation: "official-tdlib-json",
  platforms: ["desktop", "android"] as const,
  capabilities: TELEGRAM_CAPABILITIES,
  compliance: {
    official: true,
    reviewedAt: "2026-07-17",
    termsUrl: "https://core.telegram.org/api/terms",
    regionNotes: "TDLib availability and Telegram service access remain subject to local law and network reachability.",
  },
});

export class TelegramTdlibError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = "TelegramTdlibError";
    this.code = code;
  }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function tdType(value: unknown): string {
  return String(asRecord(value)?.["@type"] ?? "");
}

function integerString(value: unknown, name: string): string {
  if (typeof value === "string" && INT_TOKEN.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new TypeError(`${name} must be a TDLib integer`);
}

function optionalIntegerString(value: unknown): string | undefined {
  try {
    return value === undefined || value === null ? undefined : integerString(value, "value");
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const UNSAFE_RENDERER_FILE_TYPES = new Set(["inputFileLocal", "inputFileGenerated"]);
const MAX_PROVIDER_EXTENSION_NODES = 2_048;
const MAX_PROVIDER_EXTENSION_DEPTH = 32;

/**
 * Renderer JSON may reference provider-owned remote/file ids, but never host filesystem paths or generators.
 * Local uploads require a future native picker capability that resolves the path entirely inside the shell.
 */
function assertRendererSafeFileContent(value: unknown): void {
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_PROVIDER_EXTENSION_NODES || depth > MAX_PROVIDER_EXTENSION_DEPTH) {
      throw new TypeError("file.send provider extension is too complex");
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, depth + 1);
      return;
    }
    const record = asRecord(current);
    if (!record) return;
    const type = tdType(record);
    if (UNSAFE_RENDERER_FILE_TYPES.has(type)) {
      throw new TypeError("file.send local paths require a trusted native picker capability");
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" && INT_TOKEN.test(value) ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/** Wipe TDLib files even when no live session exists (logout, server switch, failed native upgrade). */
export async function wipeTelegramTdlibLocal(
  bridge: TelegramTdlibBridge,
  vault: ScopedConnectorVault,
): Promise<void> {
  try {
    // The TDLib directory binding is native-only. Renderer JavaScript supplies only the account capability.
    await bridge.wipe(nativeConnectorVaultCapability(vault) ?? undefined);
  } catch (error) {
    // Keep native metadata for an idempotent retry, but disable automatic restore immediately.
    await vault.remove(TELEGRAM_CONNECTION_ENABLED_KEY).catch(() => undefined);
    throw error;
  }
  await vault.wipe();
}

function stateFingerprint(state: ConnectorLoginState): string {
  return JSON.stringify(state);
}

function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function isoFromUnix(value: unknown, fallback: string): string {
  const seconds = boundedNumber(value, 0, 0, 8_640_000_000);
  if (seconds <= 0) return fallback;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function senderId(message: Record<string, unknown>): string | undefined {
  const sender = asRecord(message.sender_id);
  if (!sender) return undefined;
  const id = optionalIntegerString(sender.user_id ?? sender.chat_id);
  return id ? `${tdType(sender)}:${id}` : undefined;
}

function messageText(content: unknown): string | undefined {
  const body = asRecord(content);
  if (!body) return undefined;
  const type = tdType(body);
  if (type === "messageText") return stringValue(asRecord(body.text)?.text);
  return stringValue(asRecord(body.caption)?.text);
}

function normalizeReply(
  account: ConnectorAccountRef,
  chatId: string,
  reply: unknown,
): ConnectorMessageRef | undefined {
  const body = asRecord(reply);
  if (!body || tdType(body) !== "messageReplyToMessage") return undefined;
  const messageId = optionalIntegerString(body.message_id);
  if (!messageId || messageId === "0") return undefined;
  const repliedChat = optionalIntegerString(body.chat_id) ?? chatId;
  return { ...account, chatId: repliedChat, messageId };
}

function normalizeMessage(account: ConnectorAccountRef, value: unknown, now: string): ConnectorMessage | null {
  const body = asRecord(value);
  if (!body) return null;
  const chatId = optionalIntegerString(body.chat_id);
  const messageId = optionalIntegerString(body.id);
  if (!chatId || !messageId) return null;
  const sentAt = isoFromUnix(body.date, now);
  const editDate = boundedNumber(body.edit_date, 0, 0, 8_640_000_000);
  const text = messageText(body.content);
  const sender = senderId(body);
  const replyTo = normalizeReply(account, chatId, body.reply_to);
  return {
    ref: { ...account, chatId, messageId },
    sentAt,
    ...(editDate > 0 ? { editedAt: new Date(editDate * 1000).toISOString() } : {}),
    ...(sender ? { senderId: sender } : {}),
    ...(text === undefined ? {} : { text }),
    ...(replyTo ? { replyTo } : {}),
    raw: body,
  };
}

function chatKind(chat: Record<string, unknown>): ConnectorChat["kind"] {
  const type = asRecord(chat.type);
  const name = tdType(type);
  if (name === "chatTypePrivate" || name === "chatTypeSecret") return "dialog";
  if (name === "chatTypeBasicGroup") return "group";
  if (name === "chatTypeSupergroup") return boolValue(type?.is_channel) ? "channel" : "group";
  return "unknown";
}

function normalizeChat(account: ConnectorAccountRef, value: unknown, now: string): ConnectorChat | null {
  const body = asRecord(value);
  if (!body) return null;
  const chatId = optionalIntegerString(body.id);
  if (!chatId) return null;
  const last = asRecord(body.last_message);
  return {
    ref: { ...account, chatId },
    title: stringValue(body.title) ?? "Telegram",
    kind: chatKind(body),
    unreadCount: boundedNumber(body.unread_count, 0, 0, 2_147_483_647),
    updatedAt: isoFromUnix(last?.date, now),
    raw: body,
  };
}

function commandPayload(command: ConnectorCommand): Record<string, unknown> {
  return command.payload ? { ...command.payload } : {};
}

function requiredChat(command: ConnectorCommand): ConnectorChatRef {
  if (!command.chat) throw new TypeError(`${command.operation} requires command.chat`);
  return command.chat;
}

function requiredString(payload: Record<string, unknown>, key: string, max = 1_000_000): string {
  const value = stringValue(payload[key]);
  if (value === undefined || value.length === 0 || value.length > max) {
    throw new TypeError(`${key} must be a non-empty string up to ${max} chars`);
  }
  return value;
}

function optionalStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.map((item) => integerString(item, key));
}

function formattedText(text: string): TdJsonValue {
  return { "@type": "formattedText", text, entities: [] };
}

function inputMessageText(text: string): TdJsonValue {
  return {
    "@type": "inputMessageText",
    text: formattedText(text),
    link_preview_options: null,
    clear_draft: true,
  };
}

function messageRefFromResponse(account: ConnectorAccountRef, value: Record<string, unknown>): Readonly<Record<string, string>> | undefined {
  const chatId = optionalIntegerString(value.chat_id);
  const messageId = optionalIntegerString(value.id);
  return chatId && messageId ? { provider: TELEGRAM_PROVIDER_ID, accountId: account.accountId, chatId, messageId } : undefined;
}

class TelegramTdlibSession implements TelegramTdlibSessionPort {
  private readonly options: Required<Pick<TelegramConnectorOptions,
    "requestTimeoutMs" | "qrTtlSeconds" | "logVerbosity" | "useFileDatabase" |
    "useChatInfoDatabase" | "useMessageDatabase" | "useSecretChats" | "useTestDc">> & TelegramConnectorOptions;
  private readonly context: ConnectorOpenContext;
  private readonly bridgeClient: TelegramTdlibBridgeClient;
  private readonly vaultCapability: string | undefined;
  private readonly listeners = new Set<(event: ConnectorEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly events: ConnectorEvent[] = [];
  private readonly operationCache = new Map<string, Promise<ConnectorCommandResult>>();
  private detachBridge: (() => void) | null = null;
  private processing: Promise<void> = Promise.resolve();
  private loginStateValue: ConnectorLoginState = { status: "starting" };
  private accountValue: ConnectorAccountRef | null = null;
  private requestCounter = 0n;
  private eventCounter = 0n;
  private nativePushDrainTask: Promise<void> | null = null;
  private closed = false;

  constructor(
    options: TelegramTdlibSession["options"],
    context: ConnectorOpenContext,
    bridgeClient: TelegramTdlibBridgeClient,
    vaultCapability?: string,
  ) {
    this.options = options;
    this.context = context;
    this.bridgeClient = bridgeClient;
    this.vaultCapability = vaultCapability;
  }

  async start(): Promise<void> {
    this.detachBridge = this.options.bridge.onMessage(this.bridgeClient.clientId, (raw) => {
      this.onRawMessage(raw);
    });
    const state = await this.rpc({ "@type": "getAuthorizationState" });
    await this.handleAuthorizationState(state);
  }

  loginState(): ConnectorLoginState {
    return this.loginStateValue;
  }

  account(): ConnectorAccountRef | null {
    return this.accountValue;
  }

  async setPushToken(token: string | null, otherUserIds: readonly string[]): Promise<void> {
    const account = this.requireReadyAccount();
    const normalizedToken = token === null ? null : token.trim();
    if (normalizedToken !== null && (
      normalizedToken.length === 0 ||
      normalizedToken.length > 4096 ||
      !/^[\u0021-\u007e]+$/u.test(normalizedToken)
    )) {
      throw new TypeError("invalid Telegram FCM token");
    }
    if (normalizedToken === null && otherUserIds.length > 0) {
      throw new TypeError("Telegram push revoke cannot include companion accounts");
    }
    if (otherUserIds.length > 8) throw new TypeError("too many Telegram companion accounts");
    const normalizedOther: string[] = [];
    const seen = new Set<string>();
    for (const raw of otherUserIds) {
      const id = String(raw);
      if (!/^[1-9][0-9]{0,20}$/u.test(id)) throw new TypeError("invalid Telegram companion account id");
      if (id === account.accountId || seen.has(id)) continue;
      seen.add(id);
      normalizedOther.push(id);
    }
    await this.rpc({
      "@type": "registerDevice",
      device_token: {
        "@type": "deviceTokenFirebaseCloudMessaging",
        token: normalizedToken ?? "",
        encrypt: true,
      },
      other_user_ids: normalizedOther.map(tdInt64),
    });
    this.retryPushRecovery();
  }

  async submitAuth(input: ConnectorAuthInput): Promise<ConnectorLoginState> {
    this.assertOpen();
    if (input.kind === "cancel") {
      await this.rpc({ "@type": "logOut" });
      this.setLoginState({ status: "revoked", reason: "cancelled" });
      return this.loginStateValue;
    }
    if (input.kind === "qr_refresh") {
      await this.rpc({ "@type": "requestQrCodeAuthentication", other_user_ids: [] });
      return this.loginStateValue;
    }
    if (input.kind === "phone") {
      const phone = input.phone.trim();
      if (!/^\+[1-9][0-9]{5,19}$/u.test(phone)) throw new TypeError("Telegram phone must be in international format");
      await this.rpc({ "@type": "setAuthenticationPhoneNumber", phone_number: phone, settings: null });
      return this.loginStateValue;
    }
    if (input.kind === "code") {
      const code = input.code.trim();
      if (!/^[0-9A-Za-z_-]{1,32}$/u.test(code)) throw new TypeError("invalid Telegram authentication code");
      await this.rpc({ "@type": "checkAuthenticationCode", code });
      return this.loginStateValue;
    }
    const password = input.password;
    if (password.length === 0 || password.length > 1024) throw new TypeError("invalid Telegram 2FA password");
    await this.rpc({ "@type": "checkAuthenticationPassword", password });
    return this.loginStateValue;
  }

  async capabilities(): Promise<ConnectorCapabilityMatrix> {
    return resolveConnectorCapabilities({ provider: TELEGRAM_CAPABILITIES });
  }

  async sync(request: ConnectorSyncRequest): Promise<ConnectorSyncPage> {
    this.assertOpen();
    const limit = Math.max(1, Math.min(500, Math.trunc(request.limit)));
    const cursor = request.cursor === undefined ? 0n : BigInt(request.cursor);
    const selected = this.events.filter((event) => BigInt(event.sequence) > cursor).slice(0, limit);
    const next = selected.at(-1)?.sequence ?? request.cursor ?? "0";
    const last = this.events.at(-1)?.sequence ?? "0";
    return { cursor: next, hasMore: BigInt(next) < BigInt(last), events: selected };
  }

  async execute(command: ConnectorCommand): Promise<ConnectorCommandResult> {
    this.assertOpen();
    const account = this.requireReadyAccount();
    if (command.account.provider !== account.provider || command.account.accountId !== account.accountId) {
      throw new TypeError("Telegram command account does not match the open TDLib session");
    }
    const matrix = await this.capabilities();
    validateConnectorCommand(command, matrix);
    if (!command.idempotencyKey) return this.executeUncached(command);
    const existing = this.operationCache.get(command.idempotencyKey);
    if (existing) return existing;
    const task = this.executeUncached(command).catch((error: unknown) => {
      this.operationCache.delete(command.idempotencyKey as string);
      throw error;
    });
    this.operationCache.set(command.idempotencyKey, task);
    while (this.operationCache.size > MAX_IDEMPOTENCY_CACHE) {
      const oldest = this.operationCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.operationCache.delete(oldest);
    }
    return task;
  }

  subscribe(listener: (event: ConnectorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async revoke(): Promise<void> {
    if (this.closed) return;
    try {
      await this.rpc({ "@type": "logOut" });
    } finally {
      this.accountValue = null;
      this.events.length = 0;
      this.operationCache.clear();
      this.setLoginState({ status: "revoked", reason: "logged_out" });
    }
  }

  async wipeLocal(): Promise<void> {
    await this.close();
    await this.options.bridge.wipe(this.vaultCapability);
    await this.context.vault.wipe();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.detachBridge?.();
    this.detachBridge = null;
    // Synchronous zero-retention boundary: no account, QR token, event payload, idempotency result or listener
    // remains observable while the native shutdown acknowledgement is still pending.
    this.accountValue = null;
    this.loginStateValue = { status: "suspended" };
    this.events.length = 0;
    this.operationCache.clear();
    this.listeners.clear();
    this.processing = Promise.resolve();
    const error = new Error("TDLib connector closed");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    await this.options.bridge.close(this.bridgeClient.clientId);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("TDLib connector is closed");
  }

  private requireReadyAccount(): ConnectorAccountRef {
    if (!this.accountValue || this.loginStateValue.status !== "ready") {
      throw new Error("Telegram account is not authorized");
    }
    return this.accountValue;
  }

  private provisionalAccount(): ConnectorAccountRef {
    return this.accountValue ?? {
      provider: TELEGRAM_PROVIDER_ID,
      accountId: this.context.accountHint?.trim() || `pending:${this.bridgeClient.clientId}`,
    };
  }

  retryPushRecovery(): void {
    if (this.nativePushDrainTask || this.closed || this.loginStateValue.status !== "ready") return;
    const drain = this.options.bridge.drainPushes;
    if (!drain) return;
    let task!: Promise<void>;
    task = drain.call(this.options.bridge, this.bridgeClient.clientId).then(({ pending }) => {
      if (pending > 0) this.diagnostic({ level: "warn", code: "telegram.tdlib.push_drain_pending" });
    }).catch(() => {
      this.diagnostic({ level: "warn", code: "telegram.tdlib.push_drain_failed" });
    }).finally(() => {
      if (this.nativePushDrainTask === task) this.nativePushDrainTask = null;
    });
    this.nativePushDrainTask = task;
  }

  private diagnostic(event: ConnectorDiagnostic): void {
    this.context.onDiagnostic?.(event);
  }

  private onRawMessage(raw: string): void {
    let value: Record<string, unknown>;
    try {
      const parsed = parseTdJsonLossless(raw);
      const record = asRecord(parsed);
      if (!record) throw new SyntaxError("TDLib response must be a JSON object");
      value = record;
    } catch {
      this.diagnostic({ level: "error", code: "telegram.tdlib.invalid_json" });
      return;
    }

    const extra = asRecord(value["@extra"]);
    const requestId = stringValue(extra?.gc_request_id);
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      if (tdType(value) === "error") {
        pending.reject(new TelegramTdlibError(
          boundedNumber(value.code, 500, -2_147_483_648, 2_147_483_647),
          stringValue(value.message) ?? "TDLib request failed",
        ));
      } else {
        pending.resolve(value);
      }
      return;
    }

    this.processing = this.processing
      .then(() => this.handleUpdate(value, raw))
      .catch(() => this.diagnostic({ level: "error", code: "telegram.tdlib.update_failed" }));
  }

  private async rpc(request: TdJsonValue): Promise<Record<string, unknown>> {
    this.assertOpen();
    this.requestCounter += 1n;
    const requestId = this.requestCounter.toString();
    const body = asRecord(request);
    if (!body) throw new TypeError("TDLib request must be an object");
    const json = stringifyTdJson({
      ...body as Record<string, TdJsonValue>,
      "@extra": { gc_request_id: requestId },
    });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`TDLib request timeout: ${String(body["@type"] ?? "unknown")}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.options.bridge.send(this.bridgeClient.clientId, json).catch((error: unknown) => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  private setLoginState(state: ConnectorLoginState): void {
    if (stateFingerprint(state) === stateFingerprint(this.loginStateValue)) return;
    this.loginStateValue = state;
    this.emit("account.updated", { status: state.status }, `auth:${state.status}`);
  }

  private async handleAuthorizationState(value: unknown): Promise<void> {
    const state = asRecord(value);
    if (!state) return;
    switch (tdType(state)) {
      case "authorizationStateWaitTdlibParameters":
        this.setLoginState({ status: "starting" });
        await this.rpc({
          "@type": "setTdlibParameters",
          use_test_dc: this.options.useTestDc,
          // Native shell injects its private directories and OS-protected database key.
          use_file_database: this.options.useFileDatabase,
          use_chat_info_database: this.options.useChatInfoDatabase,
          use_message_database: this.options.useMessageDatabase,
          use_secret_chats: this.options.useSecretChats,
          // The native bridge injects GreenChat's application credentials immediately before td_send().
          system_language_code: this.options.systemLanguageCode ?? "en",
          device_model: this.options.deviceModel ?? "GreenChat",
          system_version: this.options.systemVersion ?? this.options.bridge.platform,
          application_version: this.options.applicationVersion,
        });
        break;
      case "authorizationStateWaitPhoneNumber":
        this.setLoginState({ status: "awaiting_phone" });
        break;
      case "authorizationStateWaitOtherDeviceConfirmation": {
        const link = stringValue(state.link);
        if (!link) {
          this.setLoginState({ status: "error", code: "QR_LINK_MISSING", retryable: true, message: "Telegram QR link is unavailable" });
          break;
        }
        const expires = new Date((this.context.now?.() ?? new Date()).getTime() + this.options.qrTtlSeconds * 1000);
        this.setLoginState({ status: "awaiting_qr", qrPayload: link, expiresAt: expires.toISOString() });
        break;
      }
      case "authorizationStateWaitCode": {
        const info = asRecord(state.code_info);
        const hint = stringValue(info?.phone_number) ?? stringValue(info?.email_address_pattern);
        this.setLoginState({ status: "awaiting_code", ...(hint ? { destinationHint: hint } : {}) });
        break;
      }
      case "authorizationStateWaitPassword": {
        const hint = stringValue(state.password_hint);
        this.setLoginState({ status: "awaiting_password", ...(hint ? { passwordHint: hint } : {}) });
        break;
      }
      case "authorizationStateReady": {
        const me = await this.rpc({ "@type": "getMe" });
        const id = integerString(me.id, "Telegram user id");
        this.accountValue = { provider: TELEGRAM_PROVIDER_ID, accountId: id };
        this.setLoginState({ status: "ready", account: this.accountValue });
        this.retryPushRecovery();
        break;
      }
      case "authorizationStateLoggingOut":
      case "authorizationStateClosing":
        this.setLoginState({ status: "starting" });
        break;
      case "authorizationStateClosed":
        this.setLoginState({ status: "revoked", reason: "tdlib_closed" });
        break;
      case "authorizationStateWaitRegistration":
      case "authorizationStateWaitEmailAddress":
      case "authorizationStateWaitEmailCode":
      case "authorizationStateWaitPremiumPurchase":
        this.setLoginState({
          status: "error",
          code: tdType(state).replace(/^authorizationState/u, "AUTH_"),
          retryable: false,
          message: "This Telegram authorization step requires a later GreenChat UI extension",
        });
        break;
      default:
        this.diagnostic({ level: "warn", code: "telegram.tdlib.unknown_auth_state" });
    }
  }

  private async handleUpdate(value: Record<string, unknown>, raw: string): Promise<void> {
    const type = tdType(value);
    if (type === "updateAuthorizationState") {
      await this.handleAuthorizationState(value.authorization_state);
      return;
    }
    if (type === "updateConnectionState") {
      const state = asRecord(value.state);
      if (tdType(state) === "connectionStateReady") this.retryPushRecovery();
      return;
    }
    const account = this.accountValue;
    if (!account) return;
    const now = (this.context.now?.() ?? new Date()).toISOString();
    const dedupe = `${type}:${fnv1a64(raw)}`;
    if (type === "updateNewChat") {
      const chat = normalizeChat(account, value.chat, now);
      if (chat) this.emit("chat.upserted", { chat }, dedupe);
      return;
    }
    if (type === "updateChatTitle" || type === "updateChatUnreadCount" || type === "updateChatPosition") {
      const chatId = optionalIntegerString(value.chat_id);
      if (chatId) this.emit("chat.upserted", { ref: { ...account, chatId }, update: value }, dedupe);
      return;
    }
    if (type === "updateChatLastMessage") {
      const chatId = optionalIntegerString(value.chat_id);
      if (chatId) {
        const message = normalizeMessage(account, value.last_message, now);
        this.emit("chat.upserted", { ref: { ...account, chatId }, lastMessage: message, positions: value.positions }, dedupe);
      }
      return;
    }
    if (type === "updateNewMessage" || type === "updateMessageSendSucceeded") {
      const message = normalizeMessage(account, value.message, now);
      if (message) this.emit("message.upserted", { message }, dedupe);
      return;
    }
    if (type === "updateMessageContent" || type === "updateMessageEdited") {
      const chatId = optionalIntegerString(value.chat_id);
      const messageId = optionalIntegerString(value.message_id);
      if (chatId && messageId) {
        this.emit("message.upserted", { ref: { ...account, chatId, messageId }, update: value }, dedupe);
      }
      return;
    }
    if (type === "updateDeleteMessages") {
      const chatId = optionalIntegerString(value.chat_id);
      const ids = Array.isArray(value.message_ids)
        ? value.message_ids.map((id) => integerString(id, "message_id"))
        : [];
      if (chatId && ids.length > 0) this.emit("message.removed", { chatId, messageIds: ids }, dedupe);
      return;
    }
    if (type === "updateUnreadMessageCount") {
      this.emit("read.updated", {
        totalUnreadCount: boundedNumber(value.unread_count, 0, 0, 2_147_483_647),
      }, dedupe);
      return;
    }
    if (type === "updateUnreadChatCount") {
      this.emit("read.updated", {
        unreadChatCount: boundedNumber(value.unread_count, 0, 0, 2_147_483_647),
      }, dedupe);
      return;
    }
    if (type === "updateChatReadInbox" || type === "updateChatReadOutbox") {
      const chatId = optionalIntegerString(value.chat_id);
      if (chatId) this.emit("read.updated", { chatId, update: value }, dedupe);
      return;
    }
    if (type === "updateUserChatAction") {
      const chatId = optionalIntegerString(value.chat_id);
      if (chatId) this.emit("typing.updated", { chatId, action: value.action, senderId: value.user_id }, dedupe);
    }
  }

  private emit(kind: ConnectorEventKind, payload: Readonly<Record<string, unknown>>, dedupeKey: string): void {
    this.eventCounter += 1n;
    const event: ConnectorEvent = {
      sequence: this.eventCounter.toString(),
      dedupeKey,
      account: this.provisionalAccount(),
      kind,
      occurredAt: (this.context.now?.() ?? new Date()).toISOString(),
      payload,
    };
    this.events.push(event);
    while (this.events.length > MAX_EVENT_LOG) this.events.shift();
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* isolate consumer faults */ }
    }
  }

  private async executeUncached(command: ConnectorCommand): Promise<ConnectorCommandResult> {
    const account = this.requireReadyAccount();
    const payload = commandPayload(command);
    let response: Record<string, unknown>;
    switch (command.operation) {
      case "chats.list":
        response = await this.rpc({
          "@type": "getChats",
          chat_list: null,
          limit: boundedNumber(payload.limit, 100, 1, 1000),
        });
        break;
      case "history.sync": {
        const chat = requiredChat(command);
        response = await this.rpc({
          "@type": "getChatHistory",
          chat_id: tdInt64(chat.chatId),
          from_message_id: tdInt64(optionalIntegerString(payload.fromMessageId) ?? "0"),
          offset: boundedNumber(payload.offset, 0, -99, 0),
          limit: boundedNumber(payload.limit, 100, 1, 100),
          only_local: boolValue(payload.onlyLocal),
        });
        const messages = Array.isArray(response.messages)
          ? response.messages.map((message) => normalizeMessage(account, message, new Date().toISOString())).filter(Boolean)
          : [];
        return { operation: command.operation, payload: { messages } };
      }
      case "message.send": {
        const chat = requiredChat(command);
        response = await this.rpc({
          "@type": "sendMessage",
          chat_id: tdInt64(chat.chatId),
          topic_id: null,
          reply_to: null,
          options: null,
          reply_markup: null,
          input_message_content: inputMessageText(requiredString(payload, "text", 4096)),
        });
        break;
      }
      case "message.reply": {
        const chat = requiredChat(command);
        response = await this.rpc({
          "@type": "sendMessage",
          chat_id: tdInt64(chat.chatId),
          topic_id: null,
          reply_to: {
            "@type": "inputMessageReplyToMessage",
            message_id: tdInt64(integerString(payload.messageId, "messageId")),
            quote: null,
            checklist_task_id: 0,
          },
          options: null,
          reply_markup: null,
          input_message_content: inputMessageText(requiredString(payload, "text", 4096)),
        });
        break;
      }
      case "message.edit": {
        const chat = requiredChat(command);
        response = await this.rpc({
          "@type": "editMessageText",
          chat_id: tdInt64(chat.chatId),
          message_id: tdInt64(integerString(payload.messageId, "messageId")),
          reply_markup: null,
          input_message_content: inputMessageText(requiredString(payload, "text", 4096)),
        });
        break;
      }
      case "message.delete": {
        const chat = requiredChat(command);
        const ids = optionalStringArray(payload, "messageIds");
        const single = optionalIntegerString(payload.messageId);
        if (single) ids.push(single);
        if (ids.length === 0) throw new TypeError("message.delete requires messageId or messageIds");
        response = await this.rpc({
          "@type": "deleteMessages",
          chat_id: tdInt64(chat.chatId),
          message_ids: ids.map(tdInt64),
          revoke: payload.revoke === undefined ? true : boolValue(payload.revoke),
        });
        break;
      }
      case "message.forward": {
        const chat = requiredChat(command);
        const ids = optionalStringArray(payload, "messageIds");
        if (ids.length === 0) throw new TypeError("message.forward requires messageIds");
        response = await this.rpc({
          "@type": "forwardMessages",
          chat_id: tdInt64(chat.chatId),
          topic_id: null,
          from_chat_id: tdInt64(integerString(payload.fromChatId, "fromChatId")),
          message_ids: ids.map(tdInt64),
          options: null,
          send_copy: boolValue(payload.sendCopy),
          remove_caption: boolValue(payload.removeCaption),
        });
        break;
      }
      case "reaction.set": {
        const chat = requiredChat(command);
        const emoji = stringValue(payload.emoji);
        response = emoji
          ? await this.rpc({
              "@type": "addMessageReaction",
              chat_id: tdInt64(chat.chatId),
              message_id: tdInt64(integerString(payload.messageId, "messageId")),
              reaction_type: { "@type": "reactionTypeEmoji", emoji },
              is_big: boolValue(payload.isBig),
              update_recent_reactions: true,
            })
          : await this.rpc({
              "@type": "removeMessageReaction",
              chat_id: tdInt64(chat.chatId),
              message_id: tdInt64(integerString(payload.messageId, "messageId")),
              reaction_type: {
                "@type": "reactionTypeEmoji",
                emoji: requiredString(payload, "removeEmoji", 32),
              },
            });
        break;
      }
      case "typing.set": {
        const chat = requiredChat(command);
        response = await this.rpc({
          "@type": "sendChatAction",
          chat_id: tdInt64(chat.chatId),
          topic_id: null,
          business_connection_id: "",
          action: { "@type": boolValue(payload.typing, true) ? "chatActionTyping" : "chatActionCancel" },
        });
        break;
      }
      case "read.mark": {
        const chat = requiredChat(command);
        const ids = optionalStringArray(payload, "messageIds");
        if (ids.length === 0) throw new TypeError("read.mark requires messageIds");
        response = await this.rpc({
          "@type": "viewMessages",
          chat_id: tdInt64(chat.chatId),
          message_ids: ids.map(tdInt64),
          source: null,
          force_read: payload.forceRead === undefined ? true : boolValue(payload.forceRead),
        });
        break;
      }
      case "file.send": {
        const chat = requiredChat(command);
        const content = asRecord(payload.inputMessageContent);
        if (!content || !tdType(content).startsWith("inputMessage")) {
          throw new TypeError("file.send requires provider extension inputMessageContent");
        }
        assertRendererSafeFileContent(content);
        response = await this.rpc({
          "@type": "sendMessage",
          chat_id: tdInt64(chat.chatId),
          topic_id: null,
          reply_to: null,
          options: null,
          reply_markup: null,
          input_message_content: content as TdJsonValue,
        });
        break;
      }
      case "poll.send":
      case "story.publish":
      case "call.start":
        throw new Error(`${command.operation} is not enabled in the TDLib MVP`);
      default: {
        const neverOperation: never = command.operation;
        throw new Error(`unsupported Telegram operation: ${String(neverOperation)}`);
      }
    }
    const providerRef = messageRefFromResponse(account, response);
    return {
      operation: command.operation,
      ...(providerRef ? { providerRef } : {}),
      payload: response,
    };
  }
}

class TelegramTdlibAdapter implements TelegramTdlibAdapterPort {
  readonly manifest = TELEGRAM_TDLIB_MANIFEST;
  private readonly options: TelegramConnectorOptions;

  constructor(options: TelegramConnectorOptions) {
    if (!options.applicationVersion.trim()) throw new TypeError("Telegram applicationVersion is required");
    this.options = options;
  }

  async open(context: ConnectorOpenContext): Promise<TelegramTdlibSessionPort> {
    if (context.platform === "web") throw new Error("Native TDLib connector is unavailable in the plain web client");
    if (context.platform !== this.options.bridge.platform) {
      throw new Error(`TDLib bridge platform ${this.options.bridge.platform} does not match ${context.platform}`);
    }
    const info = await this.options.bridge.info();
    if (!info.available) throw new Error(`TDLib is unavailable${info.reason ? `: ${info.reason}` : ""}`);
    if (!info.configured) throw new Error("Telegram application credentials are not configured in the native shell");
    const vaultCapability = nativeConnectorVaultCapability(context.vault) ?? undefined;
    const normalized = {
      ...this.options,
      requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      qrTtlSeconds: this.options.qrTtlSeconds ?? DEFAULT_QR_TTL_SECONDS,
      logVerbosity: this.options.logVerbosity ?? 2,
      useTestDc: this.options.useTestDc === true,
      useFileDatabase: this.options.useFileDatabase !== false,
      useChatInfoDatabase: this.options.useChatInfoDatabase !== false,
      useMessageDatabase: this.options.useMessageDatabase !== false,
      useSecretChats: this.options.useSecretChats === true,
    };
    const client = await this.options.bridge.create({
      logVerbosity: normalized.logVerbosity,
      ...(vaultCapability ? { vaultCapability } : {}),
    });
    const session = new TelegramTdlibSession(normalized, context, client, vaultCapability);
    try {
      await session.start();
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }
}

export function createTelegramTdlibAdapter(options: TelegramConnectorOptions): TelegramTdlibAdapterPort {
  return new TelegramTdlibAdapter(options);
}

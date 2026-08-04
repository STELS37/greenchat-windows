// clients/core/src/connectors.ts — provider-neutral external messenger connector contract (T-451).
//
// This file deliberately contains no Telegram/WhatsApp SDK code. It defines the narrow seam that native
// provider adapters implement. The host injects an account-scoped vault and never exposes GreenChat auth,
// wallet, card or ledger secrets to an adapter. Provider differences remain explicit through capability
// negotiation; GreenChat features are never reduced to the least-capable external provider.

export const CONNECTOR_CAPABILITIES = [
  "chats.read",
  "history.read",
  "messages.receive",
  "messages.send",
  "messages.edit",
  "messages.delete",
  "messages.reply",
  "messages.forward",
  "reactions",
  "typing",
  "read_receipts",
  "files",
  "groups",
  "channels",
  "threads",
  "polls",
  "stories",
  "calls",
  "secret_chats",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];
export type ConnectorCapabilityState = "supported" | "conditional" | "unsupported";
export type ConnectorCapabilitySource = "provider" | "account" | "chat" | "default";

export interface ConnectorCapabilityDecision {
  state: ConnectorCapabilityState;
  source?: ConnectorCapabilitySource;
  /** Stable machine-readable reason such as `business_account_required` or `region_unavailable`. */
  reason?: string;
}

export type ConnectorCapabilityOverrides = Partial<
  Readonly<Record<ConnectorCapability, ConnectorCapabilityDecision>>
>;
export type ConnectorCapabilityMatrix = Readonly<Record<ConnectorCapability, ConnectorCapabilityDecision>>;

export interface ConnectorCapabilityLayers {
  provider: ConnectorCapabilityOverrides;
  account?: ConnectorCapabilityOverrides;
  chat?: ConnectorCapabilityOverrides;
}

const DEFAULT_UNSUPPORTED: ConnectorCapabilityDecision = Object.freeze({
  state: "unsupported",
  source: "default",
  reason: "not_declared",
});

function cloneDecision(
  decision: ConnectorCapabilityDecision,
  source: ConnectorCapabilitySource,
): ConnectorCapabilityDecision {
  return {
    state: decision.state,
    source,
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
  };
}

/** Resolve provider → account → chat capability overrides, with the narrowest scope winning. */
export function resolveConnectorCapabilities(layers: ConnectorCapabilityLayers): ConnectorCapabilityMatrix {
  const resolved = {} as Record<ConnectorCapability, ConnectorCapabilityDecision>;
  for (const capability of CONNECTOR_CAPABILITIES) {
    const chat = layers.chat?.[capability];
    const account = layers.account?.[capability];
    const provider = layers.provider[capability];
    resolved[capability] = chat
      ? cloneDecision(chat, "chat")
      : account
        ? cloneDecision(account, "account")
        : provider
          ? cloneDecision(provider, "provider")
          : DEFAULT_UNSUPPORTED;
  }
  return Object.freeze(resolved);
}

export class ConnectorCapabilityError extends Error {
  readonly capability: ConnectorCapability;
  readonly decision: ConnectorCapabilityDecision;

  constructor(capability: ConnectorCapability, decision: ConnectorCapabilityDecision) {
    const suffix = decision.reason ? ` (${decision.reason})` : "";
    super(`Connector capability ${capability} is ${decision.state}${suffix}`);
    this.name = "ConnectorCapabilityError";
    this.capability = capability;
    this.decision = decision;
  }
}

/** Conditional capabilities must be checked by provider-specific UI unless explicitly accepted. */
export function requireConnectorCapability(
  matrix: ConnectorCapabilityMatrix,
  capability: ConnectorCapability,
  options: { allowConditional?: boolean } = {},
): ConnectorCapabilityDecision {
  const decision = matrix[capability];
  if (decision.state === "supported") return decision;
  if (decision.state === "conditional" && options.allowConditional === true) return decision;
  throw new ConnectorCapabilityError(capability, decision);
}

export type ConnectorPlatform = "web" | "desktop" | "android" | "ios";

export interface ConnectorCompliance {
  /** Production registry accepts only official integrations unless explicitly put in experimental mode. */
  official: boolean;
  reviewedAt: string;
  termsUrl?: string;
  regionNotes?: string;
}

export interface ConnectorManifest {
  provider: string;
  displayName: string;
  implementation: string;
  platforms: readonly ConnectorPlatform[];
  capabilities: ConnectorCapabilityOverrides;
  compliance: ConnectorCompliance;
}

export interface ConnectorAccountRef {
  provider: string;
  accountId: string;
}

export interface ConnectorChatRef extends ConnectorAccountRef {
  chatId: string;
}

export interface ConnectorMessageRef extends ConnectorChatRef {
  messageId: string;
}

function assertOpaqueId(value: string, name: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${name} must be a non-empty opaque string without control characters`);
  }
}

export function assertConnectorProviderId(provider: string): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(provider)) {
    throw new TypeError("provider must match ^[a-z][a-z0-9_.-]{1,63}$");
  }
}

export function assertConnectorAccountRef(ref: ConnectorAccountRef): void {
  assertConnectorProviderId(ref.provider);
  assertOpaqueId(ref.accountId, "accountId", 512);
}

export function assertConnectorChatRef(ref: ConnectorChatRef): void {
  assertConnectorAccountRef(ref);
  assertOpaqueId(ref.chatId, "chatId", 512);
}

export function assertConnectorMessageRef(ref: ConnectorMessageRef): void {
  assertConnectorChatRef(ref);
  assertOpaqueId(ref.messageId, "messageId", 512);
}

/** Collision-safe stable keys. IDs remain opaque and are never split on provider-controlled delimiters. */
export function connectorAccountKey(ref: ConnectorAccountRef): string {
  assertConnectorAccountRef(ref);
  return JSON.stringify([ref.provider, ref.accountId]);
}

export function connectorChatKey(ref: ConnectorChatRef): string {
  assertConnectorChatRef(ref);
  return JSON.stringify([ref.provider, ref.accountId, ref.chatId]);
}

export function connectorMessageKey(ref: ConnectorMessageRef): string {
  assertConnectorMessageRef(ref);
  return JSON.stringify([ref.provider, ref.accountId, ref.chatId, ref.messageId]);
}

export type ConnectorLoginState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "suspended" }
  | { status: "awaiting_phone" }
  | { status: "awaiting_qr"; qrPayload: string; expiresAt: string }
  | { status: "awaiting_code"; destinationHint?: string }
  | { status: "awaiting_password"; passwordHint?: string }
  | { status: "ready"; account: ConnectorAccountRef }
  | { status: "revoked"; reason?: string }
  | { status: "error"; code: string; retryable: boolean; message: string };

export type ConnectorAuthInput =
  | { kind: "phone"; phone: string }
  | { kind: "code"; code: string }
  | { kind: "password"; password: string }
  | { kind: "qr_refresh" }
  | { kind: "cancel" };

/** Account-scoped encrypted storage. The host binds provider/account; cross-account reads are impossible. */
export interface ScopedConnectorVault {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, value: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
  wipe(): Promise<void>;
  /** Release a native capability lease when the owning account/controller is discarded. */
  dispose?(): Promise<void>;
}

export interface ConnectorOpenContext {
  platform: ConnectorPlatform;
  vault: ScopedConnectorVault;
  accountHint?: string;
  now?: () => Date;
  randomId?: () => string;
  onDiagnostic?: (event: ConnectorDiagnostic) => void;
}

export interface ConnectorDiagnostic {
  level: "debug" | "info" | "warn" | "error";
  code: string;
  /** Must already be redacted: no message text, credentials, tokens or contact identifiers. */
  detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface ConnectorChat {
  ref: ConnectorChatRef;
  title: string;
  kind: "dialog" | "group" | "channel" | "saved" | "unknown";
  unreadCount: number;
  updatedAt: string;
  capabilities?: ConnectorCapabilityOverrides;
  raw?: Readonly<Record<string, unknown>>;
}

export interface ConnectorMessage {
  ref: ConnectorMessageRef;
  senderId?: string;
  sentAt: string;
  editedAt?: string;
  text?: string;
  replyTo?: ConnectorMessageRef;
  raw?: Readonly<Record<string, unknown>>;
}

export interface ConnectorSyncRequest {
  cursor?: string;
  limit: number;
}

export interface ConnectorSyncPage {
  cursor: string;
  hasMore: boolean;
  events: readonly ConnectorEvent[];
}

export type ConnectorEventKind =
  | "account.updated"
  | "chat.upserted"
  | "chat.removed"
  | "message.upserted"
  | "message.removed"
  | "read.updated"
  | "typing.updated"
  | "capabilities.updated";

export interface ConnectorEvent {
  /** Hub-local unsigned decimal sequence, serialized as string to stay safe above Number.MAX_SAFE_INTEGER. */
  sequence: string;
  /** Provider cursor is opaque and only returned to the same adapter. */
  providerCursor?: string;
  dedupeKey: string;
  account: ConnectorAccountRef;
  kind: ConnectorEventKind;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export type ConnectorOperation =
  | "chats.list"
  | "history.sync"
  | "message.send"
  | "message.edit"
  | "message.delete"
  | "message.reply"
  | "message.forward"
  | "reaction.set"
  | "typing.set"
  | "read.mark"
  | "file.send"
  | "poll.send"
  | "story.publish"
  | "call.start";

export const CONNECTOR_OPERATION_CAPABILITY: Readonly<Record<ConnectorOperation, ConnectorCapability>> =
  Object.freeze({
    "chats.list": "chats.read",
    "history.sync": "history.read",
    "message.send": "messages.send",
    "message.edit": "messages.edit",
    "message.delete": "messages.delete",
    "message.reply": "messages.reply",
    "message.forward": "messages.forward",
    "reaction.set": "reactions",
    "typing.set": "typing",
    "read.mark": "read_receipts",
    "file.send": "files",
    "poll.send": "polls",
    "story.publish": "stories",
    "call.start": "calls",
  });

const MUTATING_OPERATIONS = new Set<ConnectorOperation>([
  "message.send",
  "message.edit",
  "message.delete",
  "message.reply",
  "message.forward",
  "reaction.set",
  "typing.set",
  "read.mark",
  "file.send",
  "poll.send",
  "story.publish",
  "call.start",
]);

export interface ConnectorCommand {
  operation: ConnectorOperation;
  account: ConnectorAccountRef;
  chat?: ConnectorChatRef;
  /** Mandatory for mutations so reconnect/retry cannot duplicate an external action. */
  idempotencyKey?: string;
  payload?: Readonly<Record<string, unknown>>;
}

export interface ConnectorCommandResult {
  operation: ConnectorOperation;
  providerRef?: Readonly<Record<string, string>>;
  payload?: Readonly<Record<string, unknown>>;
}

export function validateConnectorCommand(
  command: ConnectorCommand,
  capabilities: ConnectorCapabilityMatrix,
): void {
  assertConnectorAccountRef(command.account);
  if (command.chat) {
    assertConnectorChatRef(command.chat);
    if (
      command.chat.provider !== command.account.provider ||
      command.chat.accountId !== command.account.accountId
    ) {
      throw new TypeError("command chat must belong to command account");
    }
  }
  if (MUTATING_OPERATIONS.has(command.operation)) {
    if (!command.idempotencyKey || command.idempotencyKey.length > 256) {
      throw new TypeError("mutating connector command requires idempotencyKey (1..256 chars)");
    }
    assertOpaqueId(command.idempotencyKey, "idempotencyKey", 256);
  }
  requireConnectorCapability(capabilities, CONNECTOR_OPERATION_CAPABILITY[command.operation]);
}

export interface ConnectorSession {
  loginState(): ConnectorLoginState;
  submitAuth(input: ConnectorAuthInput): Promise<ConnectorLoginState>;
  account(): ConnectorAccountRef | null;
  capabilities(scope?: { chat?: ConnectorChatRef }): Promise<ConnectorCapabilityMatrix>;
  sync(request: ConnectorSyncRequest): Promise<ConnectorSyncPage>;
  execute(command: ConnectorCommand): Promise<ConnectorCommandResult>;
  subscribe(listener: (event: ConnectorEvent) => void): () => void;
  revoke(): Promise<void>;
  wipeLocal(): Promise<void>;
  close(): Promise<void>;
}

export interface ConnectorAdapter {
  readonly manifest: ConnectorManifest;
  open(context: ConnectorOpenContext): Promise<ConnectorSession>;
}

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  private readonly allowUnofficial: boolean;

  constructor(options: { allowUnofficial?: boolean } = {}) {
    this.allowUnofficial = options.allowUnofficial === true;
  }

  register(adapter: ConnectorAdapter): void {
    const { manifest } = adapter;
    assertConnectorProviderId(manifest.provider);
    if (!manifest.displayName.trim() || !manifest.implementation.trim()) {
      throw new TypeError("connector manifest displayName and implementation are required");
    }
    if (!manifest.compliance.official && !this.allowUnofficial) {
      throw new TypeError(`unofficial connector ${manifest.provider} is disabled by production policy`);
    }
    if (this.adapters.has(manifest.provider)) {
      throw new TypeError(`connector provider already registered: ${manifest.provider}`);
    }
    this.adapters.set(manifest.provider, adapter);
  }

  get(provider: string): ConnectorAdapter | undefined {
    return this.adapters.get(provider);
  }

  list(): readonly ConnectorManifest[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.manifest)
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }
}

const DECIMAL_SEQUENCE = /^(0|[1-9][0-9]*)$/u;

export function normalizeConnectorSequence(sequence: string): string {
  if (!DECIMAL_SEQUENCE.test(sequence)) {
    throw new TypeError("connector sequence must be an unsigned canonical decimal string");
  }
  return sequence;
}

export function compareConnectorSequence(a: string, b: string): -1 | 0 | 1 {
  const left = normalizeConnectorSequence(a);
  const right = normalizeConnectorSequence(b);
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export type ConnectorEventVerdict = "apply" | "duplicate" | "stale";

/**
 * Per-account ordered-event/idempotency gate. A higher-sequence duplicate advances the cursor but is not
 * applied twice; stale/out-of-order events never mutate state. The dedupe window is bounded.
 */
export class ConnectorEventGate {
  private lastSequenceValue: string | null = null;
  private readonly seen = new Map<string, true>();
  private readonly maxDedupeEntries: number;

  constructor(maxDedupeEntries = 4096) {
    if (!Number.isInteger(maxDedupeEntries) || maxDedupeEntries < 1) {
      throw new TypeError("maxDedupeEntries must be a positive integer");
    }
    this.maxDedupeEntries = maxDedupeEntries;
  }

  lastSequence(): string | null {
    return this.lastSequenceValue;
  }

  accept(event: ConnectorEvent): ConnectorEventVerdict {
    normalizeConnectorSequence(event.sequence);
    assertConnectorAccountRef(event.account);
    assertOpaqueId(event.dedupeKey, "dedupeKey", 1024);

    if (
      this.lastSequenceValue !== null &&
      compareConnectorSequence(event.sequence, this.lastSequenceValue) <= 0
    ) {
      return "stale";
    }

    this.lastSequenceValue = event.sequence;
    if (this.seen.has(event.dedupeKey)) return "duplicate";

    this.seen.set(event.dedupeKey, true);
    while (this.seen.size > this.maxDedupeEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return "apply";
  }

  reset(): void {
    this.lastSequenceValue = null;
    this.seen.clear();
  }
}

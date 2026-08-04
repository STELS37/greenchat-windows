import assert from "node:assert/strict";
import test from "node:test";

import {
  ConnectorCapabilityError,
  ConnectorEventGate,
  ConnectorRegistry,
  compareConnectorSequence,
  connectorAccountKey,
  connectorChatKey,
  connectorMessageKey,
  normalizeConnectorSequence,
  requireConnectorCapability,
  resolveConnectorCapabilities,
  validateConnectorCommand,
  type ConnectorAdapter,
  type ConnectorCapabilityMatrix,
  type ConnectorEvent,
  type ConnectorManifest,
} from "../src/connectors.ts";

const telegramManifest: ConnectorManifest = {
  provider: "telegram",
  displayName: "Telegram",
  implementation: "tdlib-native",
  platforms: ["desktop", "android", "ios"],
  capabilities: {
    "chats.read": { state: "supported" },
    "history.read": { state: "supported" },
    "messages.send": { state: "supported" },
  },
  compliance: {
    official: true,
    reviewedAt: "2026-07-17",
    termsUrl: "https://core.telegram.org/api/terms",
  },
};

function adapter(manifest: ConnectorManifest): ConnectorAdapter {
  return {
    manifest,
    async open() {
      throw new Error("not used in contract test");
    },
  };
}

function matrix(): ConnectorCapabilityMatrix {
  return resolveConnectorCapabilities({
    provider: {
      "chats.read": { state: "supported" },
      "history.read": { state: "supported" },
      "messages.send": { state: "supported" },
      "messages.edit": { state: "unsupported", reason: "provider_limit" },
    },
  });
}

function event(sequence: string, dedupeKey: string): ConnectorEvent {
  return {
    sequence,
    dedupeKey,
    account: { provider: "telegram", accountId: "42" },
    kind: "message.upserted",
    occurredAt: "2026-07-17T10:00:00.000Z",
    payload: {},
  };
}

test("capabilities resolve provider -> account -> chat and unknown defaults fail closed", () => {
  const resolved = resolveConnectorCapabilities({
    provider: {
      "messages.send": { state: "supported" },
      calls: { state: "conditional", reason: "native_only" },
    },
    account: {
      "messages.send": { state: "conditional", reason: "account_review" },
    },
    chat: {
      "messages.send": { state: "unsupported", reason: "read_only_chat" },
    },
  });

  assert.deepEqual(resolved["messages.send"], {
    state: "unsupported",
    source: "chat",
    reason: "read_only_chat",
  });
  assert.deepEqual(resolved.calls, {
    state: "conditional",
    source: "provider",
    reason: "native_only",
  });
  assert.deepEqual(resolved.stories, {
    state: "unsupported",
    source: "default",
    reason: "not_declared",
  });
});

test("conditional capability is explicit and cannot silently pass", () => {
  const resolved = resolveConnectorCapabilities({
    provider: { calls: { state: "conditional", reason: "device_support_required" } },
  });

  assert.throws(
    () => requireConnectorCapability(resolved, "calls"),
    (error: unknown) =>
      error instanceof ConnectorCapabilityError && error.decision.reason === "device_support_required",
  );
  assert.equal(requireConnectorCapability(resolved, "calls", { allowConditional: true }).state, "conditional");
});

test("external reference keys are stable and collision-safe for provider-controlled delimiters", () => {
  const account = connectorAccountKey({ provider: "telegram", accountId: "a:b/c" });
  const chat = connectorChatKey({ provider: "telegram", accountId: "a:b", chatId: "c/d" });
  const message = connectorMessageKey({
    provider: "telegram",
    accountId: "a",
    chatId: "b:c",
    messageId: "d/e",
  });

  assert.notEqual(account, chat);
  assert.notEqual(chat, message);
  assert.deepEqual(JSON.parse(account), ["telegram", "a:b/c"]);
  assert.deepEqual(JSON.parse(chat), ["telegram", "a:b", "c/d"]);
});

test("registry rejects unofficial connectors by default and duplicate provider registrations", () => {
  const registry = new ConnectorRegistry();
  registry.register(adapter(telegramManifest));
  assert.equal(registry.get("telegram")?.manifest.implementation, "tdlib-native");

  assert.throws(() => registry.register(adapter(telegramManifest)), /already registered/u);

  const unofficial: ConnectorManifest = {
    ...telegramManifest,
    provider: "whatsapp_web_reverse",
    displayName: "Experimental WhatsApp Web",
    compliance: { official: false, reviewedAt: "2026-07-17" },
  };
  assert.throws(() => new ConnectorRegistry().register(adapter(unofficial)), /disabled by production policy/u);

  const experimental = new ConnectorRegistry({ allowUnofficial: true });
  experimental.register(adapter(unofficial));
  assert.equal(experimental.list()[0]?.provider, "whatsapp_web_reverse");
});

test("mutating commands require idempotency and cannot cross connector accounts", () => {
  const capabilities = matrix();
  const account = { provider: "telegram", accountId: "user-1" };

  assert.throws(
    () => validateConnectorCommand({ operation: "message.send", account }, capabilities),
    /requires idempotencyKey/u,
  );

  assert.doesNotThrow(() =>
    validateConnectorCommand(
      {
        operation: "message.send",
        account,
        chat: { ...account, chatId: "chat-1" },
        idempotencyKey: "send:client-message-123",
        payload: { text: "hello" },
      },
      capabilities,
    ),
  );

  assert.throws(
    () =>
      validateConnectorCommand(
        {
          operation: "message.send",
          account,
          chat: { provider: "telegram", accountId: "user-2", chatId: "chat-1" },
          idempotencyKey: "send:client-message-124",
        },
        capabilities,
      ),
    /must belong to command account/u,
  );

  assert.throws(
    () =>
      validateConnectorCommand(
        {
          operation: "message.edit",
          account,
          idempotencyKey: "edit:1",
        },
        capabilities,
      ),
    ConnectorCapabilityError,
  );
});

test("decimal sequence comparison stays exact above Number.MAX_SAFE_INTEGER", () => {
  assert.equal(compareConnectorSequence("9007199254740992", "9007199254740993"), -1);
  assert.equal(compareConnectorSequence("18446744073709551616", "9999999999999999999"), 1);
  assert.equal(compareConnectorSequence("42", "42"), 0);
  assert.equal(normalizeConnectorSequence("0"), "0");
  assert.throws(() => normalizeConnectorSequence("01"), /canonical decimal/u);
  assert.throws(() => normalizeConnectorSequence("-1"), /canonical decimal/u);
});

test("event gate applies once, advances over higher-sequence duplicates and rejects stale events", () => {
  const gate = new ConnectorEventGate(2);

  assert.equal(gate.accept(event("1", "telegram:update:100")), "apply");
  assert.equal(gate.accept(event("2", "telegram:update:100")), "duplicate");
  assert.equal(gate.lastSequence(), "2");
  assert.equal(gate.accept(event("2", "telegram:update:101")), "stale");
  assert.equal(gate.accept(event("3", "telegram:update:101")), "apply");
  assert.equal(gate.accept(event("4", "telegram:update:102")), "apply");

  // The bounded window evicted the oldest key, but ordering still prevents historical replay.
  assert.equal(gate.accept(event("5", "telegram:update:100")), "apply");
  assert.equal(gate.lastSequence(), "5");
  gate.reset();
  assert.equal(gate.lastSequence(), null);
  assert.equal(gate.accept(event("1", "telegram:update:100")), "apply");
});

// Post-merge cursor/resync safety: explicit zero is a replay cursor and full resync is an async barrier.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { ApiClient } from "../src/api.ts";
import { SyncEngine } from "../src/sync.ts";
import type { SyncEvent } from "../src/types.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

class ControlledWebSocket {
  static instances: ControlledWebSocket[] = [];
  static frames: Array<Record<string, unknown>> = [];

  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  readyState = 0;

  constructor(_url: string) {
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
    });
  }

  send(data: string): void {
    ControlledWebSocket.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "closed"): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  static reset(): void {
    this.instances = [];
    this.frames = [];
  }
}

function api(baseUrl = "http://127.0.0.1:1"): ApiClient {
  return new ApiClient({
    baseUrl,
    clientId: "qa/cursor-safety",
    tokens: { access: "test", refresh: null, accessExpiresAt: null },
    maxRetries: 0,
  });
}

test("SyncEngine reports the aggregate delivery path instead of equating a dead socket with a dead app", async () => {
  const retry = deferred();
  let requests = 0;
  const fakeApi = {
    tokens: { access: "test", refresh: null, accessExpiresAt: null },
    refreshTokens: async () => true,
    get: async () => {
      requests++;
      if (requests === 1) throw new Error("long-poll failed");
      if (requests === 2) return { events: [], next_since: 0 };
      return new Promise<never>(() => {});
    },
  } as unknown as ApiClient;
  class NeverWebSocket {
    onopen = null; onmessage = null; onclose = null; onerror = null; readyState = 0;
    constructor(_url: string) {}
    send(_data: string): void {}
    close(): void {}
  }
  const engine = new SyncEngine({
    api: fakeApi,
    baseUrl: "http://unused.invalid",
    wsImpl: NeverWebSocket as unknown as typeof WebSocket,
    onEvent: () => undefined,
    sleepImpl: () => retry.promise,
    pollErrorBackoffMs: 1,
  });

  assert.equal(engine.getDeliveryState(), "stopped");
  engine.start();
  assert.equal(engine.getDeliveryState(), "fallback", "an in-flight long-poll is the active delivery path");
  await waitFor(() => engine.getDeliveryState() === "unavailable");

  retry.resolve();
  await waitFor(() => requests >= 3 && engine.getDeliveryState() === "fallback");
  engine.stop();
  assert.equal(engine.getDeliveryState(), "stopped");
});

test("SyncEngine distinguishes an unseeded cold start from an explicit replay cursor zero", async () => {
  ControlledWebSocket.reset();
  const cold = new SyncEngine({
    api: api(),
    baseUrl: "http://127.0.0.1:1",
    wsImpl: ControlledWebSocket as unknown as typeof WebSocket,
    onEvent: () => undefined,
    sleepImpl: () => new Promise<void>(() => {}), // no timer/open handle while WS owns transport
    pollErrorBackoffMs: 60_000,
  });
  cold.start();
  await waitFor(() => ControlledWebSocket.frames.length === 1);
  assert.equal("since" in ControlledWebSocket.frames[0]!, false, "an engine never seeded by storage is cold");
  ControlledWebSocket.instances[0]!.emit({ type: "hello", user_id: 1, session_id: 1, now: 1, last_seq: 10 });
  cold.stop();

  ControlledWebSocket.reset();
  const replay = new SyncEngine({
    api: api(),
    baseUrl: "http://127.0.0.1:1",
    wsImpl: ControlledWebSocket as unknown as typeof WebSocket,
    onEvent: () => undefined,
    sleepImpl: () => new Promise<void>(() => {}),
    pollErrorBackoffMs: 60_000,
  });
  replay.setCursor(0); // a failed first durable cache write restarts from this exact cursor
  replay.start();
  await waitFor(() => ControlledWebSocket.frames.length === 1);
  assert.equal(ControlledWebSocket.frames[0]!["since"], 0, "explicit zero must be sent, not collapsed into cold start");
  replay.stop();
});

test("failed resync keeps the old cursor and retries before acknowledging the server head", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { events: [], next_since: 42, resync: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const firstAttempt = deferred();
  const retryGate = deferred();
  let attempts = 0;
  const persisted: number[] = [];
  const engine = new SyncEngine({
    api: api(baseUrl),
    baseUrl,
    wsImpl: class {
      onopen = null; onmessage = null; onclose = null; onerror = null; readyState = 0;
      constructor(_url: string) {}
      send(_data: string): void {}
      close(): void {}
    } as unknown as typeof WebSocket,
    onEvent: () => undefined,
    onCursor: (cursor) => { persisted.push(cursor); },
    onResync: () => {
      attempts++;
      firstAttempt.resolve();
      if (attempts === 1) throw new Error("full refetch failed");
    },
    sleepImpl: () => retryGate.promise,
    pollErrorBackoffMs: 1,
    longPollTimeoutSec: 1,
  });
  engine.setCursor(5);

  try {
    engine.start();
    await firstAttempt.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(engine.getCursor(), 5, "failed refetch must leave the in-memory cursor replayable");
    assert.equal(persisted.includes(42), false, "failed refetch must not persist the head");

    retryGate.resolve();
    await waitFor(() => attempts >= 2 && engine.getCursor() === 42);
    assert.equal(persisted.at(-1), 42);
    assert.ok(requests >= 1);
  } finally {
    engine.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("WebSocket live events are buffered until async full resync succeeds", async () => {
  ControlledWebSocket.reset();
  const gate = deferred();
  const started = deferred();
  const events: SyncEvent[] = [];
  const cursors: number[] = [];
  const engine = new SyncEngine({
    api: api(),
    baseUrl: "http://127.0.0.1:1",
    wsImpl: ControlledWebSocket as unknown as typeof WebSocket,
    onEvent: (event) => { events.push(event); },
    onCursor: (cursor) => { cursors.push(cursor); },
    onResync: async () => {
      started.resolve();
      await gate.promise;
    },
    sleepImpl: () => new Promise<void>(() => {}),
    pollErrorBackoffMs: 60_000,
  });
  engine.setCursor(5);
  engine.start();
  await waitFor(() => ControlledWebSocket.frames.length === 1);
  const socket = ControlledWebSocket.instances[0]!;
  socket.emit({ type: "hello", user_id: 1, session_id: 1, now: 1, last_seq: 42, resync: true });
  await started.promise;
  socket.emit({
    type: "event",
    seq: 43,
    event_type: "message.new",
    payload: { message: { id: 43, chat_id: 1, text: "after snapshot" } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(engine.getCursor(), 5, "head is not acknowledged while the snapshot is incomplete");
  assert.equal(events.length, 0, "post-head events wait behind the snapshot barrier");
  assert.equal(cursors.includes(42), false);

  gate.resolve();
  await waitFor(() => engine.getCursor() === 43 && events.length === 1);
  assert.equal(events[0]!.seq, 43);
  assert.deepEqual(cursors.slice(-2), [42, 43]);
  engine.stop();
});


test("stop/account-switch invalidates an old resync completion and its buffered events", async () => {
  ControlledWebSocket.reset();
  const gate = deferred();
  const started = deferred();
  const events: SyncEvent[] = [];
  const engine = new SyncEngine({
    api: api(),
    baseUrl: "http://127.0.0.1:1",
    wsImpl: ControlledWebSocket as unknown as typeof WebSocket,
    onEvent: (event) => { events.push(event); },
    onResync: async () => { started.resolve(); await gate.promise; },
    sleepImpl: () => new Promise<void>(() => {}),
  });
  engine.setCursor(5);
  engine.start();
  await waitFor(() => ControlledWebSocket.frames.length === 1);
  ControlledWebSocket.instances[0]!.emit({ type: "hello", user_id: 1, session_id: 1, now: 1, last_seq: 42, resync: true });
  await started.promise;
  ControlledWebSocket.instances[0]!.emit({
    type: "event", seq: 43, event_type: "message.new", payload: { message: { id: 43, chat_id: 1 } },
  });

  engine.stop();
  engine.setCursor(0); // next account
  gate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(engine.getCursor(), 0, "old snapshot completion cannot advance the new account");
  assert.equal(events.length, 0, "old-account buffered events are discarded on stop");
});

test("a newer resync head arriving mid-snapshot is refetched before any head is acknowledged", async () => {
  ControlledWebSocket.reset();
  const firstGate = deferred();
  const secondGate = deferred();
  const heads: Array<number | null> = [];
  const cursors: number[] = [];
  const engine = new SyncEngine({
    api: api(),
    baseUrl: "http://127.0.0.1:1",
    wsImpl: ControlledWebSocket as unknown as typeof WebSocket,
    onEvent: () => undefined,
    onCursor: (cursor) => { cursors.push(cursor); },
    onResync: async (head) => {
      heads.push(head);
      if (heads.length === 1) await firstGate.promise;
      else await secondGate.promise;
    },
    sleepImpl: () => new Promise<void>(() => {}),
  });
  engine.setCursor(5);
  engine.start();
  await waitFor(() => ControlledWebSocket.frames.length === 1);
  const socket = ControlledWebSocket.instances[0]!;
  socket.emit({ type: "hello", user_id: 1, session_id: 1, now: 1, last_seq: 42, resync: true });
  await waitFor(() => heads.length === 1);
  socket.emit({ type: "hello", user_id: 1, session_id: 1, now: 2, last_seq: 50, resync: true });
  firstGate.resolve();
  await waitFor(() => heads.length === 2);
  assert.deepEqual(heads, [42, 50]);
  assert.equal(engine.getCursor(), 5, "the superseded head 42 was never acknowledged");
  assert.equal(cursors.includes(42), false);

  secondGate.resolve();
  await waitFor(() => engine.getCursor() === 50);
  assert.equal(cursors.at(-1), 50);
  engine.stop();
});

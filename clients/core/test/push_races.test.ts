// QA — deterministic push-token lifecycle races. The newest bridge event must be authoritative,
// token loss must unsubscribe, and a late initial snapshot must never overwrite a fresher callback.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerPush,
  type PushApi,
  type PushBridge,
  type PushData,
  type PushToken,
} from "../src/push.ts";

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("waitFor timeout");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

class Bridge implements PushBridge {
  private readonly tokenListeners = new Set<(token: PushToken | null) => void>();
  private readonly initial: Promise<PushToken | null>;

  constructor(initial: PushToken | null | Promise<PushToken | null>) {
    this.initial = Promise.resolve(initial);
  }

  getToken(): Promise<PushToken | null> { return this.initial; }
  onToken(cb: (token: PushToken | null) => void): () => void {
    this.tokenListeners.add(cb);
    return () => { this.tokenListeners.delete(cb); };
  }
  onPush(_cb: (data: PushData) => void): () => void { return () => undefined; }
  setBadge(_count: number): void {}
  emit(token: PushToken | null): void { for (const cb of [...this.tokenListeners]) cb(token); }
}

interface Call {
  path: string;
  endpoint: string;
}

class ControlledApi implements PushApi {
  readonly calls: Call[] = [];
  readonly subscribeGates = new Map<string, ReturnType<typeof deferred<unknown>>>();

  post<T>(path: string, body?: unknown): Promise<T> {
    const endpoint = (body as { endpoint?: unknown } | undefined)?.endpoint;
    const ep = typeof endpoint === "string" ? endpoint : "";
    this.calls.push({ path, endpoint: ep });
    if (path === "/v1/push/subscribe") {
      let gate = this.subscribeGates.get(ep);
      if (!gate) {
        gate = deferred<unknown>();
        this.subscribeGates.set(ep, gate);
      }
      return gate.promise as Promise<T>;
    }
    return Promise.resolve({ removed: 1 } as T);
  }

  resolveSubscribe(endpoint: string): void {
    const gate = this.subscribeGates.get(endpoint);
    if (!gate) throw new Error(`missing subscribe gate for ${endpoint}`);
    gate.resolve({ id: endpoint });
  }

  unsubscribed(endpoint: string): boolean {
    return this.calls.some((call) => call.path === "/v1/push/unsubscribe" && call.endpoint === endpoint);
  }
}

const fcm = (endpoint: string): PushToken => ({ platform: "fcm", endpoint });

test("registerPush serializes overlapping token updates and always retires the stale endpoint", async () => {
  const api = new ControlledApi();
  const bridge = new Bridge(null);
  const reg = registerPush(api, bridge);

  bridge.emit(fcm("token-old"));
  bridge.emit(fcm("token-new"));
  await waitFor(() => api.subscribeGates.has("token-old"));

  api.resolveSubscribe("token-old");
  await waitFor(() => api.unsubscribed("token-old") && api.subscribeGates.has("token-new"));
  api.resolveSubscribe("token-new");

  await waitFor(() => reg.endpoint() === "token-new");
  assert.equal(api.unsubscribed("token-old"), true, "the stale successful subscription is retired");
  assert.equal(reg.endpoint(), "token-new");
  await reg.stop();
});

test("registerPush treats token=null as authoritative loss and unsubscribes the live endpoint", async () => {
  const api = new ControlledApi();
  const bridge = new Bridge(fcm("token-live"));
  const reg = registerPush(api, bridge);

  await waitFor(() => api.subscribeGates.has("token-live"));
  api.resolveSubscribe("token-live");
  await waitFor(() => reg.endpoint() === "token-live");

  bridge.emit(null);
  await waitFor(() => reg.endpoint() === null);
  assert.equal(api.unsubscribed("token-live"), true);
  await reg.stop();
});

test("registerPush ignores a late initial getToken snapshot after a fresher token callback", async () => {
  const initial = deferred<PushToken | null>();
  const api = new ControlledApi();
  const bridge = new Bridge(initial.promise);
  const reg = registerPush(api, bridge);

  bridge.emit(fcm("token-fresh"));
  await waitFor(() => api.subscribeGates.has("token-fresh"));
  api.resolveSubscribe("token-fresh");
  await waitFor(() => reg.endpoint() === "token-fresh");

  initial.resolve(fcm("token-stale-snapshot"));
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(reg.endpoint(), "token-fresh");
  assert.equal(api.subscribeGates.has("token-stale-snapshot"), false, "late initial snapshot is ignored");
  await reg.stop();
});


test("registerPush coalesces duplicate callbacks for the same token while subscribe is pending", async () => {
  const api = new ControlledApi();
  const bridge = new Bridge(null);
  const reg = registerPush(api, bridge);

  bridge.emit(fcm("token-same"));
  bridge.emit(fcm("token-same"));
  await waitFor(() => api.subscribeGates.has("token-same"));
  api.resolveSubscribe("token-same");
  await waitFor(() => reg.endpoint() === "token-same");
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const subscribes = api.calls.filter(
    (call) => call.path === "/v1/push/subscribe" && call.endpoint === "token-same",
  );
  assert.equal(subscribes.length, 1);
  await reg.stop();
});

test("registerPush stop waits for an in-flight subscribe and removes the resulting endpoint", async () => {
  const api = new ControlledApi();
  const bridge = new Bridge(null);
  const reg = registerPush(api, bridge);

  bridge.emit(fcm("token-stop-race"));
  await waitFor(() => api.subscribeGates.has("token-stop-race"));
  let stopped = false;
  const stop = reg.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "stop waits for the request already accepted by the transport");

  api.resolveSubscribe("token-stop-race");
  await stop;
  assert.equal(reg.endpoint(), null);
  assert.equal(api.unsubscribed("token-stop-race"), true);
});

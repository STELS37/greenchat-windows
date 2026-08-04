import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSessionQuality,
  type SessionQualityStorage,
  type SessionQualityApi,
} from "../src/session_quality.ts";

class MemoryStorage implements SessionQualityStorage {
  private readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
  removeItem(key: string): void { this.data.delete(key); }
  entries(): [string, string][] { return [...this.data.entries()]; }
}

class SpyApi implements SessionQualityApi {
  readonly posts: { path: string; body: Record<string, unknown> }[] = [];
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    return { accepted: true } as T;
  }
}

class DeferredApi implements SessionQualityApi {
  readonly posts: { path: string; body: Record<string, unknown> }[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    return new Promise<T>((resolve) => { this.waiters.push(resolve as (value: unknown) => void); });
  }
  resolveNext(value: unknown = { accepted: true }): void {
    const resolve = this.waiters.shift();
    assert.ok(resolve, "expected a pending API request");
    resolve(value);
  }
}

class SequencedApi implements SessionQualityApi {
  readonly posts: { path: string; body: Record<string, unknown> }[] = [];
  private readonly responses: unknown[];
  constructor(responses: unknown[]) { this.responses = [...responses]; }
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.posts.push({ path, body: (body ?? {}) as Record<string, unknown> });
    assert.ok(this.responses.length > 0, "unexpected API request");
    return this.responses.shift() as T;
  }
}

class FailingStorage extends MemoryStorage {
  private prefix: string | null = null;
  private remaining = 0;
  failNext(prefix: string, count = 1): void {
    this.prefix = prefix;
    this.remaining = count;
  }
  override setItem(key: string, value: string): void {
    if (this.prefix !== null && key.startsWith(this.prefix) && this.remaining > 0) {
      this.remaining -= 1;
      throw new Error("injected storage failure");
    }
    super.setItem(key, value);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function serializedExclusive() {
  let tail = Promise.resolve();
  return async (_key: string, task: () => Promise<void>): Promise<void> => {
    const operation = tail.then(task);
    tail = operation.catch(() => undefined);
    await operation;
  };
}

class TrackingScheduler {
  starts = 0;
  clears = 0;
  setInterval(_fn: () => void, _ms: number): unknown { this.starts += 1; return this.starts; }
  clearInterval(_id: unknown): void { this.clears += 1; }
}

function meta() {
  return { platform: "web" as const, appVersion: "1.0.0-beta.4" };
}

function fakeScheduler() {
  return {
    setInterval: (_fn: () => void, _ms: number): unknown => 1,
    clearInterval: (_id: unknown): void => {},
  };
}

test("session quality is default-deny and creates no local telemetry without consent", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => false, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.markCrashed();
  quality.close();
  await quality.flush();
  assert.equal(storage.length, 0);
  assert.equal(api.posts.length, 0);
});

test("one clean session is sent as an idempotent cumulative daily aggregate", async () => {
  let now = Date.UTC(2026, 6, 16, 12);
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => now, randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.close();
  await quality.flush();
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0]!.path, "/v1/client/sessions");
  assert.deepEqual(api.posts[0]!.body, {
    install_id: "install-abcdef12",
    platform: "web",
    app_version: "1.0.0-beta.4",
    window_start: Math.floor(Date.UTC(2026, 6, 16) / 1000),
    window_end: Math.floor(Date.UTC(2026, 6, 17) / 1000),
    total_sessions: 1,
    crashed_sessions: 0,
  });

  // A second session in the same UTC day sends cumulative 2/0, not a second independent sample.
  now += 60_000;
  const quality2 = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => now, randomId: () => "session-b", scheduler: fakeScheduler(),
  });
  await quality2.start();
  quality2.close();
  await quality2.flush();
  assert.equal(api.posts.length, 2);
  assert.equal(api.posts[1]!.body.total_sessions, 2);
  assert.equal(api.posts[1]!.body.crashed_sessions, 0);
});

test("two tabs keep independent append-only session events and flush an exact combined denominator", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const common = {
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), scheduler: fakeScheduler(),
  };
  const first = createSessionQuality({ ...common, randomId: () => "tab-a" });
  const second = createSessionQuality({ ...common, randomId: () => "tab-b" });
  await first.start();
  await second.start();
  first.close();
  second.close();
  assert.equal(
    storage.entries().filter(([key]) => key.startsWith("gc.session-quality.v1.event.")).length,
    2,
    "each tab owns a unique immutable session event",
  );
  await first.flush();
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0]!.body.total_sessions, 2);
  assert.equal(api.posts[0]!.body.crashed_sessions, 0);
  assert.equal(storage.entries().filter(([key]) => key.startsWith("gc.session-quality.v1.event.")).length, 0);
});

test("a crashed session is counted once even when close follows the global error", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.markCrashed();
  quality.markCrashed();
  quality.close();
  await quality.flush();
  assert.equal(api.posts.length, 1);
  assert.equal(api.posts[0]!.body.total_sessions, 1);
  assert.equal(api.posts[0]!.body.crashed_sessions, 1);
});

test("stale unclosed marker is recovered as crashed, while a recent other tab remains live", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const now = Date.UTC(2026, 6, 16, 12);
  storage.setItem("gc.session-quality.v1.marker.stale", JSON.stringify({
    id: "stale", started_at: now - 600_000, heartbeat_at: now - 600_000,
    platform: "web", app_version: "1.0.0-beta.4", crashed: false,
  }));
  storage.setItem("gc.session-quality.v1.marker.live", JSON.stringify({
    id: "live", started_at: now - 30_000, heartbeat_at: now - 30_000,
    platform: "web", app_version: "1.0.0-beta.4", crashed: false,
  }));
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => now, randomId: () => "session-new", staleAfterMs: 120_000, scheduler: fakeScheduler(),
  });
  await quality.start();
  assert.equal(storage.getItem("gc.session-quality.v1.marker.stale"), null);
  assert.notEqual(storage.getItem("gc.session-quality.v1.marker.live"), null);
  quality.close();
  await quality.flush();
  assert.equal(api.posts.at(-1)!.body.total_sessions, 2);
  assert.equal(api.posts.at(-1)!.body.crashed_sessions, 1);
});

test("opt-out purges every local marker and aggregate and prevents later delivery", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.markCrashed();
  await quality.setConsent(false);
  assert.equal(storage.entries().filter(([k]) => k.startsWith("gc.session-quality.v1.")).length, 0);
  await quality.flush();
  assert.equal(api.posts.length, 0);
});


test("late boot consent hydration cannot re-enable telemetry after explicit opt-out", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const consent = deferred<boolean>();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: () => consent.promise, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });

  const boot = quality.start();
  await quality.setConsent(false);
  consent.resolve(true);
  await boot;

  quality.markCrashed();
  quality.close();
  await quality.flush();
  assert.equal(storage.length, 0);
  assert.equal(api.posts.length, 0);
});

test("in-flight pre-opt-out flush cannot resurrect aggregates after a rapid re-enable", async () => {
  const storage = new MemoryStorage();
  const api = new DeferredApi();
  const ids = ["session-a", "session-b"];
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => ids.shift() ?? "session-extra",
    scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.close();
  const oldFlush = quality.flush();
  while (api.posts.length === 0) await Promise.resolve();

  await quality.setConsent(false);
  const reenable = quality.setConsent(true);
  api.resolveNext();
  await Promise.all([oldFlush, reenable]);

  assert.equal(api.posts.length, 1, "the already-started request may finish, but no old event is resent");
  assert.equal(storage.entries().filter(([k]) => k.includes(".event.")).length, 0);
  assert.equal(storage.entries().filter(([k]) => k.includes(".aggregate.")).length, 0);
  assert.notEqual(storage.getItem("gc.session-quality.v1.marker.session-b"), null);
});

test("acknowledged event ids heal a crash between aggregate persistence and event deletion", async () => {
  const storage = new MemoryStorage();
  const api = new SpyApi();
  const start = Math.floor(Date.UTC(2026, 6, 16) / 1000);
  storage.setItem("gc.session-quality.v1.event.acked", JSON.stringify({
    id: "acked", window_start: start, window_end: start + 86_400,
    platform: "web", app_version: "1.0.0-beta.4", crashed: false,
  }));
  const aggregateKey = `gc.session-quality.v1.aggregate.${start}.web.1.0.0-beta.4`;
  storage.setItem(aggregateKey, JSON.stringify({
    window_start: start, window_end: start + 86_400, platform: "web", app_version: "1.0.0-beta.4",
    sent_total: 1, sent_crashed: 0, acked_event_ids: ["acked"],
  }));
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-new", scheduler: fakeScheduler(),
  });

  await quality.start();
  assert.equal(storage.getItem("gc.session-quality.v1.event.acked"), null);
  const healed = JSON.parse(storage.getItem(aggregateKey) ?? "null") as { acked_event_ids?: string[] };
  assert.deepEqual(healed.acked_event_ids, []);
  assert.equal(api.posts.length, 0, "already acknowledged event must never be counted twice");
});

test("failed event persistence keeps the source marker for conservative recovery", async () => {
  const storage = new FailingStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  storage.failNext("gc.session-quality.v1.event.");
  quality.close();

  assert.notEqual(storage.getItem("gc.session-quality.v1.marker.session-a"), null);
  assert.equal(storage.entries().filter(([k]) => k.includes(".event.")).length, 0);
  assert.equal(api.posts.length, 0);
});

test("failed aggregate persistence leaves events for an exact idempotent retry", async () => {
  const storage = new FailingStorage();
  const api = new SpyApi();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler: fakeScheduler(),
  });
  await quality.start();
  quality.close();
  storage.failNext("gc.session-quality.v1.aggregate.");
  await quality.flush();
  assert.equal(storage.entries().filter(([k]) => k.includes(".event.")).length, 1);

  await quality.flush();
  assert.equal(api.posts.length, 2);
  assert.deepEqual(api.posts[1]!.body, api.posts[0]!.body);
  assert.equal(storage.entries().filter(([k]) => k.includes(".event.")).length, 0);
});


test("server-ahead authoritative counters heal the baseline before current events are acknowledged", async () => {
  const storage = new MemoryStorage();
  const api = new SequencedApi([
    { accepted: true, updated: false, total_sessions: 5, crashed_sessions: 1 },
    { accepted: true, updated: true, total_sessions: 6, crashed_sessions: 1 },
  ]);
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-current", scheduler: fakeScheduler(),
    exclusive: serializedExclusive(),
  });
  await quality.start();
  quality.close();
  await quality.flush();

  assert.equal(api.posts.length, 2);
  assert.equal(api.posts[0]!.body.total_sessions, 1, "first request exposes the stale local baseline");
  assert.equal(api.posts[0]!.body.crashed_sessions, 0);
  assert.equal(api.posts[1]!.body.total_sessions, 6, "retry adds the retained event above the healed baseline");
  assert.equal(api.posts[1]!.body.crashed_sessions, 1);
  assert.equal(storage.entries().filter(([key]) => key.includes(".event.")).length, 0);
  const aggregate = storage.entries().find(([key]) => key.includes(".aggregate."));
  assert.ok(aggregate);
  assert.equal((JSON.parse(aggregate[1]) as { sent_total: number }).sent_total, 6);
  assert.equal((JSON.parse(aggregate[1]) as { sent_crashed: number }).sent_crashed, 1);
});

test("origin-wide exclusive flush serializes cross-tab cumulative baselines", async () => {
  const storage = new MemoryStorage();
  const api = new DeferredApi();
  const exclusive = serializedExclusive();
  const common = {
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), scheduler: fakeScheduler(), exclusive,
  };
  const first = createSessionQuality({ ...common, randomId: () => "tab-a" });
  const second = createSessionQuality({ ...common, randomId: () => "tab-b" });
  await first.start();
  await second.start();

  first.close();
  const firstFlush = first.flush();
  while (api.posts.length < 1) await Promise.resolve();
  assert.equal(api.posts[0]!.body.total_sessions, 1);

  second.close();
  const secondFlush = second.flush();
  await Promise.resolve();
  assert.equal(api.posts.length, 1, "second tab must wait for the shared exclusive section");

  api.resolveNext();
  while (api.posts.length < 2) await Promise.resolve();
  assert.equal(api.posts[1]!.body.total_sessions, 2);
  api.resolveNext();
  await Promise.all([firstFlush, secondFlush]);

  const aggregate = storage.entries().find(([key]) => key.includes(".aggregate."));
  assert.ok(aggregate);
  assert.equal((JSON.parse(aggregate[1]) as { sent_total: number }).sent_total, 2);
});

test("BFCache restart resumes a retained marker after a transient event-write failure", async () => {
  const storage = new FailingStorage();
  const api = new SpyApi();
  const scheduler = new TrackingScheduler();
  const quality = createSessionQuality({
    api, storage, meta: meta(), consent: async () => true, installId: async () => "install-abcdef12",
    now: () => Date.UTC(2026, 6, 16, 12), randomId: () => "session-a", scheduler,
  });
  await quality.start();
  assert.equal(scheduler.starts, 1);

  storage.failNext("gc.session-quality.v1.event.");
  quality.close();
  assert.equal(scheduler.clears, 1);
  assert.notEqual(storage.getItem("gc.session-quality.v1.marker.session-a"), null);

  await quality.start();
  assert.equal(scheduler.starts, 2, "restored page must restart the retained marker heartbeat");
  quality.close();
  await quality.flush();
  assert.equal(api.posts.at(-1)!.body.total_sessions, 1);
});

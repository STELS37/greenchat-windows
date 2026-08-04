// QA — consent changes are privacy boundaries. Operations that observed an older opt-in must never
// recreate telemetry after opt-out, and async persistence/hydration must obey the newest user verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDiagnostics,
  type DiagApi,
  type DiagMeta,
  type DiagStore,
  type LatencySample,
  type QueuedCrash,
} from "../src/diagnostics.ts";
import { NetworkError } from "../src/errors.ts";

const META: DiagMeta = { platform: "web", appVersion: "qa", osVersion: "qa" };

function gate(): { promise: Promise<void>; release(): void; started: Promise<void>; markStarted(): void } {
  let release!: () => void;
  let markStarted!: () => void;
  return {
    promise: new Promise<void>((resolve) => { release = resolve; }),
    release: () => release(),
    started: new Promise<void>((resolve) => { markStarted = resolve; }),
    markStarted: () => markStarted(),
  };
}

function offlineApi(): DiagApi {
  return {
    async post<T>(): Promise<T> {
      throw new NetworkError("offline", null);
    },
  };
}

class BaseStore implements DiagStore {
  consent = true;
  crashes: QueuedCrash[] = [];
  samples: LatencySample[] = [];
  last = 0;

  async installId(): Promise<string> { return "install-race"; }
  async getConsent(): Promise<boolean> { return this.consent; }
  async setConsent(on: boolean): Promise<void> { this.consent = on; }
  async pushCrash(c: QueuedCrash): Promise<void> { this.crashes.push(c); }
  async listCrashes(): Promise<QueuedCrash[]> { return this.crashes.map((c) => ({ ...c })); }
  async dropCrash(id: string): Promise<void> { this.crashes = this.crashes.filter((c) => c.id !== id); }
  async clearCrashes(): Promise<void> { this.crashes = []; }
  async addSample(s: LatencySample): Promise<void> { this.samples.push(s); }
  async listSamples(): Promise<LatencySample[]> { return this.samples.map((s) => ({ ...s })); }
  async clearSamples(): Promise<void> { this.samples = []; }
  async lastDiagAt(): Promise<number> { return this.last; }
  async setLastDiagAt(ms: number): Promise<void> { this.last = ms; }
}

class DeferredCrashListStore extends BaseStore {
  readonly listGate = gate();
  private first = true;
  override async listCrashes(): Promise<QueuedCrash[]> {
    if (this.first) {
      this.first = false;
      this.listGate.markStarted();
      await this.listGate.promise;
    }
    return super.listCrashes();
  }
}

class DeferredSampleStore extends BaseStore {
  readonly addGate = gate();
  private first = true;
  override async addSample(s: LatencySample): Promise<void> {
    if (this.first) {
      this.first = false;
      this.addGate.markStarted();
      await this.addGate.promise;
    }
    await super.addSample(s);
  }
}

class DeferredConsentReadStore extends BaseStore {
  override consent = false;
  readonly readGate = gate();
  private first = true;
  override async getConsent(): Promise<boolean> {
    const captured = this.consent;
    if (this.first) {
      this.first = false;
      this.readGate.markStarted();
      await this.readGate.promise;
    }
    return captured;
  }
}

class OutOfOrderConsentStore extends BaseStore {
  override consent = false;
  readonly firstWriteGate = gate();
  private writes = 0;
  override async setConsent(on: boolean): Promise<void> {
    this.writes += 1;
    if (this.writes === 1) {
      this.firstWriteGate.markStarted();
      await this.firstWriteGate.promise;
    }
    this.consent = on;
  }
}

test("opt-out waits for an already-started crash collector and performs the final purge afterwards", async () => {
  const store = new DeferredCrashListStore();
  const diag = createDiagnostics({ api: offlineApi(), store, meta: META });

  const report = diag.reportError({ stack: "Error: old-session crash" });
  await store.listGate.started;

  let optedOut = false;
  const off = diag.setConsent(false).then(() => { optedOut = true; });
  await Promise.resolve();
  assert.equal(optedOut, false, "opt-out remains pending until the old collector can no longer write");

  store.listGate.release();
  await Promise.all([report, off]);
  assert.equal(store.consent, false);
  assert.deepEqual(store.crashes, [], "no crash can be resurrected after opt-out cleanup");
});

test("opt-out drains an in-flight sample write before clearing samples", async () => {
  const store = new DeferredSampleStore();
  const diag = createDiagnostics({ api: offlineApi(), store, meta: META });

  const sample = diag.sample({ sentAtSec: 10, receivedAtMs: 10_100 });
  await store.addGate.started;
  const off = diag.setConsent(false);

  store.addGate.release();
  await Promise.all([sample, off]);
  assert.equal(store.consent, false);
  assert.deepEqual(store.samples, []);
});

test("a stale start() consent read cannot overwrite a newer explicit opt-in", async () => {
  const store = new DeferredConsentReadStore();
  const diag = createDiagnostics({ api: offlineApi(), store, meta: META });

  const start = diag.start();
  await store.readGate.started;
  await diag.setConsent(true);
  store.readGate.release();
  await start;

  diag.recordScreen("settings");
  assert.deepEqual(diag.breadcrumbs(), ["settings"], "newer explicit consent remains authoritative in memory");
  assert.equal(store.consent, true);
});

test("overlapping consent writes commit in invocation order so the newest verdict wins durably", async () => {
  const store = new OutOfOrderConsentStore();
  const diag = createDiagnostics({ api: offlineApi(), store, meta: META });

  const on = diag.setConsent(true);
  await store.firstWriteGate.started;
  const off = diag.setConsent(false);
  await Promise.resolve();

  store.firstWriteGate.release();
  await Promise.all([on, off]);
  assert.equal(store.consent, false, "late completion of the older opt-in cannot undo opt-out");
  assert.deepEqual(store.crashes, []);
  assert.deepEqual(store.samples, []);
});


test("opt-out does not wait for a diagnostic POST that is already stuck on the network", async () => {
  const store = new BaseStore();
  const postGate = gate();
  const api: DiagApi = {
    async post<T>(): Promise<T> {
      postGate.markStarted();
      await postGate.promise;
      throw new NetworkError("offline", null);
    },
  };
  const diag = createDiagnostics({ api, store, meta: META });

  const report = diag.reportError({ stack: "Error: network-hang" });
  await postGate.started;

  const verdict = await Promise.race([
    diag.setConsent(false).then(() => "done" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
  ]);
  assert.equal(verdict, "done", "privacy toggle is bounded by local writes, not network timeout");
  assert.equal(store.consent, false);
  assert.deepEqual(store.crashes, []);

  postGate.release();
  await report;
  assert.deepEqual(store.crashes, []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDiagnosticsConsentCoordinator,
  type DiagnosticsConsentController,
  type DiagnosticsConsentSignal,
} from "../../web/src/diagnostics_consent_sync.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeSignal implements DiagnosticsConsentSignal {
  readonly published: boolean[] = [];
  private readonly listeners = new Set<(on: boolean) => void>();
  publish(on: boolean): void { this.published.push(on); }
  subscribe(listener: (on: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  emit(on: boolean): void { for (const listener of this.listeners) listener(on); }
}

class ImmediateController implements DiagnosticsConsentController {
  readonly calls: boolean[] = [];
  async setConsent(on: boolean): Promise<void> { this.calls.push(on); }
}

test("opt-out flips both telemetry controllers and publishes before async cleanup completes", async () => {
  const diagGate = deferred();
  const sessionGate = deferred();
  const diagnostics: DiagnosticsConsentController = {
    setConsent(on) {
      assert.equal(on, false);
      return diagGate.promise;
    },
  };
  const sessions: DiagnosticsConsentController = {
    setConsent(on) {
      assert.equal(on, false);
      return sessionGate.promise;
    },
  };
  const signal = new FakeSignal();
  const coordinator = createDiagnosticsConsentCoordinator({ diagnostics, sessions, signal });

  const operation = coordinator.set(false);
  assert.deepEqual(signal.published, [false], "other tabs are denied immediately, not after cleanup awaits");
  diagGate.resolve();
  sessionGate.resolve();
  await operation;
});

test("a newer opt-out cancels the remainder of a stale enable sequence", async () => {
  const enableGate = deferred();
  const diagnosticsCalls: boolean[] = [];
  const sessionCalls: boolean[] = [];
  const diagnostics: DiagnosticsConsentController = {
    setConsent(on) {
      diagnosticsCalls.push(on);
      return on ? enableGate.promise : Promise.resolve();
    },
  };
  const sessions: DiagnosticsConsentController = {
    async setConsent(on) { sessionCalls.push(on); },
  };
  const signal = new FakeSignal();
  const coordinator = createDiagnosticsConsentCoordinator({ diagnostics, sessions, signal });

  const enable = coordinator.set(true);
  const disable = coordinator.set(false);
  enableGate.resolve();
  await Promise.all([enable, disable]);

  assert.deepEqual(diagnosticsCalls, [true, false]);
  assert.deepEqual(sessionCalls, [false], "stale enable must not reach the session telemetry controller");
  assert.deepEqual(signal.published, [false]);
});

test("external tab verdict is applied locally without a broadcast loop", async () => {
  const diagnostics = new ImmediateController();
  const sessions = new ImmediateController();
  const signal = new FakeSignal();
  const coordinator = createDiagnosticsConsentCoordinator({ diagnostics, sessions, signal });

  signal.emit(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(diagnostics.calls, [true]);
  assert.deepEqual(sessions.calls, [true]);
  assert.deepEqual(signal.published, []);

  coordinator.dispose();
  signal.emit(false);
  await Promise.resolve();
  assert.deepEqual(diagnostics.calls, [true]);
  assert.deepEqual(sessions.calls, [true]);
});

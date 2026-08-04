// Cross-tab diagnostics consent coordinator.
//
// Diagnostics and crash-free session telemetry share one user-facing opt-in but have separate controllers.
// This adapter keeps their ordering fail-closed and propagates the verdict to other tabs without loops.

export interface DiagnosticsConsentController {
  setConsent(on: boolean): Promise<void>;
}

export interface DiagnosticsConsentSignal {
  publish(on: boolean): void;
  subscribe(listener: (on: boolean) => void): () => void;
}

export interface DiagnosticsConsentCoordinator {
  set(on: boolean): Promise<void>;
  dispose(): void;
}

export function createDiagnosticsConsentCoordinator(opts: {
  diagnostics: DiagnosticsConsentController;
  sessions: DiagnosticsConsentController;
  signal: DiagnosticsConsentSignal;
  onError?: (error: unknown) => void;
}): DiagnosticsConsentCoordinator {
  const onError = opts.onError ?? (() => {});
  let revision = 0;
  let disposed = false;

  async function apply(on: boolean, publish: boolean): Promise<void> {
    if (disposed) return;
    const ownRevision = ++revision;

    if (!on) {
      // Both methods switch their synchronous in-memory guards before their first await. Invoke both before
      // awaiting either one so a fatal handler, heartbeat or another tab cannot collect in the gap.
      const diagnosticsOff = opts.diagnostics.setConsent(false);
      const sessionsOff = opts.sessions.setConsent(false);
      if (publish) {
        try { opts.signal.publish(false); } catch (error) { onError(error); }
      }
      const results = await Promise.allSettled([diagnosticsOff, sessionsOff]);
      for (const result of results) if (result.status === "rejected") onError(result.reason);
      return;
    }

    try {
      // Persist/activate the canonical diagnostics opt-in first. A newer verdict invalidates the remainder,
      // while each underlying controller also carries its own revision barrier against stale completions.
      await opts.diagnostics.setConsent(true);
      if (disposed || ownRevision !== revision) return;
      await opts.sessions.setConsent(true);
      if (disposed || ownRevision !== revision) return;
      if (publish) opts.signal.publish(true);
    } catch (error) {
      onError(error);
    }
  }

  const unsubscribe = opts.signal.subscribe((on) => { void apply(on, false); });

  return {
    set(on: boolean): Promise<void> {
      return apply(on === true, true);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      ++revision;
      unsubscribe();
    },
  };
}

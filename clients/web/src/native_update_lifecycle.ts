// Native update discovery lifecycle for the direct Android shell.
//
// The installed APK can start offline, stay open for days, or return from the background after a new
// release is published. A one-shot boot request therefore cannot be the update contract. This small
// controller owns the lifecycle triggers and exactly one visible update surface; transport/presentation
// remain injected so browser/PWA builds stay inert unless the native bridge explicitly starts it.

export const NATIVE_UPDATE_INTERVAL_MS = 15 * 60 * 1000;

export interface NativeUpdateSurface {
  destroy(): void;
}

export interface NativeUpdateLifecycleEnv {
  addWindowListener(type: "online", listener: () => void): void;
  removeWindowListener(type: "online", listener: () => void): void;
  addDocumentListener(type: "visibilitychange", listener: () => void): void;
  removeDocumentListener(type: "visibilitychange", listener: () => void): void;
  visibilityState(): string;
  setInterval(listener: () => void, milliseconds: number): unknown;
  clearInterval(id: unknown): void;
}

export interface NativeUpdateLifecycleOptions<T> {
  load(): Promise<T>;
  present(value: T): NativeUpdateSurface | null;
  env: NativeUpdateLifecycleEnv;
  intervalMs?: number;
}

export interface NativeUpdateLifecycleHandle {
  checkNow(): void;
  stop(): void;
}

/**
 * Start update discovery immediately, then retry when connectivity returns, when the app becomes
 * visible, and every fifteen minutes. Concurrent triggers collapse into one trailing request. A
 * rejected load preserves the current banner; a successful "latest" verdict (present() => null)
 * clears it. stop() removes every listener/timer and destroys the owned surface.
 */
export function startNativeUpdateLifecycle<T>(options: NativeUpdateLifecycleOptions<T>): NativeUpdateLifecycleHandle {
  const { env } = options;
  const intervalMs = options.intervalMs ?? NATIVE_UPDATE_INTERVAL_MS;
  let stopped = false;
  let inFlight = false;
  let trailingCheck = false;
  let surface: NativeUpdateSurface | null = null;

  const checkNow = (): void => {
    if (stopped) return;
    if (inFlight) {
      trailingCheck = true;
      return;
    }
    inFlight = true;
    void Promise.resolve()
      .then(() => options.load())
      .then((value) => {
        if (stopped) return;
        const previous = surface;
        surface = null;
        previous?.destroy();
        surface = options.present(value);
      })
      .catch(() => {
        // Update advice must never obstruct app boot. Keep an already visible verdict and retry on the
        // next lifecycle trigger instead of converting a transient network failure into "latest".
      })
      .finally(() => {
        inFlight = false;
        if (stopped || !trailingCheck) return;
        trailingCheck = false;
        checkNow();
      });
  };

  const onOnline = (): void => checkNow();
  const onVisibility = (): void => {
    if (env.visibilityState() === "visible") checkNow();
  };
  env.addWindowListener("online", onOnline);
  env.addDocumentListener("visibilitychange", onVisibility);
  const timer = env.setInterval(checkNow, intervalMs);
  checkNow();

  return {
    checkNow,
    stop: () => {
      if (stopped) return;
      stopped = true;
      trailingCheck = false;
      env.removeWindowListener("online", onOnline);
      env.removeDocumentListener("visibilitychange", onVisibility);
      env.clearInterval(timer);
      surface?.destroy();
      surface = null;
    },
  };
}

export function browserNativeUpdateLifecycleEnv(): NativeUpdateLifecycleEnv {
  return {
    addWindowListener: (type, listener) => window.addEventListener(type, listener),
    removeWindowListener: (type, listener) => window.removeEventListener(type, listener),
    addDocumentListener: (type, listener) => document.addEventListener(type, listener),
    removeDocumentListener: (type, listener) => document.removeEventListener(type, listener),
    visibilityState: () => document.visibilityState,
    setInterval: (listener, milliseconds) => window.setInterval(listener, milliseconds),
    clearInterval: (id) => window.clearInterval(id as number),
  };
}

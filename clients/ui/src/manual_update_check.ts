// Manual update check used by Settings. Unlike the previous fallback, this never reloads the app:
// reloading a native WebView can tear down the authenticated session before its secure container has
// restored it. Native builds query the governed update manifest; web/PWA builds ask their existing
// service-worker registration to check and report whether a worker is waiting.
import { fetchUpdateStatus } from "../../core/src/update_checker.ts";

export type ManualUpdateResult =
  | { state: "latest" }
  | { state: "available"; version?: string }
  | { state: "unknown" };

export interface NativeUpdateIdentity {
  platform: string;
  arch: string;
  version: string;
  build: number;
}

export interface ManualUpdateEnv {
  nativeInfo(): NativeUpdateIdentity | null;
  fetchNative(info: NativeUpdateIdentity): Promise<ManualUpdateResult>;
  serviceWorkerRegistration(): Promise<ServiceWorkerRegistration | null>;
  hasServiceWorkerController(): boolean;
  timeoutMs?: number;
}

function waitForWorkerState(worker: ServiceWorker, timeoutMs: number): Promise<void> {
  if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      worker.removeEventListener("statechange", onState);
      resolve();
    };
    const onState = (): void => {
      if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    worker.addEventListener("statechange", onState);
  });
}

async function checkServiceWorker(env: ManualUpdateEnv): Promise<ManualUpdateResult> {
  let registration: ServiceWorkerRegistration | null;
  try {
    registration = await env.serviceWorkerRegistration();
  } catch {
    return { state: "unknown" };
  }
  // A plain browser tab without a registered PWA always serves the current web bundle from the
  // backend. There is no local binary that can be stale.
  if (!registration) return { state: "latest" };
  try {
    await registration.update();
    if (registration.waiting && env.hasServiceWorkerController()) return { state: "available" };
    const installing = registration.installing;
    if (installing) await waitForWorkerState(installing, env.timeoutMs ?? 4_000);
    return registration.waiting && env.hasServiceWorkerController()
      ? { state: "available" }
      : { state: "latest" };
  } catch {
    return { state: "unknown" };
  }
}

export async function checkManualUpdate(env: ManualUpdateEnv = browserManualUpdateEnv()): Promise<ManualUpdateResult> {
  const native = env.nativeInfo();
  if (native) {
    try {
      return await env.fetchNative(native);
    } catch {
      return { state: "unknown" };
    }
  }
  return checkServiceWorker(env);
}

export function browserManualUpdateEnv(): ManualUpdateEnv {
  return {
    nativeInfo: () => {
      const info = (globalThis as { __gcUpdateInfo?: NativeUpdateIdentity }).__gcUpdateInfo;
      if (!info) return null;
      if (!info.platform || !info.arch || !info.version || !Number.isSafeInteger(info.build)) return null;
      return info;
    },
    fetchNative: async (info) => {
      const verdict = await fetchUpdateStatus(info.platform, info.arch, info.version, { currentBuild: info.build });
      if (!verdict) return { state: "unknown" };
      if (verdict.state === "latest") return { state: "latest" };
      return { state: "available", version: verdict.latest };
    },
    serviceWorkerRegistration: async () => {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
      return (await navigator.serviceWorker.getRegistration()) ?? null;
    },
    hasServiceWorkerController: () =>
      typeof navigator !== "undefined"
      && "serviceWorker" in navigator
      && navigator.serviceWorker.controller !== null,
  };
}

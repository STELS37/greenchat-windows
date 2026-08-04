// clients/core/src/push.ts — the client PushBridge seam + registrar (CLIENTS §5.4, wired by T-414).
//
// §5.4: the client CORE owns push-subscription registration; a thin, platform-specific PushBridge is the
// seam to the OS push service. This module defines that interface plus `registerPush`, the core-side
// registrar the plan means by «Ядро регистрирует подписку POST /v1/push/subscribe». It is transport-
// agnostic (structural PushApi = the ApiClient) and platform-agnostic:
//   • Android (T-414) installs a Capacitor-backed bridge on window.__gcPushBridge (FCM / UnifiedPush).
//   • iOS (T-415) installs an APNs-backed bridge the same way.
//   • Web/PWA installs a webpush/Service-Worker bridge.
// The registrar subscribes the device's current token, follows token refreshes (re-subscribe, then drop
// the stale endpoint), and unsubscribes on stop() (logout). It is BEST-EFFORT: a network failure never
// throws into the caller — a push subscription is an optimization, never a gate on using the app (the
// live WS already delivers everything while the app is open).

/** The four server-recognised platforms (CLIENTS §8.1 CHECK constraint). */
export type PushPlatform = "webpush" | "fcm" | "apns" | "unifiedpush";

/** A device push token/endpoint ready for POST /v1/push/subscribe (CLIENTS §8.1). */
export interface PushToken {
  platform: PushPlatform;
  endpoint: string; // webpush endpoint / fcm token / apns device token / unifiedpush endpoint
  keys?: { p256dh: string; auth: string }; // webpush only (RFC 8291 keys); absent for fcm/apns/up
}

/** An incoming push payload (privacy-first, CLIENTS §8.3): identifiers by default, preview only opt-in. */
export interface PushData {
  chat_id?: number;
  message_id?: number;
  kind?: string;
  title?: string;
  body?: string;
  [key: string]: unknown;
}

/** CLIENTS §5.4 PushBridge — the platform seam between the OS push service and the app core. */
export interface PushBridge {
  /** The current device token/endpoint, or null when push is unavailable (e.g. WS-only mode). */
  getToken(): Promise<PushToken | null>;
  /** Subscribe to token issue/refresh; returns an unsubscribe fn. Fires with null when a token is lost. */
  onToken(cb: (token: PushToken | null) => void): () => void;
  /** Subscribe to foreground push payloads; returns an unsubscribe fn. */
  onPush(cb: (data: PushData) => void): () => void;
  /** Reflect the unread count on the app icon badge. */
  setBadge(count: number): void;
}

/** The minimal transport the registrar needs (the core ApiClient satisfies it structurally). */
export interface PushApi {
  post<T>(path: string, body?: unknown): Promise<T>;
}

/** A live push registration; stop() unsubscribes the device and detaches the token listener. */
export interface PushRegistration {
  /** The currently-registered endpoint, or null if none is registered yet. */
  endpoint(): string | null;
  stop(): Promise<void>;
}

/**
 * Register the device's push token with the server and keep it current (CLIENTS §5.4/§8.1).
 * Subscribes the initial token, re-subscribes on refresh (dropping the stale endpoint), and unsubscribes
 * on stop() (logout). Every call is best-effort: a failure goes to `onError` (default: swallow) and never
 * throws. `stop()` racing an in-flight subscribe is handled — the just-created subscription is undone.
 */
export function registerPush(
  api: PushApi,
  bridge: PushBridge,
  opts: { onError?: (err: unknown) => void } = {},
): PushRegistration {
  const onError = opts.onError ?? ((): void => {});
  let current: PushToken | null = null;
  let desired: PushToken | null = null;
  let desiredRevision = 0;
  let completedRevision = 0;
  let stopped = false;
  let tokenEventSeen = false;
  let reconcileTask: Promise<void> | null = null;

  const sameToken = (a: PushToken | null, b: PushToken | null): boolean =>
    a === b || (
      a !== null &&
      b !== null &&
      a.platform === b.platform &&
      a.endpoint === b.endpoint &&
      a.keys?.p256dh === b.keys?.p256dh &&
      a.keys?.auth === b.keys?.auth
    );

  const unsubscribe = async (endpoint: string): Promise<void> => {
    try {
      await api.post("/v1/push/unsubscribe", { endpoint });
    } catch (err) {
      onError(err);
    }
  };

  const subscribe = async (token: PushToken): Promise<boolean> => {
    try {
      await api.post("/v1/push/subscribe", {
        platform: token.platform,
        endpoint: token.endpoint,
        ...(token.keys ? { keys: token.keys } : {}),
      });
      return true;
    } catch (err) {
      onError(err);
      return false;
    }
  };

  const reconcile = async (): Promise<void> => {
    while (!stopped) {
      const revision = desiredRevision;
      const target = desired;
      if (sameToken(current, target)) {
        completedRevision = revision;
        if (revision === desiredRevision) return;
        continue;
      }

      if (target === null) {
        const previous = current;
        current = null; // token loss is authoritative locally even if best-effort unsubscribe fails
        if (previous) await unsubscribe(previous.endpoint);
        completedRevision = revision;
        if (revision === desiredRevision) return;
        continue;
      }

      const previous = current;
      const subscribed = await subscribe(target);
      if (!subscribed) {
        completedRevision = revision; // retry only on the next bridge event, never a hot loop
        return;
      }
      if (stopped) {
        await unsubscribe(target.endpoint);
        return;
      }
      if (revision !== desiredRevision || !sameToken(target, desired)) {
        // This successful response is already stale. Remove it before reconciling the newer token.
        if (previous?.endpoint === target.endpoint) current = null;
        await unsubscribe(target.endpoint);
        completedRevision = revision;
        continue;
      }

      current = target;
      if (previous && previous.endpoint !== target.endpoint) await unsubscribe(previous.endpoint);
      completedRevision = revision;
      if (revision === desiredRevision) return;
    }
  };

  const schedule = (): Promise<void> => {
    if (reconcileTask) return reconcileTask;
    let task!: Promise<void>;
    task = reconcile()
      .catch(onError)
      .finally(() => {
        if (reconcileTask === task) reconcileTask = null;
        if (!stopped && completedRevision < desiredRevision) void schedule();
      });
    reconcileTask = task;
    return task;
  };

  const setDesired = (token: PushToken | null): void => {
    if (stopped) return;
    if (sameToken(desired, token)) {
      if (sameToken(current, token)) return;
      if (completedRevision < desiredRevision) return; // identical request is already in flight
      // Same callback after a completed failure is a legitimate explicit retry.
    }
    desired = token;
    desiredRevision += 1;
    void schedule();
  };

  const detach = bridge.onToken((token) => {
    tokenEventSeen = true;
    setDesired(token);
  });
  void bridge
    .getToken()
    .then((token) => {
      // A token callback is newer than the snapshot requested at construction time.
      if (!tokenEventSeen) setDesired(token);
    })
    .catch(onError);

  return {
    endpoint: (): string | null => current?.endpoint ?? null,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      desired = null;
      desiredRevision += 1;
      detach();
      if (reconcileTask) await reconcileTask.catch(onError);
      if (current) {
        const endpoint = current.endpoint;
        current = null;
        await unsubscribe(endpoint);
      }
    },
  };
}

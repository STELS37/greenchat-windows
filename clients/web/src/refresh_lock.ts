import { ApiError, createRefreshSuccessor, type RefreshCoordinator, type TokenStore } from "../../core/src/index.ts";
import type { SessionStorage } from "../../ui/src/screens/index.ts";

const REFRESH_LOCK = "greenchat.session.refresh";

async function withRefreshLock<T>(task: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks) return await task();
  return locks.request(REFRESH_LOCK, { mode: "exclusive" }, async () => task());
}

/** Wait until every earlier same-origin refresh has completed and persisted its rotation. */
export function browserRefreshBarrier(task: () => void | Promise<void>): Promise<void> {
  return withRefreshLock(task);
}

/**
 * Serialize refreshes and durably journal the proposed successor before the request. Replaying the
 * same pair is safe whether the server committed the first request or never received it.
 */
export function browserRefreshCoordinator(tokens: TokenStore, storage: SessionStorage): RefreshCoordinator {
  const rotate = async (task: () => Promise<boolean>, retrySuperseded: boolean): Promise<boolean> => {
    const before = storage.load();
    if (before?.refresh) {
      tokens.refresh = before.refresh;
      const pending = before.pendingRefresh ?? createRefreshSuccessor();
      tokens.refreshNext = pending;
      if (pending && before.pendingRefresh !== pending) storage.save({ ...before, pendingRefresh: pending });
      await storage.flush?.();
    }

    const attemptedRefresh = tokens.refresh;
    try {
      const ok = await task();
      if (!ok || !tokens.refresh || !before) return ok;
      const current = storage.load();
      if (!current || current.user.id !== before.user.id) return ok;
      if (current.refresh === before.refresh || current.refresh === tokens.refresh) {
        storage.save({ refresh: tokens.refresh, user: current.user });
        await storage.flush?.();
      } else {
        tokens.refresh = current.refresh;
        tokens.refreshNext = current.pendingRefresh ?? null;
      }
      return ok;
    } catch (err) {
      if (retrySuperseded && err instanceof ApiError && err.code === "REFRESH_SUPERSEDED" && before) {
        const current = storage.load();
        if (current && current.user.id === before.user.id && current.refresh !== attemptedRefresh) {
          tokens.refresh = current.refresh;
          tokens.refreshNext = current.pendingRefresh ?? null;
          return rotate(task, false);
        }
      }
      throw err;
    }
  };
  return async (task) => withRefreshLock(() => rotate(task, true));
}

export interface BadgeRefreshDeps {
  allowed(): boolean;
  loadCount(): Promise<number>;
  apply(count: number): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  delayMs?: number;
}

export interface BadgeRefreshController {
  request(): void;
  reset(): void;
}

export function createBadgeRefreshController(deps: BadgeRefreshDeps): BadgeRefreshController {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const delayMs = deps.delayMs ?? 800;
  let timer: unknown = null;
  let epoch = 0;
  let latestRequest = 0;

  return {
    request(): void {
      if (!deps.allowed() || timer !== null) return;
      const mineEpoch = epoch;
      const mineRequest = ++latestRequest;
      timer = setTimer(() => {
        timer = null;
        if (mineEpoch !== epoch || mineRequest !== latestRequest || !deps.allowed()) return;
        void deps.loadCount()
          .then((count) => {
            if (mineEpoch === epoch && mineRequest === latestRequest && deps.allowed()) deps.apply(count);
          })
          .catch(() => undefined);
      }, delayMs);
    },
    reset(): void {
      epoch += 1;
      latestRequest += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      deps.apply(0);
    },
  };
}

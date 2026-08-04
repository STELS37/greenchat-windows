// clients/ui/src/store.ts — mini-store (T-404).
// A tiny reactive state container (the Telegram Web K path: no framework). Zero dependencies and
// completely DOM-free, so it is unit-tested directly under node:test.
//
// Model: one immutable-by-convention state object. Consumers read via getState(), mutate via
// setState(patch), and subscribe either to the whole store or to a *slice* (a selector). Slice
// subscribers are notified only when their selected value changes (Object.is by default, or a
// custom equality) — that is what keeps re-renders cheap. Notifications are batched on a microtask:
// many setState() calls in one tick collapse into a single notification pass.

export type Listener = () => void;
export type Selector<S, T> = (state: S) => T;
export type SliceListener<T> = (value: T, prev: T) => void;
export type Equality<T> = (a: T, b: T) => boolean;
export type Updater<S> = (prev: S) => Partial<S>;

export interface SelectOptions<T> {
  equals?: Equality<T>;
  // Fire immediately with the current value on subscribe (default true).
  immediate?: boolean;
}

export interface Store<S extends object> {
  getState(): S;
  setState(patch: Partial<S> | Updater<S>): void;
  subscribe(listener: Listener): () => void;
  select<T>(selector: Selector<S, T>, listener: SliceListener<T>, options?: SelectOptions<T>): () => void;
  destroy(): void;
}

interface SliceSub<S, T> {
  selector: Selector<S, T>;
  listener: SliceListener<T>;
  equals: Equality<T>;
  last: T;
}

const defaultEquals = <T>(a: T, b: T): boolean => Object.is(a, b);

export function createStore<S extends object>(initial: S): Store<S> {
  let state: S = initial;
  let alive = true;
  const listeners = new Set<Listener>();
  const slices = new Set<SliceSub<S, unknown>>();

  let scheduled = false;
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(flush);
  };

  const flush = (): void => {
    scheduled = false;
    if (!alive) return;
    // Snapshot subscribers so a listener that (un)subscribes mid-flush cannot corrupt iteration.
    for (const sub of [...slices]) {
      const next = sub.selector(state);
      if (!sub.equals(next, sub.last)) {
        const prev = sub.last;
        sub.last = next;
        sub.listener(next, prev);
      }
    }
    for (const l of [...listeners]) l();
  };

  const getState = (): S => state;

  const setState = (patch: Partial<S> | Updater<S>): void => {
    if (!alive) return;
    const delta = typeof patch === "function" ? (patch as Updater<S>)(state) : patch;
    let changed = false;
    for (const k in delta) {
      const cur = (state as Record<string, unknown>)[k];
      const nxt = (delta as Record<string, unknown>)[k];
      if (!Object.is(cur, nxt)) { changed = true; break; }
    }
    if (!changed) return;
    state = { ...state, ...delta };
    schedule();
  };

  const subscribe = (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  const select = <T>(
    selector: Selector<S, T>,
    listener: SliceListener<T>,
    options?: SelectOptions<T>,
  ): (() => void) => {
    const equals = options?.equals ?? defaultEquals;
    const sub: SliceSub<S, T> = { selector, listener, equals, last: selector(state) };
    slices.add(sub as SliceSub<S, unknown>);
    if (options?.immediate !== false) listener(sub.last, sub.last);
    return () => { slices.delete(sub as SliceSub<S, unknown>); };
  };

  const destroy = (): void => {
    alive = false;
    listeners.clear();
    slices.clear();
  };

  return { getState, setState, subscribe, select, destroy };
}

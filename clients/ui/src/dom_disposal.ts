// DOM-owned resource lifecycle. Screens create short-lived rows and overlays whose async bindings
// own AbortControllers, object URLs and event listeners. Removing a subtree must release those
// resources explicitly; garbage collection cannot revoke a browser object URL.

type Cleanup = () => void;
type ChildNodeLike = object & { children?: Iterable<object> | ArrayLike<object> };

const cleanups = new WeakMap<object, Set<Cleanup>>();

/** Register one cleanup against the DOM node that owns the resource. */
export function registerDomCleanup(node: object, cleanup: Cleanup): () => void {
  let set = cleanups.get(node);
  if (!set) {
    set = new Set<Cleanup>();
    cleanups.set(node, set);
  }
  set.add(cleanup);
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    const current = cleanups.get(node);
    current?.delete(cleanup);
    if (current?.size === 0) cleanups.delete(node);
  };
}

/** Release resources registered anywhere in a subtree before that subtree is discarded. */
export function disposeDomTree(node: object): void {
  const children = (node as ChildNodeLike).children;
  if (children) {
    for (const child of Array.from(children as ArrayLike<object>)) disposeDomTree(child);
  }
  const set = cleanups.get(node);
  if (!set) return;
  cleanups.delete(node);
  for (const cleanup of [...set]) {
    try { cleanup(); } catch { /* disposal must never block replacement of the UI */ }
  }
}

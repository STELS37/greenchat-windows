// SPDX-License-Identifier: AGPL-3.0-or-later
// Document-scoped, reference-counted lease. A second sheet must not unlock the first one.
// No fixed-body positioning, scrollTo(), gesture cancellation or changes to application containers.
interface ScrollLease { users: number; restore: () => void }
const locks = new WeakMap<Document, ScrollLease>();

export function lockDocumentScroll(doc: Document): () => void {
  let lease = locks.get(doc);
  if (!lease) {
    const root = doc.documentElement;
    if (!root) return () => {};
    const style = root.style;
    const undo: Array<() => void> = [];
    const set = (name: string, value: string): void => {
      const oldValue = style.getPropertyValue(name);
      const oldPriority = style.getPropertyPriority(name);
      style.setProperty(name, value, "important");
      const ownValue = style.getPropertyValue(name);
      undo.push(() => {
        // Preserve changes made by another host subsystem while this lease was active.
        if (style.getPropertyValue(name) !== ownValue || style.getPropertyPriority(name) !== "important") return;
        if (oldValue) style.setProperty(name, oldValue, oldPriority);
        else style.removeProperty(name);
      });
    };
    const win = doc.defaultView;
    // Reserve an existing CLASSIC scrollbar gutter only. Creating one on an overlay-scrollbar
    // platform would itself introduce the layout jump this code is meant to prevent.
    if (win && win.innerWidth > root.clientWidth &&
        !win.getComputedStyle(root).scrollbarGutter.includes("stable")) set("scrollbar-gutter", "stable");
    set("overflow-x", "hidden");
    set("overflow-y", "hidden");
    lease = { users: 0, restore: () => { for (const restore of undo.reverse()) restore(); } };
    locks.set(doc, lease);
  }
  const owned = lease;
  owned.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--owned.users > 0) return;
    if (locks.get(doc) === owned) locks.delete(doc);
    owned.restore();
  };
}

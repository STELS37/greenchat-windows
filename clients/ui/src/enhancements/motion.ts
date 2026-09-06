// SPDX-License-Identifier: AGPL-3.0-or-later
// One animation per owned element; unrelated entrances do not cancel one another.
export interface MotionController {
  enter(target: HTMLElement, delay?: number): void;
  cancel(): void;
  destroy(): void;
}
export function createMotionController(suppressed: () => boolean): MotionController {
  const active = new Map<HTMLElement, Animation>();
  let disposed = false;
  const forget = (target: HTMLElement, animation: Animation): void => {
    if (active.get(target) === animation) active.delete(target);
  };
  function cancel(): void {
    for (const animation of active.values()) animation.cancel();
    active.clear();
  }
  return {
    enter(target, delay = 0) {
      const previous = active.get(target);
      if (previous) { active.delete(target); previous.cancel(); }
      if (disposed || suppressed() || !target.isConnected || typeof target.animate !== "function") return;
      // Keep rapid page switches finite even when old DOM is removed before an animation finishes.
      for (const [node, animation] of active) if (!node.isConnected) { active.delete(node); animation.cancel(); }
      if (active.size >= 12) {
        const oldest = active.entries().next().value!;
        active.delete(oldest[0]); oldest[1].cancel();
      }
      try {
        const animation = target.animate([
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], { duration: 240, delay: Math.min(120, Math.max(0, Number.isFinite(delay) ? delay : 0)),
          easing: "cubic-bezier(.2,.75,.25,1)", fill: "backwards" });
        active.set(target, animation);
        void animation.finished.then(() => forget(target, animation), () => forget(target, animation));
      } catch { /* Animation support must never be a prerequisite for opening a functional screen. */ }
    },
    cancel,
    destroy() { if (disposed) return; disposed = true; cancel(); },
  };
}

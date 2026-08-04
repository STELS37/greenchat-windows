// clients/ui/src/shortcuts.ts — keyboard shortcut framework (T-404).
// Parity with TG Desktop hotkeys + the Ctrl+K command palette hook (PRODUCT_UX §2 п.16).
// A chord like "mod+k" resolves `mod` to Ctrl on Windows/Linux and Cmd (meta) on macOS. Chord parsing
// and event matching are pure (unit-tested in node); the DOM keydown binding is lazy (browser only).

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeyChord {
  key: string; // normalised lower-case, e.g. "k", "enter", "arrowdown", "/"
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface Binding {
  combo: string;
  run: (ev: KeyEventLike) => void;
  when?: () => boolean;
  description?: string;
  // Allow firing while a text field is focused (default false — most shortcuts must not).
  allowInInput?: boolean;
}

const ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  ins: "insert",
  return: "enter",
  space: " ",
  spacebar: " ",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
};

function normKey(raw: string): string {
  const k = raw.toLowerCase();
  return ALIASES[k] ?? k;
}

export function parseCombo(combo: string): KeyChord {
  const chord: KeyChord = { key: "", mod: false, ctrl: false, meta: false, alt: false, shift: false };
  const parts = combo.split("+").map((p) => p.trim()).filter((p) => p.length > 0);
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === "mod" || p === "cmdorctrl") chord.mod = true;
    else if (p === "ctrl" || p === "control") chord.ctrl = true;
    else if (p === "meta" || p === "cmd" || p === "command" || p === "win" || p === "super") chord.meta = true;
    else if (p === "alt" || p === "option" || p === "opt") chord.alt = true;
    else if (p === "shift") chord.shift = true;
    else chord.key = normKey(part);
  }
  return chord;
}

export function detectIsMac(nav?: { platform?: string; userAgent?: string }): boolean {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (!n) return false;
  const hay = `${n.platform ?? ""} ${n.userAgent ?? ""}`.toLowerCase();
  return hay.includes("mac") || hay.includes("iphone") || hay.includes("ipad");
}

export function matchChord(chord: KeyChord, ev: KeyEventLike, isMac: boolean): boolean {
  if (normKey(ev.key) !== chord.key) return false;
  const wantCtrl = chord.ctrl || (chord.mod && !isMac);
  const wantMeta = chord.meta || (chord.mod && isMac);
  return ev.ctrlKey === wantCtrl
    && ev.metaKey === wantMeta
    && ev.altKey === chord.alt
    && ev.shiftKey === chord.shift;
}

interface Registered {
  chord: KeyChord;
  binding: Binding;
}

export interface ShortcutsOptions {
  isMac?: boolean;
  // Decide whether a target counts as a text field (so most shortcuts are suppressed). Injectable
  // for tests; defaults to a tag/contenteditable check in the browser.
  isTextInput?: (target: unknown) => boolean;
}

function defaultIsTextInput(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class Shortcuts {
  private readonly registered = new Set<Registered>();
  private readonly isMac: boolean;
  private readonly isTextInput: (target: unknown) => boolean;
  private detach: (() => void) | null = null;

  constructor(options?: ShortcutsOptions) {
    this.isMac = options?.isMac ?? detectIsMac();
    this.isTextInput = options?.isTextInput ?? defaultIsTextInput;
  }

  register(binding: Binding): () => void {
    const entry: Registered = { chord: parseCombo(binding.combo), binding };
    this.registered.add(entry);
    return () => { this.registered.delete(entry); };
  }

  // Returns true if a binding handled the event. `target` lets the input-suppression rule apply.
  handle(ev: KeyEventLike, target?: unknown): boolean {
    const inInput = target !== undefined && this.isTextInput(target);
    for (const { chord, binding } of [...this.registered]) {
      if (inInput && !binding.allowInInput) continue;
      if (binding.when && !binding.when()) continue;
      if (matchChord(chord, ev, this.isMac)) {
        binding.run(ev);
        return true;
      }
    }
    return false;
  }

  // Lazy DOM binding: attaches a capturing keydown listener; preventDefault on a match.
  attach(target?: EventTarget): () => void {
    const tgt = target ?? (typeof document !== "undefined" ? document : undefined);
    if (!tgt) return () => {};
    const onKey = (e: Event): void => {
      const ke = e as unknown as KeyEventLike & { target?: unknown; preventDefault(): void };
      if (this.handle(ke, ke.target)) ke.preventDefault();
    };
    tgt.addEventListener("keydown", onKey, true);
    this.detach = () => tgt.removeEventListener("keydown", onKey, true);
    return this.detach;
  }

  destroy(): void {
    this.detach?.();
    this.detach = null;
    this.registered.clear();
  }
}

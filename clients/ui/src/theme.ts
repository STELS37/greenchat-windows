// clients/ui/src/theme.ts — theme & density controller (T-404, CLIENTS §6).
// Design tokens live in tokens.css as CSS custom properties keyed off data-attributes on the root
// element: [data-theme=light|dark], [data-density=comfortable|compact], plus --gc-font-scale for a
// dynamic font size (a11y). This controller resolves the effective theme (honouring "system"),
// applies the attributes, and persists the preference. Pure helpers are unit-tested; the browser env
// (document root, matchMedia, localStorage) is injectable so the controller is testable in node.

export type ThemePref = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";
export type Density = "comfortable" | "compact";

export interface ThemeState {
  pref: ThemePref;
  density: Density;
  fontScale: number;
  effective: EffectiveTheme;
}

// Resolve the concrete theme to paint given the preference and the current system setting.
export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): EffectiveTheme {
  if (pref === "system") return systemPrefersDark ? "dark" : "light";
  return pref;
}

export const FONT_SCALE_MIN = 0.8;
export const FONT_SCALE_MAX = 1.4;

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
}

// Minimal shapes so the controller does not depend on the full DOM lib at runtime in node tests.
export interface RootElementLike {
  setAttribute(name: string, value: string): void;
  style: { setProperty(name: string, value: string): void };
}

export interface ThemeEnv {
  root: RootElementLike;
  prefersDark(): boolean;
  onSystemChange(cb: () => void): () => void;
  load(): Partial<Pick<ThemeState, "pref" | "density" | "fontScale">> | null;
  save(state: Pick<ThemeState, "pref" | "density" | "fontScale">): void;
}

export class ThemeController {
  private readonly env: ThemeEnv;
  // Default "system": mirrors the server-side ui_theme default. Before this the client painted light
  // even on a device in dark mode, so the first launch was a white flash the user had to undo by hand.
  private pref: ThemePref = "system";
  private density: Density = "comfortable";
  private fontScale = 1;
  private readonly listeners = new Set<(s: ThemeState) => void>();
  private unlistenSystem: (() => void) | null = null;

  constructor(env: ThemeEnv) {
    this.env = env;
    const saved = env.load();
    if (saved) {
      if (saved.pref) this.pref = saved.pref;
      if (saved.density) this.density = saved.density;
      if (saved.fontScale !== undefined) this.fontScale = clampFontScale(saved.fontScale);
    }
    this.unlistenSystem = env.onSystemChange(() => {
      if (this.pref === "system") this.apply();
    });
  }

  get state(): ThemeState {
    return {
      pref: this.pref,
      density: this.density,
      fontScale: this.fontScale,
      effective: resolveTheme(this.pref, this.env.prefersDark()),
    };
  }

  setPref(pref: ThemePref): void { this.pref = pref; this.persist(); this.apply(); }
  setDensity(density: Density): void { this.density = density; this.persist(); this.apply(); }
  setFontScale(scale: number): void { this.fontScale = clampFontScale(scale); this.persist(); this.apply(); }

  private persist(): void {
    this.env.save({ pref: this.pref, density: this.density, fontScale: this.fontScale });
  }

  // Write the resolved attributes onto the root element. Idempotent — safe to call repeatedly.
  apply(): ThemeState {
    const state = this.state;
    this.env.root.setAttribute("data-theme", state.effective);
    this.env.root.setAttribute("data-density", state.density);
    this.env.root.style.setProperty("--gc-font-scale", String(state.fontScale));
    for (const l of [...this.listeners]) l(state);
    return state;
  }

  subscribe(listener: (s: ThemeState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  destroy(): void {
    this.unlistenSystem?.();
    this.unlistenSystem = null;
    this.listeners.clear();
  }
}

// Browser env: paints on <html>, reads/writes localStorage, tracks the OS colour scheme. Every DOM
// access is guarded so importing this module never throws in a non-browser runtime.
export function browserThemeEnv(storageKey = "gc.theme"): ThemeEnv {
  const canStore = typeof localStorage !== "undefined";
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  return {
    root: (typeof document !== "undefined" ? document.documentElement : { setAttribute() {}, style: { setProperty() {} } }) as RootElementLike,
    prefersDark: () => media?.matches ?? false,
    onSystemChange: (cb: () => void) => {
      if (!media) return () => {};
      media.addEventListener("change", cb);
      return () => media.removeEventListener("change", cb);
    },
    load: () => {
      if (!canStore) return null;
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as Partial<Pick<ThemeState, "pref" | "density" | "fontScale">>) : null;
      } catch { return null; }
    },
    save: (state) => {
      if (!canStore) return;
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* quota/privacy */ }
    },
  };
}

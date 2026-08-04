// Device-local interface language. The preference is independent from the account and server so an
// unreadable interface can always be corrected offline.
import type { Locale } from "./i18n.ts";

export type LangPref = "system" | Locale;
export const LANG_PREFS: readonly LangPref[] = ["system", "ru", "en"];
export const SUPPORTED_LOCALES: readonly Locale[] = ["ru", "en"];
export const FALLBACK_LOCALE: Locale = "en";

export interface LangState { pref: LangPref; locale: Locale }
export interface LangRootLike { setAttribute(name: string, value: string): void }
export interface LangEnv {
  root: LangRootLike;
  systemTags(): readonly string[];
  onSystemChange(cb: () => void): () => void;
  load(): LangPref | null;
  save(pref: LangPref): void;
}

export function normalizeLangPref(value: unknown): LangPref {
  return value === "ru" || value === "en" || value === "system" ? value : "system";
}

export function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/, 1)[0] ?? "";
}

export function resolveLocale(pref: LangPref, systemTags: readonly string[]): Locale {
  if (pref !== "system") return pref;
  for (const tag of systemTags) {
    const lang = primarySubtag(tag);
    if (lang === "ru" || lang === "en") return lang;
  }
  return "en";
}

export class LanguageController {
  private pref: LangPref;
  private readonly env: LangEnv;
  private readonly listeners = new Set<(state: LangState) => void>();

  constructor(env: LangEnv) {
    this.env = env;
    this.pref = normalizeLangPref(env.load());
    env.onSystemChange(() => { if (this.pref === "system") this.apply(); });
  }

  get state(): LangState {
    return { pref: this.pref, locale: resolveLocale(this.pref, this.env.systemTags()) };
  }

  setPref(pref: LangPref): LangState {
    this.pref = normalizeLangPref(pref);
    this.env.save(this.pref);
    return this.apply();
  }

  apply(): LangState {
    const state = this.state;
    this.env.root.setAttribute("lang", state.locale);
    for (const listener of this.listeners) listener(state);
    return state;
  }

  subscribe(listener: (state: LangState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

export function browserLangEnv(storageKey = "gc.lang"): LangEnv {
  return {
    root: document.documentElement,
    systemTags: () => navigator.languages.length ? navigator.languages : [navigator.language],
    onSystemChange: (cb) => {
      window.addEventListener("languagechange", cb);
      return () => window.removeEventListener("languagechange", cb);
    },
    load: () => {
      try {
        const value = localStorage.getItem(storageKey);
        return value === null ? null : normalizeLangPref(value);
      } catch { return null; }
    },
    save: (pref) => {
      try { localStorage.setItem(storageKey, pref); } catch { /* unavailable storage */ }
    },
  };
}

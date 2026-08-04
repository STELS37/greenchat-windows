// clients/ui/src/i18n.ts — internationalisation engine (T-404).
// JSON-style dictionaries ru/en with namespaced flat keys ("chat.newMessage"); {name} interpolation;
// dates/numbers/relative time via the platform Intl (available in Node 22 and browsers). DOM-free →
// unit-tested directly. Missing keys fall back to the fallback locale, then to the key itself.

export type Locale = "ru" | "en";
export type Dict = Record<string, string>;
export type Params = Record<string, string | number>;

export interface I18nOptions {
  locale: Locale;
  dicts: Record<Locale, Dict>;
  fallbackLocale?: Locale;
  onMissing?: (key: string, locale: Locale) => void;
}

export interface I18n {
  readonly locale: Locale;
  setLocale(locale: Locale): void;
  t(key: string, params?: Params): string;
  // Map an Appendix D server error code (or a NetworkError) to human text (CLIENTS §9).
  error(code: string | null | undefined): string;
  formatNumber(value: number, options?: Intl.NumberFormatOptions): string;
  formatDate(value: Date | number, options?: Intl.DateTimeFormatOptions): string;
  formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string;
  subscribe(listener: (locale: Locale) => void): () => void;
}

const BCP47: Record<Locale, string> = { ru: "ru-RU", en: "en-US" };

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

export function createI18n(options: I18nOptions): I18n {
  let locale = options.locale;
  const dicts = options.dicts;
  const fallback = options.fallbackLocale ?? "en";
  const onMissing = options.onMissing;
  const listeners = new Set<(l: Locale) => void>();

  const lookup = (key: string): string | undefined => {
    const primary = dicts[locale]?.[key];
    if (primary !== undefined) return primary;
    const fb = dicts[fallback]?.[key];
    if (fb !== undefined) return fb;
    return undefined;
  };

  // Plural selection. A Russian UI needs three forms for the same sentence ("1 участник", "2 участника",
  // "5 участников"), and a single {count} template can only ever be right for one of them — the classic
  // machine-translated look. When a call passes a numeric `count`, the engine first tries the CLDR
  // category suffix for the active locale (Intl.PluralRules: one/few/many/other), then ".other", and only
  // then the bare key. Keys without suffixed variants therefore behave exactly as before.
  const pluralRules = new Map<Locale, Intl.PluralRules>();
  const categoryOf = (value: number): Intl.LDMLPluralRule => {
    let rules = pluralRules.get(locale);
    if (!rules) {
      rules = new Intl.PluralRules(BCP47[locale]);
      pluralRules.set(locale, rules);
    }
    return rules.select(value);
  };

  const t = (key: string, params?: Params): string => {
    const count = params?.count;
    if (typeof count === "number" && Number.isFinite(count)) {
      const variant = lookup(`${key}.${categoryOf(count)}`) ?? lookup(`${key}.other`);
      if (variant !== undefined) return interpolate(variant, params);
    }
    const template = lookup(key);
    if (template === undefined) {
      onMissing?.(key, locale);
      return key;
    }
    return interpolate(template, params);
  };

  const error = (code: string | null | undefined): string => {
    if (!code) return t("errors.unknown");
    const specific = lookup(`errors.${code}`);
    return specific !== undefined ? specific : t("errors.unknown");
  };

  const formatNumber = (value: number, opts?: Intl.NumberFormatOptions): string =>
    new Intl.NumberFormat(BCP47[locale], opts).format(value);

  const formatDate = (value: Date | number, opts?: Intl.DateTimeFormatOptions): string => {
    const date = value instanceof Date ? value : new Date(value);
    return new Intl.DateTimeFormat(BCP47[locale], opts).format(date);
  };

  const formatRelativeTime = (value: number, unit: Intl.RelativeTimeFormatUnit): string =>
    new Intl.RelativeTimeFormat(BCP47[locale], { numeric: "auto" }).format(value, unit);

  const setLocale = (next: Locale): void => {
    if (next === locale) return;
    locale = next;
    for (const l of [...listeners]) l(locale);
  };

  const subscribe = (listener: (l: Locale) => void): (() => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };

  return {
    get locale() { return locale; },
    setLocale,
    t,
    error,
    formatNumber,
    formatDate,
    formatRelativeTime,
    subscribe,
  };
}

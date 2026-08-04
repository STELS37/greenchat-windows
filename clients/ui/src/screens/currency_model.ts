// clients/ui/src/screens/currency_model.ts — display-currency helpers for the settings picker (T-503).
// Pure, DOM/i18n-free → unit-tested. The SERVER is the source of truth (BANKING §4): it validates the
// code against Intl.supportedValuesOf("currency") and self-responds 204. These helpers only shape the
// client UI and MIRROR the server's normalisation, so what the picker shows is exactly what we send.

// Every ISO-4217 code the runtime knows, for the picker. Returns null when the engine predates
// Intl.supportedValuesOf (older WebViews) — the screen then degrades to a validated manual text entry.
export function listSupportedCurrencies(): string[] | null {
  const sv = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  if (typeof sv !== "function") return null;
  try {
    const list = sv.call(Intl, "currency");
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch {
    return null;
  }
}

// Canonical form the server expects: trimmed + UPPERCASE (mirrors currency.trim().toUpperCase()).
export function normalizeCurrencyInput(code: string): string {
  return code.trim().toUpperCase();
}

// Structural validity for MANUAL entry: exactly three ASCII letters. Deliberately permissive — the
// server owns the authoritative membership check (unknown code → VALIDATION_FAILED), so we only stop the
// obviously-malformed before the round-trip and never second-guess which codes the server accepts.
export function isValidCurrencyCode(code: string): boolean {
  return /^[A-Za-z]{3}$/.test(code.trim());
}

// A human label for the picker: "EUR — Euro" when Intl.DisplayNames can name the code, else just "EUR".
// Never throws (DisplayNames is absent on some engines; an unknown code returns the code itself).
export function currencyLabel(code: string, locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "currency" }).of(code);
    return name && name.toUpperCase() !== code.toUpperCase() ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

// i18n locale ("ru"|"en") → the BCP-47 tag the app formats with (matches i18n.ts's private BCP47 map).
// Shared by the settings picker and the future wallet screen's formatApproxFiat(...) call.
export function currencyLocaleTag(locale: "ru" | "en"): string {
  return locale === "ru" ? "ru-RU" : "en-US";
}

// ─── First-login auto-suggestion (BANKING §4) ────────────────────────────────────────────────────────
// The proposal is derived SOLELY from the client locale (navigator.language) via a small static table in
// this file — NO network, NO external service and explicitly NO IP-geolocation (BANKING §4). It is only a
// proposal: the source of truth stays the user's explicit choice, so nothing is ever written without a tap.

// The eurozone, expanded into REGION_CURRENCY below so every member maps to EUR without 20 repeated lines.
const EUROZONE = ["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"];

// ISO-3166 region → its everyday ISO-4217 currency. A pragmatic subset (eurozone + the common majors); an
// unknown region simply yields no suggestion (the prompt stays hidden) rather than a confidently-wrong guess.
const REGION_CURRENCY: Record<string, string> = {
  US: "USD", GB: "GBP", RU: "RUB", UA: "UAH", BY: "BYN", KZ: "KZT",
  JP: "JPY", CN: "CNY", HK: "HKD", TW: "TWD", KR: "KRW", SG: "SGD", IN: "INR",
  CA: "CAD", AU: "AUD", NZ: "NZD", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK",
  PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", BG: "BGN", TR: "TRY",
  BR: "BRL", MX: "MXN", AR: "ARS", CL: "CLP", CO: "COP",
  ZA: "ZAR", NG: "NGN", EG: "EGP", IL: "ILS", AE: "AED", SA: "SAR",
  TH: "THB", ID: "IDR", MY: "MYR", PH: "PHP", VN: "VND",
  ...Object.fromEntries(EUROZONE.map((r) => [r, "EUR"])),
};

// Primary language subtag → a default currency, used ONLY when the locale carries no region (bare "ru",
// "de", …). Ambiguous languages spanning many currencies (e.g. "es") are deliberately omitted so we stay
// silent rather than guess wrong — the user can always pick in Settings.
const LANGUAGE_CURRENCY: Record<string, string> = {
  en: "USD", ru: "RUB", uk: "UAH", be: "BYN", kk: "KZT",
  de: "EUR", fr: "EUR", it: "EUR", nl: "EUR", pt: "EUR", el: "EUR", et: "EUR", lv: "EUR", lt: "EUR", sk: "EUR", sl: "EUR", fi: "EUR",
  ja: "JPY", zh: "CNY", ko: "KRW", hi: "INR", th: "THB", id: "IDR", vi: "VND",
  pl: "PLN", cs: "CZK", hu: "HUF", ro: "RON", bg: "BGN", tr: "TRY", he: "ILS",
};

// The ISO-3166 region of a BCP-47 tag ("en-US" → "US", "zh-Hant-TW" → "TW"), tolerating the underscore
// form some platforms emit ("en_GB"). Intl.Locale when present, else a subtag regex that requires a leading
// hyphen so the primary language ("en") can never be mistaken for a region.
function localeRegion(tag: string): string | null {
  const norm = tag.replace(/_/g, "-");
  try {
    const r = new Intl.Locale(norm).region;
    if (r) return r.toUpperCase();
  } catch {
    /* malformed tag — fall through to the regex */
  }
  const m = norm.match(/-([A-Za-z]{2}|[0-9]{3})(?=-|$)/);
  return m ? m[1].toUpperCase() : null;
}

// The primary language subtag of a BCP-47 tag ("en-US" → "en", "zh-Hant-TW" → "zh").
function primaryLanguage(tag: string): string | null {
  const m = tag.replace(/_/g, "-").match(/^([A-Za-z]{2,3})(?=-|$)/);
  return m ? m[1].toLowerCase() : null;
}

// navigator.language → a proposed ISO-4217 code (region first, then a language default), or null when the
// locale gives nothing sensible. Deterministic and offline; the ONLY input is the client locale (NO IP).
export function suggestCurrencyFromLocale(language: string): string | null {
  const tag = (language || "").trim();
  if (!tag) return null;
  const region = localeRegion(tag);
  if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
  const lang = primaryLanguage(tag);
  return (lang && LANGUAGE_CURRENCY[lang]) || null;
}

// What the shell should do about the first-login suggestion, given the CURRENT display_currency and locale.
// Pure — it decides but NEVER writes: `offer` is the code to show (null → show nothing) and `markOffered`
// asks the shell to burn its one-time flag straight away (already chosen, or the locale gives nothing) so we
// neither nag a user who has a currency nor re-check a locale that yields none on every boot.
export interface CurrencySuggestPlan {
  offer: string | null;
  markOffered: boolean;
}

export function planCurrencySuggestion(displayCurrency: string | null, locale: string): CurrencySuggestPlan {
  if (displayCurrency != null) return { offer: null, markOffered: true };
  const code = suggestCurrencyFromLocale(locale);
  if (!code) return { offer: null, markOffered: true };
  return { offer: code, markOffered: false };
}

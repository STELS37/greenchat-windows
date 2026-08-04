// clients/ui/src/screens/approx_fiat_model.ts — the "≈" fiat approximation renderer (T-503).
// Source of truth: server buildApproxFiat (modules/wallet.ts) + BANKING §4/§6. DOM-free & i18n-free →
// unit-tested in isolation. A future wallet screen calls formatApproxFiat(row.approx_fiat, locale) and
// paints {text, badge}; this module owns EVERY display rule so that screen stays a one-liner.
//
// Two hard laws it enforces (BANKING §6):
//   1. The "≈" marker is ALWAYS present on an amount — an approximation is never shown as if exact.
//   2. The amount string is fed VERBATIM to Intl.NumberFormat: it is never parsed to a JS number, so a
//      value beyond 2^53 keeps every digit (a float would silently corrupt the low bits).
import type { ApproxFiat } from "./types.ts";

// Semantic badge tokens (the screen maps these to i18n: currency.badge.stale / .unavailable). Kept as
// tokens — not localized text — so the model needs no i18n and tests stay language-agnostic.
export type ApproxBadge = "stale" | "unavailable";

export interface ApproxFiatView {
  // "≈ <localized amount>" — the marker is glued to the amount with a no-break space so it can
  // never wrap onto its own line.
  text: string;
  // "stale" → «курс устарел»; "unavailable" → «курс недоступен»; null → no badge (a fresh rate).
  badge: ApproxBadge | null;
}

// U+2248 ALMOST EQUAL TO + U+00A0 NO-BREAK SPACE.
export const APPROX_MARK = "≈ ";

// Render one wallet/operation approximation, or null when there is NOTHING to show.
//
// Returns null iff `approx` is absent (null/undefined): when fx is disabled the server OMITS the
// approx_fiat field entirely (GC_FX=0), and the rule is to render nothing — NOT an empty badge, NOT a
// bare "≈". Any present approx always yields a text with the "≈" marker; the badge depends on freshness:
//   - unavailable (G-004: rate missing → USD fallback) → "unavailable"  (checked first: strongest signal)
//   - stale       (rate older than the max-age policy) → "stale"
//   - otherwise                                        → null
export function formatApproxFiat(
  approx: ApproxFiat | null | undefined,
  locale: string,
): ApproxFiatView | null {
  if (!approx) return null;
  const badge: ApproxBadge | null = approx.unavailable ? "unavailable" : approx.stale ? "stale" : null;
  return { text: APPROX_MARK + formatCurrencyAmount(approx.amount, approx.currency, locale), badge };
}

// Localize "<amount> <currency>" via Intl, honoring the currency's own fraction digits and symbol.
// The amount arrives as a decimal STRING and is handed to Intl.NumberFormat unchanged — Intl accepts a
// string and formats it without the precision loss of Number(amount) (BANKING §6). TS's lib types lag
// the spec (they still say number|bigint), hence the deliberate cast; the runtime path is proven by a
// beyond-2^53 test. An unknown currency code makes Intl throw RangeError — we then fall back to the raw
// number + code so a stray label never blanks the wallet.
export function formatCurrencyAmount(amount: string, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

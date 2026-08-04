// T-503 — the "≈" fiat approximation formatter (pure, DOM/i18n-free). Covers every display branch:
// absence (fx off), fresh/stale/unavailable badges, the mandatory ≈ marker, the no-float precision
// law (BANKING §6), locale sensitivity, and the graceful fallback on a malformed currency code.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatApproxFiat,
  formatCurrencyAmount,
  APPROX_MARK,
} from "../src/screens/approx_fiat_model.ts";
import type { ApproxFiat } from "../src/screens/types.ts";

const EN = "en-US";
const RU = "ru-RU";
const NB = " "; // NO-BREAK SPACE, used verbatim by the model's marker and its fallback.

// A normal cross-rate approximation; overrides tweak one field per case.
function fiat(over: Partial<ApproxFiat> = {}): ApproxFiat {
  return { currency: "EUR", amount: "10.42", rate_asof: 1784017089, stale: false, ...over };
}

test("absent approx (fx disabled) → null: render NOTHING, not an empty badge", () => {
  assert.equal(formatApproxFiat(null, EN), null);
  assert.equal(formatApproxFiat(undefined, EN), null);
});

test("fresh cross-rate → ≈ marker, no badge, exact Intl output", () => {
  const v = formatApproxFiat(fiat(), EN);
  assert.ok(v);
  assert.equal(v.badge, null);
  assert.ok(v.text.startsWith(APPROX_MARK), "marker present");
  assert.equal(v.text, APPROX_MARK + "€10.42");
});

test("stale rate → badge 'stale' (курс устарел), text still marked", () => {
  const v = formatApproxFiat(fiat({ stale: true }), EN);
  assert.ok(v);
  assert.equal(v.badge, "stale");
  assert.ok(v.text.startsWith(APPROX_MARK));
});

test("unavailable rate (G-004 USD fallback) → badge 'unavailable' (курс недоступен)", () => {
  const v = formatApproxFiat(
    { currency: "USD", amount: "0.00", rate_asof: null, stale: false, unavailable: true },
    EN,
  );
  assert.ok(v);
  assert.equal(v.badge, "unavailable");
  assert.equal(v.text, APPROX_MARK + "$0.00");
});

test("unavailable outranks stale when both are set (defensive precedence)", () => {
  const v = formatApproxFiat(fiat({ stale: true, unavailable: true }), EN);
  assert.equal(v!.badge, "unavailable");
});

test("USD passthrough (rate_asof:null, not unavailable) → marker, no badge", () => {
  const v = formatApproxFiat({ currency: "USD", amount: "0.00", rate_asof: null, stale: false }, EN);
  assert.ok(v);
  assert.equal(v.badge, null);
  assert.ok(v.text.startsWith(APPROX_MARK));
});

test("amount is fed VERBATIM as a string — precision beyond 2^53 survives (no float — §6)", () => {
  // 9007199254740993 = 2^53 + 1; Number(...) would collapse it to ...992.
  const v = formatApproxFiat(fiat({ currency: "JPY", amount: "9007199254740993" }), EN);
  assert.ok(v);
  assert.ok(v.text.includes("740,993"), `kept all digits: ${v.text}`);
  assert.ok(!v.text.includes("740,992"), "did not go through a float");
});

test("VG4 vector (§6): JPY 181877 renders as ≈ ¥181,877 (en) and localizes (ru)", () => {
  const en = formatApproxFiat(fiat({ currency: "JPY", amount: "181877" }), EN);
  const ru = formatApproxFiat(fiat({ currency: "JPY", amount: "181877" }), RU);
  assert.equal(en!.text, APPROX_MARK + "¥181,877");
  assert.ok(ru!.text.includes("181"), "ru keeps the amount");
  assert.ok(ru!.text.includes("¥"), "ru keeps the symbol");
  assert.notEqual(en!.text, ru!.text, "locale changes the layout");
});

test("currency fraction digits follow the currency, not the string (JPY 0-dp, USD 2-dp)", () => {
  // JPY has 0 fraction digits: a "10.42" string rounds to ¥10 (server sends already-scaled values;
  // this just proves the client applies the currency's own scale via Intl).
  assert.equal(formatCurrencyAmount("10.42", "JPY", EN), "¥10");
  assert.equal(formatCurrencyAmount("10", "USD", EN), "$10.00");
});

test("malformed currency code → graceful '<amount> <code>' fallback (never throws/blanks)", () => {
  // "EU" is not a well-formed ISO-4217 code → Intl throws RangeError → we fall back to the raw
  // "<amount> <code>" (NBSP, matching the model — keeps the two glued on one line).
  assert.equal(formatCurrencyAmount("10.42", "EU", EN), "10.42" + NB + "EU");
  // And through the top-level renderer: still marked, no crash.
  const v = formatApproxFiat(fiat({ currency: "EU" }), EN);
  assert.equal(v!.text, APPROX_MARK + "10.42" + NB + "EU");
});

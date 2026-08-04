// T-503 — display-currency helpers (pure). The picker list, the server-mirroring normaliser, the
// permissive manual-entry validator, the DisplayNames label, and the locale→BCP-47 map.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listSupportedCurrencies,
  normalizeCurrencyInput,
  isValidCurrencyCode,
  currencyLabel,
  currencyLocaleTag,
  suggestCurrencyFromLocale,
  planCurrencySuggestion,
} from "../src/screens/currency_model.ts";

test("listSupportedCurrencies: a non-empty ISO-4217 list on a modern runtime (incl. USD/EUR)", () => {
  const list = listSupportedCurrencies();
  assert.ok(Array.isArray(list), "Node 22 supports Intl.supportedValuesOf");
  assert.ok(list!.length > 100);
  assert.ok(list!.includes("USD") && list!.includes("EUR"));
  assert.ok(list!.every((c) => typeof c === "string"));
});

test("normalizeCurrencyInput: trims + upcases to the server's canonical form", () => {
  assert.equal(normalizeCurrencyInput("  eur "), "EUR");
  assert.equal(normalizeCurrencyInput("usd"), "USD");
  assert.equal(normalizeCurrencyInput("JpY"), "JPY");
});

test("isValidCurrencyCode: exactly three ASCII letters (case-insensitive, trimmed)", () => {
  for (const ok of ["EUR", "eur", " usd ", "JpY"]) assert.equal(isValidCurrencyCode(ok), true, ok);
  for (const bad of ["", "EU", "EURO", "E1R", "12$", "€", "US D"]) assert.equal(isValidCurrencyCode(bad), false, bad);
});

test("isValidCurrencyCode is permissive — a well-formed but unassigned code passes (server decides)", () => {
  // "ZZZ" is structurally valid; the SERVER, not the client, rejects it as unknown.
  assert.equal(isValidCurrencyCode("ZZZ"), true);
});

test("currencyLabel: 'CODE — Name' when Intl.DisplayNames can name it; localized", () => {
  assert.equal(currencyLabel("EUR", "en-US"), "EUR — Euro");
  assert.equal(currencyLabel("USD", "en-US"), "USD — US Dollar");
  assert.ok(currencyLabel("EUR", "ru-RU").startsWith("EUR — "), "ru name follows the code");
});

test("currencyLabel: falls back to the bare code (unnamed code / malformed / no DisplayNames)", () => {
  assert.equal(currencyLabel("ZZZ", "en-US"), "ZZZ"); // DisplayNames returns the code → no ' — '
  assert.equal(currencyLabel("E1", "en-US"), "E1");   // malformed → DisplayNames throws → caught
});

test("currencyLocaleTag: i18n locale → the app's BCP-47 tag", () => {
  assert.equal(currencyLocaleTag("ru"), "ru-RU");
  assert.equal(currencyLocaleTag("en"), "en-US");
});

// ─── First-login auto-suggestion (BANKING §4): navigator.language → currency, NO IP ──────────────────

test("suggestCurrencyFromLocale: region-bearing tag → that region's currency", () => {
  assert.equal(suggestCurrencyFromLocale("en-US"), "USD");
  assert.equal(suggestCurrencyFromLocale("en-GB"), "GBP");
  assert.equal(suggestCurrencyFromLocale("ru-RU"), "RUB");
  assert.equal(suggestCurrencyFromLocale("de-DE"), "EUR");
  assert.equal(suggestCurrencyFromLocale("fr-CA"), "CAD");
  assert.equal(suggestCurrencyFromLocale("pt-BR"), "BRL");
  assert.equal(suggestCurrencyFromLocale("ja-JP"), "JPY");
});

test("suggestCurrencyFromLocale: region wins over the language default (es-MX → MXN, not a Spain guess)", () => {
  assert.equal(suggestCurrencyFromLocale("es-MX"), "MXN");
  assert.equal(suggestCurrencyFromLocale("es-ES"), "EUR");
  assert.equal(suggestCurrencyFromLocale("en-CA"), "CAD");
});

test("suggestCurrencyFromLocale: a region-less tag falls back to the primary language default", () => {
  assert.equal(suggestCurrencyFromLocale("ru"), "RUB");
  assert.equal(suggestCurrencyFromLocale("en"), "USD");
  assert.equal(suggestCurrencyFromLocale("de"), "EUR");
  assert.equal(suggestCurrencyFromLocale("ja"), "JPY");
});

test("suggestCurrencyFromLocale: tolerates the underscore form and casing", () => {
  assert.equal(suggestCurrencyFromLocale("en_GB"), "GBP");
  assert.equal(suggestCurrencyFromLocale("PT-br"), "BRL");
  assert.equal(suggestCurrencyFromLocale("  ru-RU  "), "RUB");
});

test("suggestCurrencyFromLocale: script subtags don't shadow the region (zh-Hant-TW → TWD)", () => {
  assert.equal(suggestCurrencyFromLocale("zh-Hant-TW"), "TWD");
  assert.equal(suggestCurrencyFromLocale("zh-Hans-CN"), "CNY");
  assert.equal(suggestCurrencyFromLocale("zh-Hant"), "CNY"); // script only → language default
});

test("suggestCurrencyFromLocale: no confident guess → null (empty, garbage, unmapped, ambiguous 'es')", () => {
  assert.equal(suggestCurrencyFromLocale(""), null);
  assert.equal(suggestCurrencyFromLocale("   "), null);
  assert.equal(suggestCurrencyFromLocale("x"), null);
  assert.equal(suggestCurrencyFromLocale("es"), null); // bare Spanish spans many currencies → stay silent
  assert.equal(suggestCurrencyFromLocale("zz-ZZ"), null); // well-formed but unmapped region + language
});

test("planCurrencySuggestion: null display_currency + a mappable locale → offer it, don't burn the flag", () => {
  assert.deepEqual(planCurrencySuggestion(null, "de-DE"), { offer: "EUR", markOffered: false });
  assert.deepEqual(planCurrencySuggestion(null, "en-US"), { offer: "USD", markOffered: false });
});

test("planCurrencySuggestion: a currency already chosen → show nothing, burn the flag (stop checking)", () => {
  assert.deepEqual(planCurrencySuggestion("USD", "de-DE"), { offer: null, markOffered: true });
  assert.deepEqual(planCurrencySuggestion("JPY", "ru-RU"), { offer: null, markOffered: true });
});

test("planCurrencySuggestion: null display_currency but the locale gives nothing → burn (don't retry each boot)", () => {
  assert.deepEqual(planCurrencySuggestion(null, "es"), { offer: null, markOffered: true });
  assert.deepEqual(planCurrencySuggestion(null, ""), { offer: null, markOffered: true });
});

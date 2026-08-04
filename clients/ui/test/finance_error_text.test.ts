// A money refusal must say what happened.
//
// Found on the emulator during the P0 beta pass: a transfer came back 403
// {"code":"PAYMENTS_FROZEN"} and the sheet printed "Something went wrong". Fifteen of the sixteen
// wallet codes had no text at all, so an empty balance, a missing PIN and a maintenance freeze were
// indistinguishable — the person could not tell a mistake they could fix from a wait they could not.
//
// The gate reads the codes straight out of the money modules on the server, so a new refusal added
// there fails here until it gets human wording in BOTH locales. Codes that never reach a screen
// (internal state guards) are listed explicitly rather than silently skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = resolve(here, "../../../server/src");

const MODULES = [
  "modules/wallet.ts",
  "modules/onchain.ts",
  "modules/swaps.ts",
  "modules/orders.ts",
  "core/payment_gate.ts",
  "core/payment_control.ts",
];

// Refusals the money screens never surface: they belong to shop checkout (its own screen) or to
// generic families already covered by the shared errors.* block.
const NOT_A_MONEY_SHEET = new Set([
  "SHOP_STOCK_EMPTY",
  "SHOP_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "FORBIDDEN",
  "CONFLICT",
]);

function codesThrownBy(file: string): string[] {
  const source = readFileSync(resolve(serverSrc, file), "utf8");
  const found = new Set<string>();
  for (const match of source.matchAll(/ApiError\(\s*"([A-Z][A-Z0-9_]+)"/g)) found.add(match[1]);
  return [...found];
}

test("finance: every money refusal the server can send has human text in ru and en", () => {
  const codes = new Set<string>();
  for (const file of MODULES) for (const code of codesThrownBy(file)) codes.add(code);
  assert.ok(codes.size >= 15, `expected the money modules to still declare their codes, saw ${codes.size}`);

  const untranslated: string[] = [];
  for (const code of [...codes].sort()) {
    if (NOT_A_MONEY_SHEET.has(code)) continue;
    const key = `errors.${code}`;
    if (typeof en[key] !== "string" || typeof ru[key] !== "string") untranslated.push(code);
  }
  assert.deepEqual(untranslated, [], `money codes with no wording (they render as "Something went wrong"): ${untranslated.join(", ")}`);
});

test("finance: the maintenance freeze is named, not hidden behind the generic line", () => {
  // The exact case caught on device: PAYMENTS_FROZEN must not resolve to the unknown-error text,
  // and it must promise the money is intact — otherwise a pause reads as a loss.
  assert.notEqual(en["errors.PAYMENTS_FROZEN"], en["errors.unknown"]);
  assert.notEqual(ru["errors.PAYMENTS_FROZEN"], ru["errors.unknown"]);
  assert.match(en["errors.PAYMENTS_FROZEN"] as string, /maintenance/i);
  assert.match(ru["errors.PAYMENTS_FROZEN"] as string, /обслуживание|обслуживани/i);
  assert.match(en["errors.PIN_REQUIRED"] as string, /PIN/);
  assert.match(en["errors.INSUFFICIENT_FUNDS"] as string, /funds/i);
});

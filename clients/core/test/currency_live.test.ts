// T-503 — LIVE integration of the client currency surface against the REAL compiled server (T-502 merged).
// Spawns the server on a throwaway data dir + free port (server-harness) with GC_PAYMENTS=1 GC_FX=1 and the
// default `manual` FX source (no rate rows seeded), which makes the G-004 "unavailable" branch deterministic.
// Proves: (1) a currency change reaches /v1/users/me, (2) the wallet's read-time approx_fiat surfaces the
// unavailable branch a client renders as the «курс недоступен» badge, and (3) USD is the identity leg (no
// badge). The badge-TEXT mapping itself is pinned hermetically in ui/test/approx_fiat_model.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startLiveServer, emptyTokens, type LiveServer } from "./server-harness.ts";
import { ApiClient } from "../src/api.ts";
import type { SessionResult, ApproxFiat, FxRatesResult } from "../src/types.ts";

let srv: LiveServer;
before(async () => {
  // GC_PAYMENTS=1 → /v1/wallet is readable; GC_FX=1 → approx_fiat is attached; manual source, no seeded
  // rates → every non-USD display currency hits the G-004 fallback. GC_FX_SOURCE defaults to "manual".
  srv = await startLiveServer({ GC_PAYMENTS: "1", GC_FX: "1" });
});
after(async () => {
  await srv.teardown();
});

let uSeq = 0;
function uname(): string {
  return `cur${Date.now().toString(36)}${(uSeq++).toString(36)}`.slice(0, 20).toLowerCase();
}
async function register(): Promise<ApiClient> {
  const api = new ApiClient({ baseUrl: srv.base, clientId: "node/0.1.0", tokens: emptyTokens() });
  const r = await api.post<SessionResult>(
    "/v1/auth/register",
    { username: uname(), password: "password1", name: "Cur", legal_accepted: true, age_confirmed: true },
    { idempotent: false },
  );
  api.tokens.access = r.access_token;
  api.tokens.refresh = r.refresh_token;
  api.tokens.accessExpiresAt = r.access_expires_at;
  return api;
}

test("putMyCurrency (204) → the choice reaches /v1/users/me", async () => {
  const api = await register();

  const before = await api.get<{ display_currency: string | null }>("/v1/users/me");
  assert.equal(before.display_currency, null, "a fresh account has no display currency (NULL ⇒ USD, §4)");

  const put = await api.putMyCurrency("EUR");
  assert.equal(put, null, "PUT /v1/me/currency self-responds 204 → the SDK resolves null");

  const after = await api.get<{ display_currency: string | null }>("/v1/users/me");
  assert.equal(after.display_currency, "EUR", "the explicit choice is the source of truth and round-trips");
});

test("wallet approx_fiat: a currency with no rate → G-004 unavailable branch (renders «курс недоступен»)", async () => {
  const api = await register();
  await api.putMyCurrency("EUR"); // manual source, no EUR rate seeded ⇒ no rate on hand

  const wallet = await api.get<{ approx_fiat?: ApproxFiat }>("/v1/wallet");
  const approx = wallet.approx_fiat;
  assert.ok(approx, "GC_FX=1 attaches approx_fiat to the wallet read");
  assert.equal(approx!.unavailable, true, "no rate for EUR ⇒ unavailable:true (the badge branch, not an error)");
  assert.equal(approx!.currency, "USD", "G-004 falls back to the USD notional");
  assert.equal(approx!.rate_asof, null, "the fallback has no rate timestamp");
  assert.equal(approx!.stale, false, "unavailable is its own branch — never also flagged stale");
});

test("wallet approx_fiat: USD is the identity leg → no badge at all", async () => {
  const api = await register();
  await api.putMyCurrency("USD");

  const wallet = await api.get<{ approx_fiat?: ApproxFiat }>("/v1/wallet");
  const approx = wallet.approx_fiat;
  assert.ok(approx, "approx_fiat present under GC_FX=1");
  assert.equal(approx!.currency, "USD");
  assert.ok(!approx!.unavailable, "USD needs no rate → not unavailable");
  assert.equal(approx!.stale, false, "and never stale");
});

test("getFxRates decodes the reference table (enabled, source, items[])", async () => {
  const api = await register();
  const rates = await api.getFxRates<FxRatesResult>();
  assert.equal(rates.enabled, true, "GC_FX=1 ⇒ the table reports enabled");
  assert.equal(typeof rates.source, "string");
  assert.ok(Array.isArray(rates.items), "items is an array (possibly empty with no seeded rates)");
});

// T-503 — the first-login suggestion controller's orchestration (BANKING §4). We exercise the branches that
// resolve BEFORE any DOM is built (the offer path itself is DOM chrome, validated by typecheck + the live
// probe): the one-time flag gate, the me fetch, burning the flag when a currency is already set or the
// locale gives nothing, and — crucially — NOT burning the flag on a transient fetch error.
import { test } from "node:test";
import assert from "node:assert/strict";
import { maybeSuggestCurrency } from "../src/screens/currency_suggest.ts";
import type { CurrencySuggestFlagPort } from "../src/screens/currency_suggest.ts";
import type { ApiLike } from "../src/screens/api.ts";
import type { I18n } from "../src/i18n.ts";

// A flag port that records writes.
function fakeFlag(initial: boolean): CurrencySuggestFlagPort & { offered: boolean; marks: number } {
  const state = { offered: initial, marks: 0 };
  return {
    offered: initial,
    marks: 0,
    wasOffered() { return state.offered; },
    markOffered() { state.offered = true; this.offered = true; this.marks += 1; },
  };
}

// A minimal ApiLike whose GET yields a chosen me (or throws), counting calls. Only get<T> is exercised here.
function fakeApi(me: { display_currency: string | null } | Error): ApiLike & { gets: number } {
  const api = {
    gets: 0,
    async get<T>(): Promise<T> {
      this.gets += 1;
      if (me instanceof Error) throw me;
      return me as unknown as T;
    },
    async post<T>(): Promise<T> { throw new Error("unused"); },
    async put<T>(): Promise<T> { throw new Error("unused"); },
    async del<T>(): Promise<T> { throw new Error("unused"); },
  };
  return api as unknown as ApiLike & { gets: number };
}

const i18n = {} as unknown as I18n;          // never reached in these (non-DOM) branches
const host = {} as unknown as HTMLElement;   // never touched before the offer path

test("already offered → no fetch, no write (short-circuits on the flag)", async () => {
  const flag = fakeFlag(true);
  const api = fakeApi({ display_currency: null });
  await maybeSuggestCurrency({ api, i18n, host, locale: "de-DE", flag });
  assert.equal(api.gets, 0, "must not fetch me once the flag is set");
  assert.equal(flag.marks, 0);
});

test("a currency already chosen → fetch, burn the flag, show nothing", async () => {
  const flag = fakeFlag(false);
  const api = fakeApi({ display_currency: "USD" });
  await maybeSuggestCurrency({ api, i18n, host, locale: "de-DE", flag });
  assert.equal(api.gets, 1);
  assert.equal(flag.offered, true, "burns the flag so it never re-checks");
  assert.equal(flag.marks, 1);
});

test("null currency but the locale gives nothing → burn the flag (don't retry every boot), no DOM", async () => {
  const flag = fakeFlag(false);
  const api = fakeApi({ display_currency: null });
  await maybeSuggestCurrency({ api, i18n, host, locale: "es", flag }); // bare 'es' → no confident guess
  assert.equal(api.gets, 1);
  assert.equal(flag.offered, true);
});

test("a transient fetch error → do NOT burn the flag (a later boot retries)", async () => {
  const flag = fakeFlag(false);
  const api = fakeApi(new Error("offline"));
  await maybeSuggestCurrency({ api, i18n, host, locale: "de-DE", flag });
  assert.equal(api.gets, 1);
  assert.equal(flag.offered, false, "the one-time flag stays unburnt on a transient failure");
  assert.equal(flag.marks, 0);
});

test("would offer, but no DOM host → best-effort no-op: no throw, flag left unburnt", async () => {
  // display_currency null + a mappable locale ⇒ plan.offer = 'EUR'; with no `document` the banner build
  // fails INSIDE the guarded block and the call resolves cleanly instead of rejecting the void promise.
  const flag = fakeFlag(false);
  const api = fakeApi({ display_currency: null });
  await assert.doesNotReject(maybeSuggestCurrency({ api, i18n, host, locale: "de-DE", flag }));
  assert.equal(api.gets, 1);
  assert.equal(flag.offered, false, "the offer path never burns the flag on its own — only a user tap does");
});

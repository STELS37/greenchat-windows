// clients/ui/test/visual_finance_states_v85.test.ts — V85 regression guard.
//
// Defect, measured on the running client at 390x844 with the finance contour off
// (probe var/ux-audit/tools/m_finstate_v85.mjs, 2026-07-30, pointer parked off the page):
//
//   /exchange  .gc-finance-empty  358 x 609  @y=145  action=NONE
//   /wallet    .gc-finance-empty  358 x 609  @y=145  action=NONE
//   /          .gc-state          (the chats screen already spoke the V76 language)
//
// Two faults, one cause. The finance family carried a SECOND state language, written before V76:
//
//   1. Dead end. Whatever went wrong — the contour is deliberately off, the phone lost the network,
//      or the server refused the request — the screen spent the entire viewport on a sentence and
//      offered the user no move at all (`action=NONE`). A read failure is the one case where a retry
//      is always the right button, and it was missing.
//   2. One picture for three different facts. `.gc-finance-empty` always drew the same green glyph,
//      so "not switched on for you" was indistinguishable from "we cannot reach the server" and from
//      "the server answered with an error" — the user cannot tell whether to wait, to retry, or to
//      report.
//
// V76 had already solved exactly this for chats and calls: one shape (`.gc-state`), the meaning in
// `data-tone`, and one honest action. V85 deletes the second language instead of improving it.
//
// Textual guard, like V63–V76: the routes that reach these states depend on /v1/config and on a live
// network, so what is frozen here is the RULE, not one rendered pixel map.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");
const finance = read("../src/screens/finance_screen.ts");
const calls = read("../src/screens/calls_screen.ts");
const stateView = read("../src/screens/state_view.ts");
const sheets = {
  "styles.css": read("../../web/src/styles.css"),
  "redesign.css": read("../../web/src/redesign.css"),
};
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("V85: the second state language is gone from the screens", () => {
  for (const [name, src] of [["finance_screen.ts", finance], ["calls_screen.ts", calls]] as const) {
    const live = src.replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(live, /gc-finance-empty/, `${name} still builds the pre-V76 state block`);
  }
});

test("V85: no stylesheet keeps an orphan rule for the deleted block", () => {
  for (const [name, css] of Object.entries(sheets)) {
    assert.doesNotMatch(strip(css), /\.gc-finance-empty\b/, `${name} still styles a block nobody renders`);
  }
});

test("V85: every state on a finance screen comes from the shared builder", () => {
  // The screen may keep a local helper, but it must delegate: the only element class allowed here is
  // the shared one, and it is produced by state_view.ts, not by hand.
  assert.match(finance, /from "\.\/state_view\.ts"/, "finance_screen imports the shared state language");
  assert.match(stateView, /class:\s*"gc-state"/, "state_view.ts is the one place that builds .gc-state");
  const handmade = finance.match(/class:\s*"gc-state/g) ?? [];
  assert.equal(handmade.length, 0, "a screen must not hand-build the shared state markup");
});

test("V85: a failure offers a retry and says which kind of failure it was", () => {
  // failureState() picks tone offline vs error from the thrown value and always wires a retry, so
  // requiring it on the failure path is what makes both claims true at once.
  assert.match(
    finance,
    /:\s*failureState\(err,\s*i18n,\s*\(\)\s*=>\s*void load\(\)\)/,
    "a failing finance load must render the honest failure state with a working retry",
  );
  assert.doesNotMatch(
    finance,
    /emptyState\(\s*name,\s*i18n\.t\(titleKey\),\s*describeError/,
    "a server failure must not be dressed up as an empty result",
  );
});

test("V85: a contour that is off still offers the one move that can change the answer", () => {
  // The flag lives on the server and can flip without the app restarting, so "not switched on" is not
  // a dead end either. Both off-paths (the pre-flight guard and the cards route) must pass an action.
  // Balanced-paren slice: a regex window cannot read a call whose own arguments contain parentheses.
  const callsTo = (src: string, name: string): string[] => {
    const out: string[] = [];
    for (const m of src.matchAll(new RegExp(`${name}\\(`, "g"))) {
      let depth = 0;
      for (let i = m.index! + name.length; i < src.length; i += 1) {
        if (src[i] === "(") depth += 1;
        else if (src[i] === ")") {
          depth -= 1;
          if (depth === 0) { out.push(src.slice(m.index!, i + 1)); break; }
        }
      }
    }
    return out;
  };
  const offStates = callsTo(finance, "emptyState");
  const unavailable = offStates.filter((s) => /finance\.unavailable/.test(s));
  assert.ok(unavailable.length >= 2, "the contour-off states are still rendered from one helper");
  for (const state of unavailable) {
    assert.match(state, /common\.retry/, "an unavailable contour must still offer a retry");
    assert.match(state, /onAction:\s*\(\)\s*=>\s*void load\(\)/, "and the retry must actually reload");
  }
});

test("V85: the shared state keeps its three tones", () => {
  for (const tone of ["empty", "offline", "error"]) {
    assert.ok(stateView.includes(`"${tone}"`), `the ${tone} tone must survive`);
  }
  const tinted = strip(sheets["redesign.css"]).match(/\.gc-state\[data-tone="(offline|error)"\]/g) ?? [];
  assert.equal(new Set(tinted).size, 2, "offline and error must stay visually distinct from empty");
});

// ---------------------------------------------------------------------------------------------
// V85b: silence is not an answer.
//
// The first V85 pass gave the finance screens a retry button, and the browser probe
// (var/ux-audit/tools/m_fintone_v85.mjs, 2026-07-30, 390x844) then showed the deeper defect: with the
// network fully cut, /wallet STILL rendered
//
//   tone=empty  glyph=green  «Кошелёк временно недоступен / Финансовый контур ещё не активирован…»
//
// i.e. a confident statement about the SERVER's configuration derived from the phone's silence. Two
// causes, both fixed here and frozen by these tests:
//
//   1. serverFeatures() folded "the probe failed" into "the contours are off" and then CACHED that
//      verdict for the lifetime of the api instance — so the retry button could not change the answer,
//      because nothing ever asked again.
//   2. The screens short-circuited on `payments === false` without asking whether the server had in
//      fact answered. A short-circuit is only legitimate on a real answer; on silence the request must
//      run, because its own failure is what tells the truth (offline vs refused).
import { readServerFeatures, serverFeatures, forgetServerFeatures } from "../src/screens/server_features.ts";
import type { ApiLike } from "../src/screens/api.ts";

const fakeApi = (impl: () => Promise<unknown>): { api: ApiLike; calls: () => number } => {
  let calls = 0;
  const api = {
    get: <T,>(): Promise<T> => {
      calls += 1;
      return impl() as Promise<T>;
    },
  } as unknown as ApiLike;
  return { api, calls: () => calls };
};

test("V85b: an answer marks the contours known; a silence does not", async () => {
  assert.equal(readServerFeatures({ features: { cards: true, payments: true } }).known, true);
  // A server that predates the flags still ANSWERED: known stays true, the contours read off.
  const old = readServerFeatures({});
  assert.equal(old.known, true);
  assert.equal(old.payments, false);

  const { api } = fakeApi(() => Promise.reject(new Error("offline")));
  const silent = await serverFeatures(api);
  assert.equal(silent.known, false, "a failed probe must not claim to know the server's configuration");
  assert.equal(silent.payments, false, "…while still hiding contours it cannot confirm");
  forgetServerFeatures(api);
});

test("V85b: a failed probe is not remembered, so retry can actually change the answer", async () => {
  let fail = true;
  const { api, calls } = fakeApi(() =>
    fail ? Promise.reject(new Error("offline")) : Promise.resolve({ features: { payments: true } }),
  );
  assert.equal((await serverFeatures(api)).known, false);
  fail = false;
  const second = await serverFeatures(api);
  assert.equal(calls(), 2, "the second call must re-probe: a silence is not a cached answer");
  assert.equal(second.payments, true);
  assert.equal(second.known, true);
  // An ANSWER, by contrast, is cached — /v1/config is public and read by several screens.
  await serverFeatures(api);
  assert.equal(calls(), 2, "an answer must stay memoised");
  forgetServerFeatures(api);
});

test("V85b: no screen declares a contour off on the strength of a silent probe", () => {
  // contourOff(): the wallet/exchange guard.
  assert.match(
    finance,
    /if \(probe\.payments \|\| !probe\.known\) return false;/,
    "the wallet/exchange guard must fall through when the probe never reached the server",
  );
  // renderCards(): the same rule, written the other way round.
  assert.match(
    finance,
    /if \(!probe\.cards && probe\.known\) \{/,
    "the cards guard must fall through when the probe never reached the server",
  );
  // And nothing may go back to reading the raw boolean without the `known` companion.
  assert.doesNotMatch(
    finance,
    /if \(await paymentsAvailable\)|if \(!\(await cardsAvailable\)\) \{/,
    "a bare contour boolean must not gate a whole screen again",
  );
});

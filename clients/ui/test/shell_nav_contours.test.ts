// The main navigation must not advertise a destination the server refuses to serve.
//
// Measured defect (UX route audit v40, var/ux-audit/v40/report.json): on a stock deployment
// (GC_PAYMENTS unset, which is the documented default of PAYMENTS.md) the bottom bar of the client
// offered five destinations, and two of them — «Кошелёк» and «Биржа» — answered every tap with
// `http 403 /v1/wallet`, `http 403 /v1/ex/pairs` and an "unavailable" card. Two fifths of the primary
// navigation of a messenger were reserved for a contour that cannot run. The bar is now built from
// what /v1/config actually advertises.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readServerFeatures, visibleDestinations } from "../src/screens/server_features.ts";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(resolve(here, "../src/screens/app.ts"), "utf8");

// V161: the bar no longer carries «Биржа». It was the third door to the wallet's own exchange view
// (the finance screen has a Wallet|Exchange control and an «Обмен» tile), so the slot went to
// «Контакты» — a destination with no server contour to gate on, which is why it carries no `requires`.
// «Биржа» did not disappear: it is a hub tile now, still gated on payments (asserted below).
const NAV = [
  { section: "chats" },
  { section: "calls" },
  { section: "contacts" },
  { section: "wallet", requires: "payments" as const },
  { section: "settings" },
];

test("a payments-less server keeps only the destinations that work", () => {
  const off = readServerFeatures({ features: { payments: false, cards: false } });
  assert.deepEqual(
    visibleDestinations(NAV, off).map((i) => i.section),
    ["chats", "calls", "contacts", "settings"],
  );
});

test("a payments-enabled server gets the full bar back", () => {
  const on = readServerFeatures({ features: { payments: true, cards: true } });
  assert.deepEqual(
    visibleDestinations(NAV, on).map((i) => i.section),
    ["chats", "calls", "contacts", "wallet", "settings"],
  );
});

test("an old server that omits the flag reads as off, never as on", () => {
  // The conservative direction: a hidden tab comes back on the next probe, a dead tab never recovers.
  for (const body of [null, {}, { features: {} }, { features: { payments: "yes" } }, "nonsense"]) {
    const f = readServerFeatures(body);
    assert.equal(f.payments, false, `payments must read off for ${JSON.stringify(body)}`);
    assert.equal(f.cards, false, `cards must read off for ${JSON.stringify(body)}`);
  }
});

test("the shell actually routes its navigation through the filter", () => {
  // Without this the pure helper above could stay green while the bar rendered the raw list.
  assert.match(app, /visibleDestinations\(mainDestinations\(\), contours\)/);
  // …and the same filter must gate the «Ещё» service catalogue, otherwise a destination hidden from
  // the bar would reappear as a hub tile that still answers 403.
  assert.match(app, /visibleDestinations\(catalogue, contours\)/);
  // A destination trimmed from the bar has to land in the hub instead of vanishing from the product.
  assert.match(app, /advertised\.has\(entry\.route\)/);
  assert.match(app, /section: "wallet"[\s\S]{0,160}requires: "payments"/);
  // V161: «Биржа» left the bar, so the ONLY acceptable outcome is that the hub carries it — with the
  // same payments gate, or a payments-less deployment would get a tile that answers 403.
  assert.ok(!/section: "exchange"/.test(app), "the tab bar must not advertise the exchange any more");
  assert.match(app, /id: "exchange"[\s\S]{0,220}requires: "payments"/);
  // …and the slot it freed is a real destination, deliberately ungated (contacts need no contour).
  assert.match(app, /section: "contacts"[\s\S]{0,160}route: "\/contacts"/);
  assert.ok(
    !/section: "contacts"[\s\S]{0,160}requires:/.test(app),
    "contacts work on every deployment: gating them would hide the tab on a stock server",
  );
  // …and that the probe is fired at start-up, otherwise the bar would stay minimal forever.
  assert.match(app, /probeContours\(\);/);
});

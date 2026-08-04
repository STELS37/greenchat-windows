// clients/ui/test/gcn_screen.test.ts — the Green Coin (GCN) sheet, pinned by what it must never claim.
//
// The owner's brief for this token is one sentence: "сделай его выгодным для приобретения, эмиссию
// ограничь и сделай дефляционным". Two thirds of that are ledger facts (a cap that can only fall, a
// fee burn) and are enforced on the server. The last third is a UI temptation: "выгодный" is exactly
// the word that makes screens grow a price forecast, a projected yield, or a discount the reader
// cannot actually receive today. This file is the guard on that third.
//
// It therefore checks statements, not pixels:
//   1. a dark holder programme reports the discount the caller REALLY has (zero), and the tier's
//      worth appears only as an explanation carrying the words "when the programme is on";
//   2. the deflation block says which way the ceiling moves, and follows the server if the server
//      ever reports the opposite;
//   3. a token that does not exist here, and a route that refuses, produce one sentence — never a
//      page of zeroes, which would read as "the cap is 0" instead of "there is nothing here";
//   4. the bars are decorative: aria-hidden, width written through the CSSOM (a `style` attribute is
//      dropped by `style-src 'self'`, V84), and always in step with the figure above them.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { formatNano } from "../src/screens/finance_model.ts";
import type { GcnWire } from "../src/screens/gcn_model.ts";
import { openGcn, type GcnSheetDeps } from "../src/screens/gcn_screen.ts";
import { sheetError } from "../src/screens/finance_sheet.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const NANO = 1_000_000_000n;
const nano = (whole: number | bigint): string => (BigInt(whole) * NANO).toString();

/** The shape the running server answers with (server/src/modules/gcn.ts), 21M cap, some burned. */
const WIRE: GcnWire = {
  available: true,
  asset: "GCN",
  name: "Green Coin",
  supply: {
    max: nano(21_000_000),
    effective_max: nano(20_999_500),
    minted: nano(1_000_000),
    burned: nano(500),
    circulating: nano(999_500),
    remaining_issuance: nano(19_999_500),
    treasury: nano(400_000),
  },
  deflation: {
    fee_burn_bp: 10_000,
    burn_period_sec: 3600,
    burn_restores_headroom: false,
    burn_account: "burn:gcn",
  },
  holder_programme: {
    enabled: false,
    tiers: [
      { name: "green", min_holding: nano(100), discount_bp: 1000 },
      { name: "bronze", min_holding: nano(1_000), discount_bp: 2500 },
      { name: "silver", min_holding: nano(10_000), discount_bp: 4000 },
      { name: "gold", min_holding: nano(100_000), discount_bp: 5000 },
    ],
  },
  you: {
    holding: nano(1_500),
    tier: "bronze",
    discount_bp: 0,
    next_tier: { name: "silver", min_holding: nano(10_000), discount_bp: 4000, need: nano(8_500) },
  },
  market: { pair: "GCN/GUSD", quote: "GUSD", mode: "swap_only", enabled: true },
  server_time: 1_800_000_000,
};

const clone = (): GcnWire => JSON.parse(JSON.stringify(WIRE)) as GcnWire;

function mount(gcn: () => Promise<GcnWire>): { deps: GcnSheetDeps; panel: () => StubNode } {
  let panel: StubNode | null = null;
  const deps: GcnSheetDeps = {
    money: { gcn },
    i18n,
    openSheet: (node) => { panel = node as unknown as StubNode; },
    closeSheet: () => {},
  };
  return { deps, panel: () => { assert.ok(panel, "no sheet mounted"); return panel as unknown as StubNode; } };
}

const status = (panel: StubNode): StubNode => {
  const s = panel.find((n) => n.hasClass("gc-sheet-status"));
  assert.ok(s, "the sheet has no status line");
  return s as StubNode;
};
const bars = (panel: StubNode): StubNode[] => panel.findAll((n) => n.hasClass("gc-gcn-bar"));

// ── 1. the discount is the one the caller actually receives ─────────────────────────────────────

test("GCN: a dark holder programme shows zero discount and says why", async () => {
  const h = mount(() => Promise.resolve(clone()));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  const holder = panel.find((n) => n.hasClass("gc-gcn-holder"));
  assert.ok(holder, "no holder block");
  const shown = holder!.find((n) => n.hasClass("gc-gcn-discount"));
  assert.ok(shown, "the discount is not stated at all");
  assert.equal(shown!.textContent, "0 %", "a discount nobody receives today must not be printed as received");
  // The tier's worth may be explained, but only in the sentence that dates it to the future.
  assert.ok(holder!.textContent.includes(i18n.t("gcn.programmeOff")), "the zero is left unexplained");
  assert.ok(
    holder!.textContent.includes(i18n.t("gcn.tierWorth", { name: "Бронза", pct: "25" })),
    "the ladder's value must be explained as conditional, not claimed",
  );
});

test("GCN: an armed programme prints the discount the server grants, not the tier table's", async () => {
  const wire = clone();
  wire.holder_programme!.enabled = true;
  // The server is the authority on what this account gets: a grandfathered account can hold a bronze
  // balance and still be granted the silver rate. The screen must repeat the server, never recompute.
  wire.you!.discount_bp = 4000;
  const h = mount(() => Promise.resolve(wire));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  assert.equal(panel.find((n) => n.hasClass("gc-gcn-discount"))!.textContent, "40 %");
  assert.ok(!panel.textContent.includes(i18n.t("gcn.programmeOff")), "an armed programme must not warn it is dark");
});

// ── 2. the deflation claim follows the ledger, in both directions ────────────────────────────────

test("GCN: the page states that burning lowers the ceiling for good", async () => {
  const h = mount(() => Promise.resolve(clone()));
  openGcn(h.deps);
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes(i18n.t("gcn.deflationIrreversible")), "the one claim that makes this deflationary is missing");
  assert.ok(text.includes(i18n.t("gcn.deflationBurn", { pct: "100", asset: "GCN", period: i18n.t("gcn.periodHour") })));
  // 21 000 000 − 20 999 500 = 500 GCN of cap that no longer exists.
  assert.ok(text.includes(i18n.t("gcn.ceilingLowered", { amount: "500", asset: "GCN" })), "the fallen cap is not shown");
});

test("GCN: a server that restores headroom is quoted, not contradicted", async () => {
  const wire = clone();
  wire.deflation!.burn_restores_headroom = true;
  const h = mount(() => Promise.resolve(wire));
  openGcn(h.deps);
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes(i18n.t("gcn.deflationRestores")), "the screen kept its own story instead of the ledger's");
  assert.ok(!text.includes(i18n.t("gcn.deflationIrreversible")), "two opposite claims on one page");
});

test("GCN: a switched-off burn is stated as off instead of as a 0 % burn", async () => {
  const wire = clone();
  wire.deflation!.fee_burn_bp = 0;
  const h = mount(() => Promise.resolve(wire));
  openGcn(h.deps);
  await settle();
  assert.ok(h.panel().textContent.includes(i18n.t("gcn.deflationOff")));
});

// ── 3. absence is a sentence, not a page of zeroes ───────────────────────────────────────────────

test("GCN: a deployment without the token says so and prints no supply figures", async () => {
  const h = mount(() => Promise.resolve({ available: false } as GcnWire));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  assert.equal(status(panel).textContent, i18n.t("gcn.unavailable"));
  assert.equal(panel.find((n) => n.hasClass("gc-gcn-hero")), null, "an absent token must not render a hero");
  assert.ok(!panel.textContent.includes(i18n.t("gcn.supply.max")), "a cap of «—» reads as a real cap of zero");
});

test("GCN: a refused route lands as the sheet's own wording, never as a code", async () => {
  const err = Object.assign(new Error("off"), { name: "ApiError", code: "FEATURE_DISABLED" });
  const h = mount(() => Promise.reject(err));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  assert.equal(status(panel).textContent, sheetError(err, i18n));
  assert.ok(!panel.textContent.includes("FEATURE_DISABLED"));
  assert.equal(panel.find((n) => n.hasClass("gc-gcn-hero")), null);
});

test("GCN: the sheet appears before the answer does", () => {
  const h = mount(() => new Promise<GcnWire>(() => {}));
  openGcn(h.deps);
  // A button that does nothing until a round trip finishes reads as a dead button.
  assert.equal(status(h.panel()).textContent, i18n.t("common.loading"));
});

// ── 4. the bars are decoration, and they agree with the figures ──────────────────────────────────

test("GCN: every bar is aria-hidden, sized through the CSSOM, and clamped to 0..100", async () => {
  const h = mount(() => Promise.resolve(clone()));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  const found = bars(panel);
  assert.ok(found.length >= 6, `expected the hero, five supply rows and the tier progress, got ${found.length}`);
  for (const node of found) {
    assert.equal(node.attrs["aria-hidden"], "true", "a decorative twin of a figure must not be read out");
    assert.equal(node.attrs.style, undefined, "a style attribute is dropped by style-src 'self' (V84)");
    const fill = node.find((n) => n.hasClass("gc-gcn-bar-fill"));
    assert.ok(fill, "a bar with no fill");
    const pct = Number.parseFloat(fill!.style.width ?? "");
    assert.ok(Number.isFinite(pct) && pct >= 0 && pct <= 100, `bar width out of range: ${fill!.style.width}`);
  }
  // The hero bar is the headline claim of scarcity: 1 000 000 of 21 000 000 = 4.7 %.
  assert.equal(found[0]!.find((n) => n.hasClass("gc-gcn-bar-fill"))!.style.width, "4.7%");
  assert.ok(panel.textContent.includes(i18n.t("gcn.issuedOfCap", { pct: "4.7" })));
});

test("GCN: the ladder marks where the caller stands and what is next", async () => {
  const h = mount(() => Promise.resolve(clone()));
  openGcn(h.deps);
  await settle();
  const panel = h.panel();
  const tiers = panel.findAll((n) => n.hasClass("gc-gcn-tier"));
  assert.equal(tiers.length, 4);
  assert.ok(tiers[1]!.hasClass("is-reached"), "the tier the caller is standing in is not marked");
  assert.ok(tiers[2]!.hasClass("is-next"), "the tier worth aiming at is not marked");
  // Marking must not rest on colour alone (WCAG 1.4.1) — the class drives border/weight in styles.css.
  assert.ok(!tiers[0]!.hasClass("is-reached") && !tiers[3]!.hasClass("is-reached"));
  // `need` is built with the shared formatter rather than typed out: money grouping uses U+202F (a
  // narrow no-break space), so an ASCII space here would have failed against a screen that is correct.
  const need = formatNano(nano(8_500), { maxFraction: 0, placeholder: "—" });
  assert.ok(panel.textContent.includes(i18n.t("gcn.nextTier", { name: "Серебро", need, asset: "GCN" })),
    "the distance to the next tier is the one actionable number on the page");
});

test("GCN: a pair that was never opened is named as such, with no empty price row", async () => {
  const wire = clone();
  // The server sends `market: null` when the pair is not in the database at all (modules/gcn.ts:97) —
  // an absent pair, not a pair with empty fields.
  wire.market = null;
  const h = mount(() => Promise.resolve(wire));
  openGcn(h.deps);
  await settle();
  const text = h.panel().textContent;
  assert.ok(text.includes(i18n.t("gcn.marketState.none")));
  assert.ok(!text.includes(i18n.t("gcn.marketState.swap_only")));
});

test("GCN: the page carries its own honesty note", async () => {
  const h = mount(() => Promise.resolve(clone()));
  openGcn(h.deps);
  await settle();
  const note = h.panel().find((n) => n.hasClass("gc-gcn-footnote"));
  assert.ok(note, "the note that this page promises no price or yield is missing");
  assert.equal(note!.textContent, i18n.t("gcn.noPromise"));
});

test("GCN: both locales carry every key this screen asks for", () => {
  const keys = Object.keys(ru).filter((k) => k.startsWith("gcn."));
  assert.ok(keys.length >= 40, `the screen's vocabulary shrank: ${keys.length} keys`);
  for (const key of keys) {
    assert.ok(en[key], `en is missing ${key} — the fallback locale would print the key itself`);
  }
  for (const key of Object.keys(en).filter((k) => k.startsWith("gcn."))) {
    assert.ok(ru[key], `ru is missing ${key}`);
  }
});

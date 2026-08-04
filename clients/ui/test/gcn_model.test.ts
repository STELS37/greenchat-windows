// T-GCN-UI — the Green Coin token page model.
//
// Every fixture below is a real `/v1/gcn` payload shape (server/src/modules/gcn.ts), amounts in raw nano
// integer strings exactly as core/money.ts formatAmount emits them, tiers exactly as core/gcn.ts freezes
// them (green 100, bronze 1 000, silver 10 000, gold 100 000 GCN at 10/25/40/50 % off).
//
// The three properties this file is here to nail down, because they are the ones a token page gets wrong:
//   * a DARK holder programme grants a 0 % discount, not the discount it would grant once armed;
//   * a BURN lowers the ceiling permanently — burned supply is never presented as re-issuable headroom;
//   * a MALFORMED amount costs one row, not the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bpToPercent,
  burnPeriod,
  discountedFeeBp,
  gcnView,
  sharePct,
  type GcnWire,
} from "../src/screens/gcn_model.ts";

/** formatNano groups with U+202F NARROW NO-BREAK SPACE and signs with U+2212 MINUS SIGN. */
const NNBSP = " ";
const NANO = 1_000_000_000n;
const nano = (gcn: bigint): string => (gcn * NANO).toString();

const TIERS = [
  { name: "green", min_holding: nano(100n), discount_bp: 1_000 },
  { name: "bronze", min_holding: nano(1_000n), discount_bp: 2_500 },
  { name: "silver", min_holding: nano(10_000n), discount_bp: 4_000 },
  { name: "gold", min_holding: nano(100_000n), discount_bp: 5_000 },
];

/** A payload the server would actually produce: pass only what the case is about. */
function wire(patch: Partial<GcnWire> = {}): GcnWire {
  return {
    available: true,
    asset: "GCN",
    name: "Green Coin",
    supply: {
      max: nano(21_000_000n),
      effective_max: nano(21_000_000n),
      minted: "0",
      burned: "0",
      circulating: "0",
      remaining_issuance: nano(21_000_000n),
      treasury: "0",
    },
    deflation: { fee_burn_bp: 10_000, burn_period_sec: 3_600, burn_restores_headroom: false, burn_account: "burn:gcn" },
    holder_programme: { enabled: false, tiers: TIERS },
    you: {
      holding: "0",
      tier: null,
      discount_bp: 0,
      next_tier: { name: "green", min_holding: nano(100n), discount_bp: 1_000, need: nano(100n) },
    },
    market: { pair: "GCN/GUSD", quote: "GUSD", mode: "swap_only", enabled: true },
    server_time: 1_770_000_000,
    ...patch,
  };
}

test("a fresh contour shows a cap that has not been touched, and says so in every row", () => {
  const view = gcnView(wire());

  assert.equal(view.available, true);
  assert.equal(view.asset, "GCN");
  assert.equal(view.name, "Green Coin");

  assert.deepEqual(
    view.supply.map((row) => [row.key, row.value, row.sharePct]),
    [
      ["max", `21${NNBSP}000${NNBSP}000`, 100],
      ["circulating", "0", 0],
      ["burned", "0", 0],
      ["remaining", `21${NNBSP}000${NNBSP}000`, 100],
      ["treasury", "0", 0],
    ],
  );

  assert.equal(view.issuedPct, 0);
  assert.equal(view.burnedPct, 0);
  assert.equal(view.ceilingLowered, false, "nothing burned yet, so the ceiling is still the cap");
  assert.equal(view.ceilingLoweredBy, "0");

  assert.equal(view.deflation.sharePct, "100");
  assert.deepEqual(view.deflation.period, { value: 1, unit: "hour" });
  assert.equal(view.deflation.restoresHeadroom, false);
  assert.equal(view.deflation.active, true);

  assert.equal(view.market.pair, "GCN/GUSD");
  assert.equal(view.market.quote, "GUSD");
  assert.equal(view.market.state, "swap_only");

  assert.equal(view.holder.programmeEnabled, false);
  assert.equal(view.holder.tier, null);
  assert.equal(view.holder.holding, "0");
  assert.deepEqual(view.holder.nextTier, { name: "green", need: "100", discountBp: 1_000, progressPct: 0 });
  assert.deepEqual(
    view.holder.tiers.map((tier) => [tier.name, tier.minHolding, tier.discountBp, tier.reached, tier.next]),
    [
      ["green", "100", 1_000, false, true],
      ["bronze", `1${NNBSP}000`, 2_500, false, false],
      ["silver", `10${NNBSP}000`, 4_000, false, false],
      ["gold", `100${NNBSP}000`, 5_000, false, false],
    ],
  );
});

test("a burn lowers the ceiling and is never shown as headroom that could come back", () => {
  const minted = 1_500_000n;
  const burned = 12_500n;
  const view = gcnView(
    wire({
      supply: {
        max: nano(21_000_000n),
        // The server computes this as MAX − burned; the model must repeat the server, not recompute a
        // friendlier number. 21 000 000 − 12 500 = 20 987 500 is the most that can ever exist now.
        effective_max: nano(20_987_500n),
        minted: nano(minted),
        burned: nano(burned),
        circulating: nano(minted - burned),
        remaining_issuance: nano(21_000_000n - minted),
        treasury: nano(400_000n),
      },
    }),
  );

  assert.equal(view.ceilingLowered, true);
  assert.equal(view.ceilingLoweredBy, `12${NNBSP}500`, "the cap has permanently fallen by exactly what was burned");
  assert.equal(view.issuedPct, 7.1, "1.5M of 21M, truncated — a supply page never rounds issuance up");
  assert.equal(view.burnedPct, 0.8, "12 500 of 1 500 000 ever issued");
  assert.deepEqual(
    view.supply.map((row) => [row.key, row.value]),
    [
      ["max", `21${NNBSP}000${NNBSP}000`],
      ["circulating", `1${NNBSP}487${NNBSP}500`],
      ["burned", `12${NNBSP}500`],
      ["remaining", `19${NNBSP}500${NNBSP}000`],
      ["treasury", `400${NNBSP}000`],
    ],
  );
});

test("a dark holder programme reports the discount a user gets today: zero", () => {
  const view = gcnView(
    wire({
      holder_programme: { enabled: false, tiers: TIERS },
      you: {
        holding: nano(5_500n),
        tier: "bronze",
        discount_bp: 0,
        next_tier: { name: "silver", min_holding: nano(10_000n), discount_bp: 4_000, need: nano(4_500n) },
      },
    }),
  );

  assert.equal(view.holder.tier, "bronze");
  assert.equal(view.holder.holding, `5${NNBSP}500`);
  assert.equal(view.holder.effectiveDiscountBp, 0, "the programme is off, so the user is charged full fee");
  assert.equal(view.holder.tierDiscountBp, 2_500, "what the tier is worth is still explainable");
  assert.equal(discountedFeeBp(10, view), 10, "a taker fee of 10 bp stays 10 bp while the discount is dark");

  // Progress is measured across the step being climbed (1 000 → 10 000), not from zero: a holder at
  // 5 500 is halfway to silver, not "55 % of the way", and a bar that said 55 % would be flattering.
  assert.deepEqual(view.holder.nextTier, { name: "silver", need: `4${NNBSP}500`, discountBp: 4_000, progressPct: 50 });
  assert.deepEqual(
    view.holder.tiers.map((tier) => [tier.name, tier.reached, tier.next]),
    [
      ["green", false, false],
      ["bronze", true, false],
      ["silver", false, true],
      ["gold", false, false],
    ],
  );
});

test("an armed holder programme cuts the fee exactly the way the server does", () => {
  const view = gcnView(
    wire({
      holder_programme: { enabled: true, tiers: TIERS },
      you: {
        holding: nano(12_000n),
        tier: "silver",
        discount_bp: 4_000,
        next_tier: { name: "gold", min_holding: nano(100_000n), discount_bp: 5_000, need: nano(88_000n) },
      },
    }),
  );

  assert.equal(view.holder.programmeEnabled, true);
  assert.equal(view.holder.effectiveDiscountBp, 4_000);
  // core/gcn.ts gcnDiscountedFeeBp: floor(feeBp * (10000 − discount) / 10000), integer basis points.
  assert.equal(discountedFeeBp(10, view), 6, "10 bp − 40 % = 6 bp");
  assert.equal(discountedFeeBp(25, view), 15);
  assert.equal(discountedFeeBp(1, view), 0, "1 bp floors to 0 — the same as the server, not rounded up to 1");
  assert.equal(discountedFeeBp(0, view), 0);
  assert.equal(view.holder.nextTier?.progressPct, 2.2, "12 000 of the 10 000 → 100 000 step");
});

test("the granted discount comes from the server, not from re-reading the tier table", () => {
  // Today the server cannot disagree with its own table (modules/gcn.ts computes the field from the
  // same tiers), so this case is about the next change rather than the current build: a promotion, a
  // grandfathered account or an account capped by a rule all arrive as a `you.discount_bp` that is not
  // the plain tier rate. Whatever the reason, the exchange charges THAT number, and a page showing the
  // table's number instead would misstate a fee — the one class of defect this contour must not ship.
  const promoted = gcnView(
    wire({
      holder_programme: { enabled: true, tiers: TIERS },
      you: { holding: nano(1_500n), tier: "bronze", discount_bp: 4_000, next_tier: null },
    }),
  );
  assert.equal(promoted.holder.effectiveDiscountBp, 4_000, "the server's grant must win");
  assert.equal(promoted.holder.tierDiscountBp, 2_500, "the ladder still explains what bronze is worth");
  assert.equal(discountedFeeBp(10, promoted), 6, "the fee shown follows the grant, not the ladder");

  // The mirror case: an account the server has switched off individually keeps its tier badge and gets
  // nothing. Zero is a decision here, so it must not fall back to the ladder.
  const blocked = gcnView(
    wire({
      holder_programme: { enabled: true, tiers: TIERS },
      you: { holding: nano(1_500n), tier: "bronze", discount_bp: 0, next_tier: null },
    }),
  );
  assert.equal(blocked.holder.effectiveDiscountBp, 0);
  assert.equal(blocked.holder.tier, "bronze");

  // A server too old to publish the field is the only case where the table may speak for it.
  const legacy = gcnView(
    wire({
      holder_programme: { enabled: true, tiers: TIERS },
      you: { holding: nano(1_500n), tier: "bronze", next_tier: null },
    }),
  );
  assert.equal(legacy.holder.effectiveDiscountBp, 2_500, "without a published grant the tier is the best answer");
});

test("the top tier has nothing above it and the model does not invent a rung", () => {
  const view = gcnView(
    wire({
      holder_programme: { enabled: true, tiers: TIERS },
      you: { holding: nano(150_000n), tier: "gold", discount_bp: 5_000, next_tier: null },
    }),
  );
  assert.equal(view.holder.nextTier, null);
  assert.equal(view.holder.effectiveDiscountBp, 5_000);
  assert.deepEqual(view.holder.tiers.filter((tier) => tier.next), []);
  assert.deepEqual(view.holder.tiers.filter((tier) => tier.reached).map((tier) => tier.name), ["gold"]);
});

test("a server without the token, and a payload that is not one, both degrade to a clean empty page", () => {
  for (const payload of [null, undefined, { available: false, asset: "GCN" } as GcnWire, {} as GcnWire]) {
    const view = gcnView(payload);
    assert.equal(view.available, false);
    assert.deepEqual(view.supply, []);
    assert.deepEqual(view.holder.tiers, []);
    assert.equal(view.holder.nextTier, null);
    assert.equal(view.holder.effectiveDiscountBp, 0);
    assert.equal(view.market.state, "none");
    assert.equal(view.market.pair, null);
    assert.equal(view.deflation.active, false);
    assert.equal(view.asset, "GCN", "the ticker is still nameable when the contour has no token");
  }
});

test("one malformed amount costs one row, never the page", () => {
  const view = gcnView(
    wire({
      supply: {
        max: nano(21_000_000n),
        effective_max: nano(21_000_000n),
        minted: nano(1_000n),
        burned: "0",
        circulating: "12.5", // not a canonical nano integer: a producer bug, not a value
        remaining_issuance: nano(20_999_000n),
        treasury: "0",
      },
    }),
  );
  assert.equal(view.available, true, "the page still renders");
  const circulating = view.supply.find((row) => row.key === "circulating");
  assert.equal(circulating?.value, "—");
  assert.equal(circulating?.sharePct, 0, "a share that cannot be computed is not guessed at");
  assert.equal(view.supply.find((row) => row.key === "remaining")?.value, `20${NNBSP}999${NNBSP}000`);
});

test("market state follows the pair, not the hope", () => {
  // NonNullable-free on purpose: `exactOptionalPropertyTypes` makes "absent" and "null" different
  // things, and the case being tested is a market that is present-but-null, never one that is missing.
  const state = (market: NonNullable<GcnWire["market"]> | null): string => gcnView(wire({ market })).market.state;
  assert.equal(state({ pair: "GCN/GUSD", quote: "GUSD", mode: "active", enabled: true }), "trading");
  assert.equal(state({ pair: "GCN/GUSD", quote: "GUSD", mode: "swap_only", enabled: true }), "swap_only");
  assert.equal(state({ pair: "GCN/GUSD", quote: "GUSD", mode: "halted", enabled: true }), "halted");
  assert.equal(state({ pair: "GCN/GUSD", quote: "GUSD", mode: "active", enabled: false }), "halted", "a disabled pair is not tradable, whatever its mode says");
  assert.equal(state(null), "none");
});

test("shares, basis points and burn periods are said the way a person reads them", () => {
  assert.equal(sharePct(0n, 100n), 0);
  assert.equal(sharePct(1n, 3n), 33.3, "truncated, never rounded up");
  assert.equal(sharePct(100n, 100n), 100);
  assert.equal(sharePct(200n, 100n), 100, "clamped: a share of more than everything is a bug upstream");
  assert.equal(sharePct(5n, 0n), 0, "no division by an empty whole");
  assert.equal(sharePct(-5n, 100n), 0);

  assert.equal(bpToPercent(10_000), "100");
  assert.equal(bpToPercent(2_500), "25");
  assert.equal(bpToPercent(1_250), "12.5");
  assert.equal(bpToPercent(5), "0.05");
  assert.equal(bpToPercent(0), "0");
  assert.equal(bpToPercent(undefined), "0");
  assert.equal(bpToPercent(50_000), "100", "clamped to the whole");

  assert.deepEqual(burnPeriod(3_600), { value: 1, unit: "hour" });
  assert.deepEqual(burnPeriod(86_400), { value: 1, unit: "day" });
  assert.deepEqual(burnPeriod(604_800), { value: 7, unit: "day" });
  assert.deepEqual(burnPeriod(21_600), { value: 6, unit: "hour" });
  assert.deepEqual(burnPeriod(900), { value: 15, unit: "minute" });
  assert.deepEqual(burnPeriod(45), { value: 1, unit: "minute" }, "a sub-minute cadence is a misconfiguration, not a label");
  assert.deepEqual(burnPeriod(0), { value: 1, unit: "hour" }, "the server default");
  assert.deepEqual(burnPeriod(undefined), { value: 1, unit: "hour" });
});

test("a fee burn that is switched off is reported as switched off", () => {
  const view = gcnView(wire({ deflation: { fee_burn_bp: 0, burn_period_sec: 86_400, burn_restores_headroom: false, burn_account: "burn:gcn" } }));
  assert.equal(view.deflation.active, false);
  assert.equal(view.deflation.sharePct, "0");
  assert.deepEqual(view.deflation.period, { value: 1, unit: "day" });
});

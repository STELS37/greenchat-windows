// clients/ui/src/screens/gcn_model.ts — the Green Coin (GCN) token page, as data.
//
// DOM-free on purpose, exactly like finance_model.ts: everything a person is told about the token is
// decided here and unit-tested here, so the screen that renders it can only ever be markup. The owner
// asked for a token that is "выгодным для приобретения" — attractive to acquire — and the honest way to
// build that is to show the scarcity and the discount a holder actually gets, never a projected price.
//
// Three rules this module enforces, because a token page is exactly where a UI is tempted to lie:
//
//  1. NOTHING IS INVENTED. Every figure is derived from the `/v1/gcn` payload, which the server derives
//     from the ledger. A field that fails to parse degrades to a placeholder in ONE row (parseNano
//     returns null) instead of blanking the page or, worse, rendering a plausible zero.
//  2. NO YIELD, NO PRICE PROMISE. There is no "expected return" anywhere in this file. What a buyer is
//     shown is supply, what has been destroyed, and the fee discount their holding already earns.
//  3. A DARK PROGRAMME IS SAID TO BE DARK. While the server reports holder_programme.enabled === false
//     the tier is shown as a position, and the discount is reported as 0 — not as the number it "would"
//     be. A discount a user cannot receive today must not be printed as if it applied.
import { formatNano, parseNano, NANO_ONE, BASIS_POINTS } from "./finance_model.ts";

/** The `/v1/gcn` payload. Fields are optional so a partial/older server degrades instead of throwing. */
export interface GcnSupplyWire {
  max?: string;
  effective_max?: string;
  minted?: string;
  burned?: string;
  circulating?: string;
  remaining_issuance?: string;
  treasury?: string;
}
export interface GcnDeflationWire {
  fee_burn_bp?: number;
  burn_period_sec?: number;
  burn_restores_headroom?: boolean;
  burn_account?: string;
}
export interface GcnTierWire {
  name?: string;
  min_holding?: string;
  discount_bp?: number;
  need?: string;
}
export interface GcnWire {
  available?: boolean;
  asset?: string;
  name?: string;
  supply?: GcnSupplyWire;
  deflation?: GcnDeflationWire;
  holder_programme?: { enabled?: boolean; tiers?: GcnTierWire[] };
  you?: { holding?: string; tier?: string | null; discount_bp?: number; next_tier?: GcnTierWire | null };
  market?: { pair?: string; quote?: string; mode?: string; enabled?: boolean } | null;
  server_time?: number;
}

/** One "label: value" fact, ready to render. `hint` is the sentence under it, when there is one. */
export interface GcnFact {
  key: string;
  value: string;
  /** Percent of the cap this fact represents, when the fact is a share of the cap. 0..100, one decimal. */
  sharePct?: number;
}

export type GcnMarketState = "trading" | "swap_only" | "halted" | "none";

export interface GcnTierView {
  name: string;
  minHolding: string;
  discountBp: number;
  /** The tier the caller is standing in right now. */
  reached: boolean;
  /** The next tier up from where the caller stands — the one worth aiming at. */
  next: boolean;
}

export interface GcnView {
  available: boolean;
  asset: string;
  name: string;
  /** Supply rows, in the order a reader should meet them. */
  supply: GcnFact[];
  /** Issued as a share of the hard cap, 0..100 with one decimal. 0 on a fresh contour. */
  issuedPct: number;
  /** Destroyed as a share of everything ever issued, 0..100 with one decimal. */
  burnedPct: number;
  /** True once anything has been burned: the ceiling has permanently fallen below the cap. */
  ceilingLowered: boolean;
  /** How much the cap has fallen, formatted. "0" when nothing has been burned. */
  ceilingLoweredBy: string;
  deflation: {
    /** The share of collected GCN fees destroyed each period, as a percent string ("100", "12.5"). */
    sharePct: string;
    /** The burn period as {value, unit} so the screen can localise it. */
    period: { value: number; unit: "minute" | "hour" | "day" };
    restoresHeadroom: boolean;
    active: boolean;
  };
  holder: {
    programmeEnabled: boolean;
    holding: string;
    tier: string | null;
    /** The discount the caller receives TODAY. 0 while the programme is dark. */
    effectiveDiscountBp: number;
    /** The discount the caller's tier is worth once armed — for explaining, never for claiming. */
    tierDiscountBp: number;
    nextTier: { name: string; need: string; discountBp: number; progressPct: number } | null;
    tiers: GcnTierView[];
  };
  market: { pair: string | null; quote: string | null; state: GcnMarketState };
}

const PLACEHOLDER = "—";

/** Percent with one decimal, truncated (never rounded up) and clamped to 0..100. */
export function sharePct(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  const tenths = (part * 1000n) / whole; // 0..1000 for 0..100.0 %
  const clamped = tenths > 1000n ? 1000n : tenths;
  return Number(clamped) / 10;
}

/** Basis points → a percent string a person reads: 10000 → "100", 1250 → "12.5", 0 → "0". */
export function bpToPercent(bp: number | undefined): string {
  if (!Number.isFinite(bp ?? NaN)) return "0";
  const value = Math.max(0, Math.min(10_000, Math.trunc(bp as number)));
  const whole = Math.trunc(value / 100);
  const fraction = value % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0+$/, "")}`;
}

/**
 * Seconds → the largest whole unit that divides them exactly, so a screen can say "каждый час" instead
 * of "каждые 3600 секунд". Anything that is not a whole number of minutes stays in minutes (rounded up
 * to at least one), because a sub-minute burn cadence is a misconfiguration, not a thing to render.
 */
export function burnPeriod(seconds: number | undefined): { value: number; unit: "minute" | "hour" | "day" } {
  const total = Number.isFinite(seconds ?? NaN) && (seconds as number) > 0 ? Math.trunc(seconds as number) : 3_600;
  if (total % 86_400 === 0) return { value: total / 86_400, unit: "day" };
  if (total % 3_600 === 0) return { value: total / 3_600, unit: "hour" };
  return { value: Math.max(1, Math.round(total / 60)), unit: "minute" };
}

function fact(key: string, raw: string | undefined, options: { maxFraction?: number } = {}): GcnFact {
  return { key, value: formatNano(raw, { maxFraction: options.maxFraction ?? 0, placeholder: PLACEHOLDER }) };
}

function marketState(market: GcnWire["market"]): GcnMarketState {
  if (!market || typeof market.pair !== "string" || market.pair.length === 0) return "none";
  if (market.enabled === false) return "halted";
  if (market.mode === "halted") return "halted";
  if (market.mode === "swap_only") return "swap_only";
  return "trading";
}

/**
 * The whole page, derived. `available: false` (a server without migration 096, or a payload that is not
 * a token page at all) yields an empty but well-formed view, so the screen renders "not available here"
 * rather than a wall of dashes.
 */
export function gcnView(wire: GcnWire | null | undefined): GcnView {
  const empty: GcnView = {
    available: false,
    asset: wire?.asset ?? "GCN",
    name: wire?.name ?? "Green Coin",
    supply: [],
    issuedPct: 0,
    burnedPct: 0,
    ceilingLowered: false,
    ceilingLoweredBy: "0",
    deflation: { sharePct: "0", period: { value: 1, unit: "hour" }, restoresHeadroom: false, active: false },
    holder: {
      programmeEnabled: false,
      holding: PLACEHOLDER,
      tier: null,
      effectiveDiscountBp: 0,
      tierDiscountBp: 0,
      nextTier: null,
      tiers: [],
    },
    market: { pair: null, quote: null, state: "none" },
  };
  if (!wire || wire.available !== true) return empty;

  const supplyWire = wire.supply ?? {};
  const max = parseNano(supplyWire.max) ?? 0n;
  const minted = parseNano(supplyWire.minted) ?? 0n;
  const burned = parseNano(supplyWire.burned) ?? 0n;
  const effectiveMax = parseNano(supplyWire.effective_max) ?? max;

  // Amounts are shown whole: 21 000 000 reads as a supply, "21000000.000000000" reads as a database
  // dump. The holding keeps decimals — that one is the user's own money.
  const supply: GcnFact[] = [
    { ...fact("max", supplyWire.max), sharePct: 100 },
    { ...fact("circulating", supplyWire.circulating), sharePct: sharePct(parseNano(supplyWire.circulating) ?? 0n, max) },
    { ...fact("burned", supplyWire.burned), sharePct: sharePct(burned, max) },
    { ...fact("remaining", supplyWire.remaining_issuance), sharePct: sharePct(parseNano(supplyWire.remaining_issuance) ?? 0n, max) },
    { ...fact("treasury", supplyWire.treasury), sharePct: sharePct(parseNano(supplyWire.treasury) ?? 0n, max) },
  ];

  const deflationWire = wire.deflation ?? {};
  const feeBurnBp = Number.isFinite(deflationWire.fee_burn_bp ?? NaN) ? (deflationWire.fee_burn_bp as number) : 0;

  const programmeEnabled = wire.holder_programme?.enabled === true;
  const tiersWire = Array.isArray(wire.holder_programme?.tiers) ? wire.holder_programme!.tiers! : [];
  const holding = parseNano(wire.you?.holding) ?? 0n;
  const tierName = typeof wire.you?.tier === "string" ? wire.you.tier : null;
  const nextWire = wire.you?.next_tier ?? null;
  const nextName = typeof nextWire?.name === "string" ? nextWire.name : null;

  const tiers: GcnTierView[] = tiersWire
    .filter((tier): tier is GcnTierWire & { name: string } => typeof tier.name === "string")
    .map((tier) => ({
      name: tier.name,
      minHolding: formatNano(tier.min_holding, { maxFraction: 0, placeholder: PLACEHOLDER }),
      discountBp: Number.isFinite(tier.discount_bp ?? NaN) ? (tier.discount_bp as number) : 0,
      reached: tier.name === tierName,
      next: tier.name === nextName,
    }));

  // Progress toward the next tier is measured from the tier the caller already reached, not from zero:
  // a holder one step below silver should see how far THIS step is, not how far they have come overall.
  let nextTier: GcnView["holder"]["nextTier"] = null;
  if (nextWire && nextName) {
    const target = parseNano(nextWire.min_holding) ?? 0n;
    const floor = tiersWire
      .map((tier) => parseNano(tier.min_holding) ?? 0n)
      .filter((min) => min <= holding)
      .reduce((acc, min) => (min > acc ? min : acc), 0n);
    const span = target - floor;
    nextTier = {
      name: nextName,
      need: formatNano(nextWire.need, { maxFraction: 0, placeholder: PLACEHOLDER }),
      discountBp: Number.isFinite(nextWire.discount_bp ?? NaN) ? (nextWire.discount_bp as number) : 0,
      progressPct: span > 0n ? sharePct(holding - floor, span) : 0,
    };
  }

  const tierDiscountBp = tiers.find((tier) => tier.reached)?.discountBp ?? 0;

  // The discount the caller RECEIVES is the server's statement, not this module's arithmetic. Today the
  // two agree by construction — modules/gcn.ts answers `tier && enabled ? tier.discountBp : 0` — and
  // that is precisely why the difference stays invisible until it costs something: the first deployment
  // that grants a rate which is not the plain tier rate (a promotion, a grandfathered account, an
  // account capped by a rule) would have this page print a discount the exchange does not apply. A
  // screen that misstates a fee is the defect this whole contour is being audited for, so the published
  // number wins. The tier table remains the fallback for a server too old to publish `you.discount_bp`,
  // and a dark programme still forces zero, because with the flag off nothing is discounted anywhere.
  const grantedBp = Number.isFinite(wire.you?.discount_bp ?? NaN) ? (wire.you!.discount_bp as number) : null;
  const effectiveDiscountBp = programmeEnabled ? (grantedBp ?? tierDiscountBp) : 0;

  return {
    available: true,
    asset: typeof wire.asset === "string" ? wire.asset : "GCN",
    name: typeof wire.name === "string" ? wire.name : "Green Coin",
    supply,
    issuedPct: sharePct(minted, max),
    burnedPct: sharePct(burned, minted),
    ceilingLowered: burned > 0n,
    ceilingLoweredBy: formatNano((max - effectiveMax).toString(), { maxFraction: 0, placeholder: "0" }),
    deflation: {
      sharePct: bpToPercent(feeBurnBp),
      period: burnPeriod(deflationWire.burn_period_sec),
      // The server publishes this as false and the ledger enforces it; if a server ever claimed true, the
      // page would have to say so rather than keep repeating the promise this module was written around.
      restoresHeadroom: deflationWire.burn_restores_headroom === true,
      active: feeBurnBp > 0,
    },
    holder: {
      programmeEnabled,
      holding: formatNano(wire.you?.holding, { maxFraction: 4, placeholder: PLACEHOLDER }),
      tier: tierName,
      effectiveDiscountBp,
      tierDiscountBp,
      nextTier,
      tiers,
    },
    market: {
      pair: typeof wire.market?.pair === "string" ? wire.market.pair : null,
      quote: typeof wire.market?.quote === "string" ? wire.market.quote : null,
      state: marketState(wire.market),
    },
  };
}

/**
 * The fee a trade actually costs a holder, in basis points, computed the same way the server does
 * (core/gcn.ts gcnDiscountedFeeBp: integer basis points, floor division, never below zero). The screen
 * uses it to show "0.1 % → 0.075 %" next to an order, so the discount is visible where it is spent
 * rather than only on the token page. Returns `feeBp` untouched while the programme is dark.
 */
export function discountedFeeBp(feeBp: number, view: GcnView): number {
  if (!Number.isFinite(feeBp) || feeBp <= 0) return 0;
  const whole = Math.trunc(feeBp);
  if (!view.holder.programmeEnabled || view.holder.effectiveDiscountBp <= 0) return whole;
  const discount = BigInt(Math.max(0, Math.min(10_000, view.holder.effectiveDiscountBp)));
  const result = (BigInt(whole) * (BASIS_POINTS - discount)) / BASIS_POINTS;
  return Number(result < 0n ? 0n : result);
}

/** One GCN in nano units, re-exported so a caller never re-derives the scale by hand. */
export const GCN_ONE = NANO_ONE;

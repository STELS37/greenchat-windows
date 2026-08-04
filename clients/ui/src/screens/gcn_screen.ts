// clients/ui/src/screens/gcn_screen.ts — the Green Coin (GCN) sheet: the token page a person sees.
//
// Deliberately markup-only. Every number, percentage, tier position and market state is decided in
// gcn_model.ts (DOM-free, unit-tested); this file may only place them. That split is what keeps the
// owner's rule enforceable — "выгодным для приобретения" must be argued with scarcity and a discount
// the holder really receives, never with a price forecast — because a screen cannot invent a figure
// it is not handed.
//
// Three things this sheet refuses to do:
//  1. Print a discount the caller cannot receive today. While the holder programme is dark the model
//     reports effectiveDiscountBp = 0, and the tier's own worth is shown as an explanation of the
//     ladder, in a muted line that says the programme is off — not as the caller's benefit.
//  2. Show a market that does not exist. `state: "none"` means the pair was never opened; the block
//     says so instead of drawing an empty price row.
//  3. Blank the page on a partial payload. A field that fails to parse becomes "—" in ONE row, which
//     is the model's contract, so a server that grows a field later cannot break this screen.
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { icon } from "../icons.ts";
import { sheet, sheetError, statusLine } from "./finance_sheet.ts";
import { bpToPercent, gcnView, type GcnView } from "./gcn_model.ts";
import type { MoneyApi } from "./money_api.ts";

/** Structurally satisfied by WalletOpsDeps, so the finance hub passes the deps it already built. */
export interface GcnSheetDeps {
  money: Pick<MoneyApi, "gcn">;
  i18n: I18n;
  openSheet(panel: HTMLElement): void;
  closeSheet(): void;
}

/**
 * A share drawn as a bar. The width is written through the CSSOM, never as a `style` attribute: the
 * server sends `style-src 'self'`, which also governs style-src-attr, so Chrome silently DROPS an
 * inline declaration (V84, pinned by csp_inline_style_v84.test.ts) and every bar would have rendered
 * empty in production while looking correct in a test. The bar is aria-hidden — the figure above it
 * is the accessible content, and a decorative twin must not be read twice.
 */
function bar(pct: number, extraClass = ""): HTMLElement {
  const fill = el("span", { class: "gc-gcn-bar-fill" });
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return el("div", { class: `gc-gcn-bar${extraClass ? ` ${extraClass}` : ""}`, "aria-hidden": true }, [fill]);
}

/**
 * A tier's name as the server spells it (green/bronze/silver/gold), translated when this build knows
 * the word and left verbatim when it does not. i18n.t() returns the key for a missing entry, so the
 * comparison below is the documented way to ask "is this translated?" — a server that invents a fifth
 * tier tomorrow shows its own name instead of the string "gcn.tierName.platinum".
 */
function tierLabel(i18n: I18n, name: string): string {
  const key = `gcn.tierName.${name}`;
  const text = i18n.t(key);
  return text === key ? name : text;
}

/** "каждый час" / "каждые 6 ч" — the burn cadence in the largest unit that divides it exactly. */
function periodText(i18n: I18n, period: GcnView["deflation"]["period"]): string {
  const single = { minute: "gcn.periodMinute", hour: "gcn.periodHour", day: "gcn.periodDay" } as const;
  const plural = { minute: "gcn.periodMinutes", hour: "gcn.periodHours", day: "gcn.periodDays" } as const;
  return period.value === 1
    ? i18n.t(single[period.unit])
    : i18n.t(plural[period.unit], { value: String(period.value) });
}

/** A labelled figure with the share of the cap it represents drawn under it. */
function factRow(label: string, value: string, asset: string, sharePct: number | undefined): HTMLElement {
  const children: Node[] = [
    el("div", { class: "gc-gcn-fact-head" }, [
      el("span", { class: "gc-gcn-fact-label" }, [label]),
      el("strong", { class: "gc-gcn-fact-value" }, [`${value} ${asset}`]),
    ]),
  ];
  if (typeof sharePct === "number") children.push(bar(sharePct));
  return el("div", { class: "gc-gcn-fact" }, children);
}

function supplySection(view: GcnView, i18n: I18n): HTMLElement {
  const rows = view.supply.map((fact) =>
    factRow(i18n.t(`gcn.supply.${fact.key}`), fact.value, view.asset, fact.sharePct),
  );
  return el("section", { class: "gc-gcn-block" }, [
    el("h3", {}, [i18n.t("gcn.supplyTitle")]),
    ...rows,
  ]);
}

function deflationSection(view: GcnView, i18n: I18n): HTMLElement {
  const lines: Node[] = [];
  lines.push(
    el("p", { class: view.deflation.active ? "gc-gcn-line" : "gc-gcn-line is-muted" }, [
      view.deflation.active
        ? i18n.t("gcn.deflationBurn", {
            pct: view.deflation.sharePct,
            period: periodText(i18n, view.deflation.period),
            asset: view.asset,
          })
        : i18n.t("gcn.deflationOff"),
    ]),
  );
  // The whole point of the design, said plainly: an ordinary cap frees issuance when coins are
  // destroyed, this one does not. If a server ever reported the opposite, the page must say THAT.
  lines.push(
    el("p", { class: "gc-gcn-line" }, [
      view.deflation.restoresHeadroom ? i18n.t("gcn.deflationRestores") : i18n.t("gcn.deflationIrreversible"),
    ]),
  );
  if (view.ceilingLowered) {
    lines.push(
      el("p", { class: "gc-gcn-line is-strong" }, [
        i18n.t("gcn.ceilingLowered", { amount: view.ceilingLoweredBy, asset: view.asset }),
      ]),
    );
  }
  return el("section", { class: "gc-gcn-block" }, [el("h3", {}, [i18n.t("gcn.deflationTitle")]), ...lines]);
}

function holderSection(view: GcnView, i18n: I18n): HTMLElement {
  const holder = view.holder;
  const children: Node[] = [
    el("div", { class: "gc-gcn-fact-head" }, [
      el("span", { class: "gc-gcn-fact-label" }, [i18n.t("gcn.holding")]),
      el("strong", { class: "gc-gcn-fact-value" }, [`${holder.holding} ${view.asset}`]),
    ]),
    el("div", { class: "gc-gcn-fact-head" }, [
      el("span", { class: "gc-gcn-fact-label" }, [i18n.t("gcn.discountToday")]),
      el("strong", { class: "gc-gcn-fact-value gc-gcn-discount" }, [
        `${bpToPercent(holder.effectiveDiscountBp)} %`,
      ]),
    ]),
  ];
  if (!holder.programmeEnabled) {
    children.push(el("p", { class: "gc-gcn-line is-muted gc-gcn-dark" }, [i18n.t("gcn.programmeOff")]));
    if (holder.tierDiscountBp > 0 && holder.tier) {
      children.push(
        el("p", { class: "gc-gcn-line is-muted" }, [
          i18n.t("gcn.tierWorth", {
            name: tierLabel(i18n, holder.tier),
            pct: bpToPercent(holder.tierDiscountBp),
          }),
        ]),
      );
    }
  }
  if (holder.nextTier) {
    children.push(
      el("p", { class: "gc-gcn-line" }, [
        i18n.t("gcn.nextTier", {
          name: tierLabel(i18n, holder.nextTier.name),
          need: holder.nextTier.need,
          asset: view.asset,
        }),
      ]),
      bar(holder.nextTier.progressPct),
    );
  }
  if (holder.tiers.length > 0) {
    const ladder = holder.tiers.map((tier) =>
      el(
        "div",
        {
          class: `gc-gcn-tier${tier.reached ? " is-reached" : ""}${tier.next ? " is-next" : ""}`,
        },
        [
          el("span", { class: "gc-gcn-tier-name" }, [tierLabel(i18n, tier.name)]),
          el("span", { class: "gc-gcn-tier-need" }, [`${tier.minHolding} ${view.asset}`]),
          el("span", { class: "gc-gcn-tier-cut" }, [`−${bpToPercent(tier.discountBp)} %`]),
        ],
      ),
    );
    children.push(el("div", { class: "gc-gcn-tiers" }, [
      el("p", { class: "gc-gcn-line is-muted" }, [i18n.t("gcn.tiersTitle")]),
      ...ladder,
    ]));
  }
  return el("section", { class: "gc-gcn-block gc-gcn-holder" }, [
    el("h3", {}, [i18n.t("gcn.holderTitle")]),
    ...children,
  ]);
}

function marketSection(view: GcnView, i18n: I18n): HTMLElement {
  const state = i18n.t(`gcn.marketState.${view.market.state}`);
  const children: Node[] = [
    el("div", { class: "gc-gcn-fact-head" }, [
      el("span", { class: "gc-gcn-fact-label" }, [i18n.t("gcn.marketPair")]),
      el("strong", { class: "gc-gcn-fact-value" }, [view.market.pair ?? "—"]),
    ]),
    el("p", { class: "gc-gcn-line is-muted" }, [state]),
  ];
  return el("section", { class: "gc-gcn-block" }, [el("h3", {}, [i18n.t("gcn.marketTitle")]), ...children]);
}

/** Everything below the titlebar, for a payload that says the token exists here. */
function tokenBody(view: GcnView, i18n: I18n): Node[] {
  const hero = el("section", { class: "gc-gcn-hero" }, [
    el("span", { class: "gc-gcn-mark", "aria-hidden": true }, [icon("spark")]),
    el("div", { class: "gc-gcn-hero-main" }, [
      el("strong", { class: "gc-gcn-hero-name" }, [`${view.name} · ${view.asset}`]),
      el("span", { class: "gc-gcn-hero-issued" }, [
        i18n.t("gcn.issuedOfCap", { pct: String(view.issuedPct) }),
      ]),
      bar(view.issuedPct, "is-hero"),
    ]),
  ]);
  return [
    hero,
    supplySection(view, i18n),
    deflationSection(view, i18n),
    holderSection(view, i18n),
    marketSection(view, i18n),
    // The one sentence that keeps this page honest, kept ON the page rather than in a commit message.
    el("p", { class: "gc-gcn-footnote" }, [i18n.t("gcn.noPromise")]),
  ];
}

/**
 * Open the token sheet. The frame mounts immediately with a waiting line — a sheet that appears only
 * after a round trip reads as a dead button — and the body is filled once `/v1/gcn` answers. A refusal
 * lands on the status line in the sheet's own words (FEATURE_DISABLED/NOT_FOUND become "not activated
 * here"), never as a raw code.
 */
export function openGcn(deps: GcnSheetDeps): void {
  const { i18n } = deps;
  const status = statusLine();
  status.textContent = i18n.t("common.loading");
  const slot = el("div", { class: "gc-gcn-slot" }, []);
  const panel = sheet(i18n, i18n.t("gcn.title"), i18n.t("gcn.hint"), [slot, status], deps.closeSheet);
  deps.openSheet(panel);

  void deps.money.gcn().then(
    (wire) => {
      const view = gcnView(wire);
      slot.textContent = "";
      if (!view.available) {
        status.textContent = i18n.t("gcn.unavailable");
        return;
      }
      status.textContent = "";
      for (const node of tokenBody(view, i18n)) slot.append(node);
    },
    (err: unknown) => {
      slot.textContent = "";
      status.textContent = sheetError(err, i18n);
    },
  );
}

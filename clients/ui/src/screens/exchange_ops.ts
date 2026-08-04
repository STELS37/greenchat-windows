// clients/ui/src/screens/exchange_ops.ts — the trading surface (T010–T013).
//
// The finance hub used to render markets behind a `readOnlyNotice`: prices arrived, but nothing
// could be traded from the application even though the server had run a full central limit order
// book (CLOB) all along. This module is that missing half — the pair screen, the order ticket, the
// activity lists and the instant swap.
//
// Two rules hold everywhere below, because both are how money bugs happen:
//   * every amount that travels or is displayed is a WIRE nano string; arithmetic stays in BigInt
//     inside finance_model.ts, never in JS numbers (PAYMENTS §21 + §13);
//   * nothing is shown that the server would not do. The order ticket mirrors the server's own
//     validateInput/holdNeed/fee split through previewOrder(), so the cost is visible BEFORE the
//     trade (EXCHANGE §0.5) and a rejected order is a liveness surprise, not a formatting one.
import { el } from "../dom.ts";
import type { I18n } from "../i18n.ts";
import { icon } from "../icons.ts";
import {
  bookTop,
  clientOpId,
  depthLadder,
  formatNanoWire,
  humanToNano,
  notionalFloor,
  orderRequestBody,
  pairHasDemoAsset,
  previewOrder,
  quoteRemainingSec,
  quoteUnitRate,
  summarizeCandles,
  type ExCandleRow,
  type ExDepthRow,
  type ExMyTradeRow,
  type ExOrderRow,
  type ExPairRow,
  type ExTickerRow,
  type ExTradeRow,
  type OrderPreview,
  type OrderPreviewInput,
  type SwapQuoteRow,
  type WalletAssetRow,
} from "./finance_model.ts";
import { field, input, money, row, select, sheet, sheetError, statusLine } from "./finance_sheet.ts";
import type { ExCandleTf, ExOrderRequest, MoneyApi, WalletResult } from "./money_api.ts";

export interface ExchangeOpsDeps {
  money: MoneyApi;
  i18n: I18n;
  /** Mount the sheet; the hub owns the overlay, exactly as it does for the wallet sheets. */
  openSheet(panel: HTMLElement): void;
  closeSheet(): void;
  /** Something changed on the server: the hub reloads and reports it on its own status line. */
  onChanged(message: string): void;
  /** Seconds since the epoch. Injected so tests do not depend on the wall clock. */
  now?(): number;
  /**
   * Start a repeating tick and return its canceller. Injected because the swap countdown is the one
   * place this module owns a timer, and a test must not wait real seconds for it.
   */
  interval?(fn: () => void, ms: number): () => void;
}

const nowSec = (deps: ExchangeOpsDeps): number => Math.trunc((deps.now ?? (() => Date.now() / 1000))());

const startInterval = (deps: ExchangeOpsDeps, fn: () => void, ms: number): (() => void) => {
  if (deps.interval) return deps.interval(fn, ms);
  const handle = globalThis.setInterval(fn, ms);
  return () => globalThis.clearInterval(handle);
};

/** Timeframes the server accepts on GET /v1/ex/candles/:pair (server: candleTf). */
export const TIMEFRAMES: ExCandleTf[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

const assetById = (assets: WalletAssetRow[], id: string): WalletAssetRow | undefined =>
  assets.find((asset) => asset.id === id);

/** A signed percent from basis points, e.g. -125 bp → "-1.25%". Display only, never money. */
export function changeText(changeBp: number | null): string {
  if (changeBp === null) return "—";
  const sign = changeBp > 0 ? "+" : "";
  return `${sign}${(changeBp / 100).toFixed(2)}%`;
}

/**
 * The localized reason an order ticket is not ready. Every problem previewOrder can report has its
 * own line: a generic "invalid input" would leave the trader guessing which of four fields is wrong.
 */
export function previewProblemText(preview: OrderPreview, pair: ExPairRow, i18n: I18n): string {
  switch (preview.problem) {
    case null: return "";
    case "qty_empty": return i18n.t("finance.qtyEmpty");
    case "qty_format": return i18n.t("finance.qtyFormat");
    case "qty_precision": return i18n.t("finance.qtyPrecision");
    case "qty_positive": return i18n.t("finance.qtyPositive");
    case "qty_lot_step": return i18n.t("finance.qtyLotStep", { step: money(pair.lot_step) });
    case "price_empty": return i18n.t("finance.priceEmpty");
    case "price_format": return i18n.t("finance.priceFormat");
    case "price_precision": return i18n.t("finance.pricePrecision");
    case "price_positive": return i18n.t("finance.pricePositive");
    case "price_tick": return i18n.t("finance.priceTick", { tick: money(pair.price_tick) });
    case "cap_empty": return i18n.t("finance.capEmpty");
    case "cap_format": return i18n.t("finance.capFormat");
    case "cap_precision": return i18n.t("finance.capPrecision");
    case "cap_positive": return i18n.t("finance.capPositive");
    case "cap_tick": return i18n.t("finance.capTick", { tick: money(pair.price_tick) });
    case "min_notional": return i18n.t("finance.minNotional", { min: money(pair.min_notional) });
    case "insufficient": return i18n.t("finance.insufficientFunds");
    default: return i18n.t("finance.amountFormat");
  }
}

/** A sparkline for the candle window. SVG geometry only — no number ever comes back as money. */
function sparkline(candles: ExCandleRow[] | undefined): { node: HTMLElement | null; changeBp: number | null } {
  const summary = summarizeCandles(candles);
  if (!summary) return { node: null, changeBp: null };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 32");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "gc-ex-spark");
  const path = document.createElementNS(ns, "polyline");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("points", summary.points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" "));
  svg.append(path);
  return { node: svg as unknown as HTMLElement, changeBp: summary.changeBp };
}

// ── T010–T011 pair screen with the order ticket ─────────────────────────────────────────────────

export function openPair(deps: ExchangeOpsDeps, pair: ExPairRow, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const stats = el("div", { class: "gc-ex-stats" });
  const chart = el("div", { class: "gc-ex-chart" });
  const book = el("div", { class: "gc-ex-book" });
  const tape = el("div", { class: "gc-ex-tape" });
  const orders = el("div", { class: "gc-finance-list gc-ex-orders" });

  // ---- market data -----------------------------------------------------------------------------
  const renderStats = (ticker: ExTickerRow, changeBp: number | null): void => {
    stats.textContent = "";
    const cell = (label: string, value: string): HTMLElement =>
      el("div", { class: "gc-ex-stat" }, [el("span", {}, [label]), el("strong", {}, [value])]);
    stats.append(
      cell(i18n.t("finance.lastPrice"), ticker.last ?? ticker.mid ? money((ticker.last ?? ticker.mid) as string) : "—"),
      cell(i18n.t("finance.change24h"), changeText(changeBp)),
      cell(i18n.t("finance.high24h"), ticker.high_24h ? money(ticker.high_24h) : "—"),
      cell(i18n.t("finance.low24h"), ticker.low_24h ? money(ticker.low_24h) : "—"),
      cell(i18n.t("finance.volume24h"), money(ticker.vol_quote_24h, 2)),
    );
  };

  let lastTicker: ExTickerRow | null = null;
  let lastChangeBp: number | null = null;

  const loadTicker = (): void => {
    void deps.money.ticker(pair.id).then(
      (result) => { lastTicker = result.ticker; renderStats(result.ticker, lastChangeBp); },
      (err) => { stats.textContent = sheetError(err, i18n); },
    );
  };

  const tfSelect = select();
  for (const tf of TIMEFRAMES) tfSelect.append(el("option", { value: tf }, [tf]));

  const loadCandles = (): void => {
    const tf = (tfSelect.value || "1h") as ExCandleTf;
    void deps.money.candles(pair.id, tf).then(
      (result) => {
        chart.textContent = "";
        const { node, changeBp } = sparkline(result.candles);
        lastChangeBp = changeBp;
        if (node) chart.append(node);
        else chart.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noChart")]));
        if (lastTicker) renderStats(lastTicker, changeBp);
      },
      (err) => { chart.textContent = sheetError(err, i18n); },
    );
  };
  tfSelect.addEventListener("change", loadCandles);

  const ladderSide = (levels: ReturnType<typeof depthLadder>, side: "bid" | "ask"): HTMLElement => {
    const box = el("div", { class: `gc-ex-ladder side-${side}` });
    for (const level of levels) {
      const row = el("div", { class: "gc-ex-level" }, [
        el("span", { class: "gc-ex-level-price" }, [money(formatNanoWire(level.price))]),
        el("span", { class: "gc-ex-level-qty" }, [money(formatNanoWire(level.qty))]),
        el("span", { class: "gc-ex-level-total" }, [money(formatNanoWire(level.total))]),
      ]);
      // Through the CSSOM, never as a `style="…"` attribute: our CSP is `style-src 'self'`, which
      // covers style attributes, so the depth bar behind each level used to be silently refused and
      // every rung of the ladder rendered flat (V84).
      row.style.setProperty("--gc-depth", `${(level.ratio * 100).toFixed(2)}%`);
      box.append(row);
    }
    return box;
  };

  const renderBook = (depth: ExDepthRow): void => {
    book.textContent = "";
    const bids = depthLadder(depth.bids);
    const asks = depthLadder(depth.asks);
    if (bids.length === 0 && asks.length === 0) {
      book.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noDepth")]));
      return;
    }
    const top = bookTop(depth);
    book.append(
      el("div", { class: "gc-ex-book-head" }, [
        el("span", {}, [i18n.t("finance.price")]),
        el("span", {}, [i18n.t("finance.qty")]),
        el("span", {}, [i18n.t("finance.total")]),
      ]),
      el("div", { class: "gc-ex-book-cols" }, [
        el("div", {}, [el("h4", {}, [i18n.t("finance.bids")]), ladderSide(bids, "bid")]),
        el("div", {}, [el("h4", {}, [i18n.t("finance.asks")]), ladderSide(asks, "ask")]),
      ]),
      el("p", { class: "gc-ex-spread" }, [
        `${i18n.t("finance.spread")}: ${top.spread === null ? "—" : money(formatNanoWire(top.spread))}`,
      ]),
    );
  };

  const loadBook = (): void => {
    void deps.money.depth(pair.id).then(renderBook, (err) => { book.textContent = sheetError(err, i18n); });
  };

  const renderTape = (trades: ExTradeRow[]): void => {
    tape.textContent = "";
    if (trades.length === 0) {
      tape.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noTrades")]));
      return;
    }
    for (const trade of trades.slice(0, 20)) {
      tape.append(el("div", { class: "gc-ex-tape-row" }, [
        el("span", {}, [money(trade.price)]),
        el("span", {}, [money(trade.qty)]),
        el("span", {}, [money(trade.notional, 2)]),
      ]));
    }
  };

  const loadTape = (): void => {
    void deps.money.trades(pair.id).then(
      (result) => renderTape(result.trades),
      (err) => { tape.textContent = sheetError(err, i18n); },
    );
  };

  // ---- the order ticket (T011) -----------------------------------------------------------------
  const sideSelect = select();
  sideSelect.append(el("option", { value: "buy" }, [i18n.t("finance.buy")]));
  sideSelect.append(el("option", { value: "sell" }, [i18n.t("finance.sell")]));
  const typeSelect = select();
  typeSelect.append(el("option", { value: "limit" }, [i18n.t("finance.limitOrder")]));
  typeSelect.append(el("option", { value: "market" }, [i18n.t("finance.marketOrder")]));
  const qtyInput = input({ type: "text", inputmode: "decimal", placeholder: "0.00" });
  const priceInput = input({ type: "text", inputmode: "decimal", placeholder: "0.00" });
  const capInput = input({ type: "text", inputmode: "decimal", placeholder: "0.00" });
  const priceField = field(i18n.t("finance.price"), priceInput);
  const capField = field(i18n.t("finance.slippageCap"), capInput);
  const preview = el("p", { class: "gc-finance-preview" });
  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [icon("exchange"), i18n.t("finance.placeOrder")]);

  const demoFees = pairHasDemoAsset(pair, wallet.assets);
  // The pair's own mode decides whether an order can exist at all: `swap_only` and `halted` pairs
  // reject every order server-side (core/exchange assertPairTradable), so the ticket says so instead
  // of collecting input for a request that cannot succeed.
  const tradable = pair.enabled && pair.mode === "active";

  const ticketInput = (): OrderPreviewInput => {
    const side = (sideSelect.value || "buy") as "buy" | "sell";
    const type = (typeSelect.value || "limit") as "limit" | "market";
    const holdAsset = side === "buy" ? pair.quote_asset : pair.base_asset;
    return {
      pair,
      side,
      type,
      qty: qtyInput.value,
      price: priceInput.value,
      slippageCap: capInput.value,
      available: assetById(wallet.assets, holdAsset)?.available ?? null,
      demoFees,
    };
  };

  const updatePreview = (): void => {
    const isMarket = typeSelect.value === "market";
    priceField.setAttribute("hidden", "");
    capField.setAttribute("hidden", "");
    if (isMarket) capField.removeAttribute("hidden");
    else priceField.removeAttribute("hidden");
    if (!tradable) {
      preview.textContent = i18n.t(pair.mode === "swap_only" ? "finance.marketSwapOnly" : "finance.marketHalted");
      submit.setAttribute("disabled", "true");
      return;
    }
    const ticket = ticketInput();
    const result = previewOrder(ticket);
    if (!result.ok) {
      preview.textContent = qtyInput.value.trim() || priceInput.value.trim() || capInput.value.trim()
        ? previewProblemText(result, pair, i18n)
        : "";
      submit.setAttribute("disabled", "true");
      return;
    }
    submit.removeAttribute("disabled");
    const parts = [
      `${i18n.t("finance.holdAmount")}: ${money(formatNanoWire(result.holdAmount ?? 0n))} ${result.holdAsset}`,
      demoFees
        ? i18n.t("finance.demoNoFee")
        : `${i18n.t("finance.makerFee")}: ${money(formatNanoWire(result.makerFee ?? 0n))} ${result.feeAsset}`
          + ` · ${i18n.t("finance.takerFee")}: ${money(formatNanoWire(result.takerFee ?? 0n))} ${result.feeAsset}`,
      `${i18n.t("finance.receiveWorstCase")}: ${money(formatNanoWire(result.receiveWorstCase ?? 0n))} ${result.receiveAsset}`,
      `${i18n.t("finance.timeInForce")}: ${result.tif}`,
    ];
    preview.textContent = parts.join(" · ");
  };

  for (const control of [sideSelect, typeSelect]) control.addEventListener("change", updatePreview);
  for (const control of [qtyInput, priceInput, capInput]) control.addEventListener("input", updatePreview);

  const renderOrders = (items: ExOrderRow[]): void => {
    orders.textContent = "";
    const mine = items.filter((item) => item.pair === pair.id);
    if (mine.length === 0) {
      orders.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noOrders")]));
      return;
    }
    for (const item of mine) orders.append(orderRow(deps, item, () => { loadOrders(); loadBook(); }));
  };

  const loadOrders = (): void => {
    void deps.money.orders().then(
      (result) => renderOrders(result.orders.filter((item) => OPEN_STATUSES.has(item.status))),
      (err) => { orders.textContent = sheetError(err, i18n); },
    );
  };

  const form = el("form", { class: "gc-finance-form" }, [
    el("div", { class: "gc-finance-form-row" }, [
      field(i18n.t("finance.side"), sideSelect),
      field(i18n.t("finance.orderType"), typeSelect),
    ]),
    el("div", { class: "gc-finance-form-row" }, [
      field(`${i18n.t("finance.qty")} (${pair.base_asset})`, qtyInput),
      priceField,
      capField,
    ]),
    preview,
    el("div", { class: "gc-sheet-actions" }, [submit]),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const ticket = ticketInput();
    const result = previewOrder(ticket);
    if (!result.ok) {
      status.textContent = previewProblemText(result, pair, i18n);
      return;
    }
    submit.setAttribute("disabled", "true");
    // orderRequestBody builds exactly the JSON the route expects; the cast is the boundary between
    // the pure model (which must not import the transport) and the typed transport.
    const body = orderRequestBody(ticket, result, clientOpId("ord")) as unknown as ExOrderRequest;
    void deps.money.placeOrder(body).then(
      (placed) => {
        submit.removeAttribute("disabled");
        qtyInput.value = "";
        updatePreview();
        const statusText = i18n.t(`finance.orderStatus.${placed.order.status}`);
        status.textContent = `${i18n.t("finance.orderPlaced")} · ${statusText}`;
        loadOrders();
        loadBook();
        loadTape();
        deps.onChanged(i18n.t("finance.orderPlaced"));
      },
      (err) => { submit.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
    );
  });

  updatePreview();
  deps.openSheet(sheet(i18n, `${i18n.t("finance.trade")} · ${pair.id}`, i18n.t("finance.tradeHint"), [
    stats,
    el("div", { class: "gc-ex-chart-head" }, [el("h3", {}, [i18n.t("finance.chart")]), tfSelect]),
    chart,
    el("h3", {}, [i18n.t("finance.orderBook")]),
    book,
    el("h3", {}, [i18n.t("finance.recentTrades")]),
    tape,
    form,
    status,
    el("h3", {}, [i18n.t("finance.openOrders")]),
    orders,
  ], deps.closeSheet));

  loadTicker();
  loadCandles();
  loadBook();
  loadTape();
  loadOrders();
}

/** Statuses that still live in the book, i.e. the ones a cancel can act on (server: cancelOrder). */
const OPEN_STATUSES = new Set(["waiting", "open", "partial"]);

function orderRow(deps: ExchangeOpsDeps, item: ExOrderRow, onChanged: () => void): HTMLElement {
  const { i18n } = deps;
  const statusKey = `finance.orderStatus.${item.status}`;
  const statusText = i18n.t(statusKey);
  const side: Node[] = [
    el("strong", {}, [statusText === statusKey ? item.status : statusText]),
    el("span", {}, [i18n.t("finance.filledOf", { filled: money(item.filled_qty), qty: money(item.qty) })]),
  ];
  if (OPEN_STATUSES.has(item.status)) {
    const cancel = el("button", { type: "button", class: "gc-btn gc-btn-quiet" }, [i18n.t("finance.cancelOrder")]);
    cancel.addEventListener("click", () => {
      cancel.setAttribute("disabled", "true");
      void deps.money.cancelOrder(item.id).then(
        () => { deps.onChanged(i18n.t("finance.orderCancelled")); onChanged(); },
        () => { cancel.removeAttribute("disabled"); },
      );
    });
    side.push(cancel);
  }
  return row(item.side === "buy" ? "receive" : "send", [
    el("strong", {}, [`${item.pair} · ${i18n.t(item.side === "buy" ? "finance.buy" : "finance.sell")}`]),
    el("span", {}, [item.price ? `${money(item.price)} · ${money(item.qty)}` : money(item.qty)]),
  ], side, `side-${item.side}`);
}

// ── T012 my orders and my trades ────────────────────────────────────────────────────────────────

export function openActivity(deps: ExchangeOpsDeps): void {
  const { i18n } = deps;
  const status = statusLine();
  const orders = el("div", { class: "gc-finance-list gc-ex-orders" });
  const trades = el("div", { class: "gc-finance-list gc-ex-mytrades" });

  const loadOrders = (): void => {
    void deps.money.orders().then(
      (result) => {
        orders.textContent = "";
        const items = result.orders.filter((item) => OPEN_STATUSES.has(item.status));
        if (items.length === 0) {
          orders.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noOrders")]));
          return;
        }
        for (const item of items) orders.append(orderRow(deps, item, loadOrders));
      },
      (err) => { orders.textContent = sheetError(err, i18n); },
    );
  };

  const renderTrades = (items: ExMyTradeRow[]): void => {
    trades.textContent = "";
    if (items.length === 0) {
      trades.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noMyTrades")]));
      return;
    }
    for (const item of items) {
      trades.append(row(item.side === "buy" ? "receive" : "send", [
        el("strong", {}, [`${item.pair} · ${i18n.t(item.side === "buy" ? "finance.buy" : "finance.sell")}`]),
        el("span", {}, [`${money(item.price)} · ${money(item.qty)} · ${i18n.t(`finance.role.${item.role}`)}`]),
      ], [
        el("strong", {}, [money(item.notional, 2)]),
        // The fee is named with its own asset: a buy is charged in base, a sell in quote, and an
        // unlabelled number here would be read as the quote currency every time.
        el("span", {}, [`${i18n.t("finance.takerFee")}: ${money(item.fee)} ${item.fee_asset}`]),
      ], `side-${item.side}`));
    }
  };

  const loadTrades = (): void => {
    void deps.money.myTrades().then(
      (result) => renderTrades(result.trades),
      (err) => { trades.textContent = sheetError(err, i18n); },
    );
  };

  deps.openSheet(sheet(i18n, i18n.t("finance.openOrders"), i18n.t("finance.tradeHint"), [
    orders,
    el("h3", {}, [i18n.t("finance.myTrades")]),
    trades,
    status,
  ], deps.closeSheet));
  loadOrders();
  loadTrades();
}

// ── T013 instant swap ───────────────────────────────────────────────────────────────────────────

export function openSwap(deps: ExchangeOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const assets = wallet.assets.filter((asset) => asset.enabled);
  const fromSelect = select();
  const toSelect = select();
  for (const asset of assets) {
    fromSelect.append(el("option", { value: asset.id }, [`${asset.id} · ${money(asset.available)}`]));
    toSelect.append(el("option", { value: asset.id }, [asset.id]));
  }
  if (assets.length > 1) toSelect.value = assets[1]?.id ?? "";
  const amount = input({ type: "text", inputmode: "decimal", placeholder: "0.00" });
  const pin = input({ type: "password", inputmode: "numeric", placeholder: i18n.t("finance.pinIfRequired") });
  const pinField = field(i18n.t("finance.paymentPin"), pin);
  pinField.setAttribute("hidden", "");
  const quoteBox = el("div", { class: "gc-ex-quote" });
  const quoteBtn = el("button", { type: "submit", class: "gc-btn gc-btn-quiet" }, [i18n.t("finance.getQuote")]);
  const confirm = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [icon("exchange"), i18n.t("finance.confirmSwap")]);
  confirm.setAttribute("disabled", "true");

  let quote: SwapQuoteRow | null = null;
  let stopTick: (() => void) | null = null;
  const stopCountdown = (): void => { stopTick?.(); stopTick = null; };

  // The server demands a PIN when the USD notional of the quote reaches the account threshold
  // (modules/swaps.ts postSwap: notional(amount_from, rate_from) >= paymentPinThreshold()). The same
  // comparison is done here, in nano, so the field appears exactly when the server will ask for it.
  const pinNeeded = (row: SwapQuoteRow): boolean => {
    const threshold = humanToNano(wallet.payment_settings.pin_required_usd ?? "");
    if (threshold === null) return false;
    const usd = notionalFloor(BigInt(row.amount_from), BigInt(row.rate_from));
    return usd >= threshold;
  };

  const renderQuote = (): void => {
    quoteBox.textContent = "";
    if (!quote) return;
    const left = quoteRemainingSec(quote, nowSec(deps));
    const rate = quoteUnitRate(quote);
    quoteBox.append(
      el("p", {}, [`${i18n.t("finance.to")}: ${money(quote.amount_to)} ${quote.to}`]),
      el("p", {}, [`${i18n.t("finance.quoteRate")}: 1 ${quote.from} = ${rate === null ? "—" : money(formatNanoWire(rate))} ${quote.to}`]),
      el("p", {}, [i18n.t("finance.spreadBp", { bp: String(quote.spread_bp) })]),
      el("p", { class: left > 0 ? "gc-ex-quote-live" : "gc-ex-quote-dead" }, [
        left > 0 ? i18n.t("finance.quoteExpires", { sec: String(left) }) : i18n.t("finance.quoteExpired"),
      ]),
    );
    if (left > 0) confirm.removeAttribute("disabled");
    else {
      confirm.setAttribute("disabled", "true");
      stopCountdown();
    }
  };

  const form = el("form", { class: "gc-finance-form" }, [
    el("div", { class: "gc-finance-form-row" }, [
      field(i18n.t("finance.from"), fromSelect),
      field(i18n.t("finance.to"), toSelect),
    ]),
    field(i18n.t("finance.amount"), amount),
    pinField,
    quoteBox,
    status,
    el("div", { class: "gc-sheet-actions" }, [quoteBtn, confirm]),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const nano = humanToNano(amount.value);
    if (nano === null || nano <= 0n) {
      status.textContent = i18n.t("finance.amountFormat");
      return;
    }
    stopCountdown();
    quoteBtn.setAttribute("disabled", "true");
    status.textContent = i18n.t("common.loading");
    void deps.money.swapQuote({ from: fromSelect.value, to: toSelect.value, amount: formatNanoWire(nano) }).then(
      (result) => {
        quoteBtn.removeAttribute("disabled");
        status.textContent = "";
        quote = result;
        if (pinNeeded(result)) pinField.removeAttribute("hidden");
        else pinField.setAttribute("hidden", "");
        renderQuote();
        stopTick = startInterval(deps, renderQuote, 1000);
      },
      (err) => {
        quoteBtn.removeAttribute("disabled");
        quote = null;
        confirm.setAttribute("disabled", "true");
        quoteBox.textContent = "";
        status.textContent = sheetError(err, i18n);
      },
    );
  });

  confirm.addEventListener("click", () => {
    if (!quote) return;
    if (quoteRemainingSec(quote, nowSec(deps)) <= 0) {
      status.textContent = i18n.t("finance.quoteExpired");
      confirm.setAttribute("disabled", "true");
      return;
    }
    const pinValue = pin.value.trim();
    confirm.setAttribute("disabled", "true");
    void deps.money.swap({ quote_id: quote.quote_id, ...(pinValue ? { pin: pinValue } : {}) }).then(
      (result) => {
        stopCountdown();
        deps.onChanged(`${i18n.t("finance.swapDone")}: ${money(result.amount_to)} ${result.to}`);
        deps.closeSheet();
      },
      (err) => {
        confirm.removeAttribute("disabled");
        status.textContent = sheetError(err, i18n);
      },
    );
  });

  deps.openSheet(sheet(i18n, i18n.t("finance.swap"), i18n.t("finance.swapHint"), [form], () => {
    stopCountdown();
    deps.closeSheet();
  }));
}

// clients/ui/src/screens/finance_screen.ts — GreenChat V4 finance hub.
// The surface reads the real wallet/exchange/cards APIs. It never invents balances or market data:
// disabled contours render an explicit unavailable state, while transfers keep every server-side PIN,
// 2FA, limits and risk check intact.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { createFocusTrap, type FocusTrap } from "../a11y.ts";
import { createWidthFitter } from "../fit_width.ts";
import { icon, type IconName } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";
import { formatDecimal, formatNano } from "./finance_model.ts";
import type {
  WalletResult as MoneyWalletResult,
  WalletHistoryResult,
  EnvelopeRow,
} from "./money_api.ts";
import { createMoneyApi } from "./money_api.ts";
import {
  demoTopUpAssets,
  openDemoTopUp,
  openDeposit,
  openPin,
  openWhitelist,
  openWithdraw,
} from "./wallet_ops.ts";
import {
  openActivity,
  openPair,
  openSwap,
  type ExchangeOpsDeps,
} from "./exchange_ops.ts";
import { openGcn } from "./gcn_screen.ts";
import { serverFeatures } from "./server_features.ts";
import { failureState, stateView } from "./state_view.ts";

export type FinanceView = "wallet" | "exchange" | "cards";

export interface FinanceScreenDeps {
  api: ApiLike;
  i18n: I18n;
  view: FinanceView;
  onNavigate(view: FinanceView): void;
  onBack(): void;
  // See CallsScreenDeps.atShellRoot: a tab destination owns no back arrow, because the tab bar below
  // it already names every place the user could go.
  atShellRoot?: boolean;
}

// The wallet wire shapes are NOT redeclared here any more: money_api.ts owns them, and two copies of
// the same shape is how a field ends up spelled differently on one screen than on the wire.
type WalletResult = MoneyWalletResult;
type WalletHistory = WalletHistoryResult;

// The currency the wallet headline is denominated in. `total_usd` is a USD sum by contract, so this
// is a constant rather than a setting — it exists so the headline and the "≈" line can be compared
// instead of both hard-coding the same literal in two places that could drift apart.
const HEADLINE_CURRENCY = "USD";

// Same rule for the exchange shapes, except there is no alias left to keep: the market row and the
// pair sheet both take the row straight out of money$.pairs()/money$.tickers(), whose element types
// are ExPairRow/ExTickerRow from finance_model.ts. The old local copies omitted price_tick, lot_step
// and min_notional, so a row could not have opened an order ticket without inventing those numbers.

interface CardItem {
  id: string;
  state: string;
  network: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  created_at: number;
}

// Two formatters, because the server sends two different kinds of money string and the old single
// `money()` treated both as decimal. Measured against server/test/integration/wallet.test.ts: a
// balance of 12.5 tUSDT arrives as "12500000000" (PAYMENTS §21 — canonical nano integer, no dot),
// so splitting on "." found nothing and printed 12 500 000 000. Every balance, rate and amount was
// shown 1e9 times too large.
//   money()     — a WIRE nano string (balance, available, usd_value, total_usd, ticker prices).
//   fiatMoney() — an ALREADY-human decimal (approx_fiat.amount, pin_required_usd), which the server
//                 has already rounded to minor units; scaling it by 1e-9 would be the mirror bug.
const money = (raw: string | null | undefined, maxFraction = 6): string =>
  formatNano(raw, { maxFraction });

const fiatMoney = (raw: string | null | undefined, maxFraction = 2): string =>
  formatDecimal(raw, maxFraction);

const timeText = (seconds: number): string => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(seconds * 1000));
  } catch {
    return "";
  }
};

const assetTone = (id: string): string =>
  `gc-asset gc-asset-${id.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

// The action grid is a fixed 4-column tile row. Long sentences ("Установить платёжный PIN") wrapped to
// three lines and broke the grid rhythm, so the tile shows a SHORT caption while the full wording stays
// as the accessible name and the tooltip — no meaning is lost for screen readers or hover.
// A short caption may also carry a soft hyphen (U+00AD, see locales/ru.ts): it is a break HINT, invisible
// until the word has to break, and it deliberately reaches only the visible span — `title` and
// `aria-label` take `label`, so no assistive technology ever sees a hyphenated word.
function actionButton(
  name: IconName,
  label: string,
  className = "",
  short?: string,
): HTMLButtonElement {
  return el(
    "button",
    {
      type: "button",
      class: `gc-finance-action ${className}`.trim(),
      title: label,
      "aria-label": label,
    },
    [
      el("span", { class: "gc-finance-action-icon", "aria-hidden": true }, [
        icon(name),
      ]),
      el("span", { class: "gc-finance-action-label" }, [short ?? label]),
    ],
  ) as HTMLButtonElement;
}

// V85: this family used to draw its own state block (`.gc-finance-empty`) — a second language for the
// same four situations `state_view.ts` already owns. Measured on the running client at 390x844
// (var/ux-audit/tools/m_finstate_v85.mjs, 2026-07-30, contour off): /wallet and /exchange each spent
// 358x609 — the whole screen — on a block with `action=NONE`, i.e. a dead end, and painted the SAME
// green glyph whether the contour was deliberately off, the network was down, or the server had
// failed. Three different facts, one picture, no move. Every state below now speaks the V76 language:
// one shape, the tone carries the meaning, and there is always exactly one honest action.
function emptyState(
  name: IconName,
  title: string,
  body: string,
  action?: { label: string; onAction: () => void },
): HTMLElement {
  return stateView({
    tone: "empty",
    icon: name,
    title,
    body,
    ...(action ? { actionLabel: action.label, onAction: action.onAction } : {}),
  });
}

export function createFinanceScreen(deps: FinanceScreenDeps): {
  root: HTMLElement;
  destroy(): void;
} {
  const { api, i18n } = deps;
  const money$ = createMoneyApi(api);
  // Owns the re-fit on rotation / keyboard / system font change for the headline balance.
  const fitter = createWidthFitter();
  let disposed = false;
  let loadSeq = 0;
  let activeOverlay: HTMLElement | null = null;
  // The keyboard trap belonging to that overlay. One at a time, by construction: mountSheet closes
  // whatever was open before it mounts the next sheet.
  let activeTrap: FocusTrap | null = null;

  const title =
    deps.view === "wallet"
      ? i18n.t("finance.wallet")
      : deps.view === "exchange"
        ? i18n.t("finance.exchange")
        : i18n.t("finance.cards");

  const back = el(
    "button",
    {
      type: "button",
      class: "gc-icon-btn gc-finance-back",
      title: i18n.t("common.back"),
      "aria-label": i18n.t("common.back"),
    },
    [icon("back")],
  );
  back.addEventListener("click", deps.onBack);
  const refresh = el(
    "button",
    {
      type: "button",
      class: "gc-icon-btn",
      title: i18n.t("common.retry"),
      "aria-label": i18n.t("common.retry"),
    },
    [icon("refresh")],
  );
  const heading = el("div", { class: "gc-finance-heading" }, [
    el("h1", {}, [title]),
    el("p", {}, [i18n.t("finance.secureNote")]),
  ]);
  const header = el("header", { class: "gc-finance-header" }, [
    ...(deps.atShellRoot === true ? [] : [back]),
    heading,
    refresh,
  ]);

  const tabBar = el("nav", {
    class: "gc-finance-tabs",
    "aria-label": i18n.t("finance.navigation"),
  });
  const tabs: Array<{ view: FinanceView; icon: IconName; label: string }> = [
    { view: "wallet", icon: "wallet", label: i18n.t("finance.wallet") },
    { view: "exchange", icon: "exchange", label: i18n.t("finance.exchange") },
    // "cards" is deliberately absent: it is appended below only when the server advertises the contour.
  ];
  const tabButton = (tab: {
    view: FinanceView;
    icon: IconName;
    label: string;
  }): HTMLElement => {
    const button = el(
      "button",
      {
        type: "button",
        class: `gc-finance-tab${deps.view === tab.view ? " is-active" : ""}`,
        "aria-current": deps.view === tab.view ? "page" : undefined,
      },
      [icon(tab.icon), el("span", {}, [tab.label])],
    );
    button.addEventListener("click", () => deps.onNavigate(tab.view));
    return button;
  };
  for (const tab of tabs) tabBar.append(tabButton(tab));
  // The card contour is fail-closed on the server, so the tab is offered only after /v1/config confirms
  // it exists. Deep-linking straight to #/cards keeps the tab visible regardless, otherwise the screen
  // you are standing on would have no entry in its own tab bar.
  const contours = serverFeatures(api);
  const cardsAvailable = contours.then((f) => f.cards);
  // B-P0-4: the demo top-up entry exists only where the server says the demo contour is on. On a
  // deployment with live rails it never renders, so no user is ever offered test money next to real
  // money.
  const demoFinanceAvailable = contours.then((f) => f.demoFinance);
  // Green Coin has no /v1/config flag of its own, and inventing one would be a second source of truth:
  // whether the token exists here is a property of the LEDGER (migration 096 plus a GCN asset), and
  // `/v1/gcn` reports exactly that in `available`. The probe is gated on the money contour being
  // advertised at all, so a stock deployment — payments off, every money route answering 403 — fires
  // no doomed request, which is the same rule the cards tab follows. A refusal or a server that never
  // heard of the route resolves to `false`: the entry point simply does not appear.
  const gcnAvailable = contours
    .then((f) => (f.payments ? money$.gcn().then((wire) => wire?.available === true) : false))
    .catch(() => false);
  // The whole money contour is fail-closed too (GC_PAYMENTS defaults to 0): every /v1/wallet and
  // /v1/ex/* call then answers 403. The screen already rendered an honest "unavailable" card, but only
  // AFTER firing the doomed requests, so a stock deployment logged four failed requests and console
  // errors on each visit (var/ux-audit/v40/report.json). Ask the advertised flag first — see
  // contourOff() for why only a real ANSWER is allowed to skip the request.
  void cardsAvailable.then((available) => {
    if (disposed || !(available || deps.view === "cards")) return;
    tabBar.append(
      tabButton({
        view: "cards",
        icon: "cards",
        label: i18n.t("finance.cards"),
      }),
    );
  });

  const status = el("p", {
    class: "gc-finance-status",
    role: "status",
    "aria-live": "polite",
  });
  const body = el("main", { class: "gc-finance-body", "aria-busy": "true" }, [
    el("div", { class: "gc-finance-skeleton" }),
    el("div", { class: "gc-finance-skeleton" }),
    el("div", { class: "gc-finance-skeleton" }),
  ]);
  const root = el("div", { class: `gc-finance gc-finance-${deps.view}` }, [
    header,
    tabBar,
    status,
    body,
  ]);

  const closeOverlay = (): void => {
    // Release before the layer leaves the tree: the trap only hands the caret back while it can still
    // prove the caret is inside the sheet, and a removed node's activeElement proves nothing.
    activeTrap?.release();
    activeTrap = null;
    activeOverlay?.remove();
    activeOverlay = null;
  };

  // The on-chain sheets (deposit / withdraw / whitelist / PIN) live in wallet_ops.ts. They get the
  // hub's own mount and status channel, so a sheet never touches document.body itself and every
  // server-side change comes back through one reload path.
  //
  // It is also the single place that owns the KEYBOARD for every money sheet — deposit, withdraw,
  // whitelist, PIN, demo top-up, trade, orders, swap and the transfer form all arrive here. Each of
  // those panels declares role="dialog" aria-modal="true", i.e. tells assistive technology that the
  // wallet behind it no longer exists; before V152 not one of them moved focus, so Tab kept walking a
  // page the screen reader had just hidden, and money forms are the worst possible place to type into
  // a control you cannot see.
  const mountSheet = (panel: HTMLElement, initialFocus?: HTMLElement): void => {
    closeOverlay();
    const layer = el("div", { class: "gc-sheet-layer" }, [panel]);
    layer.addEventListener("click", (event) => {
      if (event.target === layer) closeOverlay();
    });
    // Escape dismisses, as it does in every other overlay in this client. The listener sits on the
    // layer so it catches keys bubbling from any control inside the sheet.
    layer.addEventListener("keydown", (event) => {
      const key = (event as unknown as { key?: string }).key;
      if (key !== "Escape") return;
      event.preventDefault();
      closeOverlay();
    });
    document.body.append(layer);
    activeOverlay = layer;
    // The trap watches the whole layer (Tab bubbles up to it from every field) but parks the caret on
    // the panel — the node that actually carries role="dialog", so a reader announces the sheet
    // rather than the scrim around it.
    activeTrap = createFocusTrap(layer, { initialFocus: initialFocus ?? panel });
    activeTrap.activate();
  };

  // One wiring for every money sheet. ExchangeOpsDeps is a strict superset of WalletOpsDeps (it adds
  // the optional injected timer the swap countdown needs), so both families share this single object
  // instead of two near-identical ones that could drift apart.
  const opsDeps: ExchangeOpsDeps = {
    money: money$,
    i18n,
    openSheet: mountSheet,
    closeSheet: closeOverlay,
    onChanged: (message) => {
      status.textContent = message;
      void load();
    },
  };

  const unavailable = (
    err: unknown,
    name: IconName,
    titleKey: string,
  ): void => {
    const code = apiErrorCode(err);
    const featureOff =
      code === "FEATURE_DISABLED" ||
      code === "PAYMENTS_DISABLED" ||
      code === "PAYMENTS_FROZEN" ||
      code === "NOT_FOUND";
    clear(body);
    // A contour that is off is not a failure: nothing is broken, the flag is simply not set for this
    // account or environment. It stays the neutral "empty" tone — but it still gets the one move that
    // can change the answer, because the server flag can flip without the app restarting. Anything
    // else IS a failure and must say which kind: unreachable server (wait) or refused request (report).
    body.append(
      featureOff
        ? emptyState(name, i18n.t(titleKey), i18n.t("finance.unavailable"), {
            label: i18n.t("common.retry"),
            onAction: () => void load(),
          })
        : failureState(err, i18n, () => void load()),
    );
    status.textContent = "";
    body.setAttribute("aria-busy", "false");
  };

  const openTransfer = (wallet: WalletResult): void => {
    closeOverlay();
    const enabled = wallet.assets.filter((asset) => asset.enabled);
    const recipient = el("input", {
      class: "gc-input",
      type: "text",
      autocomplete: "off",
      placeholder: "@username",
    }) as HTMLInputElement;
    const amount = el("input", {
      class: "gc-input",
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      placeholder: "0.00",
    }) as HTMLInputElement;
    const note = el("input", {
      class: "gc-input",
      type: "text",
      autocomplete: "off",
      placeholder: i18n.t("finance.noteOptional"),
    }) as HTMLInputElement;
    const pin = el("input", {
      class: "gc-input",
      type: "password",
      inputmode: "numeric",
      autocomplete: "off",
      placeholder: i18n.t("finance.pinIfRequired"),
    }) as HTMLInputElement;
    const select = el("select", { class: "gc-select" }) as HTMLSelectElement;
    for (const asset of enabled)
      select.append(
        el("option", { value: asset.id }, [
          `${asset.id} · ${money(asset.available)}`,
        ]),
      );
    const formStatus = el("p", {
      class: "gc-sheet-status",
      role: "status",
      "aria-live": "polite",
    });
    const submit = el(
      "button",
      { type: "submit", class: "gc-btn gc-btn-accent" },
      [icon("send"), i18n.t("finance.send")],
    );
    const cancel = el(
      "button",
      { type: "button", class: "gc-btn gc-btn-quiet" },
      [i18n.t("common.cancel")],
    );
    cancel.addEventListener("click", closeOverlay);

    const form = el("form", { class: "gc-finance-form" }, [
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("finance.recipient")]),
        recipient,
      ]),
      el("div", { class: "gc-finance-form-row" }, [
        el("label", { class: "gc-field" }, [
          el("span", { class: "gc-field-label" }, [i18n.t("finance.asset")]),
          select,
        ]),
        el("label", { class: "gc-field" }, [
          el("span", { class: "gc-field-label" }, [i18n.t("finance.amount")]),
          amount,
        ]),
      ]),
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("finance.note")]),
        note,
      ]),
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("finance.paymentPin")]),
        pin,
      ]),
      formStatus,
      el("div", { class: "gc-sheet-actions" }, [cancel, submit]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const username = recipient.value.trim().replace(/^@/, "");
      const amountValue = amount.value.trim();
      if (!username || !amountValue) {
        formStatus.textContent = i18n.t("finance.completeFields");
        return;
      }
      submit.setAttribute("disabled", "true");
      formStatus.textContent = i18n.t("finance.sending");
      const opId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `ui-${Date.now()}-${Math.trunc(Math.random() * 1e9)}`;
      void api
        .post<Record<string, unknown>>("/v1/wallet/transfer", {
          to_username: username,
          client_op_id: opId,
          asset: select.value,
          amount: amountValue,
          note: note.value.trim(),
          pin: pin.value.trim(),
        })
        .then((result) => {
          if (disposed) return;
          closeOverlay();
          // P0-4: the server answers `mode: "claimable"` when the recipient is a stranger — the money
          // is parked in an envelope, not delivered. Saying "sent" for that case is how the sender
          // learned nothing and the recipient learned nothing either.
          status.textContent = i18n.t(
            result?.mode === "claimable" ? "finance.sentClaimable" : "finance.sent",
          );
          void load();
        })
        .catch((err) => {
          formStatus.textContent = describeError(err, i18n);
          submit.removeAttribute("disabled");
        });
    });

    const panel = el(
      "section",
      {
        class: "gc-sheet gc-finance-sheet",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": i18n.t("finance.send"),
      },
      [
        el("div", { class: "gc-sheet-handle", "aria-hidden": true }),
        el("div", { class: "gc-sheet-titlebar" }, [
          el("div", {}, [
            el("h2", {}, [i18n.t("finance.send")]),
            el("p", {}, [i18n.t("finance.transferHint")]),
          ]),
          el(
            "button",
            {
              type: "button",
              class: "gc-icon-btn",
              title: i18n.t("common.cancel"),
              "aria-label": i18n.t("common.cancel"),
            },
            [icon("close")],
          ),
        ]),
        form,
      ],
    );
    (
      panel.querySelector(".gc-icon-btn") as HTMLButtonElement | null
    )?.addEventListener("click", closeOverlay);
    // Through the same funnel as every other money sheet (V152). This used to build its own layer,
    // and so it was the one sheet that moved focus (into the recipient field) yet still let Tab walk
    // straight out into the wallet behind it, never restored the caret on close, and ignored Escape.
    // Typing a recipient into a field you cannot see is how a transfer goes to the wrong person.
    mountSheet(panel, recipient);
  };

  // Shared shape of the two guards below: contour off → the same honest panel the error path renders,
  // minus the failing round-trip. Returns true when the caller must stop.
  const contourOff = async (
    seq: number,
    name: IconName,
    titleKey: string,
  ): Promise<boolean> => {
    const probe = await contours;
    // V85: short-circuit ONLY on a real answer. When the probe itself failed (`known === false`, e.g.
    // the phone is offline) this used to print «Финансовый контур ещё не активирован» — a confident
    // statement about the SERVER derived from silence. Measured 2026-07-30 at 390x844 with every
    // request aborted: /wallet showed the contour-off panel, not the offline one. Falling through
    // costs one doomed request and buys the truth: the request's own failure says which fact it is.
    if (probe.payments || !probe.known) return false;
    if (disposed || seq !== loadSeq) return true;
    clear(body);
    body.append(
      emptyState(name, i18n.t(titleKey), i18n.t("finance.unavailable"), {
        label: i18n.t("common.retry"),
        onAction: () => void load(),
      }),
    );
    status.textContent = "";
    body.setAttribute("aria-busy", "false");
    return true;
  };

  const renderWallet = async (seq: number): Promise<void> => {
    try {
      if (await contourOff(seq, "wallet", "finance.walletUnavailable")) return;
      // P0-4: the claimable inbox travels with the wallet. It is fetched TOLERANTLY — a server that
      // predates GET /v1/envelopes answers 404, and a wallet that renders is worth more than a
      // section that cannot: an empty list simply draws nothing.
      const [wallet, history, inbox] = await Promise.all([
        api.get<WalletResult>("/v1/wallet"),
        api.get<WalletHistory>("/v1/wallet/history?limit=8"),
        money$.envelopes().catch(() => ({ envelopes: [] as EnvelopeRow[] })),
      ]);
      if (disposed || seq !== loadSeq) return;
      clear(body);
      const send = actionButton(
        "send",
        i18n.t("finance.send"),
        "is-primary",
        i18n.t("finance.shortSend"),
      );
      send.addEventListener("click", () => openTransfer(wallet));
      const exchange = actionButton("swap", i18n.t("finance.exchange"));
      exchange.addEventListener("click", () => deps.onNavigate("exchange"));
      // Same rule as the tab: hidden until the server confirms the contour, so the wallet hero never
      // offers a shortcut into a guaranteed error screen.
      const cards = actionButton("cards", i18n.t("finance.cards"));
      cards.hidden = true;
      cards.addEventListener("click", () => deps.onNavigate("cards"));
      void cardsAvailable.then((available) => {
        if (!disposed && available) cards.hidden = false;
      });
      const receive = actionButton(
        "receive",
        i18n.t("finance.receive"),
        "",
        i18n.t("finance.shortReceive"),
      );
      receive.addEventListener("click", () => openDeposit(opsDeps, wallet));
      const withdraw = actionButton("send", i18n.t("finance.withdraw"));
      withdraw.addEventListener("click", () => openWithdraw(opsDeps, wallet));
      // Test funds. Hidden by default and revealed only when /v1/config advertises the demo contour
      // AND this wallet actually lists a demo asset — otherwise the sheet would have nothing to
      // credit.
      const demoTopUp = actionButton(
        "receive",
        i18n.t("finance.demoTopUpTitle"),
        "",
        i18n.t("finance.shortDemoTopUp"),
      );
      demoTopUp.hidden = true;
      demoTopUp.addEventListener("click", () => openDemoTopUp(opsDeps, wallet));
      void demoFinanceAvailable.then((available) => {
        if (!disposed && available && demoTopUpAssets(wallet.assets).length > 0)
          demoTopUp.hidden = false;
      });
      // The token page. It is an entry point into a SHEET rather than a tab, deliberately: the tab bar
      // is the map of the money contour (wallet · exchange · cards), and Green Coin is one asset inside
      // it, not a fourth contour. Hidden until `/v1/gcn` says the token exists here, on the same rule
      // as cards and the demo top-up — a tile whose only possible outcome is "not available" is a
      // defect, not a graceful degradation.
      const gcnAction = actionButton(
        "spark",
        i18n.t("gcn.action"),
        "",
        i18n.t("gcn.actionShort"),
      );
      gcnAction.hidden = true;
      gcnAction.addEventListener("click", () => openGcn(opsDeps));
      void gcnAvailable.then((available) => {
        if (!disposed && available) gcnAction.hidden = false;
      });
      const whitelist = actionButton(
        "shield",
        i18n.t("finance.whitelist"),
        "",
        i18n.t("finance.shortWhitelist"),
      );
      whitelist.addEventListener("click", () => openWhitelist(opsDeps, wallet));
      const pinAction = actionButton(
        "lock",
        wallet.payment_settings.has_pin
          ? i18n.t("finance.changePin")
          : i18n.t("finance.setPin"),
        "",
        i18n.t("finance.shortPin"),
      );
      pinAction.addEventListener("click", () => openPin(opsDeps, wallet));
      const historyAction = actionButton(
        "history",
        i18n.t("finance.history"),
        "",
        i18n.t("finance.shortHistory"),
      );
      historyAction.addEventListener("click", () =>
        body
          .querySelector(".gc-finance-history")
          ?.scrollIntoView({ behavior: "smooth" }),
      );

      // The headline below already states the total in HEADLINE_CURRENCY, so an approximation that
      // lands in the SAME currency has nothing left to add: the server returns currency:"USD" both
      // for a USD display currency and for the G-004 rate fallback, and the two amounts are rounded
      // on different paths (sum of per-asset USD vs one converted total). On the device that printed
      // «24.91 USD ≈ 24.92 USD» — one balance shown twice, disagreeing with itself. When the
      // currencies match the amount is dropped and only the freshness note survives, because the
      // note is the one thing the headline cannot say.
      const approxFiat = wallet.approx_fiat;
      const approxNote = approxFiat?.stale ? i18n.t("finance.rateStale") : "";
      const approx = approxFiat
        ? approxFiat.currency === HEADLINE_CURRENCY
          ? approxNote
          : `≈ ${fiatMoney(approxFiat.amount)} ${approxFiat.currency}${approxNote ? ` · ${approxNote}` : ""}`
        : i18n.t("finance.fiatUnavailable");
      // The headline balance is one unbreakable line of data whose length nobody controls, so it is
      // measured and scaled instead of being allowed to break between two digits (fit_width.ts).
      // Two segments, not one string: the amount is unbreakable data, the currency is a word that
      // may move to the next row when the box is too small for both (V102 — at 320 dp with the
      // system font at 2.0 the single-string headline read «6 126 775.24…», i.e. the wallet stopped
      // saying which currency it held). fit_width.ts decides between "one row, scaled" and
      // "wrapped between the segments" from the measurement, not from a breakpoint.
      const totalLine = el("strong", { class: "gc-finance-total" }, [
        el("span", { class: "gc-finance-total-amount" }, [
          money(wallet.total_usd, 2),
        ]),
        " ",
        el("span", { class: "gc-finance-total-cur" }, [HEADLINE_CURRENCY]),
      ]);
      const summary = el("section", { class: "gc-finance-summary" }, [
        el("div", { class: "gc-finance-summary-top" }, [
          el("div", {}, [
            el("span", { class: "gc-finance-eyebrow" }, [
              i18n.t("finance.totalBalance"),
            ]),
            totalLine,
            // An empty approximation is NOT an empty element: a blank line under the balance still
            // takes vertical space and reads as a value that failed to load.
            ...(approx ? [el("span", { class: "gc-finance-approx" }, [approx])] : []),
          ]),
          el(
            "span",
            { class: "gc-finance-summary-mark", "aria-hidden": true },
            [icon("logo")],
          ),
        ]),
        el("div", { class: "gc-finance-actions" }, [
          send,
          receive,
          demoTopUp,
          withdraw,
          exchange,
          gcnAction,
          whitelist,
          pinAction,
          cards,
          historyAction,
        ]),
      ]);

      const assetList = el("div", { class: "gc-finance-list" });
      for (const asset of wallet.assets) {
        const row = el(
          "article",
          { class: `gc-finance-row${asset.enabled ? "" : " is-disabled"}` },
          [
            el("span", { class: assetTone(asset.id), "aria-hidden": true }, [
              asset.id.slice(0, 1),
            ]),
            el("div", { class: "gc-finance-row-main" }, [
              el("strong", {}, [asset.id]),
              el("span", {}, [asset.name]),
            ]),
            el("div", { class: "gc-finance-row-value" }, [
              el("strong", {}, [money(asset.balance)]),
              el("span", {}, [
                asset.usd_value
                  ? `≈ ${money(asset.usd_value, 2)} USD`
                  : i18n.t("finance.noRate"),
              ]),
            ]),
          ],
        );
        assetList.append(row);
      }

      // P0-4: money that already left one wallet and has not reached the other. Measured on the live
      // deployment 2026-07-31: a demo transfer to a stranger parks in an envelope, the sender is
      // debited immediately, and the recipient was told nothing but a websocket event they may never
      // have been online to see. This is the durable place where both sides can act: the recipient
      // claims, the sender takes it back.
      const pendingList = el("div", {
        class: "gc-finance-list gc-finance-pending",
      });
      for (const envelope of inbox.envelopes) {
        const incoming = envelope.role === "recipient";
        const rowStatus = el("span", { class: "gc-finance-pending-error" }, []);
        const action = el(
          "button",
          {
            type: "button",
            class: incoming ? "gc-btn gc-btn-accent" : "gc-btn gc-btn-quiet",
          },
          [incoming ? i18n.t("finance.claim") : i18n.t("finance.takeBack")],
        ) as HTMLButtonElement;
        action.addEventListener("click", () => {
          action.setAttribute("disabled", "true");
          rowStatus.textContent = "";
          const run = incoming
            ? money$.claimEnvelope(envelope.id)
            : money$.refundEnvelope(envelope.id);
          void run
            .then(() => {
              if (disposed) return;
              status.textContent = i18n.t(
                incoming ? "finance.claimed" : "finance.takenBack",
              );
              void load();
            })
            .catch((err) => {
              if (disposed) return;
              rowStatus.textContent = describeError(err, i18n);
              action.removeAttribute("disabled");
            });
        });
        pendingList.append(
          el("article", { class: "gc-finance-row gc-finance-operation" }, [
            el(
              "span",
              {
                class: `gc-operation-icon ${incoming ? "is-positive" : "is-negative"}`,
                "aria-hidden": true,
              },
              [icon(incoming ? "receive" : "send")],
            ),
            el("div", { class: "gc-finance-row-main" }, [
              el("strong", {}, [
                i18n.t(
                  incoming ? "finance.pendingIncoming" : "finance.pendingOutgoing",
                ),
              ]),
              el("span", {}, [
                `${i18n.t("finance.pendingExpires")} · ${timeText(envelope.expires_at)}`,
              ]),
              rowStatus,
            ]),
            el(
              "div",
              {
                class: `gc-finance-row-value ${incoming ? "is-positive" : ""}`.trim(),
              },
              [
                el("strong", {}, [
                  `${money(envelope.remaining)} ${envelope.asset}`,
                ]),
                action,
              ],
            ),
          ]),
        );
      }

      const historyList = el("div", {
        class: "gc-finance-list gc-finance-history",
      });
      if (history.items.length === 0) {
        historyList.append(
          el("p", { class: "gc-finance-list-empty" }, [
            i18n.t("finance.noOperations"),
          ]),
        );
      } else {
        for (const item of history.items) {
          const positive = !item.amount.startsWith("-");
          historyList.append(
            el("article", { class: "gc-finance-row gc-finance-operation" }, [
              el(
                "span",
                {
                  class: `gc-operation-icon ${positive ? "is-positive" : "is-negative"}`,
                  "aria-hidden": true,
                },
                [icon(positive ? "receive" : "send")],
              ),
              el("div", { class: "gc-finance-row-main" }, [
                el("strong", {}, [
                  item.memo || i18n.t(`finance.op.${item.op}`),
                ]),
                el("span", {}, [timeText(item.created_at)]),
              ]),
              el(
                "div",
                {
                  class: `gc-finance-row-value ${positive ? "is-positive" : "is-negative"}`,
                },
                [
                  el("strong", {}, [`${money(item.amount)} ${item.asset}`]),
                  el("span", {}, [
                    item.approx_fiat
                      ? `≈ ${fiatMoney(item.approx_fiat.amount)} ${item.approx_fiat.currency}`
                      : "",
                  ]),
                ],
              ),
            ]),
          );
        }
      }

      body.append(
        summary,
        // Above the asset list on purpose: it is the only block on this screen that asks the user to
        // do something, and it disappears entirely when there is nothing pending.
        ...(inbox.envelopes.length
          ? [
              el("section", { class: "gc-finance-section" }, [
                el("div", { class: "gc-section-heading" }, [
                  el("h2", {}, [i18n.t("finance.pending")]),
                ]),
                pendingList,
              ]),
            ]
          : []),
        el("section", { class: "gc-finance-section" }, [
          el("div", { class: "gc-section-heading" }, [
            el("h2", {}, [i18n.t("finance.assets")]),
          ]),
          assetList,
        ]),
        el("section", { class: "gc-finance-section" }, [
          el("div", { class: "gc-section-heading" }, [
            el("h2", {}, [i18n.t("finance.history")]),
          ]),
          historyList,
        ]),
      );
      status.textContent = "";
      body.setAttribute("aria-busy", "false");
      // Measured only once it is in the document and laid out: an element with no box reports 0 and
      // fitZoom() refuses to scale on that, so the first pass would silently do nothing.
      fitter.track(totalLine);
      fitter.refit();
    } catch (err) {
      if (!disposed && seq === loadSeq)
        unavailable(err, "wallet", "finance.walletUnavailable");
    }
  };

  const renderExchange = async (seq: number): Promise<void> => {
    try {
      if (await contourOff(seq, "exchange", "finance.exchangeUnavailable"))
        return;
      // The wallet is fetched with the market data because the order ticket and the swap need the
      // trader's own assets. It is safe to demand it here: getWallet and getPairs sit behind the very
      // same assertPaymentsReadable gate on the server, so this call cannot fail on its own and turn
      // a working market list into a false "unavailable".
      const [pairResult, tickerResult, wallet] = await Promise.all([
        money$.pairs(),
        money$.tickers(),
        money$.wallet(),
      ]);
      if (disposed || seq !== loadSeq) return;
      clear(body);
      const tickers = new Map(
        tickerResult.tickers.map((ticker) => [ticker.pair, ticker]),
      );
      const live = pairResult.pairs.filter(
        (pair) => pair.enabled && pair.mode === "active",
      ).length;
      const hero = el("section", { class: "gc-market-hero" }, [
        el("div", {}, [
          el("span", { class: "gc-finance-eyebrow" }, [
            i18n.t("finance.marketOverview"),
          ]),
          el("h2", {}, [i18n.t("finance.exchangeTitle")]),
          el("p", {}, [i18n.t("finance.exchangeLead")]),
        ]),
        el("div", { class: "gc-market-health" }, [
          el("strong", {}, [String(live)]),
          el("span", {}, [i18n.t("finance.livePairs")]),
        ]),
      ]);
      // The two account-wide sheets. They are hung off the hero rather than off a pair row because
      // neither one is about a single market: openActivity lists every open order and every fill,
      // openSwap converts assets without touching the order book at all.
      const actions = el("div", {
        class: "gc-finance-actions gc-market-actions",
      });
      const activityAction = actionButton(
        "history",
        i18n.t("finance.openOrders"),
      );
      const swapAction = actionButton("swap", i18n.t("finance.swap"));
      activityAction.addEventListener("click", () => openActivity(opsDeps));
      swapAction.addEventListener("click", () => openSwap(opsDeps, wallet));
      actions.append(activityAction, swapAction);
      hero.append(actions);
      const list = el("div", { class: "gc-market-list" });
      for (const pair of pairResult.pairs) {
        const ticker = tickers.get(pair.id);
        const statusKey =
          pair.mode === "active"
            ? "finance.marketActive"
            : pair.mode === "swap_only"
              ? "finance.marketSwapOnly"
              : "finance.marketHalted";
        // A button, not an <article>: this row is the only way into the pair sheet, so it has to be
        // reachable by keyboard and announced as an action. Halted and swap-only pairs stay clickable
        // on purpose — the sheet still shows real depth, tape and candles, and it is openPair (mirroring
        // the server's assertPairTradable) that disables the order ticket instead of the UI pretending
        // the market does not exist.
        const row = el(
          "button",
          {
            type: "button",
            class: `gc-market-row mode-${pair.mode}`,
            title: `${i18n.t("finance.trade")} · ${pair.id}`,
          },
          [
            el("div", { class: "gc-market-pair" }, [
              el(
                "span",
                { class: assetTone(pair.base_asset), "aria-hidden": true },
                [pair.base_asset.slice(0, 1)],
              ),
              el("div", {}, [
                el("strong", {}, [pair.id]),
                el("span", {}, [i18n.t(statusKey)]),
              ]),
            ]),
            el("div", { class: "gc-market-price" }, [
              el("strong", {}, [ticker?.last ? money(ticker.last) : "—"]),
              el("span", {}, [
                ticker?.vol_quote_24h
                  ? `${i18n.t("finance.volume24h")} ${money(ticker.vol_quote_24h, 2)}`
                  : i18n.t("finance.noTrades"),
              ]),
            ]),
            el("span", { class: `gc-market-state state-${pair.mode}` }, [
              i18n.t(statusKey),
            ]),
          ],
        ) as HTMLButtonElement;
        row.addEventListener("click", () => openPair(opsDeps, pair, wallet));
        list.append(row);
      }
      body.append(
        hero,
        el("section", { class: "gc-finance-section" }, [
          // Was finance.readOnlyNotice ("market data without simulated orders"). That sentence described
          // the screen before the trading sheets were wired in and is now simply false, so it is replaced
          // by the instruction that matches what the row actually does.
          el("div", { class: "gc-section-heading" }, [
            el("h2", {}, [i18n.t("finance.markets")]),
            el("span", {}, [i18n.t("finance.marketsHint")]),
          ]),
          pairResult.pairs.length
            ? list
            : emptyState(
                "trend",
                i18n.t("finance.noMarkets"),
                i18n.t("finance.noMarketsLead"),
              ),
        ]),
      );
      status.textContent = "";
      body.setAttribute("aria-busy", "false");
    } catch (err) {
      if (!disposed && seq === loadSeq)
        unavailable(err, "exchange", "finance.exchangeUnavailable");
    }
  };

  const renderCards = async (seq: number): Promise<void> => {
    try {
      // Asking a server that fail-closed the contour produces a guaranteed 404 and a console error on
      // every visit. The advertised flag answers the same question without the failing round-trip.
      // Same rule as contourOff(): silence is not an answer. `known === false` means the probe never
      // reached the server, so we let the real request run and report its own honest failure.
      const probe = await contours;
      if (!probe.cards && probe.known) {
        if (disposed || seq !== loadSeq) return;
        clear(body);
        body.append(
          emptyState(
            "cards",
            i18n.t("finance.cardsUnavailable"),
            i18n.t("finance.unavailable"),
            { label: i18n.t("common.retry"), onAction: () => void load() },
          ),
        );
        status.textContent = "";
        body.setAttribute("aria-busy", "false");
        return;
      }
      const result = await api.get<{ cards: CardItem[] }>("/v1/cards");
      if (disposed || seq !== loadSeq) return;
      clear(body);
      const intro = el("section", { class: "gc-cards-intro" }, [
        el("div", {}, [
          el("span", { class: "gc-finance-eyebrow" }, [
            i18n.t("finance.cards"),
          ]),
          el("h2", {}, [i18n.t("finance.cardsTitle")]),
          el("p", {}, [i18n.t("finance.cardsLead")]),
        ]),
        el("span", { class: "gc-cards-shield", "aria-hidden": true }, [
          icon("shield"),
        ]),
      ]);
      const grid = el("div", { class: "gc-card-grid" });
      for (const card of result.cards) {
        grid.append(
          el("article", { class: `gc-payment-card state-${card.state}` }, [
            el("div", { class: "gc-payment-card-top" }, [
              el("span", { class: "gc-payment-card-brand" }, [
                icon("logo"),
                "GreenCard",
              ]),
              el(
                "span",
                { class: `gc-payment-card-state state-${card.state}` },
                [i18n.t(`finance.cardState.${card.state}`)],
              ),
            ]),
            el("strong", { class: "gc-payment-card-number" }, [
              `•••• ${card.last4}`,
            ]),
            el("div", { class: "gc-payment-card-bottom" }, [
              el("span", {}, [
                `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}`,
              ]),
              el("strong", {}, [card.network.toUpperCase()]),
            ]),
          ]),
        );
      }
      body.append(
        intro,
        result.cards.length
          ? el("section", { class: "gc-finance-section" }, [
              el("div", { class: "gc-section-heading" }, [
                el("h2", {}, [i18n.t("finance.myCards")]),
              ]),
              grid,
            ])
          : emptyState(
              "cards",
              i18n.t("finance.noCards"),
              i18n.t("finance.cardIssueRequirements"),
            ),
      );
      status.textContent = "";
      body.setAttribute("aria-busy", "false");
    } catch (err) {
      if (!disposed && seq === loadSeq)
        unavailable(err, "cards", "finance.cardsUnavailable");
    }
  };

  const load = async (): Promise<void> => {
    const seq = ++loadSeq;
    body.setAttribute("aria-busy", "true");
    status.textContent = i18n.t("common.loading");
    if (deps.view === "wallet") await renderWallet(seq);
    else if (deps.view === "exchange") await renderExchange(seq);
    else await renderCards(seq);
  };

  refresh.addEventListener("click", () => void load());
  void load();

  // The strip scrolls instead of clipping (styles.css .gc-finance-tabs, V68), but scrolling was left
  // to the finger: landing on a tab that sits past the right edge showed a cut-off word and no hint
  // that the tab you are standing on exists. Observed on the emulator at system font_scale 2.0 on
  // #/cards — the active "Cards" tab was sliced by the screen edge. Bring the active tab into view
  // once it is laid out; `scrollIntoView` is feature-detected because the node-side DOM stub used by
  // the screen tests does not implement it.
  const revealActiveTab = (): void => {
    if (disposed) return;
    const active = tabBar.querySelector(".gc-finance-tab.is-active");
    if (
      active &&
      typeof (active as HTMLElement).scrollIntoView === "function"
    ) {
      (active as HTMLElement).scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
  };
  revealActiveTab();
  // The cards tab is appended asynchronously (server capability), so re-run once that settles.
  void cardsAvailable.then(revealActiveTab).catch(() => {});

  return {
    root,
    destroy() {
      disposed = true;
      loadSeq++;
      fitter.destroy();
      closeOverlay();
    },
  };
}

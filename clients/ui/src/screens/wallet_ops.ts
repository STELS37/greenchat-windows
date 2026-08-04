// clients/ui/src/screens/wallet_ops.ts — the on-chain side of the wallet (T006–T009).
//
// Four sheets live here — deposit, withdraw, whitelist, payment PIN — because they share one shape:
// a sheet over the finance hub, a real server call, and an honest failure. They are deliberately
// DOM-thin: every number, every limit and every waiting period comes from finance_model.ts, which is
// unit-tested without a DOM, so this file only decides what to show and when.
//
// Three measured rules the code below obeys:
//  1. Amounts are canonical nano strings on the wire (PAYMENTS §21). Text a person typed goes through
//     parseHumanAmount/checkWithdrawAmount and leaves as formatNanoWire — never as a float.
//  2. A withdrawal address must already be whitelisted AND 24 hours old, because the server refuses
//     with WHITELIST_REQUIRED otherwise (modules/onchain.ts createWithdrawal). The form therefore
//     offers only whitelist entries and disables the ones still cooling down, instead of letting a
//     person type an address that cannot possibly work.
//  3. A network fee is shown with its state (estimate / upper bound / actual) exactly as the server
//     labelled it. An estimate must never be rendered as a fact.
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { icon } from "../icons.ts";
import { createQrSvg } from "../qr.ts";
import { field, input, money, row, select, sheet, sheetError, statusLine, waitText } from "./finance_sheet.ts";
import {
  checkWithdrawAmount,
  clientOpId,
  depositProgress,
  formatNanoWire,
  humanToNano,
  parseNano,
  whitelistState,
  withdrawalCost,
  type DepositRow,
  type WalletAssetRow,
  type WhitelistRow,
  type WithdrawalRow,
} from "./finance_model.ts";
import type { MoneyApi, WalletResult } from "./money_api.ts";

export interface WalletOpsDeps {
  money: MoneyApi;
  i18n: I18n;
  /** Mount the sheet and remember it, so the hub can close it on destroy (finance_screen owns this). */
  openSheet(panel: HTMLElement): void;
  closeSheet(): void;
  /** Something changed on the server: the hub reloads and reports it on its own status line. */
  onChanged(message: string): void;
  /** Seconds since the epoch. Injected so tests do not depend on the wall clock. */
  now?(): number;
}

const nowSec = (deps: WalletOpsDeps): number => Math.trunc((deps.now ?? (() => Date.now() / 1000))());

// ── T006 deposit ────────────────────────────────────────────────────────────────────────────────

/**
 * Chains a deposit can actually arrive on: what the wallet's assets declare, INTERSECTED with what
 * the server said it can serve (GET /v1/wallet/chains → serviceableChains() in modules/onchain.ts).
 *
 * The intersection is the whole point. An asset's `chain` is a label for where the unit is
 * denominated, not a promise of a rail: measured on the live database 2026-08-04, the only enabled
 * chain-carrying asset was GUSD with `chain='sol'`, and `sol` has no adapter in any configuration —
 * so the unfiltered list offered a SOL network whose address request answers 404 NOT_FOUND every
 * time. Evidence: state/outbox/2026-08-04-wallet-phantom-chain.
 *
 * `serviceable` is optional so an older caller (and the sheets before their reload lands) keeps the
 * previous behaviour instead of silently rendering an empty picker: passing nothing means "the client
 * does not know yet", which is different from "the server serves nothing" (an empty array).
 */
export function depositChains(assets: WalletAssetRow[], serviceable?: readonly string[]): string[] {
  const allowed = serviceable ? new Set(serviceable) : null;
  const seen = new Set<string>();
  for (const asset of assets) {
    if (!asset.enabled) continue;
    if (typeof asset.chain !== "string" || !asset.chain) continue;
    if (allowed && !allowed.has(asset.chain)) continue;
    seen.add(asset.chain);
  }
  return [...seen];
}

/**
 * Repopulate a network picker once the server has said which chains it can serve, and report the
 * result to the caller so a sheet can mute the part of itself that promised an address.
 *
 * Deliberately fire-and-forget with a swallowed failure: the picker already holds the unfiltered
 * label-derived list, and losing this refresh must degrade to the previous behaviour (an address
 * request that fails loudly on its own) rather than to an empty form. The one thing it must never do
 * is leave a network selected that the server has just said it cannot serve.
 */
function refreshChainPicker(
  deps: WalletOpsDeps,
  wallet: WalletResult,
  chainSelect: HTMLSelectElement,
  onResolved: (chains: string[]) => void,
): void {
  const unfiltered = depositChains(wallet.assets);
  void deps.money.walletChains().then(
    (result) => {
      const serviceable = (result?.chains ?? []).map((row) => row.chain);
      const chains = depositChains(wallet.assets, serviceable);
      const previous = chainSelect.value;
      chainSelect.textContent = "";
      for (const chain of chains) chainSelect.append(el("option", { value: chain }, [chain.toUpperCase()]));
      if (chains.includes(previous)) chainSelect.value = previous;
      onResolved(chains);
    },
    // A server too old to answer /v1/wallet/chains, or an offline client: fall back to exactly the
    // behaviour that shipped before this filter existed. Degrading to the previous (noisier) screen is
    // right; degrading to an empty picker would hide rails that do work.
    () => onResolved(unfiltered),
  );
}

export function openDeposit(deps: WalletOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const chains = depositChains(wallet.assets);
  const status = statusLine();
  const addressBox = el("div", { class: "gc-deposit-address" });
  const qrBox = el("div", { class: "gc-deposit-qr" });
  const list = el("div", { class: "gc-finance-list gc-deposit-list" });

  const chainSelect = select();
  for (const chain of chains) chainSelect.append(el("option", { value: chain }, [chain.toUpperCase()]));

  // No copy button, and this is a policy decision rather than a missing feature. The forensic gate
  // `S23-no-unmanaged-clipboard` (scripts/forensic-selftest.mjs:174) forbids every runtime clipboard
  // API across clients/{core,ui,web}/src and clients/mobile/bridge, and the whole client tree really
  // contains no managed clipboard helper to route this through. The reason is the one this product
  // exists for: the system clipboard is world-readable by other installed apps, it survives in
  // clipboard history, and it lands in device backups — a deposit address in it is an unencrypted
  // trace of a payment. So the address is offered two ways the app fully controls: the QR code
  // below, and manual selection of the address text by the operating system's own selection menu,
  // which the user initiates and the app never touches.

  // P0-4 (owner directive 2026-07-30), measured on the signed superapp APK 1000013, 2026-07-31: on a
  // deployment whose real rails are off, /v1/wallet/deposit-address answers with the disabled code
  // and the sheet kept its whole form on screen — the hint «Отправляйте только указанный актив в
  // указанной сети», a network picker showing SOL, the heading «Адрес пополнения» with NOTHING under
  // it, and a paragraph telling the user to scan a QR code that was never drawn. The refusal itself
  // was one faint status line below all of that. A screen that instructs a user how to send money to
  // an address it does not have is worse than a screen that says the feature is off: it invites a
  // real transfer into the void. So the address block is bound to the address actually existing.
  //
  // Only the ADDRESS block is bound, not the whole form: the network picker survives so a user whose
  // one chain failed can switch to another instead of being locked out of the sheet.
  const addressGroup = el("div", { class: "gc-deposit-address-group" }, [
    el("div", { class: "gc-field" }, [
      el("span", { class: "gc-field-label" }, [i18n.t("finance.depositAddress")]),
      addressBox,
    ]),
    qrBox,
    el("p", { class: "gc-field-hint" }, [i18n.t("finance.addressSelectHint")]),
  ]);
  const unavailable = el("p", { class: "gc-finance-list-empty gc-deposit-unavailable" }, []);
  unavailable.hidden = true;
  // The sheet's own subtitle is part of the same promise ("send only this asset on this network"),
  // so it is muted together with the address block. It lives in the shared titlebar, so the node is
  // captured once the panel exists rather than being threaded through sheet()'s signature.
  let subtitle: HTMLElement | null = null;
  const setPromiseVisible = (visible: boolean): void => {
    addressGroup.hidden = !visible;
    if (subtitle) subtitle.hidden = !visible;
  };

  const showAddress = (chain: string): void => {
    status.textContent = i18n.t("common.loading");
    addressBox.textContent = "";
    qrBox.textContent = "";
    unavailable.hidden = true;
    unavailable.textContent = "";
    setPromiseVisible(true);
    void deps.money.depositAddress(chain).then(
      (result) => {
        status.textContent = "";
        setPromiseVisible(true);
        unavailable.hidden = true;
        addressBox.textContent = result.address;
        // The QR encodes the bare address: a chain-specific URI scheme would be a guess, and a wrong
        // scheme is worse than none — wallets fall back to plain-address parsing reliably.
        try {
          qrBox.append(createQrSvg(result.address, i18n.t("finance.qrLabel")));
        } catch {
          qrBox.textContent = "";
        }
      },
      (err) => {
        // Clear the stale address too: leaving the previous chain's address on screen under a new
        // chain's label is how a user sends coins to the wrong network and loses them.
        addressBox.textContent = "";
        qrBox.textContent = "";
        // The reason moves OUT of the faint status line and INTO the space the address occupied, and
        // the address block goes away with the address: no heading without a value, no "scan the QR"
        // without a QR, no "send only this asset on this network" above an empty box.
        setPromiseVisible(false);
        status.textContent = "";
        unavailable.textContent = sheetError(err, i18n);
        unavailable.hidden = false;
      },
    );
  };

  const renderDeposits = (items: DepositRow[]): void => {
    list.textContent = "";
    if (items.length === 0) {
      list.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noDeposits")]));
      return;
    }
    for (const item of items) {
      const progress = depositProgress(item);
      const statusKey = `finance.depositStatus.${item.status}`;
      const statusText = i18n.t(statusKey);
      list.append(row(
        progress.credited ? "check" : "clock",
        [
          el("strong", {}, [`${money(item.amount)} ${item.asset}`]),
          el("span", {}, [`${item.chain.toUpperCase()} · ${statusText === statusKey ? item.status : statusText}`]),
        ],
        [
          el("strong", {}, [progress.credited
            ? i18n.t("finance.depositStatus.credited")
            : i18n.t("finance.confirmations", { seen: progress.confirmations, need: progress.need })]),
          el("span", { class: "gc-progress", role: "progressbar", "aria-valuenow": Math.round(progress.ratio * 100), "aria-valuemin": 0, "aria-valuemax": 100 }, []),
        ],
        `status-${item.status}`,
      ));
    }
  };

  const form = el("div", { class: "gc-finance-form" }, [
    field(i18n.t("finance.network"), chainSelect),
    addressGroup,
  ]);
  const noChains = el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noChains")]);
  // One slot, exactly one occupant, and NEITHER until the server has answered which chains it can
  // really serve. The distinction matters to the tests and to the user for the same reason: a form
  // that is merely `hidden` is still a form in the document — reachable by keyboard focus, by an
  // accessibility tree walk and by anything that counts fields — while the question "does this
  // deployment have a rail?" is still unanswered. So the branch is MOUNTED, not revealed.
  const slot = el("div", { class: "gc-finance-slot" }, []);
  const setChains = (available: string[]): void => {
    slot.textContent = "";
    slot.append(available.length > 0 ? form : noChains);
    if (available.length === 0) {
      setPromiseVisible(false);
      status.textContent = "";
      unavailable.hidden = true;
    }
  };

  const panel = sheet(i18n, i18n.t("finance.receiveTitle"), i18n.t("finance.receiveHint"), [
    slot,
    unavailable,
    status,
    el("div", { class: "gc-section-heading" }, [el("h3", {}, [i18n.t("finance.deposits")])]),
    list,
  ], deps.closeSheet);

  subtitle = panel.querySelector<HTMLElement>(".gc-sheet-subtitle");
  setPromiseVisible(false);
  chainSelect.addEventListener("change", () => showAddress(chainSelect.value || chains[0] || ""));
  deps.openSheet(panel);
  status.textContent = i18n.t("common.loading");
  refreshChainPicker(deps, wallet, chainSelect, (available) => {
    setChains(available);
    // Only now is an address worth asking for: the chain is one the server said it can serve, so a
    // failure here is a real rail problem rather than a network this deployment never had.
    if (available.length) showAddress(available[0] as string);
  });
  void deps.money.deposits().then(
    (result) => renderDeposits(result.items),
    (err) => { list.textContent = ""; list.append(el("p", { class: "gc-finance-list-empty" }, [sheetError(err, i18n)])); },
  );
}

// ── T008 whitelist ──────────────────────────────────────────────────────────────────────────────

export function openWhitelist(deps: WalletOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const list = el("div", { class: "gc-finance-list gc-whitelist-list" });
  const chains = depositChains(wallet.assets);
  const chainSelect = select();
  for (const chain of chains) chainSelect.append(el("option", { value: chain }, [chain.toUpperCase()]));
  const address = input({ type: "text", placeholder: "0x…" });
  const label = input({ type: "text", placeholder: i18n.t("finance.addressLabel") });
  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [icon("plus"), i18n.t("finance.addAddress")]);

  const render = (items: WhitelistRow[]): void => {
    list.textContent = "";
    if (items.length === 0) {
      list.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noWhitelist")]));
      return;
    }
    const now = nowSec(deps);
    for (const item of items) {
      const state = whitelistState(item, now);
      const remove = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("finance.removeAddress"), "aria-label": i18n.t("finance.removeAddress") }, [icon("trash")]);
      remove.addEventListener("click", () => {
        remove.setAttribute("disabled", "true");
        void deps.money.deleteWhitelist(item.id).then(
          () => { status.textContent = i18n.t("finance.whitelistRemoved"); reload(); deps.onChanged(i18n.t("finance.whitelistRemoved")); },
          (err) => { remove.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
        );
      });
      list.append(el("article", { class: `gc-finance-row gc-whitelist-row${state.active ? " is-active" : " is-waiting"}` }, [
        el("span", { class: "gc-operation-icon", "aria-hidden": true }, [icon(state.active ? "shield" : "clock")]),
        el("div", { class: "gc-finance-row-main" }, [
          el("strong", {}, [item.label || item.address]),
          el("span", {}, [`${item.chain.toUpperCase()} · ${item.address}`]),
        ]),
        el("div", { class: "gc-finance-row-value" }, [
          el("span", {}, [state.active ? i18n.t("finance.whitelistActive") : i18n.t("finance.whitelistWaiting", { wait: waitText(state.waitSec, i18n) })]),
          remove,
        ]),
      ]));
    }
  };

  const reload = (): void => {
    void deps.money.whitelist().then(
      (result) => render(result.items),
      (err) => { list.textContent = ""; list.append(el("p", { class: "gc-finance-list-empty" }, [sheetError(err, i18n)])); },
    );
  };

  const form = el("form", { class: "gc-finance-form" }, [
    el("div", { class: "gc-finance-form-row" }, [
      field(i18n.t("finance.network"), chainSelect),
      field(i18n.t("finance.address"), address),
    ]),
    field(i18n.t("finance.addressLabel"), label),
    el("div", { class: "gc-sheet-actions" }, [submit]),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) {
      status.textContent = i18n.t("finance.completeFields");
      return;
    }
    submit.setAttribute("disabled", "true");
    void deps.money.addWhitelist({ chain: chainSelect.value || (chains[0] ?? ""), address: value, label: label.value.trim() || null }).then(
      () => {
        submit.removeAttribute("disabled");
        address.value = "";
        label.value = "";
        status.textContent = i18n.t("finance.whitelistAdded");
        reload();
      },
      (err) => { submit.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
    );
  });

  // V159, same product rule as the deposit sheet 120 lines above, applied to the sheet that ADDS the
  // address: with no network there is nothing to whitelist an address ON.
  //
  // Measured on the shipped production shape (GC_FINANCE_DEMO=0, NODE_ENV=production): /v1/wallet
  // returns 25 assets, 18 of them enabled, and every asset that carries a `chain` — GUSD/sol,
  // BTC/btc, ETH/evm:eth, TON/ton, TRX/tron — is `enabled:false`. So `depositChains()` is empty, and
  // this sheet still rendered three input fields, a network <select> with ZERO options, and a fully
  // enabled «Добавить адрес». Submitting posted `chain: ""`; the server answered 403 PAYMENTS_FROZEN.
  // A form that cannot be completed, above a button that cannot succeed, is the exact defect V99 was
  // written for — it was simply never applied here.
  //
  // The LIST stays: reading the whitelist is `assertPaymentsReadable` and works, and an address added
  // while a rail was live is a fact the owner is entitled to see (and to delete).
  const noRails = el("p", { class: "gc-finance-list-empty gc-whitelist-unavailable" }, [i18n.t("finance.noWhitelistChains")]);
  // Same one-slot rule as the deposit sheet: the form is mounted only once the server has named a
  // chain it can serve, and the reason paragraph only once it has named none. Hiding the form instead
  // would leave three focusable inputs and an enabled «Добавить адрес» in the document.
  const slot = el("div", { class: "gc-finance-slot" }, []);
  const panel = sheet(i18n, i18n.t("finance.whitelist"), i18n.t("finance.whitelistHint"), [
    slot,
    status,
    list,
  ], deps.closeSheet);
  // The subtitle is part of the same promise ("a new address becomes available in 24 hours"), so it
  // is muted together with the form — a countdown to an address that can never be added is worse
  // than silence. The deposit sheet mutes its own subtitle by the same rule.
  const subtitle = panel.querySelector<HTMLElement>(".gc-sheet-subtitle");
  if (subtitle) subtitle.hidden = true;
  refreshChainPicker(deps, wallet, chainSelect, (available) => {
    slot.textContent = "";
    slot.append(available.length > 0 ? form : noRails);
    if (subtitle) subtitle.hidden = available.length === 0;
  });
  deps.openSheet(panel);
  reload();
}

// ── T007 withdrawal ─────────────────────────────────────────────────────────────────────────────

function networkFeeText(item: WithdrawalRow, i18n: I18n): string {
  const cost = withdrawalCost(item);
  if (cost.networkFee === null) return "";
  const stateKey = cost.networkFeeState === "actual"
    ? "finance.networkFeeActual"
    : cost.networkFeeState === "signed_ceiling" || cost.networkFeeState === "estimated_ceiling"
      ? "finance.networkFeeCeiling"
      : "finance.networkFeeEstimated";
  return `${i18n.t("finance.networkFee")}: ${money(formatNanoWire(cost.networkFee))} ${cost.networkFeeAsset ?? ""} · ${i18n.t(stateKey)}`.trim();
}

/**
 * The ONLY status the server still lets the owner cancel. Measured, not assumed:
 * `core/chain.ts cancelWithdrawalInTx` rejects anything but `pending_review` with
 * `STATE_INVALID` 409, and `server/test/unit/chain.test.ts` asserts exactly that. Offering the
 * button on `approved` would promise the owner a cancellation the server always refuses — the
 * withdrawal is already released for signing by then.
 */
const CANCELLABLE = new Set(["pending_review"]);

export function openWithdraw(deps: WalletOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const list = el("div", { class: "gc-finance-list gc-withdraw-list" });
  const assets = wallet.assets.filter((asset) => asset.enabled && asset.chain);
  const assetSelect = select();
  for (const asset of assets) assetSelect.append(el("option", { value: asset.id }, [`${asset.id} · ${money(asset.available)}`]));
  const addressSelect = select();
  const amount = input({ type: "text", inputmode: "decimal", placeholder: "0.00" });
  const pin = input({ type: "password", inputmode: "numeric", placeholder: i18n.t("finance.pinIfRequired") });
  const code = input({ type: "text", inputmode: "numeric", placeholder: i18n.t("finance.twoFactorCode") });
  const preview = el("p", { class: "gc-finance-preview" });
  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [icon("send"), i18n.t("finance.withdraw")]);

  // P0-4 (owner directive 2026-07-30), measured on the signed superapp APK 1000013, 2026-07-31: with
  // an empty whitelist this sheet opened with a full form and a bright green «Вывести» that did
  // nothing on tap. Two separate faults produced that: the button carried no disabled styling at all
  // (fixed once for the whole product in styles.css), and NOTHING on screen said why the action was
  // out of reach — the only clue was the word «Адресов пока нет» inside a collapsed <select>, which
  // a touch user never opens.
  //
  // A disabled control is skipped by screen readers and shows no tooltip on touch, so the reason must
  // live outside it (WCAG 3.3.2) — the same pattern the registration gate already uses. Two distinct
  // reasons are kept apart because the user's next step differs: with no address at all they must add
  // one; with an address still inside the 24-hour window they must simply wait, and telling them to
  // "add an address" would make them add a second one that also cannot be used.
  const gateText = el("span", {});
  const gate = el("p", { class: "gc-auth-gate gc-withdraw-gate", role: "status" }, [icon("info"), gateText]);
  gate.hidden = true;
  // The form is also blocked while the whitelist is still loading: enabling the button first and
  // disabling it a moment later is exactly how a user gets a tap in that never lands.
  let addressReady = false;

  // V159, the third reason — and the one that outranks the other two. `assets` above is the enabled
  // assets that carry a chain, i.e. what this deployment can actually send out. Measured on the
  // shipped production shape: 18 enabled assets, not one with a chain, so the asset <select>
  // rendered ZERO options while the gate told the user to «сначала добавьте адрес». Following that
  // advice costs a 24-hour wait and changes nothing, because the sheet still has nothing to send.
  // Stated before the whitelist round trip so the sheet is honest from its first frame.
  const noAsset = assets.length === 0;
  if (noAsset) {
    submit.setAttribute("disabled", "true");
    gateText.textContent = i18n.t("finance.withdrawNoAsset");
    gate.hidden = false;
  }

  const currentAsset = (): WalletAssetRow | undefined =>
    assets.find((asset) => asset.id === assetSelect.value) ?? assets[0];

  // The fee is shown BEFORE the request, from the same asset fields the server enforces, so nobody
  // discovers the cost only in the history list.
  const updatePreview = (): void => {
    const asset = currentAsset();
    if (!asset) {
      // No sendable asset at all: nothing this preview could compute, and nothing the button could
      // submit (the handler would answer «заполните поля»). Kept disabled rather than merely not
      // enabled, so no later call can leave it live by falling through this branch.
      submit.setAttribute("disabled", "true");
      preview.textContent = "";
      return;
    }
    const check = checkWithdrawAmount(amount.value, asset);
    if (check.problem !== null) {
      const key: Record<string, string> = {
        empty: "finance.amountEmpty", format: "finance.amountFormat", precision: "finance.amountPrecision",
        negative: "finance.amountNegative", positive: "finance.amountNegative", below_min: "finance.amountBelowMin",
        above_max: "finance.amountAboveMax", fee_exceeds: "finance.amountFeeExceeds", insufficient: "finance.insufficientFunds",
      };
      preview.textContent = amount.value.trim() ? i18n.t(key[check.problem] ?? "finance.amountFormat") : "";
      submit.setAttribute("disabled", "true");
      return;
    }
    // A valid amount is not enough: without a usable address the request cannot be sent, and the
    // button must not flicker into life just because the number parses.
    if (!addressReady) submit.setAttribute("disabled", "true");
    else submit.removeAttribute("disabled");
    preview.textContent = `${i18n.t("finance.withdrawFee")}: ${money(formatNanoWire(check.fee))} ${asset.id} · `
      + `${i18n.t("finance.youReceive")}: ${money(formatNanoWire(check.net ?? 0n))} ${asset.id}`;
  };

  const renderWithdrawals = (items: WithdrawalRow[]): void => {
    list.textContent = "";
    if (items.length === 0) {
      list.append(el("p", { class: "gc-finance-list-empty" }, [i18n.t("finance.noWithdrawals")]));
      return;
    }
    for (const item of items) {
      const statusKey = `finance.withdrawStatus.${item.status}`;
      const statusText = i18n.t(statusKey);
      const side: Node[] = [
        el("strong", {}, [statusText === statusKey ? item.status : statusText]),
        el("span", {}, [networkFeeText(item, i18n)]),
      ];
      if (CANCELLABLE.has(item.status)) {
        const cancel = el("button", { type: "button", class: "gc-btn gc-btn-quiet" }, [i18n.t("finance.cancelWithdrawal")]);
        cancel.addEventListener("click", () => {
          cancel.setAttribute("disabled", "true");
          void deps.money.cancelWithdrawal(item.id).then(
            () => { status.textContent = i18n.t("finance.withdrawalCancelled"); reload(); deps.onChanged(i18n.t("finance.withdrawalCancelled")); },
            (err) => { cancel.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
          );
        });
        side.push(cancel);
      }
      list.append(row("send", [
        el("strong", {}, [`${money(item.amount)} ${item.asset}`]),
        el("span", {}, [`${item.chain.toUpperCase()} · ${item.to_address}`]),
      ], side, `status-${item.status}`));
    }
  };

  const reload = (): void => {
    void deps.money.withdrawals().then(
      (result) => renderWithdrawals(result.items),
      (err) => { list.textContent = ""; list.append(el("p", { class: "gc-finance-list-empty" }, [sheetError(err, i18n)])); },
    );
  };

  // Only whitelisted addresses are offered, and the ones still inside the 24-hour window are shown
  // disabled with the remaining time — the server would refuse them with WHITELIST_REQUIRED.
  const loadAddresses = (): void => {
    void deps.money.whitelist().then(
      (result) => {
        addressSelect.textContent = "";
        const now = nowSec(deps);
        addressReady = false;
        let soonest = 0;
        for (const item of result.items) {
          const state = whitelistState(item, now);
          const text = state.active
            ? `${item.label || item.address} · ${item.chain.toUpperCase()}`
            : `${item.label || item.address} · ${i18n.t("finance.whitelistWaiting", { wait: waitText(state.waitSec, i18n) })}`;
          addressSelect.append(el("option", {
            value: `${item.chain}|${item.address}`,
            disabled: !state.active,
          }, [text]));
          if (state.active) addressReady = true;
          else if (soonest === 0 || state.waitSec < soonest) soonest = state.waitSec;
        }
        if (result.items.length === 0) {
          addressSelect.append(el("option", { value: "" }, [i18n.t("finance.noWhitelist")]));
        }
        // One reason at a time, most fundamental first: a usable address cannot unlock a sheet that
        // has nothing to send, so `noAsset` is checked before the whitelist verdict.
        if (noAsset) {
          addressReady = false;
          submit.setAttribute("disabled", "true");
          gateText.textContent = i18n.t("finance.withdrawNoAsset");
          gate.hidden = false;
        } else if (result.items.length === 0) {
          submit.setAttribute("disabled", "true");
          gateText.textContent = i18n.t("finance.withdrawNeedsAddress");
          gate.hidden = false;
        } else if (!addressReady) {
          // Every address exists but is still cooling down: the honest instruction is the remaining
          // time of the one that unlocks first, not "add an address".
          submit.setAttribute("disabled", "true");
          gateText.textContent = i18n.t("finance.withdrawAddressWaiting", { wait: waitText(soonest, i18n) });
          gate.hidden = false;
        } else {
          gate.hidden = true;
          gateText.textContent = "";
        }
        updatePreview();
      },
      (err) => {
        status.textContent = sheetError(err, i18n);
        // The list could not be read, so no address can be trusted as usable.
        addressReady = false;
        submit.setAttribute("disabled", "true");
      },
    );
  };

  const form = el("form", { class: "gc-finance-form" }, [
    el("div", { class: "gc-finance-form-row" }, [
      field(i18n.t("finance.asset"), assetSelect),
      field(i18n.t("finance.amount"), amount),
    ]),
    field(i18n.t("finance.address"), addressSelect),
    el("div", { class: "gc-finance-form-row" }, [
      field(i18n.t("finance.paymentPin"), pin),
      field(i18n.t("finance.twoFactorCode"), code),
    ]),
    preview,
    status,
    gate,
    el("div", { class: "gc-sheet-actions" }, [submit]),
  ]);
  amount.addEventListener("input", updatePreview);
  assetSelect.addEventListener("change", updatePreview);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const asset = currentAsset();
    const target = addressSelect.value;
    if (!asset || !target) {
      status.textContent = i18n.t("finance.completeFields");
      return;
    }
    const check = checkWithdrawAmount(amount.value, asset);
    if (!check.ok || check.nano === null) {
      updatePreview();
      return;
    }
    const [chain = "", toAddress = ""] = target.split("|");
    submit.setAttribute("disabled", "true");
    status.textContent = i18n.t("finance.sending");
    void deps.money.createWithdrawal({
      chain,
      asset: asset.id,
      to_address: toAddress,
      // The wire carries the FULL amount; the server subtracts the fee itself (createWithdrawal).
      amount: formatNanoWire(check.nano),
      client_op_id: clientOpId("wd"),
      pin: pin.value.trim(),
      ...(code.value.trim() ? { code: code.value.trim() } : {}),
    }).then(
      () => {
        submit.removeAttribute("disabled");
        amount.value = "";
        pin.value = "";
        code.value = "";
        preview.textContent = "";
        status.textContent = i18n.t("finance.withdrawalCreated");
        reload();
        deps.onChanged(i18n.t("finance.withdrawalCreated"));
      },
      (err) => { submit.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
    );
  });

  const panel = sheet(i18n, i18n.t("finance.withdrawTitle"), i18n.t("finance.withdrawHint"), [
    // V159: with no sendable asset the form is five dead fields over two empty pickers, and no user
    // action can fill them — `enabled` comes from the deployment's asset table, not from the account.
    // That is the same case as the deposit sheet's `finance.noChains`, so it gets the same answer: a
    // sentence instead of a form. The gate above still covers every case where assets DO exist and
    // only the address is missing, which is what a user can actually fix (V99).
    noAsset
      ? el("p", { class: "gc-finance-list-empty gc-withdraw-unavailable" }, [i18n.t("finance.withdrawNoAsset")])
      : form,
    el("div", { class: "gc-section-heading" }, [el("h3", {}, [i18n.t("finance.withdrawals")])]),
    list,
  ], deps.closeSheet);
  // «Вывод возможен только на адрес из белого списка, активный не менее 24 часов» is a HOW-TO. With
  // no sendable asset it is advice for a road that does not exist, so it goes with the form — the
  // same rule the deposit sheet applies to its own subtitle.
  if (noAsset) {
    const subtitle = panel.querySelector<HTMLElement>(".gc-sheet-subtitle");
    if (subtitle) subtitle.hidden = true;
  }
  deps.openSheet(panel);
  updatePreview();
  loadAddresses();
  reload();
}

// ── T009 payment PIN ────────────────────────────────────────────────────────────────────────────

export function openPin(deps: WalletOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const hasPin = wallet.payment_settings.has_pin;
  const password = input({ type: "password", placeholder: i18n.t("finance.password") });
  const newPin = input({ type: "password", inputmode: "numeric", placeholder: i18n.t("finance.newPin") });
  const code = input({ type: "text", inputmode: "numeric", placeholder: i18n.t("finance.twoFactorCode") });
  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [icon("lock"), i18n.t("common.save")]);

  const children: Node[] = [
    field(i18n.t("finance.password"), password),
    field(i18n.t("finance.newPin"), newPin),
  ];
  // The second-factor field appears only when the account actually has one; the server answers
  // TWO_FACTOR_REQUIRED otherwise, and an always-visible empty box only invites wrong guesses.
  if (wallet.payment_settings.two_factor_enabled) children.push(field(i18n.t("finance.twoFactorCode"), code));

  const form = el("form", { class: "gc-finance-form" }, [
    ...children,
    status,
    el("div", { class: "gc-sheet-actions" }, [submit]),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const pinValue = newPin.value.trim();
    if (!password.value || !pinValue) {
      status.textContent = i18n.t("finance.completeFields");
      return;
    }
    submit.setAttribute("disabled", "true");
    void deps.money.setWalletPin({
      password: password.value,
      pin: pinValue,
      ...(code.value.trim() ? { code: code.value.trim() } : {}),
    }).then(
      () => {
        password.value = "";
        newPin.value = "";
        code.value = "";
        // Changing an existing PIN puts a security hold on withdrawals (wallet.ts applySecurityHold).
        // Saying so here prevents a support ticket five minutes later.
        deps.onChanged(hasPin ? i18n.t("finance.pinChangedHold") : i18n.t("finance.pinSaved"));
        deps.closeSheet();
      },
      (err) => { submit.removeAttribute("disabled"); status.textContent = sheetError(err, i18n); },
    );
  });

  deps.openSheet(sheet(i18n, i18n.t("finance.pinTitle"), i18n.t("finance.pinHint"), [form], deps.closeSheet));
}

// ── B-P0-4 demo top-up ──────────────────────────────────────────────────────────────────────────
//
// Owner directive 2026-07-30: "решить поведение недоступных финансовых функций — полноценная
// активация". Measured on production before this existed: the wallet advertised exactly one asset
// (GUSD), every rail was off (chains unconfigured, on-ramp off, cards off) and users held 0, so
// «Пополнить» could only ever open a deposit sheet with no chain to deposit on, and «Отправить»,
// «Обменять» and the whole exchange had nothing to move. The finance half of the app was therefore
// visible and unusable — the exact state the directive forbids shipping.
//
// The honest activation that does not invent a money rail: demo assets. The server already carries
// `kind='demo'` assets and a faucet; both are now switched on by an explicit deployment flag
// (GC_FINANCE_DEMO=1) and advertised as `features.demo_finance`. This sheet is the user-facing way
// in. It is deliberately blunt about what the money is: the title says test funds, the hint repeats
// it, and no amount of it can ever leave the deployment (demo assets have no chain and withdrawals
// reject them).

/** Assets a demo top-up may credit: the demo-kind ones this wallet already lists. */
export function demoTopUpAssets(assets: WalletAssetRow[]): WalletAssetRow[] {
  return assets.filter((asset) => asset.kind === "demo");
}

export function openDemoTopUp(deps: WalletOpsDeps, wallet: WalletResult): void {
  const { i18n } = deps;
  const status = statusLine();
  const assets = demoTopUpAssets(wallet.assets);
  const assetSelect = select();
  for (const asset of assets) {
    assetSelect.append(el("option", { value: asset.id }, [`${asset.id} · ${asset.name}`]));
  }
  // Seed the selection explicitly instead of relying on the browser picking the first option: the
  // submit handler refuses an empty asset, so an implicit default is the difference between a working
  // form and one that answers "fill in the fields" on an untouched dropdown.
  if (assets[0]) assetSelect.value = assets[0].id;
  const amount = input({ type: "text", inputmode: "decimal", placeholder: "100" });
  amount.value = "100";
  const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent" }, [
    icon("receive"),
    i18n.t("finance.demoTopUpAction"),
  ]);

  // An empty list means the deployment advertises the demo contour but carries no demo asset. Say so
  // instead of rendering a form whose only outcome is a server error.
  const form = el("form", { class: "gc-finance-form" }, [
    ...(assets.length
      ? [field(i18n.t("finance.asset"), assetSelect), field(i18n.t("finance.amount"), amount)]
      : [el("p", { class: "gc-finance-note" }, [i18n.t("finance.demoTopUpNoAssets")])]),
    el("p", { class: "gc-finance-note" }, [i18n.t("finance.demoTopUpNote")]),
    status,
    ...(assets.length ? [el("div", { class: "gc-sheet-actions" }, [submit])] : []),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = amount.value.trim();
    if (!assetSelect.value || !value) {
      status.textContent = i18n.t("finance.completeFields");
      return;
    }
    // Every amount endpoint speaks the ledger's integer units, never the text a person typed:
    // /v1/wallet/faucet runs the same parseAmount as transfers, so "100" on the wire means 100 nano
    // units (1e-7 of a token) and the server answers AMOUNT_TOO_SMALL against the asset's 1000-unit
    // floor — verified against the ephemeral demo deployment on port 39715. Convert through the one
    // human-entry parser the rest of the money screens use.
    const nano = humanToNano(value);
    if (nano === null || nano <= 0n) {
      status.textContent = i18n.t("finance.amountFormat");
      return;
    }
    submit.setAttribute("disabled", "true");
    status.textContent = i18n.t("common.loading");
    void deps.money.faucet({ asset: assetSelect.value, amount: formatNanoWire(nano) }).then(
      (result) => {
        // The server echoes the ledger integer back; show it the way every other balance on the
        // screen is shown, otherwise a 100-token credit reports itself as "100000000000".
        deps.onChanged(`${i18n.t("finance.demoTopUpDone")} ${money(result.amount)} ${result.asset}`);
        deps.closeSheet();
      },
      (err) => {
        submit.removeAttribute("disabled");
        status.textContent = sheetError(err, i18n);
      },
    );
  });

  deps.openSheet(
    sheet(i18n, i18n.t("finance.demoTopUpTitle"), i18n.t("finance.demoTopUpHint"), [form], deps.closeSheet),
  );
}

/** Is there anything on hold right now? Used by the hub to explain a frozen balance. */
export function heldTotal(assets: WalletAssetRow[]): bigint {
  let total = 0n;
  for (const asset of assets) total += parseNano(asset.hold) ?? 0n;
  return total;
}

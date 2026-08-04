// clients/ui/src/screens/finance_sheet.ts — the frame every money sheet shares (T006–T013).
//
// Extracted from wallet_ops.ts when the exchange surface needed the same pieces. A second copy of a
// sheet frame is how one screen ends up with a close button that is not labelled, or an error path
// that shows a raw code — so there is exactly one copy, here, and both surfaces import it.
import type { I18n } from "../i18n.ts";
import { el } from "../dom.ts";
import { icon, type IconName } from "../icons.ts";
import { apiErrorCode, describeError } from "./api.ts";
import { formatNano } from "./finance_model.ts";

/** A WIRE nano string rendered for a person. Never used on already-human decimals (approx_fiat). */
export const money = (raw: string | null | undefined, maxFraction = 6): string =>
  formatNano(raw, { maxFraction });

export function field(label: string, control: Node): HTMLElement {
  return el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [label]), control]);
}

export function input(attrs: Record<string, string>): HTMLInputElement {
  return el("input", { class: "gc-input", autocomplete: "off", ...attrs }) as HTMLInputElement;
}

export function select(): HTMLSelectElement {
  return el("select", { class: "gc-select" }) as HTMLSelectElement;
}

export function statusLine(): HTMLElement {
  return el("p", { class: "gc-sheet-status", role: "status", "aria-live": "polite" });
}

/** The shared sheet frame: handle, titlebar with a labelled close button, then the caller's content. */
export function sheet(
  i18n: I18n,
  title: string,
  hint: string,
  content: Node[],
  onClose: () => void,
): HTMLElement {
  const close = el("button", {
    type: "button",
    class: "gc-icon-btn",
    title: i18n.t("common.cancel"),
    "aria-label": i18n.t("common.cancel"),
  }, [icon("close")]);
  close.addEventListener("click", onClose);
  return el("section", {
    class: "gc-sheet gc-finance-sheet",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": title,
  }, [
    el("div", { class: "gc-sheet-handle", "aria-hidden": true }),
    el("div", { class: "gc-sheet-titlebar" }, [
      // The hint carries a class of its own so a sheet can address it: the deposit sheet mutes its
      // subtitle when the promise it makes ("send only this asset on this network") has no address
      // to attach to. Styling still comes from the `.gc-sheet-titlebar p` rule.
      el("div", {}, [el("h2", {}, [title]), el("p", { class: "gc-sheet-subtitle" }, [hint])]),
      close,
    ]),
    ...content,
  ]);
}

/**
 * A failure inside a sheet. A contour that was never switched on for this account/environment is
 * not an error the person can fix, so it gets the neutral "unavailable" wording; everything else
 * keeps its real code text, because hiding a real reason behind a generic line is how a bug becomes
 * invisible. PAYMENTS_FROZEN and CHAIN_UNAVAILABLE left this bucket once they got their own text:
 * "paused for maintenance, balances are safe" is a different fact from "not enabled here", and a
 * person waiting out a freeze deserves to know it will come back.
 */
export function sheetError(err: unknown, i18n: I18n): string {
  const code = apiErrorCode(err);
  return code === "FEATURE_DISABLED" || code === "PAYMENTS_DISABLED" || code === "NOT_FOUND"
    ? i18n.t("finance.unavailable")
    : describeError(err, i18n);
}

export function row(iconName: IconName, main: Node[], side: Node[], className = ""): HTMLElement {
  return el("article", { class: `gc-finance-row ${className}`.trim() }, [
    el("span", { class: "gc-operation-icon", "aria-hidden": true }, [icon(iconName)]),
    el("div", { class: "gc-finance-row-main" }, main),
    el("div", { class: "gc-finance-row-value" }, side),
  ]);
}

/** A whole-second countdown as "23 ч 41 мин" / "23h 41m" — enough precision for a 24-hour wait. */
export function waitText(seconds: number, i18n: I18n): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return hours > 0
    ? `${hours} ${i18n.t("common.hourShort")} ${minutes} ${i18n.t("common.minuteShort")}`
    : `${Math.max(1, minutes)} ${i18n.t("common.minuteShort")}`;
}

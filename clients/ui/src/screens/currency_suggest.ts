// clients/ui/src/screens/currency_suggest.ts — optional display-currency helper for Wallet/Exchange surfaces.
// It must never run during messenger sign-in, unlock or inbox boot. A financial screen may invoke it only
// after an explicit user action; the proposal uses only the client locale (no IP/network lookup) and writes
// only on an explicit tap. The user's wallet/settings choice remains the source of truth.
import type { I18n } from "../i18n.ts";
import type { ApiLike } from "./api.ts";
import type { Me } from "./types.ts";
import { el } from "../dom.ts";
import { describeError } from "./api.ts";
import { planCurrencySuggestion } from "./currency_model.ts";

// The LOCAL one-time flag ("have we already offered on this device?"). The web shell backs it with
// localStorage; a shell that omits it simply never suggests. Both reads and writes are best-effort.
export interface CurrencySuggestFlagPort {
  wasOffered(): boolean | Promise<boolean>;
  markOffered(): void | Promise<void>;
}

export interface CurrencySuggestDeps {
  api: ApiLike;
  i18n: I18n;
  host: HTMLElement; // the banner mounts here (e.g. document.body), as a sibling to the routed screen
  locale: string; // navigator.language — the ONLY signal (region/language → currency; NO IP — BANKING §4)
  flag: CurrencySuggestFlagPort;
}

// Runs the first-login suggestion at most once. Safe to call on every authed boot (and on a fresh login):
// the flag short-circuits after the first handling, and a set display_currency short-circuits forever after.
// Errors are swallowed — a missing DOM / transient GET must never break the app, and a transient failure
// deliberately does NOT burn the flag so a later boot can retry.
export async function maybeSuggestCurrency(deps: CurrencySuggestDeps): Promise<void> {
  const { api, i18n, host, locale, flag } = deps;

  let offered = false;
  try {
    offered = await flag.wasOffered();
  } catch {
    return; // can't read the flag → don't risk a duplicate prompt
  }
  if (offered) return;

  let me: Me;
  try {
    me = await api.get<Me>("/v1/users/me");
  } catch {
    return; // transient (offline/5xx) → retry on the next boot; keep the one-time flag unburnt
  }

  const plan = planCurrencySuggestion(me.display_currency, locale);
  if (plan.markOffered) {
    try {
      await flag.markOffered();
    } catch {
      /* best-effort */
    }
  }
  if (!plan.offer) return;
  const code = plan.offer;

  // Burn the one-time flag whenever the prompt is resolved (accepted OR dismissed) so it never returns.
  const burn = async (): Promise<void> => {
    try {
      await flag.markOffered();
    } catch {
      /* best-effort */
    }
  };
  const put = (c: string): Promise<null> =>
    api.putMyCurrency ? api.putMyCurrency(c) : api.put<null>("/v1/me/currency", { currency: c });

  // From here on it's best-effort chrome: a host without a DOM (non-browser embed) must never throw out of
  // the void-called promise. Everything the browser needs is inside the try.
  try {
    const status = el("span", { class: "gc-currency-suggest-status", role: "status", "aria-live": "polite" });
    const acceptBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("currency.suggest.accept", { code })]);
    const dismissBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("currency.suggest.dismiss")]);
    const actions = el("div", { class: "gc-currency-suggest-actions" }, [dismissBtn, acceptBtn]);
    const banner = el("div", { class: "gc-currency-suggest", role: "dialog", "aria-label": i18n.t("settings.currency") }, [
      el("span", { class: "gc-currency-suggest-text" }, [i18n.t("currency.suggest.prompt", { code })]),
      actions,
      status,
    ]);

    const close = (): void => {
      try {
        banner.remove();
      } catch {
        /* already detached */
      }
    };
    acceptBtn.addEventListener("click", () => {
      acceptBtn.setAttribute("disabled", "");
      dismissBtn.setAttribute("disabled", "");
      status.textContent = "";
      void put(code)
        .then(async () => {
          await burn();
          close();
        })
        .catch((err: unknown) => {
          // The write failed → keep the banner so the user can retry or dismiss; do NOT burn the flag yet.
          status.textContent = describeError(err, i18n);
          acceptBtn.removeAttribute("disabled");
          dismissBtn.removeAttribute("disabled");
        });
    });
    dismissBtn.addEventListener("click", () => {
      void burn();
      close();
    });

    host.append(banner);
  } catch {
    /* no DOM host — the suggestion is best-effort chrome, never critical */
  }
}

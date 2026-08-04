// clients/ui/src/screens/deep_link_screen.ts — honest handlers for the three canonical action links.
//
// Before V169 the router recognised user / invite / invoice links, but app.ts had no screen for any
// of them. The shell therefore rendered Home under an address that promised a profile, a group join or
// a payment. This screen keeps every link explicit: reads may start automatically, while mutations
// (open/create a dialog, join a chat, pay an invoice) require a visible button press.
import type { I18n, Locale } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike, DialogChat, ResolvedUser } from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";
import { formatNano } from "./finance_model.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { failureState, skeletonList, stateView } from "./state_view.ts";

export type DeepLinkKind = "user" | "join" | "pay";

type TextKey =
  | "userTitle" | "userLoading" | "userOpen" | "userDeleted"
  | "publicTitle" | "publicLoading" | "publicLead" | "publicOpenApp" | "publicContinue"
  | "joinTitle" | "joinLead" | "joinAction" | "joinBusy" | "joinPending" | "joinPendingBody"
  | "invoiceTitle" | "invoiceLoading" | "invoicePay" | "invoiceBusy" | "invoicePaid"
  | "invoiceDescription" | "invoiceStatus" | "invoiceExpires" | "invoicePin" | "invoicePinHint"
  | "statusOpen" | "statusPaid" | "statusExpired" | "statusCancelled" | "statusUnknown";

const TEXT: Record<Locale, Record<TextKey, string>> = {
  ru: {
    userTitle: "Профиль",
    userLoading: "Загружаем профиль…",
    userOpen: "Открыть диалог",
    userDeleted: "Этот аккаунт удалён",
    publicTitle: "Профиль GreenChat",
    publicLoading: "Загружаем публичный профиль…",
    publicLead: "Откройте профиль в приложении или войдите в веб-версию, чтобы написать.",
    publicOpenApp: "Открыть в GreenChat",
    publicContinue: "Войти и написать",
    joinTitle: "Приглашение",
    joinLead: "Вступление изменит состав участников. GreenChat никогда не делает это автоматически по ссылке.",
    joinAction: "Вступить",
    joinBusy: "Вступаем…",
    joinPending: "Заявка отправлена",
    joinPendingBody: "Администраторы рассмотрят запрос на вступление.",
    invoiceTitle: "Счёт",
    invoiceLoading: "Загружаем счёт…",
    invoicePay: "Оплатить",
    invoiceBusy: "Оплачиваем…",
    invoicePaid: "Счёт оплачен",
    invoiceDescription: "Назначение",
    invoiceStatus: "Статус",
    invoiceExpires: "Действителен до",
    invoicePin: "Платёжный PIN",
    invoicePinHint: "Введите PIN, если GreenChat запросил его для этой суммы.",
    statusOpen: "Открыт",
    statusPaid: "Оплачен",
    statusExpired: "Истёк",
    statusCancelled: "Отменён",
    statusUnknown: "Недоступен",
  },
  en: {
    userTitle: "Profile",
    userLoading: "Loading profile…",
    userOpen: "Open chat",
    userDeleted: "This account was deleted",
    publicTitle: "GreenChat profile",
    publicLoading: "Loading public profile…",
    publicLead: "Open this profile in the app or sign in on the web to send a message.",
    publicOpenApp: "Open in GreenChat",
    publicContinue: "Sign in and message",
    joinTitle: "Invitation",
    joinLead: "Joining changes the member list. GreenChat never does that automatically from a link.",
    joinAction: "Join",
    joinBusy: "Joining…",
    joinPending: "Request sent",
    joinPendingBody: "Administrators will review your request to join.",
    invoiceTitle: "Invoice",
    invoiceLoading: "Loading invoice…",
    invoicePay: "Pay",
    invoiceBusy: "Paying…",
    invoicePaid: "Invoice paid",
    invoiceDescription: "Description",
    invoiceStatus: "Status",
    invoiceExpires: "Valid until",
    invoicePin: "Payment PIN",
    invoicePinHint: "Enter the PIN if GreenChat requests it for this amount.",
    statusOpen: "Open",
    statusPaid: "Paid",
    statusExpired: "Expired",
    statusCancelled: "Cancelled",
    statusUnknown: "Unavailable",
  },
};

interface Invoice {
  id: number;
  code: string;
  asset: string;
  amount: string;
  description: string;
  status: string;
  expires_at: number;
}

interface InvoiceResult { invoice: Invoice; }
interface JoinResult { id?: number; chat_id?: number; pending?: boolean; }

export interface DeepLinkScreenDeps {
  api: ApiLike;
  i18n: I18n;
  kind: DeepLinkKind;
  value: string;
  onBack(): void;
  onOpenChat(chatId: number): void;
  makeClientRef?: () => string;
  now?: () => number;
}

function statusText(locale: Locale, status: string): string {
  const key: TextKey = status === "open"
    ? "statusOpen"
    : status === "paid"
      ? "statusPaid"
      : status === "expired"
        ? "statusExpired"
        : status === "cancelled"
          ? "statusCancelled"
          : "statusUnknown";
  return TEXT[locale][key];
}

function defaultClientRef(): string {
  const random = globalThis.crypto?.randomUUID?.().replace(/-/g, "").slice(0, 18)
    ?? Math.random().toString(36).slice(2, 20);
  return `invoice-${Date.now().toString(36)}-${random}`.slice(0, 64);
}

export interface PublicUserProfile {
  username: string;
  name: string;
  bio: string;
  is_bot: boolean;
  emoji_status: string | null;
  is_system?: true;
}

export interface PublicUserLinkScreenDeps {
  api: ApiLike;
  i18n: I18n;
  value: string;
  onBack(): void;
  onContinueWeb(): void;
}

/** Native target behind the public landing page's explicit “Open in GreenChat” action. */
export function publicUserAppHref(raw: string): string {
  const username = raw.trim().replace(/^@+/, "");
  return `greenchat://user/${encodeURIComponent(username)}`;
}

/**
 * Anonymous profile landing for a copied @username link.
 *
 * Telegram-style links are useful before login: they show who the link points to and offer a native
 * app action. Authentication is requested only when the visitor explicitly chooses the web action;
 * merely opening the URL performs no account mutation and never discards the destination.
 */
export function createPublicUserLinkScreen(
  deps: PublicUserLinkScreenDeps,
): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const value = deps.value.trim().replace(/^@+/, "");
  let disposed = false;
  let epoch = 0;
  let profile: PublicUserProfile | null = null;
  let loadError: unknown = null;

  const t = (key: TextKey): string => TEXT[i18n.locale][key];
  // Reuse the signed-out surface rather than mounting authenticated shell chrome around a public link.
  // This keeps the landing compact, centred and immediately recognisable on phones and desktop.
  const root = el("div", { class: "gc-auth gc-public-user-link" });
  const status = el("p", { class: "gc-auth-security", role: "status", "aria-live": "polite" });

  status.hidden = true;
  const body = el("div", { class: "gc-auth-form" });
  const back = el("button", { type: "button", class: "gc-link" }, [i18n.t("common.back")]);
  back.addEventListener("click", deps.onBack);
  const brand = el("div", { class: "gc-auth-brand" }, [
    el("span", { class: "gc-auth-brand-mark", "aria-hidden": true }, [icon("logo")]),
    el("span", { class: "gc-auth-brand-word" }, [i18n.t("common.appName")]),
  ]);
  const heading = el("h1", { class: "gc-auth-title" }, [t("publicTitle")]);
  const intro = el("div", { class: "gc-auth-intro" }, [heading]);
  root.append(
    el("div", { class: "gc-auth-atmosphere", "aria-hidden": true }),
    el("div", { class: "gc-auth-card" }, [brand, intro, status, body, back]),
  );

  const render = (): void => {
    if (disposed) return;
    clear(body);
    status.textContent = "";

    status.hidden = true;
    if (loadError) {
      heading.textContent = t("publicTitle");
      body.append(failureState(loadError, i18n, () => { void load(); }));
      return;
    }
    if (!profile) {
      heading.textContent = t("publicTitle");
      status.textContent = t("publicLoading");

      status.hidden = false;
      body.append(skeletonList(3, { avatar: true }));
      return;
    }

    const name = profile.name.trim() || `@${profile.username}`;
    heading.textContent = name;
    const openApp = el("a", {
      class: "gc-btn gc-btn-accent",
      href: publicUserAppHref(profile.username),
      "aria-label": t("publicOpenApp"),
    }, [icon("logo"), t("publicOpenApp")]);
    const continueWeb = el("button", { type: "button", class: "gc-btn gc-btn-quiet" }, [
      t("publicContinue"),
    ]);
    continueWeb.addEventListener("click", deps.onContinueWeb);

    body.append(
      el("div", { class: "gc-auth-intro" }, [
        el("span", { class: "gc-avatar", "data-tone": String(avatarTone(name)), "aria-hidden": true }, [initials(name)]),
        el("p", { class: "gc-auth-tagline" }, [`@${profile.username}`]),
      ]),
      ...(profile.bio.trim() ? [el("p", { class: "gc-auth-tagline" }, [profile.bio.trim()])] : []),
      el("p", { class: "gc-auth-security" }, [icon("shield"), el("span", {}, [t("publicLead")])]),
      openApp,
      continueWeb,
    );
  };

  const load = async (): Promise<void> => {
    const run = ++epoch;
    loadError = null;
    profile = null;
    render();
    try {
      const next = await api.get<PublicUserProfile>(`/v1/public/users/${encodeURIComponent(value)}`);
      if (disposed || run !== epoch) return;
      profile = next;
    } catch (error) {
      if (disposed || run !== epoch) return;
      loadError = error;
    }
    render();
  };

  const relocalise = i18n.subscribe(() => {
    back.textContent = i18n.t("common.back");
    render();
  });
  void load();

  return {
    root,
    destroy() {
      disposed = true;
      epoch += 1;
      relocalise();
    },
  };
}

export function createDeepLinkScreen(deps: DeepLinkScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const value = deps.value.trim();
  let disposed = false;
  let epoch = 0;
  let busy = false;
  let loadError: unknown = null;
  let actionError: unknown = null;
  let user: Exclude<ResolvedUser, { deleted: true }> | null = null;
  let userDeleted = false;
  let invoice: Invoice | null = null;
  let joinedPending = false;
  let paid = false;
  let pinNeeded = false;
  let pinValue = "";

  const t = (key: TextKey): string => TEXT[i18n.locale][key];
  const nowSec = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const root = el("div", { class: "gc-server gc-deep-link" });
  const status = el("p", { class: "gc-server-status", role: "status", "aria-live": "polite" });
  const card = el("div", { class: "gc-server-card" });
  const back = el("button", {
    type: "button",
    class: "gc-icon-btn",
    title: i18n.t("common.back"),
    "aria-label": i18n.t("common.back"),
  }, [icon("back")]);
  back.addEventListener("click", deps.onBack);

  const title = (): string => deps.kind === "user" ? t("userTitle") : deps.kind === "join" ? t("joinTitle") : t("invoiceTitle");
  const header = el("header", { class: "gc-server-header" }, [back, el("h1", { class: "gc-server-title" }, [title()])]);
  root.append(header, status, card);

  const retry = (): void => {
    if (deps.kind === "join") void join();
    else void load();
  };

  const renderUser = (): void => {
    if (userDeleted) {
      card.append(stateView({ tone: "empty", icon: "user", title: t("userDeleted") }));
      return;
    }
    if (!user) return;
    const name = user.name.trim() || `@${user.username}`;
    const open = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy }, [
      busy ? i18n.t("auth.submitting") : t("userOpen"),
    ]);
    open.addEventListener("click", () => void openDialog());
    card.append(
      el("div", { class: "gc-setting-list" }, [
        el("div", { class: "gc-setting-row" }, [
          el("span", { class: "gc-avatar", "data-tone": String(avatarTone(name)), "aria-hidden": true }, [initials(name)]),
          el("span", { class: "gc-setting-label" }, [
            el("strong", {}, [name]),
            el("span", { class: "gc-settings-note" }, [`@${user.username}`]),
          ]),
        ]),
      ]),
      ...(actionError ? [el("p", { class: "gc-field-err", role: "alert" }, [describeError(actionError, i18n)])] : []),
      el("div", { class: "gc-server-actions" }, [open]),
    );
  };

  const renderJoin = (): void => {
    if (joinedPending) {
      card.append(stateView({ tone: "empty", icon: "clock", title: t("joinPending"), body: t("joinPendingBody") }));
      return;
    }
    const joinButton = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy }, [
      busy ? t("joinBusy") : t("joinAction"),
    ]);
    joinButton.addEventListener("click", () => void join());
    card.append(
      el("p", { class: "gc-settings-note" }, [t("joinLead")]),
      el("p", {}, [value]),
      ...(actionError ? [el("p", { class: "gc-field-err", role: "alert" }, [describeError(actionError, i18n)])] : []),
      el("div", { class: "gc-server-actions" }, [joinButton]),
    );
  };

  const invoiceStatus = (): string => {
    if (!invoice) return "unknown";
    return invoice.status === "open" && invoice.expires_at > 0 && invoice.expires_at <= nowSec()
      ? "expired"
      : invoice.status;
  };

  const renderInvoice = (): void => {
    if (paid || invoice?.status === "paid") {
      card.append(stateView({ tone: "empty", icon: "check", title: t("invoicePaid") }));
      return;
    }
    if (!invoice) return;
    const effectiveStatus = invoiceStatus();
    const open = effectiveStatus === "open";
    const amount = `${formatNano(invoice.amount, { maxFraction: 9 })} ${invoice.asset}`;
    const pin = el("input", {
      type: "password",
      class: "gc-input",
      inputmode: "numeric",
      autocomplete: "current-password",
      value: pinValue,
      "aria-label": t("invoicePin"),
    }) as HTMLInputElement;
    pin.value = pinValue;
    pin.addEventListener("input", () => { pinValue = pin.value; });
    const pay = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy || !open }, [
      busy ? t("invoiceBusy") : t("invoicePay"),
    ]);
    pay.addEventListener("click", () => void payInvoice());
    const rows = [
      el("div", { class: "gc-setting-row" }, [el("span", { class: "gc-setting-label" }, [amount])]),
      el("div", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [t("invoiceStatus")]),
        el("span", {}, [statusText(i18n.locale, effectiveStatus)]),
      ]),
    ];
    if (invoice.description) rows.push(el("div", { class: "gc-setting-row" }, [
      el("span", { class: "gc-setting-label" }, [t("invoiceDescription")]),
      el("span", {}, [invoice.description]),
    ]));
    if (Number.isFinite(invoice.expires_at) && invoice.expires_at > 0) rows.push(el("div", { class: "gc-setting-row" }, [
      el("span", { class: "gc-setting-label" }, [t("invoiceExpires")]),
      el("span", {}, [i18n.formatDate(invoice.expires_at * 1000, { dateStyle: "medium", timeStyle: "short" })]),
    ]));
    card.append(
      el("div", { class: "gc-setting-list" }, rows),
      ...(pinNeeded ? [el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [t("invoicePin")]),
        pin,
        el("span", { class: "gc-field-hint" }, [t("invoicePinHint")]),
      ])] : []),
      ...(actionError ? [el("p", { class: "gc-field-err", role: "alert" }, [describeError(actionError, i18n)])] : []),
      el("div", { class: "gc-server-actions" }, [pay]),
    );
  };

  const render = (): void => {
    if (disposed) return;
    clear(card);
    status.textContent = "";
    if (loadError) {
      card.append(failureState(loadError, i18n, retry));
      return;
    }
    if ((deps.kind === "user" && !user && !userDeleted) || (deps.kind === "pay" && !invoice)) {
      status.textContent = deps.kind === "user" ? t("userLoading") : t("invoiceLoading");
      card.append(skeletonList(3, { avatar: deps.kind === "user" }));
      return;
    }
    if (deps.kind === "user") renderUser();
    else if (deps.kind === "join") renderJoin();
    else renderInvoice();
  };

  const load = async (): Promise<void> => {
    const run = ++epoch;
    loadError = null;
    actionError = null;
    render();
    try {
      if (deps.kind === "user") {
        const resolved = api.resolveUser
          ? await api.resolveUser(value.replace(/^@+/, ""))
          : await api.get<ResolvedUser>(`/v1/users/resolve?username=${encodeURIComponent(value.replace(/^@+/, ""))}`);
        if (disposed || run !== epoch) return;
        if ("deleted" in resolved && resolved.deleted) userDeleted = true;
        else user = resolved;
      } else if (deps.kind === "pay") {
        const result = await api.get<InvoiceResult>(`/v1/invoices/${encodeURIComponent(value)}`);
        if (disposed || run !== epoch) return;
        invoice = result.invoice;
      }
    } catch (error) {
      if (disposed || run !== epoch) return;
      loadError = error;
    }
    render();
  };

  const openDialog = async (): Promise<void> => {
    if (!user || busy) return;
    busy = true;
    actionError = null;
    render();
    try {
      const dialog = api.createDialog
        ? await api.createDialog(user.id)
        : await api.post<DialogChat>("/v1/chats/dialog", { user_id: user.id });
      if (!disposed) deps.onOpenChat(dialog.id);
    } catch (error) {
      if (!disposed) { actionError = error; busy = false; render(); }
    }
  };

  const join = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    actionError = null;
    render();
    try {
      const result = await api.post<JoinResult>(`/v1/join/${encodeURIComponent(value)}`, {});
      if (disposed) return;
      const chatId = Number(result.id ?? result.chat_id);
      if (result.pending === true) {
        joinedPending = true;
        busy = false;
        render();
      } else if (Number.isSafeInteger(chatId) && chatId > 0) {
        deps.onOpenChat(chatId);
      } else {
        throw new Error("join response missing chat id");
      }
    } catch (error) {
      if (!disposed) { actionError = error; busy = false; render(); }
    }
  };

  const payInvoice = async (): Promise<void> => {
    if (!invoice || invoiceStatus() !== "open" || busy) return;
    busy = true;
    actionError = null;
    render();
    const body: Record<string, string> = {
      amount: invoice.amount,
      client_op_id: (deps.makeClientRef ?? defaultClientRef)(),
    };
    if (pinValue.trim()) body.pin = pinValue.trim();
    try {
      const result = await api.post<InvoiceResult>(`/v1/invoices/${encodeURIComponent(value)}/pay`, body);
      if (disposed) return;
      invoice = result.invoice;
      paid = true;
      busy = false;
      pinValue = "";
      render();
    } catch (error) {
      if (disposed) return;
      if (apiErrorCode(error) === "PIN_REQUIRED") pinNeeded = true;
      actionError = error;
      busy = false;
      render();
    }
  };

  const relocalise = i18n.subscribe(() => {
    const heading = root.querySelector(".gc-server-title");
    if (heading) heading.textContent = title();
    render();
  });
  if (deps.kind === "join") render(); else void load();

  return {
    root,
    destroy() {
      disposed = true;
      epoch += 1;
      pinValue = "";
      relocalise();
    },
  };
}

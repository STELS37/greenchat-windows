// clients/ui/src/screens/telegram_settings.ts — Telegram multi-account connection/auth settings (T-453A/T-453B).
// DOM only; the shell injects the provider-neutral lifecycle port structurally.

import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import { createQrSvg } from "../qr.ts";

export type TelegramLoginView =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "suspended" }
  | { status: "awaiting_qr"; qrPayload: string; expiresAt: string }
  | { status: "awaiting_phone" }
  | { status: "awaiting_code"; destinationHint?: string }
  | { status: "awaiting_password"; passwordHint?: string }
  | { status: "ready"; account: { provider: string; accountId: string } }
  | { status: "revoked"; reason?: string }
  | { status: "error"; code: string; retryable: boolean; message: string };

export type TelegramAccountSyncView =
  | "active"
  | "background"
  | "connecting"
  | "paused"
  | "disconnected"
  | "error";

export interface TelegramAccountView {
  /** Random internal selector. It stays in closures and is never rendered into text or DOM attributes. */
  slot: string;
  accountId?: string;
  login: TelegramLoginView;
  syncState: TelegramAccountSyncView;
  unreadCount: number;
  lastEventAt?: string;
}

export interface TelegramConnectionView {
  available: boolean;
  configured: boolean;
  busy: boolean;
  login: TelegramLoginView;
  activeSlot: string | null;
  accounts: readonly TelegramAccountView[];
  canAddAccount: boolean;
  totalUnreadCount: number;
  backgroundReadyCount: number;
  reason?: "not_configured" | "runtime_unavailable" | "vault_unavailable" | "connection_failed";
  runtimeVersion?: string;
}

export interface TelegramConnectionPort {
  snapshot(): TelegramConnectionView;
  subscribe(listener: (snapshot: TelegramConnectionView) => void): () => void;
  initialize(): Promise<void>;
  addAccount(): Promise<string | void>;
  selectAccount(slot: string): Promise<void>;
  connectQr(): Promise<void>;
  connectPhone(phone: string): Promise<void>;
  submitCode(code: string): Promise<void>;
  submitPassword(password: string): Promise<void>;
  disconnect(): Promise<void>;
  remove(): Promise<void>;
}

export interface TelegramSettingsView {
  root: HTMLElement;
  destroy(): void;
}

export interface TelegramSettingsDeps {
  port: TelegramConnectionPort;
  i18n: I18n;
  status: HTMLElement;
}

type Confirmation = "disconnect" | "remove" | null;

function maskedAccount(id: string): string {
  return id.length <= 6 ? id : `••••${id.slice(-6)}`;
}

function validQrLink(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length <= 2_048 && /^tg:\/\/login\?token=[A-Za-z0-9_-]+$/u.test(trimmed) ? trimmed : null;
}

export function createTelegramSettings(deps: TelegramSettingsDeps): TelegramSettingsView {
  const { port, i18n, status } = deps;
  const root = el("div", { class: "gc-connector-settings" });
  let current = port.snapshot();
  let disposed = false;
  let actionSeq = 0;
  let actionBusy = false;
  let confirmation: Confirmation = null;
  const sensitiveInputs = new Set<HTMLInputElement>();

  const scrubSensitiveInputs = (): void => {
    for (const input of sensitiveInputs) input.value = "";
    sensitiveInputs.clear();
  };

  const setStatus = (key: string): void => { status.textContent = i18n.t(key); };
  const controlsBusy = (): boolean => current.busy || actionBusy;

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (actionBusy || disposed) return;
    const seq = ++actionSeq;
    actionBusy = true;
    status.textContent = "";
    render();
    try {
      await action();
      if (!disposed && seq === actionSeq) {
        confirmation = null;
        status.textContent = "";
      }
    } catch {
      if (!disposed && seq === actionSeq) setStatus("telegram.actionFailed");
    } finally {
      if (!disposed && seq === actionSeq) {
        actionBusy = false;
        render();
      }
    }
  };

  const phoneForm = (): HTMLElement => {
    const input = el("input", {
      type: "tel",
      class: "gc-input",
      inputmode: "tel",
      autocomplete: "tel",
      placeholder: "+491234567890",
      disabled: controlsBusy(),
      "aria-label": i18n.t("telegram.phone"),
    }) as HTMLInputElement;
    const submit = (): void => {
      if (controlsBusy()) return;
      const phone = input.value.trim();
      if (!/^\+[1-9][0-9]{5,19}$/u.test(phone)) {
        setStatus("telegram.phoneInvalid");
        return;
      }
      void run(() => port.connectPhone(phone));
    };
    const button = el("button", {
      type: "button",
      class: "gc-btn",
      disabled: controlsBusy(),
    }, [i18n.t("telegram.continue")]);
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    return el("div", { class: "gc-connector-form" }, [
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t("telegram.phone")]),
        input,
      ]),
      button,
    ]);
  };

  const credentialForm = (
    kind: "code" | "password",
    hint?: string,
  ): HTMLElement => {
    const input = el("input", {
      type: kind === "password" ? "password" : "text",
      class: "gc-input",
      inputmode: kind === "code" ? "numeric" : undefined,
      autocomplete: kind === "password" ? "current-password" : "one-time-code",
      maxlength: kind === "password" ? 1024 : 32,
      disabled: controlsBusy(),
      "aria-label": i18n.t(kind === "password" ? "telegram.password" : "telegram.code"),
    }) as HTMLInputElement;
    sensitiveInputs.add(input);
    const submit = (): void => {
      if (controlsBusy()) return;
      const value = input.value;
      if (!value) { setStatus("telegram.required"); return; }
      // One-time codes and 2FA secrets leave the live DOM before any asynchronous provider operation starts,
      // including the rejection path. The closure is short-lived and never copied into component state.
      input.value = "";
      void run(() => kind === "password" ? port.submitPassword(value) : port.submitCode(value.trim()));
    };
    const button = el("button", {
      type: "button",
      class: "gc-btn gc-btn-accent",
      disabled: controlsBusy(),
    }, [i18n.t("telegram.continue")]);
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") submit(); });
    return el("div", { class: "gc-connector-form" }, [
      el("label", { class: "gc-field" }, [
        el("span", { class: "gc-field-label" }, [i18n.t(kind === "password" ? "telegram.password" : "telegram.code")]),
        ...(hint ? [el("span", { class: "gc-settings-note" }, [hint])] : []),
        input,
      ]),
      button,
    ]);
  };

  const confirmationView = (kind: Exclude<Confirmation, null>): HTMLElement => {
    const warningId = `gc-telegram-${kind}-warning`;
    const confirm = el("button", {
      type: "button",
      class: "gc-btn gc-btn-danger",
      disabled: controlsBusy(),
      "aria-describedby": warningId,
    }, [i18n.t(kind === "disconnect" ? "telegram.disconnectConfirm" : "telegram.removeConfirm")]);
    confirm.addEventListener("click", () => {
      void run(kind === "disconnect" ? () => port.disconnect() : () => port.remove());
    });
    const cancel = el("button", {
      type: "button",
      class: "gc-btn",
      disabled: controlsBusy(),
    }, [i18n.t("common.cancel")]);
    cancel.addEventListener("click", () => {
      if (controlsBusy()) return;
      confirmation = null;
      render();
    });
    return el("div", { class: "gc-connector-confirmation" }, [
      el("p", {
        id: warningId,
        class: "gc-connector-warning",
        role: "alert",
      }, [i18n.t(kind === "disconnect" ? "telegram.disconnectWarning" : "telegram.removeWarning")]),
      el("div", { class: "gc-connector-actions" }, [confirm, cancel]),
    ]);
  };

  const destructiveActions = (connected: boolean): HTMLElement[] => {
    if (confirmation) return [confirmationView(confirmation)];
    const actions: HTMLElement[] = [];
    if (connected) {
      const disconnect = el("button", {
        type: "button",
        class: "gc-btn",
        disabled: controlsBusy(),
      }, [i18n.t("telegram.disconnect")]);
      disconnect.addEventListener("click", () => {
        if (controlsBusy()) return;
        confirmation = "disconnect";
        render();
      });
      actions.push(disconnect);
    }
    const remove = el("button", {
      type: "button",
      class: "gc-btn gc-btn-danger",
      disabled: controlsBusy(),
    }, [i18n.t("telegram.removeData")]);
    remove.addEventListener("click", () => {
      if (controlsBusy()) return;
      confirmation = "remove";
      render();
    });
    actions.push(remove);
    return [el("div", { class: "gc-connector-actions" }, actions)];
  };

  const syncLabel = (state: TelegramAccountSyncView): string => i18n.t(`telegram.sync.${state}`);
  const safeUnread = (value: number): number => Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 2_147_483_647)
    : 0;
  const unreadLabel = (value: number): string => i18n.t("telegram.unread", {
    count: value > 999 ? "999+" : String(value),
  });

  const accountSwitcher = (): HTMLElement => {
    const accounts = current.accounts;
    const buttons = accounts.map((account, index) => {
      const active = account.slot === current.activeSlot;
      const label = i18n.t("telegram.accountNumber", { number: index + 1 });
      const masked = account.accountId ? maskedAccount(account.accountId) : null;
      const state = syncLabel(account.syncState);
      const unread = safeUnread(account.unreadCount);
      const aria = [label, masked, state, unread > 0 ? unreadLabel(unread) : null]
        .filter((part): part is string => Boolean(part))
        .join(", ");
      const button = el("button", {
        type: "button",
        class: `gc-connector-account${active ? " is-active" : ""}`,
        disabled: controlsBusy(),
        "aria-pressed": String(active),
        "aria-label": aria,
      }, [
        el("span", { class: "gc-connector-account-main" }, [
          el("span", { class: "gc-connector-account-label" }, [label]),
          ...(masked ? [el("span", { class: "gc-connector-account-id" }, [masked])] : []),
        ]),
        el("span", { class: "gc-connector-account-meta" }, [
          el("span", { class: `gc-connector-sync is-${account.syncState}` }, [state]),
          ...(unread > 0
            ? [el("span", { class: "gc-connector-unread", "aria-hidden": true }, [unread > 999 ? "999+" : String(unread)])]
            : []),
        ]),
      ]);
      button.addEventListener("click", () => {
        if (controlsBusy() || active) return;
        confirmation = null;
        void run(() => port.selectAccount(account.slot));
      });
      return button;
    });
    const add = el("button", {
      type: "button",
      class: `gc-btn${accounts.length === 0 ? " gc-btn-accent" : ""}`,
      disabled: controlsBusy() || !current.canAddAccount,
    }, [icon("plus"), i18n.t("telegram.addAccount")]);
    add.addEventListener("click", () => {
      if (controlsBusy() || !current.canAddAccount) return;
      confirmation = null;
      void run(async () => { await port.addAccount(); });
    });
    const background = Math.max(0, Math.trunc(current.backgroundReadyCount));
    const totalUnread = safeUnread(current.totalUnreadCount);
    const summary = [
      background > 0 ? i18n.t("telegram.backgroundSummary", { count: background }) : null,
      totalUnread > 0 ? i18n.t("telegram.totalUnread", { count: totalUnread > 999 ? "999+" : String(totalUnread) }) : null,
    ].filter((part): part is string => Boolean(part)).join(" · ");
    return el("section", { class: "gc-connector-account-panel", "aria-label": i18n.t("telegram.accounts") }, [
      el("strong", { class: "gc-field-label" }, [i18n.t("telegram.accounts")]),
      ...(summary ? [el("p", { class: "gc-settings-note gc-connector-account-summary", role: "status" }, [summary])] : []),
      ...(buttons.length > 0
        ? [el("div", { class: "gc-connector-account-list", role: "group" }, buttons)]
        : [el("p", { class: "gc-settings-note" }, [i18n.t("telegram.noAccounts")])]),
      el("div", { class: "gc-connector-actions" }, [add]),
    ]);
  };

  const qrView = (login: Extract<TelegramLoginView, { status: "awaiting_qr" }>): HTMLElement[] => {
    const safeLink = validQrLink(login.qrPayload);
    if (!safeLink) return [el("p", { class: "gc-connector-warning", role: "alert" }, [i18n.t("telegram.connectionError")])];
    let qr: SVGSVGElement;
    try {
      qr = createQrSvg(safeLink, i18n.t("telegram.qrLabel"));
    } catch {
      return [el("p", { class: "gc-connector-warning", role: "alert" }, [i18n.t("telegram.connectionError")])];
    }
    const refresh = el("button", {
      type: "button",
      class: "gc-btn",
      disabled: controlsBusy(),
    }, [i18n.t("telegram.refreshQr")]);
    refresh.addEventListener("click", () => void run(() => port.connectQr()));
    const expiry = new Date(login.expiresAt);
    const expiryText = Number.isNaN(expiry.getTime())
      ? null
      : i18n.t("telegram.qrExpires", { time: i18n.formatDate(expiry, { hour: "2-digit", minute: "2-digit" }) });
    return [
      el("p", { class: "gc-settings-note" }, [i18n.t("telegram.qrExplain")]),
      el("div", { class: "gc-connector-qr-frame" }, [qr]),
      ...(expiryText ? [el("p", { class: "gc-settings-note" }, [expiryText])] : []),
      el("div", { class: "gc-connector-actions" }, [refresh]),
      phoneForm(),
      ...destructiveActions(false),
    ];
  };

  const render = (): void => {
    if (disposed) return;
    scrubSensitiveInputs();
    clear(root);
    const header = el("div", { class: "gc-connector-header" }, [
      el("span", { class: "gc-connector-icon", "aria-hidden": true }, [icon("chats")]),
      el("div", {}, [
        el("h2", { class: "gc-settings-title" }, [i18n.t("telegram.title")]),
        el("p", { class: "gc-settings-note" }, [i18n.t("telegram.explain")]),
      ]),
    ]);
    root.append(header);

    if (!current.configured) {
      root.append(el("p", { class: "gc-settings-note" }, [i18n.t("telegram.notConfigured")]));
      return;
    }
    if (!current.available) {
      root.append(el("p", { class: "gc-settings-note" }, [
        i18n.t(current.reason === "vault_unavailable" ? "telegram.vaultUnavailable" : "telegram.runtimeUnavailable"),
      ]));
      return;
    }
    if (current.runtimeVersion) {
      root.append(el("p", { class: "gc-settings-note" }, [`TDLib ${current.runtimeVersion}`]));
    }
    root.append(accountSwitcher());
    if (current.accounts.length === 0 || current.activeSlot === null) return;

    const login = current.login;
    if (current.busy || login.status === "starting") {
      root.append(el("p", { class: "gc-settings-status", role: "status" }, [i18n.t("telegram.connecting")]));
      return;
    }
    if (login.status === "suspended") {
      root.append(el("p", { class: "gc-settings-status", role: "status" }, [i18n.t("telegram.suspended")]));
      return;
    }
    if (login.status === "ready") {
      root.append(
        el("div", { class: "gc-connector-ready" }, [
          el("strong", {}, [i18n.t("telegram.connected")]),
          el("span", { class: "gc-settings-note" }, [maskedAccount(login.account.accountId)]),
        ]),
        ...destructiveActions(true),
      );
      return;
    }
    if (login.status === "awaiting_qr") {
      root.append(...qrView(login));
      return;
    }
    if (login.status === "awaiting_code") {
      root.append(credentialForm("code", login.destinationHint));
      return;
    }
    if (login.status === "awaiting_password") {
      root.append(credentialForm("password", login.passwordHint));
      return;
    }
    if (login.status === "awaiting_phone") {
      root.append(phoneForm(), ...destructiveActions(false));
      return;
    }

    const qr = el("button", {
      type: "button",
      class: "gc-btn gc-btn-accent",
      disabled: controlsBusy(),
    }, [icon("qr"), i18n.t("telegram.connectQr")]);
    qr.addEventListener("click", () => void run(() => port.connectQr()));
    root.append(
      ...(login.status === "error" ? [el("p", { class: "gc-connector-warning", role: "alert" }, [i18n.t("telegram.connectionError")])] : []),
      el("div", { class: "gc-connector-actions" }, [qr]),
      phoneForm(),
      ...destructiveActions(false),
    );
  };

  const detach = port.subscribe((snapshot) => {
    current = snapshot;
    if (snapshot.busy) confirmation = null;
    render();
  });
  const relocalise = i18n.subscribe(() => render());
  void port.initialize().catch(() => { if (!disposed) setStatus("telegram.actionFailed"); });
  render();

  return {
    root,
    destroy() {
      disposed = true;
      actionSeq += 1;
      scrubSensitiveInputs();
      clear(root);
      current = {
        available: false, configured: false, busy: false, login: { status: "idle" },
        activeSlot: null, accounts: [], canAddAccount: false,
        totalUnreadCount: 0, backgroundReadyCount: 0,
      };
      detach();
      relocalise();
    },
  };
}

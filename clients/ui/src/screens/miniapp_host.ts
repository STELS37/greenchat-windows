import type { I18n } from "../i18n.ts";
import { clear, el, modalRoot } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";
import {
  applyMiniAppControlMessage,
  DEFAULT_MINI_APP_CONTROLS,
  miniAppFramePolicy,
  miniAppNeedsConsentData,
  parseMiniAppInvoiceResult,
  parseMiniAppInvoiceRequest,
  miniAppThemeSnapshot,
  parseMiniAppBridgeMessage,
  safeMiniAppExternalUrl,
  validateMiniAppOrigin,
  type MiniAppControlsState,
  type MiniAppInvoiceView,
  type MiniAppLaunch,
  type MiniAppScope,
  type MiniAppView,
} from "./miniapps_model.ts";
import { miniAppScopeText, miniAppsText } from "./miniapps_strings.ts";

export interface MiniAppHostDeps {
  api: ApiLike;
  i18n: I18n;
  appId: number;
  chatId?: number;
  startParam?: string;
  onBack(): void;
}

type ConsentState = { app: MiniAppView; scopes: MiniAppScope[] };

export function createMiniAppHost(deps: MiniAppHostDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const root = el("main", { class: "gc-miniapp-host" });
  let launch: MiniAppLaunch | null = null;
  let consent: ConsentState | null = null;
  let error = "";
  let loading = true;
  let destroyed = false;
  let iframe: HTMLIFrameElement | null = null;
  let expanded = false;
  let messageHandler: ((event: MessageEvent) => void) | null = null;
  let controls: MiniAppControlsState = {
    main: { ...DEFAULT_MINI_APP_CONTROLS.main },
    backVisible: DEFAULT_MINI_APP_CONTROLS.backVisible,
    settingsVisible: DEFAULT_MINI_APP_CONTROLS.settingsVisible,
  };
  let controlsBar: HTMLElement | null = null;
  let controlsMounted = false;
  let invoiceSheet: HTMLElement | null = null;
  let invoiceBusy = false;

  const t = (key: Parameters<typeof miniAppsText>[1]): string => miniAppsText(i18n.locale, key);

  const response = (id: string, ok: boolean, result?: unknown, errorText?: string): void => {
    if (!iframe?.contentWindow || !launch) return;
    iframe.contentWindow.postMessage({
      type: "greenchat:host-response",
      version: 1,
      id,
      ok,
      ...(ok ? { result } : { error: errorText ?? "request denied" }),
    }, launch.launch_origin);
  };

  const sendEvent = (
    event:
      | "mainButtonPressed"
      | "backButtonPressed"
      | "settingsButtonPressed"
      | "invoicePaid"
      | "invoiceClosed",
    payload?: unknown,
  ): void => {
    if (!iframe?.contentWindow || !launch) return;
    iframe.contentWindow.postMessage({
      type: "greenchat:event",
      version: 1,
      event,
      ...(payload === undefined ? {} : { payload }),
    }, launch.launch_origin);
  };

  const resetControls = (): void => {
    controls = {
      main: { ...DEFAULT_MINI_APP_CONTROLS.main },
      backVisible: DEFAULT_MINI_APP_CONTROLS.backVisible,
      settingsVisible: DEFAULT_MINI_APP_CONTROLS.settingsVisible,
    };
    controlsBar?.remove();
    controlsBar = null;
    controlsMounted = false;
    root.classList.remove("has-controls");
  };

  const renderControls = (): void => {
    if (!iframe || !launch) return;
    if (!controlsBar) controlsBar = el("div", { class: "gc-miniapp-controls" });
    clear(controlsBar);

    const left = el("div", { class: "gc-miniapp-controls-side is-left" });
    if (controls.backVisible) {
      const back = el("button", {
        type: "button",
        class: "gc-icon-btn gc-miniapp-control-back",
        title: t("back"),
        "aria-label": t("back"),
      }, [icon("back")]);
      back.addEventListener("click", () => sendEvent("backButtonPressed"));
      left.append(back);
    }

    const main = controls.main.visible
      ? el("button", {
          type: "button",
          class: `gc-btn gc-btn-accent gc-miniapp-main${controls.main.loading ? " is-loading" : ""}`,
          disabled: !controls.main.enabled || controls.main.loading,
          "aria-label": controls.main.text || t("mainAction"),
          "aria-busy": controls.main.loading,
        }, [
          ...(controls.main.loading
            ? [el("span", { class: "gc-miniapp-control-spinner", "aria-hidden": true })]
            : []),
          el("span", {}, [controls.main.text]),
        ])
      : null;
    main?.addEventListener("click", () => sendEvent("mainButtonPressed"));

    const right = el("div", { class: "gc-miniapp-controls-side is-right" });
    if (controls.settingsVisible) {
      const settings = el("button", {
        type: "button",
        class: "gc-icon-btn gc-miniapp-control-settings",
        title: t("settings"),
        "aria-label": t("settings"),
      }, [icon("settings")]);
      settings.addEventListener("click", () => sendEvent("settingsButtonPressed"));
      right.append(settings);
    }

    const visible = controls.backVisible || controls.settingsVisible || main !== null;
    controlsBar.hidden = !visible;
    controlsBar.append(left, main ?? el("span", { "aria-hidden": true }), right);
    root.classList.toggle("has-controls", visible);
    if (!controlsMounted) {
      root.append(controlsBar);
      controlsMounted = true;
    }
  };

  const closeInvoiceSheet = (invoice: MiniAppInvoiceView | null, notify: boolean): void => {
    invoiceSheet?.remove();
    invoiceSheet = null;
    invoiceBusy = false;
    if (notify && invoice) sendEvent("invoiceClosed", { code: invoice.code, status: "cancelled" });
  };

  const mountInvoiceSheet = (invoice: MiniAppInvoiceView): void => {
    if (!launch || invoiceSheet) return;
    let paying = false;
    const overlay = el("div", {
      class: "gc-miniapp-invoice-overlay",
      role: "dialog",
      "aria-modal": true,
      "aria-label": t("invoiceTitle"),
    });
    const card = el("section", { class: "gc-miniapp-invoice-sheet" });
    const errorLine = el("p", { class: "gc-miniapp-invoice-error", role: "alert", hidden: true });
    const pinInput = el("input", {
      class: "gc-input gc-miniapp-invoice-pin",
      type: "password",
      inputmode: "numeric",
      autocomplete: "off",
      minlength: 4,
      maxlength: 8,
      pattern: "[0-9]*",
      placeholder: t("invoicePin"),
      "aria-label": t("invoicePin"),
    }) as HTMLInputElement;
    const pinBlock = el("label", { class: "gc-miniapp-invoice-pinblock", hidden: true }, [
      el("span", {}, [t("invoicePin")]),
      pinInput,
      el("small", {}, [t("invoicePinHint")]),
    ]);
    const pay = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [t("invoicePay")]) as HTMLButtonElement;
    const cancel = el("button", { type: "button", class: "gc-btn" }, [t("invoiceCancel")]) as HTMLButtonElement;

    const setPaying = (value: boolean): void => {
      paying = value;
      invoiceBusy = value;
      pay.disabled = value;
      cancel.disabled = value;
      pay.setAttribute("aria-busy", value ? "true" : "false");
    };
    const showError = (text: string, askPin: boolean): void => {
      errorLine.hidden = false;
      errorLine.textContent = text;
      pinBlock.hidden = !askPin;
      if (askPin) pinInput.focus();
    };
    const payInvoice = async (): Promise<void> => {
      if (paying || !launch) return;
      setPaying(true);
      errorLine.hidden = true;
      try {
        const pin = pinInput.value.trim();
        await api.post(`/v1/invoices/${invoice.code}/pay`, {
          client_op_id: `ma:${launch.launch_id.replaceAll("-", "").slice(0, 16)}:${invoice.code}`,
          amount: invoice.amount,
          ...(pin ? { pin } : {}),
        });
        pinInput.value = "";
        closeInvoiceSheet(null, false);
        sendEvent("invoicePaid", { code: invoice.code, status: "paid" });
      } catch (err) {
        pinInput.value = "";
        const code = apiErrorCode(err);
        const asksForPin = code === "PIN_REQUIRED" || code === "PIN_INVALID";
        const terminal = code === "INVOICE_NOT_OPEN" || code === "NOT_FOUND";
        showError(terminal ? t("invoiceUnavailable") : describeError(err, i18n), asksForPin);
      } finally {
        if (invoiceSheet) setPaying(false);
      }
    };

    pay.addEventListener("click", () => void payInvoice());
    cancel.addEventListener("click", () => {
      if (!paying) closeInvoiceSheet(invoice, true);
    });
    pinInput.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") void payInvoice();
    });

    const expiry = new Intl.DateTimeFormat(i18n.locale, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(invoice.expires_at * 1000));
    card.append(
      el("div", { class: "gc-miniapp-invoice-mark", "aria-hidden": true }, [icon("wallet")]),
      el("h2", {}, [t("invoiceTitle")]),
      el("dl", { class: "gc-miniapp-invoice-facts" }, [
        el("div", {}, [el("dt", {}, [t("invoiceRecipient")]), el("dd", {}, [launch.app.bot.name])]),
        el("div", {}, [el("dt", {}, [t("invoiceAmount")]), el("dd", {}, [`${invoice.amount} ${invoice.asset}`])]),
        ...(invoice.description
          ? [el("div", {}, [el("dt", {}, [t("invoiceDescription")]), el("dd", {}, [invoice.description])])]
          : []),
        el("div", {}, [el("dt", {}, [t("invoiceExpires")]), el("dd", {}, [expiry])]),
      ]),
      pinBlock,
      errorLine,
      el("div", { class: "gc-miniapp-invoice-actions" }, [cancel, pay]),
    );
    overlay.append(card);
    invoiceSheet = overlay;
    modalRoot(root).append(overlay);
  };

  const openInvoice = async (requestId: string, payload: unknown): Promise<void> => {
    if (!launch?.scopes.includes("payments.invoice")) {
      response(requestId, false, undefined, t("invoiceScopeDenied"));
      return;
    }
    const request = parseMiniAppInvoiceRequest(payload);
    if (!request) {
      response(requestId, false, undefined, "invalid invoice request");
      return;
    }
    if (invoiceBusy || invoiceSheet) {
      response(requestId, false, undefined, "invoice flow already open");
      return;
    }
    invoiceBusy = true;
    try {
      const raw = await api.get<unknown>(`/v1/invoices/${request.code}`);
      const invoice = parseMiniAppInvoiceResult(raw, request.code);
      if (
        !invoice ||
        !launch ||
        invoice.creator_id !== launch.app.bot_user_id ||
        invoice.expires_at <= Math.floor(Date.now() / 1000)
      ) {
        response(requestId, false, undefined, t("invoiceUnavailable"));
        return;
      }
      mountInvoiceSheet(invoice);
      response(requestId, true, { opened: true });
    } catch {
      response(requestId, false, undefined, t("invoiceUnavailable"));
    } finally {
      invoiceBusy = false;
    }
  };

  const sendInit = (): void => {
    if (!iframe?.contentWindow || !launch) return;
    iframe.contentWindow.postMessage({
      type: "greenchat:init",
      version: 1,
      initData: launch.init_data,
      initDataUnsafe: {
        appId: launch.app.id,
        launchId: launch.launch_id,
        expiresAt: launch.expires_at,
        scopes: launch.scopes,
      },
      themeParams: miniAppThemeSnapshot(),
      bridge: launch.bridge,
    }, launch.launch_origin);
  };

  const mountFrame = (): void => {
    if (!launch) return;
    const url = validateMiniAppOrigin(launch.launch_url, launch.launch_origin);
    if (!url) {
      error = t("invalidOrigin");
      launch = null;
      render();
      return;
    }
    const policy = miniAppFramePolicy();
    iframe = el("iframe", {
      class: "gc-miniapp-frame",
      src: url,
      title: launch.app.title,
      sandbox: policy.sandbox,
      allow: policy.allow,
      referrerpolicy: policy.referrerPolicy,

      credentialless: policy.credentialless,
      csp: policy.csp,
    }) as HTMLIFrameElement;
    iframe.addEventListener("load", sendInit);
    iframe.addEventListener("error", () => {
      error = t("frameError");
      render();
    });

    messageHandler = (event: MessageEvent): void => {
      if (!launch || !iframe?.contentWindow) return;
      if (event.source !== iframe.contentWindow || event.origin !== launch.launch_origin) return;
      const message = parseMiniAppBridgeMessage(event.data);
      if (!message) return;
      if (!launch.bridge.methods.includes(message.method)) {
        response(message.id, false, undefined, "bridge method unavailable");
        return;
      }
      switch (message.method) {
        case "ready":
          root.classList.add("is-ready");
          response(message.id, true, { ready: true });
          break;
        case "close":
          response(message.id, true, { closing: true });
          deps.onBack();
          break;
        case "expand":
          expanded = true;
          root.classList.add("is-expanded");
          response(message.id, true, { expanded });
          break;
        case "requestTheme":
          response(message.id, true, miniAppThemeSnapshot());
          break;
        case "setMainButton":
        case "setBackButton":
        case "setSettingsButton": {
          const next = applyMiniAppControlMessage(controls, message.method, message.payload);
          if (!next) {
            response(message.id, false, undefined, "invalid system control payload");
            break;
          }
          controls = next;
          renderControls();
          response(message.id, true, { applied: true });
          break;
        }
        case "openInvoice":
          void openInvoice(message.id, message.payload);
          break;
        case "writeClipboard": {
          // A declared scope is permission metadata, not permission to bypass GreenChat's managed
          // privacy boundary. Until a reviewed secure-copy port exists, clipboard writes fail closed
          // on every platform instead of calling the operating-system clipboard directly.
          response(message.id, false, undefined, t("clipboardDenied"));
          break;
        }
        case "openLink": {
          const raw = (message.payload as { url?: unknown } | null)?.url;
          const safe = safeMiniAppExternalUrl(raw);
          if (!safe) {
            response(message.id, false, undefined, "invalid external url");
            break;
          }
          const opened = window.open(safe, "_blank", "noopener,noreferrer");
          response(message.id, Boolean(opened), { opened: Boolean(opened) }, opened ? undefined : "popup blocked");
          break;
        }
      }
    };
    window.addEventListener("message", messageHandler);
    render();
  };

  const launchRequest = async (): Promise<void> => {
    if (messageHandler) window.removeEventListener("message", messageHandler);
    messageHandler = null;
    iframe?.remove();
    iframe = null;
    resetControls();
    closeInvoiceSheet(null, false);
    loading = true;
    error = "";
    consent = null;
    render();
    try {
      launch = await api.post<MiniAppLaunch>(`/v1/miniapps/${deps.appId}/launch`, {
        ...(deps.chatId === undefined ? {} : { chat_id: deps.chatId }),
        ...(deps.startParam ? { start_param: deps.startParam } : {}),
      });
      if (destroyed) return;
      loading = false;
      resetControls();
      mountFrame();
    } catch (err) {
      if (destroyed) return;
      const required = miniAppNeedsConsentData(err);
      if (required) consent = required;
      else error = describeError(err, i18n);
      loading = false;
      render();
    }
  };

  const grantAndLaunch = async (): Promise<void> => {
    if (!consent) return;
    loading = true;
    error = "";
    render();
    try {
      await api.post(`/v1/miniapps/${deps.appId}/grant`, { scopes: consent.scopes });
      await launchRequest();
    } catch (err) {
      loading = false;
      error = describeError(err, i18n);
      render();
    }
  };

  const revokeAndClose = async (): Promise<void> => {
    try {
      await api.delete(`/v1/miniapps/${deps.appId}/grant`);
    } finally {
      deps.onBack();
    }
  };

  const header = (app?: MiniAppView): HTMLElement => {
    const back = el("button", { type: "button", class: "gc-icon-btn", title: t("close"), "aria-label": t("close") }, [icon("close")]);
    back.addEventListener("click", deps.onBack);
    const revoke = el("button", { type: "button", class: "gc-btn gc-btn-quiet" }, [t("revoked")]);
    revoke.addEventListener("click", () => void revokeAndClose());
    return el("header", { class: "gc-miniapp-host-header" }, [
      back,
      el("div", { class: "gc-miniapp-host-title" }, [
        el("span", { class: "gc-miniapp-host-mark", "aria-hidden": true }, [icon("spark")]),
        el("div", {}, [
          el("strong", {}, [app?.title ?? t("title")]),
          ...(app ? [el("small", {}, [`@${app.bot.username}`])] : []),
        ]),
      ]),
      ...(launch ? [revoke] : []),
    ]);
  };

  const render = (): void => {
    clear(root);
    controlsMounted = false;
    root.classList.toggle("is-expanded", expanded);
    root.append(header(launch?.app ?? consent?.app));
    if (loading) {
      root.append(el("section", { class: "gc-miniapp-host-state" }, [
        el("div", { class: "gc-miniapp-spinner", "aria-hidden": true }),
        el("p", {}, [t("loading")]),
      ]));
      return;
    }
    if (error) {
      const retry = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [t("retry")]);
      retry.addEventListener("click", () => void launchRequest());
      root.append(el("section", { class: "gc-miniapp-host-state", role: "alert" }, [
        el("div", { class: "gc-miniapp-state-mark" }, [icon("warning")]),
        el("p", {}, [error]),
        retry,
      ]));
      return;
    }
    if (consent) {
      const allow = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [t("allowOpen")]);
      allow.addEventListener("click", () => void grantAndLaunch());
      const cancel = el("button", { type: "button", class: "gc-btn" }, [t("cancel")]);
      cancel.addEventListener("click", deps.onBack);
      root.append(el("section", { class: "gc-miniapp-consent" }, [
        el("div", { class: "gc-miniapp-consent-mark" }, [icon("shield")]),
        el("h1", {}, [t("consentTitle")]),
        el("p", {}, [t("consentLead")]),
        el("ul", { class: "gc-miniapp-consent-list" }, consent.scopes.map((scope) =>
          el("li", {}, [icon("check"), el("span", {}, [miniAppScopeText(i18n.locale, scope)])]),
        )),
        el("div", { class: "gc-miniapp-actions" }, [allow, cancel]),
      ]));
      return;
    }
    if (iframe) {
      root.append(iframe);
      renderControls();
    }
  };

  const relocalise = i18n.subscribe(() => {
    if (iframe && launch) sendInit();
    render();
  });
  void launchRequest();

  return {
    root,
    destroy() {
      destroyed = true;
      relocalise();
      if (messageHandler) window.removeEventListener("message", messageHandler);
      controlsBar?.remove();
      controlsBar = null;
      controlsMounted = false;
      closeInvoiceSheet(null, false);
      iframe?.remove();
      iframe = null;
    },
  };
}

// GreenChat device-link approval. A scanned login QR is a request to create a full session, so opening
// the link is read-only: the already-authenticated device first loads the attempting device/IP and only
// a visible Approve or Deny press mutates the server state.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { apiErrorCode, describeError } from "./api.ts";

interface QrAttemptInfo {
  device: string;
  device_label: string;
  ip: string;
  started_at: number;
  expires_at: number;
}

export interface QrLoginScreenDeps {
  api: ApiLike;
  i18n: I18n;
  token: string;
  onDone(): void;
}

type ViewState = "loading" | "ready" | "approved" | "denied" | "unavailable";

export function createQrLoginScreen(deps: QrLoginScreenDeps): {
  root: HTMLElement;
  destroy(): void;
} {
  const { api, i18n } = deps;
  const token = deps.token.trim();
  let disposed = false;
  let epoch = 0;
  let busy = false;
  let state: ViewState = "loading";
  let info: QrAttemptInfo | null = null;
  let error: unknown = null;

  const root = el("div", { class: "gc-server gc-qr-login-approval" });
  const back = el("button", {
    type: "button",
    class: "gc-icon-btn",
    title: i18n.t("common.back"),
    "aria-label": i18n.t("common.back"),
  }, [icon("back")]);
  back.addEventListener("click", deps.onDone);
  const header = el("header", { class: "gc-server-header" }, [
    back,
    el("h1", { class: "gc-server-title" }, [i18n.t("auth.qrApproveTitle")]),
  ]);
  const status = el("p", { class: "gc-server-status", role: "status", "aria-live": "polite" });
  const card = el("section", { class: "gc-server-card gc-qr-login-card" });
  root.append(header, status, card);

  const formatTime = (seconds: number): string => i18n.formatDate(seconds * 1_000, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const actionButton = (action: "approve" | "deny" | "done", label: string, primary = false): HTMLButtonElement => {
    const button = el("button", {
      type: "button",
      class: primary ? "gc-btn gc-btn-accent" : "gc-btn",
      "data-action": action,
      disabled: busy,
    }, [label]) as HTMLButtonElement;
    return button;
  };

  const render = (): void => {
    if (disposed) return;
    clear(card);
    status.textContent = error ? describeError(error, i18n) : "";

    if (state === "loading") {
      card.append(
        el("h2", {}, [i18n.t("auth.qrApproveChecking")]),
        el("p", { class: "gc-settings-note" }, [i18n.t("auth.qrApproveCheckingHint")]),
      );
      return;
    }
    if (state === "unavailable" || !info) {
      const retry = actionButton("done", i18n.t("common.retry"));
      retry.addEventListener("click", () => void load());
      card.append(
        el("h2", {}, [i18n.t("auth.qrUnavailableTitle")]),
        el("p", { class: "gc-settings-note" }, [i18n.t("auth.qrUnavailableHint")]),
        el("div", { class: "gc-server-actions" }, [retry]),
      );
      return;
    }
    if (state === "approved" || state === "denied") {
      const approved = state === "approved";
      const done = actionButton("done", i18n.t("common.done"), true);
      done.addEventListener("click", deps.onDone);
      card.append(
        el("h2", {}, [i18n.t(approved ? "auth.qrApprovedTitle" : "auth.qrDeniedTitle")]),
        el("p", { class: "gc-settings-note" }, [
          i18n.t(approved ? "auth.qrApprovedHint" : "auth.qrDeniedHint", { device: info.device_label }),
        ]),
        el("div", { class: "gc-server-actions" }, [done]),
      );
      return;
    }

    const approve = actionButton("approve", i18n.t("auth.qrApproveAction"), true);
    const deny = actionButton("deny", i18n.t("auth.qrDenyAction"));
    approve.addEventListener("click", () => void decide("approve"));
    deny.addEventListener("click", () => void decide("deny"));
    card.append(
      el("h2", { class: "gc-qr-device" }, [info.device_label]),
      ...(info.device && info.device !== info.device_label
        ? [el("p", { class: "gc-settings-note" }, [info.device])]
        : []),
      el("div", { class: "gc-setting-list" }, [
        el("div", { class: "gc-setting-row" }, [
          el("span", { class: "gc-setting-label" }, [i18n.t("auth.qrIp")]),
          el("span", { class: "gc-setting-value" }, [info.ip]),
        ]),
        el("div", { class: "gc-setting-row" }, [
          el("span", { class: "gc-setting-label" }, [i18n.t("auth.qrStarted")]),
          el("span", { class: "gc-setting-value" }, [formatTime(info.started_at)]),
        ]),
        el("div", { class: "gc-setting-row" }, [
          el("span", { class: "gc-setting-label" }, [i18n.t("auth.qrExpiresAt")]),
          el("span", { class: "gc-setting-value" }, [formatTime(info.expires_at)]),
        ]),
      ]),
      el("div", { class: "gc-connector-confirmation" }, [
        el("strong", {}, [i18n.t("auth.qrSecurityTitle")]),
        el("p", { class: "gc-connector-warning" }, [i18n.t("auth.qrSecurityHint")]),
      ]),
      el("div", { class: "gc-server-actions" }, [deny, approve]),
    );
  };

  const load = async (): Promise<void> => {
    const mine = ++epoch;
    error = null;
    if (!/^[0-9a-f]{96}$/i.test(token)) {
      state = "unavailable";
      render();
      return;
    }
    state = "loading";
    render();
    try {
      const next = await api.post<QrAttemptInfo>("/v1/auth/qr/info", { qr_token: token });
      if (disposed || mine !== epoch) return;
      if (
        !next || typeof next.device_label !== "string" || typeof next.ip !== "string" ||
        !Number.isFinite(next.started_at) || !Number.isFinite(next.expires_at)
      ) throw new Error("invalid QR login info");
      info = next;
      state = "ready";
    } catch (caught) {
      if (disposed || mine !== epoch) return;
      error = caught;
      state = "unavailable";
    }
    render();
  };

  const decide = async (decision: "approve" | "deny"): Promise<void> => {
    if (busy || state !== "ready" || !info) return;
    const mine = ++epoch;
    busy = true;
    error = null;
    render();
    try {
      await api.post(decision === "approve" ? "/v1/auth/qr/approve" : "/v1/auth/qr/deny", {
        qr_token: token,
      });
      if (disposed || mine !== epoch) return;
      state = decision === "approve" ? "approved" : "denied";
    } catch (caught) {
      if (disposed || mine !== epoch) return;
      const code = apiErrorCode(caught);
      if (code === "NOT_FOUND" || code === "QR_ALREADY_USED") state = "unavailable";
      error = caught;
    } finally {
      if (!disposed && mine === epoch) busy = false;
    }
    render();
  };

  void load();
  return {
    root,
    destroy() {
      disposed = true;
      epoch += 1;
    },
  };
}

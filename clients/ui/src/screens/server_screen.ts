// clients/ui/src/screens/server_screen.ts — the «Адрес сервера» screen (T-419, PRODUCT_UX §5 / FEATURES §17).
// Reachable BEFORE login (a link on the auth screen + the greenchat://connect?host=… deep link) and from
// the command palette when signed in. It lets a user point the client at a self-hosted or alternate Green
// Chat server, and toggle the automatic failover-to-backup behaviour ("функция отключаема в настройках").
// Changing the address ends the current session and wipes all local data (a different server = a
// different account namespace), so the switch is guarded by an explicit confirmation. DOM-only glue; the
// pure validation lives in server_model.ts, and all persistence / session effects sit behind the injected
// ServerPort (the web shell binds it to the core EndpointManager).
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { icon } from "../icons.ts";
import { parseServerAddress, sameServer } from "./server_model.ts";

// The shell-provided bridge to the real endpoint state. Kept structural so the screen is testable and the
// ui layer never imports core. `save("")` resets to the built-in default; `save` performs persist +
// setPrimary + a full local-data wipe (and, when signed in, a best-effort logout on the OLD server first) —
// the screen only decides WHEN to call it.
export interface ServerPort {
  current(): string; // the configured address ("" = built-in default)
  isDefault(): boolean; // current() is the built-in default
  authed(): boolean; // a session is active → changing the address will log out and wipe local data
  save(address: string): Promise<void>;
  failover: { get(): boolean; set(on: boolean): void };
  // A deep-link host to prefill once (greenchat://connect?host=…); consumed on read.
  pendingAddress?(): string | null;
}

export interface ServerScreenDeps {
  i18n: I18n;
  server: ServerPort;
  onBack: () => void;
  onSaved?: () => void;
}

export function createServerScreen(deps: ServerScreenDeps): { root: HTMLElement; destroy(): void } {
  const { i18n, server } = deps;
  let confirming = false;
  let busy = false;

  const root = el("div", { class: "gc-server" });
  const status = el("p", { class: "gc-server-status", role: "status", "aria-live": "polite" });
  const errLine = el("span", { class: "gc-field-err" });

  const input = el("input", {
    type: "url",
    class: "gc-input",
    inputmode: "url",
    autocomplete: "off",
    autocapitalize: "none",
    spellcheck: "false",
    placeholder: i18n.t("server.defaultLabel"),
  }) as HTMLInputElement;
  // Prefill: a pending deep-link host wins, else the current custom address (default → empty; placeholder shows).
  const pending = server.pendingAddress?.() ?? null;
  input.value = pending ?? (server.isDefault() ? "" : server.current());

  const failoverToggle = el("input", { type: "checkbox", class: "gc-toggle" }) as HTMLInputElement;
  failoverToggle.checked = server.failover.get();
  failoverToggle.addEventListener("change", () => {
    server.failover.set(failoverToggle.checked);
    status.textContent = i18n.t("server.saved");
  });

  // Every other screen with a header (feed, settings, import) leaves "back" as the round icon button
  // `gc-icon-btn`. This one was the last text-label form button in the client — measured at 82×46 px it
  // read as a submit control rather than navigation, and it was the loudest remaining "web form" tell on
  // the pre-login path. The accessible name stays: the icon is decorative and `title` carries the label.
  const backBtn = el(
    "button",
    { type: "button", class: "gc-icon-btn", title: i18n.t("common.back"), "aria-label": i18n.t("common.back") },
    [icon("back")],
  );
  backBtn.addEventListener("click", () => deps.onBack());

  const doSave = async (): Promise<void> => {
    if (busy) return;
    errLine.textContent = "";
    const parsed = parseServerAddress(input.value);
    if (!parsed.ok) {
      errLine.textContent = i18n.t("server.invalid");
      confirming = false;
      render();
      return;
    }
    if (sameServer(parsed.value, server.current())) {
      deps.onBack(); // no real change → nothing to confirm or switch
      return;
    }
    // Explicit warning before we wipe local data / switch account namespaces.
    if (!confirming && server.authed()) {
      confirming = true;
      render();
      return;
    }
    busy = true;
    render();
    try {
      await server.save(parsed.value);
      status.textContent = i18n.t("server.saved");
      (deps.onSaved ?? deps.onBack)();
    } catch {
      busy = false;
      confirming = false;
      status.textContent = i18n.t("server.saveError");
      render();
    }
  };

  const render = (): void => {
    clear(root);
    const field = el("label", { class: "gc-field" }, [
      el("span", { class: "gc-field-label" }, [i18n.t("server.addressLabel")]),
      input,
      errLine,
      el("span", { class: "gc-field-hint" }, [i18n.t("server.addressHint")]),
    ]);

    const saveBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy }, [
      busy ? i18n.t("auth.submitting") : confirming ? i18n.t("server.confirmChange") : i18n.t("common.save"),
    ]);
    saveBtn.addEventListener("click", () => void doSave());

    const actions: HTMLElement[] = [saveBtn];
    if (confirming) {
      const cancel = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.cancel")]);
      cancel.addEventListener("click", () => {
        confirming = false;
        render();
      });
      actions.push(cancel);
    }

    const warn = confirming
      ? [el("p", { class: "gc-server-warning", role: "alert" }, [i18n.t("server.changeWarning")])]
      : [];

    const failoverRow = el("div", { class: "gc-setting-list" }, [
      el("label", { class: "gc-setting-row" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("server.failoverLabel")]),
        failoverToggle,
      ]),
      el("p", { class: "gc-settings-note" }, [i18n.t("server.failoverNote")]),
    ]);

    root.append(
      el("header", { class: "gc-server-header" }, [
        backBtn,
        el("h1", { class: "gc-server-title" }, [i18n.t("server.title")]),
      ]),
      status,
      el("div", { class: "gc-server-card" }, [field, ...warn, el("div", { class: "gc-server-actions" }, actions), failoverRow]),
    );
  };

  render();
  const relocalise = i18n.subscribe(() => render());
  return { root, destroy: relocalise };
}

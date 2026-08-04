// clients/ui/src/screens/settings_screen.ts — profile / settings / privacy (T-405, all M0 keys).
// Three tabs under the one /settings route:
//   • Profile  — GET /v1/users/me, edit name + bio via PATCH /v1/users/me.
//   • Settings — GET/PATCH /v1/users/me/settings; every SETTINGS_SPEC key as a select/toggle.
//   • Privacy  — GET/PUT /v1/privacy; every M0 privacy key as a scope/reach/toggle select.
// A change PATCHes/PUTs just that key and restates the control from the server's echoed result. The key
// tables + normalisers are the node-tested privacy_model.ts / settings_model.ts; this file is DOM only.
import type { I18n } from "../i18n.ts";
import type { ApiLike } from "./api.ts";
import type { Me, PrivacyMap, SettingsMap } from "./types.ts";
import { el, clear } from "../dom.ts";

import { icon } from "../icons.ts";
import type { IconName } from "../icons.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { personLabel } from "./person_name.ts";
import { describeError } from "./api.ts";
import {
  avatarText, bindAvatarImage, uploadAvatarFile,
  type AvatarImageBinding, type AvatarUploadPort,
} from "./avatar_media.ts";
import { PRIVACY_ITEMS, privacyOptions, normalizePrivacy } from "./privacy_model.ts";
import {
  SETTINGS_ITEMS, settingValue, NOTIFY_MODE_ITEM, normalizeNotifyModeValue,
  SCREEN_PRIVACY_ITEM, normalizeScreenPrivacyValue,
  UI_LANG_ITEM, normalizeUiLangValue,
} from "./settings_model.ts";
import {
  listSupportedCurrencies,
  isValidCurrencyCode,
  normalizeCurrencyInput,
  currencyLabel,
  currencyLocaleTag,
} from "./currency_model.ts";
import { failureState, skeletonLine } from "./state_view.ts";
import { createDevicesScreen } from "./devices_screen.ts";
import type { SupportHelpPort, SupportHelpView } from "./support_help.ts";
import type { SafetyScreen, SafetyScreenDeps } from "./safety_screen.ts";

import {
  createTelegramSettings,
  type TelegramConnectionPort,
  type TelegramSettingsView,
} from "./telegram_settings.ts";

import type { AppLockUiPort } from "./lock_screen.ts";
import { createLockSettings } from "./lock_settings.ts";

import {
  CACHE_RETENTION_OPTIONS,
  normalizeCacheRetention,
  type CachePolicyPort,
  type CacheRetentionMode,
} from "./cache_policy_model.ts";

// A tiny local-consent port for the opt-in diagnostics toggle (T-418). The web shell backs it with the
// core Diagnostics controller (get/set persist to IndexedDB); a shell without diagnostics omits it and the
// tab never appears. Consent is LOCAL state (no server round-trip), so it is deliberately NOT part of ApiLike.
export interface DiagnosticsConsentPort {
  get(): Promise<boolean>;
  set(on: boolean): Promise<void>;
}

// T-531 (DS-13): the notification display-mode port («полное/только имя/generic»). LOCAL state like the
// diagnostics consent — no server round-trip; the shell persists the mode somewhere its service worker
// can read it with every page closed (web: gc-diag IndexedDB kv "notify_mode"). get() resolves the
// stored mode or the default; a shell without push notifications simply omits the port and no row shows.
export interface NotifyModePort {
  get(): Promise<string>;
  set(mode: string): Promise<void>;
}

// The interface language is local device state. It must be readable and changeable while offline.
export interface LanguagePort {
  get(): Promise<string>;
  set(pref: string): Promise<void>;
}

// T-530 (DS-12): local native screenshot/task-switcher protection. Omitted on PWA/desktop where the
// platform cannot enforce FLAG_SECURE; default false preserves ordinary-chat screenshot convenience.
export interface ScreenPrivacyPort {
  get(): Promise<boolean>;
  set(enabled: boolean): Promise<void>;
}


// Installed desktop-only OS controls. These are local machine properties, never account settings and
// never PATCHed to the server. PWA/mobile omit the port and therefore render no misleading controls.
export interface DesktopSystemPort {
  getNotifications(): Promise<boolean>;
  setNotifications(enabled: boolean): Promise<void>;
  getAutostart(): Promise<boolean>;
  setAutostart(enabled: boolean): Promise<void>;
}

// Manual update check action. Native shells provide the implementation; web/PWA can omit it because
// service-worker updates are handled automatically.
export interface UpdateCheckPort {
  check(): Promise<void>;
}

// One tile in the «Ещё» service hub. The shell supplies the list because only it knows which optional
// contours the server advertises and which ports (importer, support, server switch, app lock) this
// build actually has; the screen stays DOM-only and node-testable.
export interface MoreHubItem {
  /** Stable machine id for tests/selectors; the label is product copy and may change. */
  id: string;
  label: string;
  /** One line saying what the service is for. A tile without it is a mystery button. */
  hint?: string;
  glyph: IconName;
  /** Colour family for the tile mark, so the hub is not one column of identical green squares. */
  // V95: the tone marks follow the GreenChat arc — amber (money) → brand green → teal.
  // "violet" was removed with the last screen that painted a colour outside the identity.
  tone?: "brand" | "cyan" | "gold" | "neutral";
  open(): void;
}

export interface SettingsScreenDeps {
  api: ApiLike;
  i18n: I18n;
  onBack: () => void;
  // «Ещё» is a hub, not a settings menu. Measured on the running client before this change
  // (var/ux-audit/tools/m_more_v73.mjs, 390x844, 2026-07-30): behind that label sat an account card
  // and seven settings rows — 552 of 844 px, zero service entries — while «Карты», «Перенос данных»,
  // «Поддержка» and «Адрес сервера» had no phone-reachable entry point at all (desktop rail, an
  // overflow menu or a typed URL only). Present → the index opens with the services this build can
  // actually reach; absent (or empty) → the screen renders exactly as before.
  hub?: { items: MoreHubItem[] };
  // See CallsScreenDeps.atShellRoot. Settings is a drill-down, so the arrow is not simply dropped:
  // it disappears on the section INDEX (a tab destination has nowhere to go back to) and reappears
  // inside a section, where it means "up to the index" — exactly the two-level behaviour of every
  // mainstream mobile client.
  atShellRoot?: boolean;
  // T-418: when present, a 4th «Диагностика» tab exposes the single opt-in switch (default OFF).
  diagnostics?: DiagnosticsConsentPort;
  // T-512: when present, a «Помощь» tab lists the viewer's support tickets and opens the @support dialog.
  support?: SupportHelpPort;
  safety?: Omit<SafetyScreenDeps, "api" | "i18n">;
  // T-452: native official Telegram connector. Plain web/PWA omits it, so no misleading tab appears.
  telegram?: TelegramConnectionPort;
  // T-523: local application-lock settings; absent on shells without the crypto-container.
  lock?: AppLockUiPort;
  // A shell with a language controller exposes the first row in General.
  language?: LanguagePort;
  // The shell uses this only while a language write synchronously rebuilds the current screen.
  initialSection?: string | null;
  // T-531: when present, the Settings tab appends the local notification display-mode select.
  notifyMode?: NotifyModePort;
  // T-530: when present, the Settings tab appends the local screenshot-protection toggle.
  screenPrivacy?: ScreenPrivacyPort;
  // Native desktop notification permission + operating-system login item.
  desktopSystem?: DesktopSystemPort;
  // Manual "check for updates" action in Settings.
  updateCheck?: UpdateCheckPort;
  // 2026-07 redesign: a successful ui_theme change also drives the LOCAL ThemeController when the shell
  // provides this hook (mobile shells have no Ctrl+K palette, so this select is their only theme switch).
  onUiTheme?: (pref: "light" | "dark" | "system") => void;

  // T-529: encrypted local-cache retention policy. Never sent to the server.
  cachePolicy?: CachePolicyPort;
  // V179: platform/test seam for the public @username control in Profile. Production falls back to
  // the browser/native WebView clipboard capability; tests inject it so a tap can be proven without
  // replacing a process-global Navigator.
  copyText?: (text: string) => Promise<void>;
  // Existing resumable media uploader; when absent the profile stays read-only but existing photos render.
  media?: AvatarUploadPort;
}

type Tab =
  | "profile"
  | "settings"
  | "privacy"
  | "devices"
  | "safety"
  | "connections"
  | "diagnostics"
  | "help"
  | "licenses";

export function createSettingsScreen(deps: SettingsScreenDeps): {
  root: HTMLElement;
  destroy(): void;
  reset(): void;
} {
  const { api, i18n } = deps;
  const browserNav = (globalThis as {
    navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  }).navigator;
  const copyText = deps.copyText
    ?? (browserNav?.clipboard?.writeText
      ? browserNav.clipboard.writeText.bind(browserNav.clipboard)
      : undefined);
  // Settings opens on an INDEX, not on a section. Seven sections in a horizontal strip measured
  // 733 px of tabs inside a 302 px viewport (route probe, 2026-07-29): the user had to scroll a
  // ribbon sideways to discover that "Диагностика" or "Лицензии" even exist. Every mainstream
  // mobile client presents settings as a vertical list of sections that you drill into, so that
  // is what this screen does now. `null` is the index; a Tab value is an open section.
  let tab: Tab | null = deps.initialSection === "settings" ? "settings" : null;
  let disposed = false;
  // Every tab render owns one lifecycle generation. Async work may finish after the user has already
  // switched tabs (or destroyed Settings); only the current generation is allowed to touch shared DOM.
  let renderGeneration = 0;
  let accountAvatarBinding: AvatarImageBinding | null = null;
  let profileAvatarBinding: AvatarImageBinding | null = null;
  const isCurrent = (generation: number): boolean =>
    !disposed && generation === renderGeneration;
  let helpView: SupportHelpView | null = null; // T-512: the mounted «Помощь» view, if any
  let safetyView: SafetyScreen | null = null;
  let devicesView: ReturnType<typeof createDevicesScreen> | null = null;

  let telegramView: TelegramSettingsView | null = null; // T-452: live connector auth/settings view

  const root = el("div", { class: "gc-settings" });
  const panel = el("div", { class: "gc-settings-panel" });
  const status = el("p", { class: "gc-settings-status", role: "status", "aria-live": "polite" });

  const backBtn = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.back") }, [icon("back")]);
  // The row keeps role="tab" and the .gc-tab class deliberately: the accessible name and the
  // existing end-to-end selectors are a contract, and a vertical tablist is a valid ARIA pattern
  // (aria-orientation="vertical"). Only the presentation changed — icon, label, chevron.
  const tabLabels = new Map<Tab, string>();
  const tabBtn = (t: Tab, labelKey: string, glyph: IconName): HTMLElement => {
    tabLabels.set(t, i18n.t(labelKey));
    // `data-tab` is the machine contract. The visible label is product copy and MUST stay free to
    // change (the "settings" section was renamed «Настройки» -> «Общие» because a section may not
    // repeat the title of the screen containing it); end-to-end tests that matched the old label
    // silently turned that rename into a red CI stage. Selectors now key off this stable id instead.
    const b = el("button", { type: "button", class: "gc-tab gc-nav-row", role: "tab", "data-tab": t }, [
      el("span", { class: "gc-nav-row-icon", "aria-hidden": "true" }, [icon(glyph)]),
      el("span", { class: "gc-nav-row-label" }, [i18n.t(labelKey)]),
      el("span", { class: "gc-nav-row-chevron", "aria-hidden": "true" }, [icon("chevron")]),
    ]);
    b.addEventListener("click", () => {
      if (tab === t) return;
      tab = t;
      renderTab();
    });
    return b;
  };
  const profileTab = tabBtn("profile", "settings.tabProfile", "user");
  const settingsTab = tabBtn("settings", "settings.tabSettings", "settings");
  const privacyTab = tabBtn("privacy", "settings.tabPrivacy", "lock");
  const devicesTab = tabBtn("devices", "settings.tabDevices", "devices");
  const safetyTab = deps.safety ? tabBtn("safety", "settings.tabSafety", "shield") : null;
  // T-452: external connections only exist when a native connector port is present.
  const connectionsTab = deps.telegram ? tabBtn("connections", "settings.tabConnections", "globe") : null;
  // T-418: the diagnostics tab exists only when the shell wired a consent port.
  const diagnosticsTab = deps.diagnostics ? tabBtn("diagnostics", "settings.tabDiagnostics", "info") : null;
  // T-512: the help tab exists only when the shell wired a support port.
  const helpTab = deps.support ? tabBtn("help", "settings.tabHelp", "help") : null;

  // AGPL/GPL appropriate legal notices are always reachable from the interactive Settings menu.
  const licensesTab = tabBtn("licenses", "settings.tabLicenses", "file");
  const tabList = [
    profileTab,
    settingsTab,
    privacyTab,
    devicesTab,
    ...(safetyTab ? [safetyTab] : []),
    ...(connectionsTab ? [connectionsTab] : []),
    ...(diagnosticsTab ? [diagnosticsTab] : []),
    ...(helpTab ? [helpTab] : []),
    licensesTab,
  ];

  // The index title must be the name the user tapped. With a hub the tab bar says «Ещё» and the screen
  // is more than settings, so a header reading «Настройки» would rename the destination mid-tap; the
  // settings-only variant (no hub ports at all) keeps its old title.
  const indexTitle = deps.hub ? i18n.t("shell.more") : i18n.t("settings.title");
  const headerTitle = el("h1", { class: "gc-settings-title" }, [indexTitle]);
  const header = el("header", { class: "gc-settings-header" }, [backBtn, headerTitle]);
  // The settings INDEX opened straight onto seven identical grey rows. Every mainstream messenger
  // opens its settings on the account itself — picture, name, handle — because that is the one thing
  // the user came to check or change, and because a screen that starts with an identity reads as an
  // account and not as a link menu. The card is a shortcut into the same "profile" section the first
  // row already opens, so nothing new becomes reachable; only the entry point stops being anonymous.
  // V76: while /v1/me is in flight the card used to draw a green disc containing a literal "?" beside
  // the word «Загрузка…» — a question mark reads as "we do not know who you are", which is exactly
  // the wrong thing for the account card to say. It now shimmers in the shape of the real card.
  const accountAvatar = el("div", { class: "gc-avatar gc-account-card-avatar is-loading", "aria-hidden": "true" }, []);
  const accountName = el("div", { class: "gc-account-card-name" }, [skeletonLine("is-title")]);
  const accountHandle = el("div", { class: "gc-account-card-handle" }, []);
  const accountCard = el("button", {
    type: "button",
    class: "gc-account-card",
    title: i18n.t("settings.tabProfile"),
  }, [
    accountAvatar,
    el("div", { class: "gc-account-card-copy" }, [accountName, accountHandle]),
    el("span", { class: "gc-account-card-chevron", "aria-hidden": "true" }, [icon("chevron")]),
  ]);
  accountCard.addEventListener("click", () => {
    if (tab === "profile") return;
    tab = "profile";
    renderTab();
  });
  const nav = el("nav", {
    class: "gc-settings-nav",
    role: "tablist",
    "aria-orientation": "vertical",
  }, tabList);
  // The service hub. Tiles come first because they are destinations of their own; the settings
  // sections keep their list form under a group heading, so the screen reads "what this app can do"
  // before "how it is configured" instead of being a table of contents with nothing in it.
  const hubItems = deps.hub?.items ?? [];
  const services = hubItems.length > 0
    ? el("section", { class: "gc-more-services", "aria-label": i18n.t("more.services") }, [
        el("h2", { class: "gc-more-group" }, [i18n.t("more.services")]),
        el("div", { class: "gc-more-grid" }, hubItems.map((item) => {
          const tile = el("button", {
            type: "button",
            class: "gc-more-tile",
            "data-service": item.id,
            title: item.label,
          }, [
            el("span", {
              class: "gc-more-tile-icon",
              "data-tone": item.tone ?? "brand",
              "aria-hidden": "true",
            }, [icon(item.glyph)]),
            el("span", { class: "gc-more-tile-label" }, [item.label]),
            ...(item.hint ? [el("span", { class: "gc-more-tile-hint" }, [item.hint])] : []),
          ]);
          tile.addEventListener("click", () => item.open());
          return tile;
        })),
      ])
    : null;
  const settingsGroup = services
    ? el("h2", { class: "gc-more-group" }, [i18n.t("more.settingsGroup")])
    : null;
  // One extra GET on entering settings, and a failure is silent: an unreachable /v1/users/me must
  // degrade the card back to the session-free placeholder, never to an error screen over a list of
  // sections that all still work offline.
  const index = el("div", { class: `gc-settings-index${services ? " is-hub" : ""}` }, [
    accountCard,
    ...(services ? [services] : []),
    ...(settingsGroup ? [settingsGroup] : []),
    nav,
  ]);
  void (async () => {
    let me: Me;
    try {
      me = await api.get<Me>("/v1/users/me");
    } catch {
      if (!disposed) index.removeChild(accountCard);
      return;
    }
    if (disposed) return;
    const display = me.name?.trim() || me.username;
    accountAvatar.classList.remove("is-loading");
    accountAvatar.textContent = initials(display);
    accountAvatar.setAttribute("data-tone", String(avatarTone(me.name || me.username)));
    accountAvatarBinding = bindAvatarImage(accountAvatar, api, me.avatar_file_id, display);
    accountName.textContent = display;
    accountHandle.textContent = `@${me.username}`;
  })();
  root.append(header, index, status, panel);
  // Back is now two-level: inside a section it returns to the index, on the index it leaves
  // Settings. Without this the only way out of a section would be the shell's own back gesture.
  backBtn.addEventListener("click", () => {
    if (tab !== null) {
      tab = null;
      renderTab();
      return;
    }
    deps.onBack();
  });

  // A settings row bound to an async commit; on failure it reverts and shows the error.
  //
  // Presentation (V5): the row reads "label … current value ›" like every mainstream mobile client,
  // instead of stacking a full-width <select> box under a caption — that layout turned the settings
  // tab into a web form of ten identical dropdowns. Two-state (on/off) rows render a real switch.
  //
  // The native <select class="gc-select"> is DELIBERATELY kept in the DOM (visually collapsed onto the
  // row, opacity 0): it keeps keyboard/screen-reader semantics, opens the platform picker on touch, and
  // keeps the existing E2E contract (`.gc-setting-row select.gc-select`) working unchanged.
  const selectRow = (
    generation: number,
    labelText: string,
    value: string,
    options: readonly string[],
    optLabel: (v: string) => string,
    commit: (v: string) => Promise<void>,
  ): HTMLElement => {
    const sel = el("select", { class: "gc-select" }) as HTMLSelectElement;
    for (const opt of options) {
      const o = el("option", { value: opt }, [optLabel(opt)]) as HTMLOptionElement;
      if (opt === value) o.selected = true;
      sel.append(o);
    }
    const isToggle = options.length === 2 && options.includes("true") && options.includes("false");
    let shown = value; // last value the commit confirmed — where we revert on failure

    const valueEl = el("span", { class: "gc-setting-value" }, [optLabel(value)]);
    const control = isToggle
      ? el("span", { class: "gc-switch", "aria-hidden": "true" }, [el("span", { class: "gc-switch-knob" })])
      : el("span", { class: "gc-setting-chevron", "aria-hidden": "true" }, [icon("chevron")]);
    const row = el("label", {
      class: isToggle ? "gc-setting-row is-toggle" : "gc-setting-row is-picker",
    }, [
      el("span", { class: "gc-setting-label" }, [labelText]),
      ...(isToggle ? [] : [valueEl]),
      control,
      sel,
    ]);
    if (isToggle && value === "true") row.classList.add("is-on");

    const apply = async (next: string): Promise<void> => {
      if (next === shown) return;
      sel.disabled = true;
      if (isToggle) row.classList.toggle("is-on", next === "true");
      else valueEl.textContent = optLabel(next);
      try {
        await commit(next);
        if (!isCurrent(generation)) return;
        shown = next;
        status.textContent = "";
      } catch (err) {
        if (!isCurrent(generation)) return;
        sel.value = shown;
        if (isToggle) row.classList.toggle("is-on", shown === "true");
        else valueEl.textContent = optLabel(shown);
        status.textContent = describeError(err, i18n);
      } finally {
        if (isCurrent(generation)) sel.disabled = false;
      }
    };

    sel.addEventListener("change", () => { void apply(sel.value); });
    if (isToggle) {
      // Tapping a switch must flip it, not open a two-item platform picker.
      row.addEventListener("click", (ev) => {
        const target = ev.target as Node | null;
        if (target === sel) return;
        ev.preventDefault();
        const next = shown === "true" ? "false" : "true";
        sel.value = next;
        void apply(next);
      });
    }
    return row;
  };

  // ---- Profile ---------------------------------------------------------
  // T-503 — the display-currency picker lives in the Profile tab, where `me` is already loaded. Source of
  // truth is the SERVER (BANKING §4): a change PUTs /v1/me/currency (204 → null) and we reflect the new
  // code back onto `me`. List mode is a native <select> over every ISO-4217 code; when the runtime lacks
  // Intl.supportedValuesOf we degrade to a validated 3-letter manual input (same server-side check). The
  // write prefers the typed SDK shortcut (api.putMyCurrency) and falls back to a raw PUT for fakes.
  const putCurrency = (code: string): Promise<null> =>
    api.putMyCurrency ? api.putMyCurrency(code) : api.put<null>("/v1/me/currency", { currency: code });

  const currencySection = (me: Me, generation: number): HTMLElement => {
    const current = me.display_currency ?? "USD";
    const label = el("span", { class: "gc-field-label" }, [i18n.t("settings.currency")]);
    const codes = listSupportedCurrencies();

    if (codes) {
      // Keep the current code selectable even if the runtime list omits it (e.g. a legacy stored code).
      const options = codes.includes(current) ? codes : [current, ...codes];
      const tag = currencyLocaleTag(i18n.locale);
      const sel = el("select", { class: "gc-select" }) as HTMLSelectElement;
      for (const code of options) {
        const o = el("option", { value: code }, [currencyLabel(code, tag)]) as HTMLOptionElement;
        if (code === current) o.selected = true;
        sel.append(o);
      }
      let shown = current; // last value the server confirmed — where we revert on failure
      // Same treatment as the Settings tab pickers: a row that reads "Currency — USD ›" with the
      // native <select> kept in the DOM (collapsed onto the row) for keyboard, screen-reader and
      // platform-picker behaviour. A bare full-width <select> box under a caption was the last
      // remaining place where the profile still looked like an HTML form.
      const valueEl = el("span", { class: "gc-setting-value" }, [currencyLabel(current, tag)]);
      sel.addEventListener("change", async () => {
        const next = sel.value;
        sel.disabled = true;
        try {
          await putCurrency(next);
          if (!isCurrent(generation)) return;
          me.display_currency = next;
          shown = next;
          valueEl.textContent = currencyLabel(next, tag);
          status.textContent = i18n.t("settings.saved");
        } catch (err) {
          if (!isCurrent(generation)) return;
          sel.value = shown;
          valueEl.textContent = currencyLabel(shown, tag);
          status.textContent = describeError(err, i18n);
        } finally {
          if (isCurrent(generation)) sel.disabled = false;
        }
      });
      return el("label", { class: "gc-setting-row is-picker" }, [
        el("span", { class: "gc-setting-label" }, [i18n.t("settings.currency")]),
        valueEl,
        el("span", { class: "gc-setting-chevron", "aria-hidden": "true" }, [icon("chevron")]),
        sel,
      ]);
    }

    // Manual mode: a 3-letter text input + Save (runtime without Intl.supportedValuesOf).
    const input = el("input", {
      type: "text", class: "gc-input", value: current, maxlength: 3, autocapitalize: "characters",
      "aria-label": i18n.t("settings.currency"),
    }) as HTMLInputElement;
    const saveBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.save")]);
    saveBtn.addEventListener("click", async () => {
      const code = normalizeCurrencyInput(input.value);
      if (!isValidCurrencyCode(code)) {
        if (isCurrent(generation))
          status.textContent = i18n.t("settings.currencyInvalid");
        return;
      }
      input.value = code;
      saveBtn.setAttribute("disabled", "");
      try {
        await putCurrency(code);
        if (!isCurrent(generation)) return;
        me.display_currency = code;
        status.textContent = i18n.t("settings.saved");
      } catch (err) {
        if (!isCurrent(generation)) return;
        status.textContent = describeError(err, i18n);
      } finally {
        if (isCurrent(generation)) saveBtn.removeAttribute("disabled");
      }
    });
    return el("div", { class: "gc-field" }, [label, el("div", { class: "gc-currency-manual" }, [input, saveBtn])]);
  };

  const renderProfile = async (generation: number): Promise<void> => {
    clear(panel);
    panel.append(el("p", { class: "gc-settings-status" }, [i18n.t("common.loading")]));
    let me: Me;
    try {
      me = await api.get<Me>("/v1/users/me");
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      // V160: one grey line used to be the whole answer here — and offline that line was
      // «Действие поставлено в очередь.», which is a write's sentence: a failed LOAD queues nothing.
      // With no control on the panel the only way to try again was to leave Settings and come back.
      panel.append(failureState(err, i18n, () => renderTab()));
      return;
    }
    if (!isCurrent(generation)) return;
    clear(panel);

    const nameInput = el("input", { type: "text", class: "gc-input", value: me.name, maxlength: 128 }) as HTMLInputElement;
    const bioInput = el("textarea", { class: "gc-input gc-textarea", maxlength: 280, rows: 3 }) as HTMLTextAreaElement;
    bioInput.value = me.bio;
    const saveBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("common.save")]);
    saveBtn.addEventListener("click", async () => {
      saveBtn.setAttribute("disabled", "");
      try {
        await api.patch<Me>("/v1/users/me", {
          name: nameInput.value.trim(),
          bio: bioInput.value.trim(),
        });
        if (!isCurrent(generation)) return;
        status.textContent = i18n.t("settings.saved");
      } catch (err) {
        if (!isCurrent(generation)) return;
        status.textContent = describeError(err, i18n);
      } finally {
        if (isCurrent(generation)) saveBtn.removeAttribute("disabled");
      }
    });

    // A profile page with no picture and no name — just a grey "@handle" line — was the single most
    // dated thing in the app. The hero reuses the same deterministic peer colour as the chat list and
    // the conversation header, so one person looks identical everywhere.
    // V168: the same rule as the people-search, from the same module. A viewer who never set a display
    // name saw their own handle printed twice, stacked — "qa1785731573" over "@qa1785731573" — because
    // the hero name fell back to the username while the line below it always drew "@username". The
    // avatar keeps hashing the BARE seed: initials("@bob") is "@", which costs them their letter.
    // V179: the @handle is a control, not selectable decoration. One tap copies exactly what is shown;
    // when there is no display name the same control becomes the hero title instead of duplicating it.
    const label = personLabel(me);
    const handle = `@${me.username}`;
    const copyHandle = el("button", {
      type: "button",
      class: label.subtitle
        ? "gc-profile-id gc-profile-username gc-link"
        : "gc-profile-heroname gc-profile-username gc-link",
      title: i18n.t("settings.copyUsername", { username: handle }),
      "aria-label": i18n.t("settings.copyUsername", { username: handle }),
    }, [handle]) as HTMLButtonElement;
    copyHandle.addEventListener("click", () => {
      if (!copyText) {
        status.textContent = i18n.t("feed.copyUnavailable");
        return;
      }
      void copyText(handle).then(
        () => {
          if (isCurrent(generation)) status.textContent = i18n.t("feed.copied");
        },
        () => {
          if (isCurrent(generation)) status.textContent = i18n.t("feed.copyUnavailable");
        },
      );
    });
    const avatar = el("div", { class: "gc-avatar gc-profile-avatar", "data-tone": String(avatarTone(label.avatarSeed)) }, [
      initials(label.avatarSeed),
    ]);
    profileAvatarBinding?.destroy();
    profileAvatarBinding = bindAvatarImage(avatar, api, me.avatar_file_id, label.title);
    const avatarInput = el("input", {
      type: "file",
      class: "gc-visually-hidden gc-avatar-file",
      accept: "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif",
      "aria-label": avatarText(i18n.locale, "change"),
    }) as HTMLInputElement;
    const avatarButton = el("button", {
      type: "button",
      class: "gc-avatar-editor",
      title: avatarText(i18n.locale, "change"),
      "aria-label": avatarText(i18n.locale, "change"),
    }, [avatar, el("span", { class: "gc-avatar-editor-badge", "aria-hidden": "true" }, [icon("camera")])]);
    avatarButton.addEventListener("click", () => avatarInput.click());
    avatarInput.addEventListener("change", () => {
      const file = avatarInput.files?.[0];
      avatarInput.value = "";
      if (!file || !deps.media) return;
      avatarButton.setAttribute("disabled", "");
      status.textContent = i18n.t("common.loading");
      void (async () => {
        try {
          const uploaded = await uploadAvatarFile(file, deps.media as AvatarUploadPort);
          const saved = await api.post<Me>("/v1/users/me/avatar", { file_id: uploaded.file_id });
          if (!isCurrent(generation)) return;
          me.avatar_file_id = saved.avatar_file_id;
          await profileAvatarBinding?.set(saved.avatar_file_id);
          await accountAvatarBinding?.set(saved.avatar_file_id);
          status.textContent = i18n.t("settings.saved");
        } catch (err) {
          if (!isCurrent(generation)) return;
          const code = err instanceof Error ? err.message : "";
          status.textContent = code === "AVATAR_TOO_LARGE"
            ? avatarText(i18n.locale, "tooLarge")
            : code === "AVATAR_IMAGE_REQUIRED"
              ? avatarText(i18n.locale, "invalid")
              : describeError(err, i18n);
        } finally {
          if (isCurrent(generation)) avatarButton.removeAttribute("disabled");
        }
      })();
    });
    const hero = el("div", { class: "gc-profile-hero" }, [
      el("div", { class: "gc-profile-avatar-control" }, [avatarButton, avatarInput]),
      el("div", { class: "gc-profile-heronames" }, label.subtitle
        ? [el("div", { class: "gc-profile-heroname" }, [label.title]), copyHandle]
        : [copyHandle]),
    ]);

    panel.append(
      el("div", { class: "gc-profile" }, [
        hero,
        el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [i18n.t("settings.name")]), nameInput]),
        el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [i18n.t("settings.bio")]), bioInput]),
        // The currency picker is part of the same form, so "Save" must close the form, not sit in the
        // middle of it (V4 put a full-width green button above another field).
        currencySection(me, generation),
        saveBtn,
      ]),
    );
  };

  // ---- Settings --------------------------------------------------------
  const renderSettings = async (generation: number): Promise<void> => {
    clear(panel);
    panel.append(el("p", { class: "gc-settings-status" }, [i18n.t("common.loading")]));
    let map: SettingsMap;
    // T-531: the LOCAL notification display mode loads alongside the server map (port absent → no row;
    // a failing port falls back to the default rather than blocking the server-backed rows).
    const notifyPort = deps.notifyMode;
    const screenPrivacyPort = deps.screenPrivacy;
    const cachePolicyPort = deps.cachePolicy;
    const desktopSystemPort = deps.desktopSystem;
    const updateCheckPort = deps.updateCheck;
    const langPort = deps.language;
    let uiLangValue = UI_LANG_ITEM.def as string;
    if (langPort) {
      try { uiLangValue = normalizeUiLangValue(await langPort.get()); }
      catch { /* the local default remains usable */ }
      if (!isCurrent(generation)) return;
    }
    const languageRow = (): HTMLElement | null => langPort
      ? selectRow(
          generation,
          i18n.t("settings.language"),
          uiLangValue,
          UI_LANG_ITEM.options ?? [],
          (value) => i18n.t(`settings.opt.ui_lang.${value}`),
          async (value) => {
            const next = normalizeUiLangValue(value);
            uiLangValue = next;
            await langPort.set(next);
          },
        )
      : null;
    let notifyModeValue = NOTIFY_MODE_ITEM.def as string;
    let screenPrivacyValue = SCREEN_PRIVACY_ITEM.def as boolean;
    let desktopNotificationsValue = false;
    let desktopAutostartValue = false;
    let cacheRetentionValue: CacheRetentionMode = cachePolicyPort
      ? normalizeCacheRetention(cachePolicyPort.getGlobal())
      : "forever";
    try {
      const [res, localMode, localScreenPrivacy, localDesktopNotifications, localDesktopAutostart] = await Promise.all([
        api.get<{ settings: SettingsMap }>("/v1/users/me/settings"),
        notifyPort ? notifyPort.get().catch(() => NOTIFY_MODE_ITEM.def as string) : Promise.resolve(null),
        screenPrivacyPort ? screenPrivacyPort.get().catch(() => SCREEN_PRIVACY_ITEM.def as boolean) : Promise.resolve(null),
        desktopSystemPort ? desktopSystemPort.getNotifications().catch(() => false) : Promise.resolve(null),
        desktopSystemPort ? desktopSystemPort.getAutostart().catch(() => false) : Promise.resolve(null),
      ]);
      map = res.settings;
      if (typeof localMode === "string") notifyModeValue = normalizeNotifyModeValue(localMode);
      if (typeof localScreenPrivacy === "boolean") screenPrivacyValue = normalizeScreenPrivacyValue(localScreenPrivacy);
      if (typeof localDesktopNotifications === "boolean") desktopNotificationsValue = localDesktopNotifications;
      if (typeof localDesktopAutostart === "boolean") desktopAutostartValue = localDesktopAutostart;
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      // V160: one grey line used to be the whole answer here — and offline that line was
      // «Действие поставлено в очередь.», which is a write's sentence: a failed LOAD queues nothing.
      // With no control on the panel the only way to try again was to leave Settings and come back.
      panel.append(failureState(err, i18n, () => renderTab()));
      const offlineLanguage = languageRow();
      if (offlineLanguage) panel.append(el("div", { class: "gc-setting-list" }, [offlineLanguage]));
      return;
    }
    if (!isCurrent(generation)) return;
    clear(panel);

    const rows: HTMLElement[] = [];
    const localLanguage = languageRow();
    if (localLanguage) rows.push(localLanguage);
    for (const item of SETTINGS_ITEMS) {
      const label = i18n.t(`settings.key.${item.key}`);
      const commit = async (raw: string): Promise<void> => {
        const value: unknown = item.kind === "bool" ? raw === "true" : raw;
        const res = await api.patch<{ settings: SettingsMap }>(
          "/v1/users/me/settings",
          { [item.key]: value },
        );
        if (!isCurrent(generation)) return;
        map = res.settings;
        if (item.key === "ui_theme" && (value === "light" || value === "dark" || value === "system")) {
          deps.onUiTheme?.(value);
        }
      };
      if (item.kind === "bool") {
        const cur = settingValue(map, item) as boolean;
        rows.push(
          selectRow(
            generation,
            label,
            String(cur),
            ["true", "false"],
            (v) => i18n.t(v === "true" ? "common.on" : "common.off"),
            commit,
          ),
        );
      } else {
        const cur = settingValue(map, item) as string;
        rows.push(
          selectRow(
            generation,
            label,
            cur,
            item.options ?? [],
            (v) => i18n.t(`settings.opt.${item.key}.${v}`),
            commit,
          ),
        );
      }
    }
    // T-531: the notification display-mode row — same selectRow UX, but commit goes to the LOCAL port
    // (SW-readable storage), never to PATCH /v1/users/me/settings.
    if (notifyPort) {
      rows.push(
        selectRow(
          generation,
          i18n.t(`settings.key.${NOTIFY_MODE_ITEM.key}`),
          notifyModeValue,
          NOTIFY_MODE_ITEM.options ?? [],
          (v) => i18n.t(`settings.opt.${NOTIFY_MODE_ITEM.key}.${v}`),
          async (v) => {
            await notifyPort.set(normalizeNotifyModeValue(v));
            if (!isCurrent(generation)) return;
            notifyModeValue = normalizeNotifyModeValue(v);
          },
        ),
      );
    }
    if (screenPrivacyPort) {
      rows.push(
        selectRow(
          generation,
          i18n.t(`settings.key.${SCREEN_PRIVACY_ITEM.key}`),
          String(screenPrivacyValue),
          ["true", "false"],
          (v) => i18n.t(v === "true" ? "common.on" : "common.off"),
          async (v) => {
            const enabled = normalizeScreenPrivacyValue(v === "true");
            await screenPrivacyPort.set(enabled);
            if (!isCurrent(generation)) return;
            screenPrivacyValue = enabled;
          },
        ),
      );
    }
    if (desktopSystemPort) {
      rows.push(
        selectRow(
          generation,
          i18n.t("settings.desktopNotifications"),
          String(desktopNotificationsValue),
          ["true", "false"],
          (v) => i18n.t(v === "true" ? "common.on" : "common.off"),
          async (v) => {
            const enabled = v === "true";
            await desktopSystemPort.setNotifications(enabled);
            if (!isCurrent(generation)) return;
            desktopNotificationsValue = enabled;
          },
        ),
        selectRow(
          generation,
          i18n.t("settings.desktopAutostart"),
          String(desktopAutostartValue),
          ["true", "false"],
          (v) => i18n.t(v === "true" ? "common.on" : "common.off"),
          async (v) => {
            const enabled = v === "true";
            await desktopSystemPort.setAutostart(enabled);
            if (!isCurrent(generation)) return;
            desktopAutostartValue = enabled;
          },
        ),
      );
    }
    {
      const button = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [
        i18n.t("settings.checkUpdates"),
      ]);
      button.addEventListener("click", async () => {
        button.setAttribute("disabled", "");
        status.textContent = i18n.t("settings.checkingUpdates");
        try {
          if (updateCheckPort) {
            await updateCheckPort.check();
          } else {
            // Web/PWA fallback: reload the service worker update check.
            window.location.reload();
          }
          if (isCurrent(generation)) status.textContent = i18n.t("settings.updateCheckDone");
        } catch (err) {
          if (isCurrent(generation)) status.textContent = describeError(err, i18n);
        } finally {
          button.removeAttribute("disabled");
        }
      });
      rows.push(el("div", { class: "gc-setting-row" }, [button]));
    }
    if (cachePolicyPort) {
      rows.push(
        selectRow(
          generation,
          i18n.t("settings.key.cache_retention"),
          cacheRetentionValue,
          CACHE_RETENTION_OPTIONS,
          (v) => i18n.t(`settings.opt.cache_retention.${v}`),
          async (v) => {
            const mode = normalizeCacheRetention(v);
            await cachePolicyPort.setGlobal(mode);
            if (!isCurrent(generation)) return;
            cacheRetentionValue = mode;
          },
        ),
      );
    }
    panel.append(el("div", { class: "gc-setting-list" }, rows));
    if (deps.lock) {
      panel.append(createLockSettings({
        i18n,
        lock: deps.lock,
        status,
        rerender: () => renderTab(),
      }));
    }
  };

  // ---- Privacy ---------------------------------------------------------
  const renderPrivacy = async (generation: number): Promise<void> => {
    clear(panel);
    panel.append(el("p", { class: "gc-settings-status" }, [i18n.t("common.loading")]));
    let map: PrivacyMap;
    try {
      map = normalizePrivacy(await api.get<PrivacyMap>("/v1/privacy"));
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      // V160: one grey line used to be the whole answer here — and offline that line was
      // «Действие поставлено в очередь.», which is a write's sentence: a failed LOAD queues nothing.
      // With no control on the panel the only way to try again was to leave Settings and come back.
      panel.append(failureState(err, i18n, () => renderTab()));
      return;
    }
    if (!isCurrent(generation)) return;
    clear(panel);

    const rows: HTMLElement[] = [];
    for (const item of PRIVACY_ITEMS) {
      const label = i18n.t(`privacy.key.${item.key}`);
      const commit = async (v: string): Promise<void> => {
        const res = await api.put<PrivacyMap>("/v1/privacy", { [item.key]: v });
        if (!isCurrent(generation)) return;
        map = normalizePrivacy(res);
      };
      rows.push(
        selectRow(
          generation,
          label,
          map[item.key] ?? item.def,
          privacyOptions(item.kind),
          (v) => i18n.t(`privacy.val.${v}`),
          commit,
        ),
      );
    }
    panel.append(el("div", { class: "gc-setting-list" }, rows));
  };

  // ---- Diagnostics (T-418) ---------------------------------------------
  // A single opt-in switch (default OFF). Consent lives locally (the core Diagnostics controller); toggling
  // it turns anonymous crash + push-latency telemetry on or off. Turning it OFF also purges any local queue.
  const renderDiagnostics = async (generation: number): Promise<void> => {
    const port = deps.diagnostics;
    clear(panel);
    if (!port) return; // tab is unreachable without a port, but stay defensive
    panel.append(el("p", { class: "gc-settings-status" }, [i18n.t("common.loading")]));
    let on = false;
    try {
      on = await port.get();
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      // V160: one grey line used to be the whole answer here — and offline that line was
      // «Действие поставлено в очередь.», which is a write's sentence: a failed LOAD queues nothing.
      // With no control on the panel the only way to try again was to leave Settings and come back.
      panel.append(failureState(err, i18n, () => renderTab()));
      return;
    }
    if (!isCurrent(generation)) return;
    clear(panel);

    const toggle = el("input", { type: "checkbox", class: "gc-toggle" }) as HTMLInputElement;
    toggle.checked = on;
    toggle.addEventListener("change", async () => {
      const next = toggle.checked;
      toggle.disabled = true;
      try {
        await port.set(next);
        if (!isCurrent(generation)) return;
        on = next;
        status.textContent = i18n.t("settings.saved");
      } catch (err) {
        if (!isCurrent(generation)) return;
        toggle.checked = on; // revert to the last persisted value
        status.textContent = describeError(err, i18n);
      } finally {
        if (isCurrent(generation)) toggle.disabled = false;
      }
    });

    panel.append(
      el("div", { class: "gc-setting-list" }, [
        el("label", { class: "gc-setting-row" }, [
          el("span", { class: "gc-setting-label" }, [i18n.t("diagnostics.consentLabel")]),
          toggle,
        ]),
        el("p", { class: "gc-settings-note" }, [i18n.t("diagnostics.explain")]),
      ]),
    );
  };

  // ---- External connections (T-452) -----------------------------------
  const renderConnections = (): void => {
    clear(panel);
    telegramView?.destroy();
    telegramView = null;
    if (!deps.telegram) return;
    telegramView = createTelegramSettings({ port: deps.telegram, i18n, status });
    panel.append(telegramView.root);
  };

  // ---- Help (T-512) ----------------------------------------------------
  // The «Мои обращения» list + read-only ticket detail. It owns its own async loading/errors; we just
  // mount it and dispose the previous instance so a re-entry (or Settings teardown) cancels stale fetches.
  const renderHelp = async (generation: number): Promise<void> => {
    const port = deps.support;
    clear(panel);
    helpView?.destroy();
    helpView = null;
    if (!port) return; // unreachable without a port, but stay defensive
    panel.append(el("div", { class: "gc-setting-list" }, [skeletonLine("is-title"), skeletonLine()]));
    try {
      const { createSupportHelp } = await import("./support_help.ts");
      if (!isCurrent(generation) || tab !== "help") return;
      clear(panel);
      helpView = createSupportHelp({
        api, i18n, onOpenChat: port.onOpenChat,
        ...(deps.media ? { media: deps.media } : {}),
        ...(port.onContact ? { onContact: port.onContact } : {}),
        ...(port.status ? { status: port.status } : {}), // T-514: the service-status card probe
      });
      panel.append(helpView.root);
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      panel.append(failureState(err, i18n, () => renderTab()));
    }
  };

  // ---- Licenses / Corresponding Source --------------------------------
  const renderLicenses = (): void => {
    clear(panel);
    const openSource = el("a", {
      href: "/legal/open-source/",
      target: "_blank",
      rel: "noopener noreferrer",
      class: "gc-btn gc-btn-accent",
    }, [i18n.t("settings.licensesOpen")]);
    panel.append(el("section", { class: "gc-setting-list gc-licenses" }, [
      el("h2", {}, [i18n.t("settings.licensesTitle")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("settings.licensesCopyright")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("settings.licensesNoWarranty")]),
      el("p", { class: "gc-settings-note" }, [i18n.t("settings.licensesCopyleft")]),
      openSource,
    ]));
  };

  // ---- Devices / QR linking (V192) ------------------------------------
  const renderDevices = (): void => {
    clear(panel);
    devicesView?.destroy();
    devicesView = createDevicesScreen({ api, i18n });
    panel.append(devicesView.root);
  };

  const renderSafety = async (generation: number): Promise<void> => {
    clear(panel);
    safetyView?.destroy();
    safetyView = null;
    if (!deps.safety) return;
    panel.append(el("div", { class: "gc-setting-list" }, [skeletonLine("is-title"), skeletonLine()]));
    try {
      const { createSafetyScreen } = await import("./safety_screen.ts");
      if (!isCurrent(generation) || tab !== "safety") return;
      clear(panel);
      safetyView = createSafetyScreen({ api, i18n, ...deps.safety });
      panel.append(safetyView.root);
    } catch (err) {
      if (!isCurrent(generation)) return;
      clear(panel);
      panel.append(failureState(err, i18n, () => renderTab()));
    }
  };

  const renderTab = (): void => {
    const generation = ++renderGeneration;
    profileTab.classList.toggle("is-active", tab === "profile");
    settingsTab.classList.toggle("is-active", tab === "settings");
    privacyTab.classList.toggle("is-active", tab === "privacy");
    devicesTab.classList.toggle("is-active", tab === "devices");
    safetyTab?.classList.toggle("is-active", tab === "safety");
    connectionsTab?.classList.toggle("is-active", tab === "connections");
    diagnosticsTab?.classList.toggle("is-active", tab === "diagnostics");
    helpTab?.classList.toggle("is-active", tab === "help");

    licensesTab.classList.toggle("is-active", tab === "licenses");
    profileTab.setAttribute("aria-selected", String(tab === "profile"));
    settingsTab.setAttribute("aria-selected", String(tab === "settings"));
    privacyTab.setAttribute("aria-selected", String(tab === "privacy"));
    devicesTab.setAttribute("aria-selected", String(tab === "devices"));
    safetyTab?.setAttribute("aria-selected", String(tab === "safety"));
    connectionsTab?.setAttribute("aria-selected", String(tab === "connections"));
    diagnosticsTab?.setAttribute(
      "aria-selected",
      String(tab === "diagnostics"),
    );
    helpTab?.setAttribute("aria-selected", String(tab === "help"));

    licensesTab.setAttribute("aria-selected", String(tab === "licenses"));
    // Leaving Help: dispose its view so its in-flight fetches can't paint into a detached panel.
    if (tab !== "profile" && profileAvatarBinding) {
      profileAvatarBinding.destroy();
      profileAvatarBinding = null;
    }
    if (tab !== "help" && helpView) {
      helpView.destroy();
      helpView = null;
    }
    if (tab !== "safety" && safetyView) {
      safetyView.destroy();
      safetyView = null;
    }
    if (tab !== "devices" && devicesView) {
      devicesView.destroy();
      devicesView = null;
    }
    if (tab !== "connections" && telegramView) {
      telegramView.destroy();
      telegramView = null;
    }
    status.textContent = "";
    // Index vs section: exactly one of the two is in the layout at a time, and the header title
    // names where the user is. The section list stays mounted (cheap, static) so returning to it
    // is instant and keeps scroll position.
    index.hidden = tab !== null;
    panel.hidden = tab === null;
    headerTitle.textContent = tab === null ? indexTitle : (tabLabels.get(tab) ?? indexTitle);
    backBtn.title = tab === null ? i18n.t("common.back") : i18n.t("settings.title");
    // On the index of a tab destination the arrow would point at nothing: the shell's own tab bar is
    // the way out, and a dead control in the top-left corner is exactly the "old" chrome this
    // redesign removes. Inside a section it is the only way up, so it comes back.
    backBtn.hidden = deps.atShellRoot === true && tab === null;
    if (tab === null) {
      clear(panel);
      return;
    }
    if (tab === "profile") void renderProfile(generation);
    else if (tab === "settings") void renderSettings(generation);
    else if (tab === "privacy") void renderPrivacy(generation);
    else if (tab === "devices") renderDevices();
    else if (tab === "safety") void renderSafety(generation);
    else if (tab === "connections") renderConnections();
    else if (tab === "diagnostics") void renderDiagnostics(generation);
    else if (tab === "help") void renderHelp(generation);
    else renderLicenses();
  };

  renderTab();

  return {
    root,
    // Navigating to Settings while Settings is already the live screen (bottom bar, account button,
    // #/settings link) returns to the section index instead of silently doing nothing inside whatever
    // section was left open. No-op when the index is already showing, so it never costs a re-render.
    reset() {
      if (disposed || tab === null) return;
      tab = null;
      renderTab();
    },
    destroy() {
      disposed = true;
      renderGeneration += 1;
      helpView?.destroy();
      helpView = null;
      safetyView?.destroy();
      safetyView = null;
      devicesView?.destroy();
      devicesView = null;
      telegramView?.destroy();
      telegramView = null;
      accountAvatarBinding?.destroy();
      accountAvatarBinding = null;
      profileAvatarBinding?.destroy();
      profileAvatarBinding = null;
    },
  };
}

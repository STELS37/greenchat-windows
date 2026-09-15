// SPDX-License-Identifier: AGPL-3.0-or-later
import { createGamerModeScreen, type GamerModeScreen } from "./gamer_mode_screen.ts";
import { gamingExternalUrl, gamingProfile, validateGamingState, type GamingSettings, type GamingState } from "./gaming_model.ts";
import { el } from "../dom.ts";
import { createEpicLibrary, type EpicLibraryPort } from "./epic_library.ts";
import { createProviderConnection, type ProviderConnectionState } from "./provider_connection.ts";
import type { ApiLike } from "./api.ts";
import type { I18n } from "../i18n.ts";

export function createGamingScreen(deps: {
  api: ApiLike; i18n: I18n; self: { name: string; username: string }; onBack(): void;
  openExternal?(url: string): Promise<void> | void;
}): GamerModeScreen {
  const { api, i18n } = deps;
  const ru = i18n.locale.startsWith("ru");
  const copy = (a: string, b: string): string => ru ? a : b;
  const root = el("div", { class: "gc-gaming-page" });
  const host = el("div");
  const status = el("p", { class: "gc-gaming-status", role: "status", "aria-live": "polite" });
  const controls = el("div", { class: "gc-gaming-controls" });
  root.append(host, status, controls);
  const epicLibrary = createEpicLibrary(i18n.locale,
    (window as Window & { __gcEpicLibrary?: EpicLibraryPort }).__gcEpicLibrary);
  root.append(epicLibrary.root);
  let state: GamingState | null = null;
  let view: GamerModeScreen | null = null;
  let destroyed = false;
  let busy = false;
  let generation = 0;
  let fresh = false;
  let epicState: ProviderConnectionState | null = null;
  const epicConnection = createProviderConnection({ provider: "epic", locale: i18n.locale, api,
    ...(deps.openExternal ? { openExternal: deps.openExternal } : {}),
    onChange(next) { epicState = next; if (!destroyed) render(); },
  });

  const open = async (url: string, provider: "steam" | "faceit" | "epic", auth = false): Promise<void> => {
    const safe = gamingExternalUrl(url, provider, auth);
    if (deps.openExternal) await deps.openExternal(safe);
    else {
      const native = (window as Window & { __gcOpenGamingExternal?: (url: string) => Promise<void> }).__gcOpenGamingExternal;
      if (native) await native(safe);
      else window.open(safe, "_blank", "noopener,noreferrer");
    }
  };
  const openProfile = (url: string, provider: "steam" | "faceit" | "epic"): void => {
    void open(url, provider).catch(() => { if (!destroyed) status.textContent = copy("Не удалось открыть браузер.", "Could not open the browser."); });
  };

  async function run(operation: () => Promise<GamingState>, loading = false): Promise<void> {
    if (destroyed || busy) return;
    busy = true;
    const mine = ++generation;
    status.textContent = loading ? copy("Загрузка игрового профиля…", "Loading gaming profile…") : copy("Сохранение…", "Saving…");
    render();
    try {
      const next = validateGamingState(await operation());
      if (destroyed || mine !== generation) return;
      state = next;
      fresh = true;
      status.textContent = next.sync_errors?.length
        ? copy("Часть данных не обновилась. Показаны последние полученные данные.", "Some data could not be refreshed. Showing the last known values.") : "";
    } catch {
      if (destroyed || mine !== generation) return;
      fresh = false;
      status.textContent = copy("Не удалось подтвердить данные. Проверьте соединение и нажмите «Обновить».", "Could not confirm the data. Check your connection and select Refresh.");
    } finally {
      if (!destroyed && mine === generation) { busy = false; render(); }
    }
  }
  const read = (): Promise<GamingState> => api.get<GamingState>("/v1/gaming/me");
  const patch = (value: Partial<GamingSettings>): void => {
    if (fresh) void run(() => api.patch<GamingState>("/v1/gaming/me", value));
  };
  const linkSteam = (): void => {
    void run(async () => {
      const result = await api.get<{ url: string }>("/v1/gaming/connect/steam/start");
      if (!destroyed) await open(result.url, "steam", true);
      return read();
    });
  };
  const unlink = (provider: "steam" | "faceit"): void => {
    const message = provider === "steam"
      ? copy("Отключить Steam? Связанный FACEIT также будет отключён.", "Disconnect Steam? The associated FACEIT account will also be disconnected.")
      : copy("Отключить FACEIT?", "Disconnect FACEIT?");
    if (!window.confirm(message)) return;
    void run(async () => { await api.delete(`/v1/gaming/connections/${provider}`); return read(); });
  };
  function render(): void {
    const scroll = root.scrollTop;
    view?.destroy();
    const actionable = fresh && !busy;
    const steam = state?.profile.steam;
    const faceit = state?.profile.faceit;
    view = createGamerModeScreen({
      profile: { ...(state ? gamingProfile(state, deps.self, api) : deps.self), epic: { linked: !!epicState?.account } },
      epicConnection: epicConnection.root,
      locale: i18n.locale,
      initialEnabled: state?.settings.enabled ?? false,
      available: fresh,
      busy,
      onEnabledChange: enabled => patch({ enabled }),
      onBack: deps.onBack,
      ...(actionable && steam?.connected && steam.profile_url ? { onOpenSteam: () => openProfile(steam.profile_url!, "steam") }
        : actionable && state?.providers.steam.link_available ? { onOpenSteam: linkSteam } : {}),
      ...(actionable && faceit?.connected && faceit.profile_url ? { onOpenFaceit: () => openProfile(faceit.profile_url!, "faceit") }
        : actionable && state?.providers.faceit.link_available && !state.providers.faceit.requires_steam
          ? { onOpenFaceit: () => { void run(() => api.post<GamingState>("/v1/gaming/connect/faceit")); } } : {}),
      ...(actionable && steam?.connected ? { onUnlinkSteam: () => unlink("steam") } : {}),
      ...(actionable && faceit?.connected ? { onUnlinkFaceit: () => unlink("faceit") } : {}),
      onOpenEpic: () => openProfile("https://store.epicgames.com/", "epic"),
    });
    host.replaceChildren(view.root);
    controls.replaceChildren();
    const refresh = el("button", { type: "button", class: "gc-btn" }, [copy("Обновить", "Refresh")]) as HTMLButtonElement;
    refresh.disabled = busy;
    refresh.addEventListener("click", () => { void run(read, true); });
    controls.append(refresh);
    if (state) {
      const labels: Array<[keyof GamingSettings, string]> = [
        ["show_current_game", copy("Показывать текущую игру", "Show current game")],
        ["show_accounts", copy("Показывать игровые аккаунты", "Show gaming accounts")],
        ["show_faceit_rank", copy("Показывать ранг FACEIT", "Show FACEIT rank")],
      ];
      for (const [key, label] of labels) {
        const input = el("input", { type: "checkbox" }) as HTMLInputElement;
        input.checked = state.settings[key];
        input.disabled = !actionable;
        input.addEventListener("change", () => patch({ [key]: input.checked }));
        controls.append(el("label", {}, [input, label]));
      }
      if (state.providers.faceit.requires_steam) controls.append(el("p", {}, [copy("Для FACEIT сначала подключите Steam.", "Connect Steam first to use FACEIT.")]));
    }
    root.scrollTop = scroll;
  }
  const wake = (): void => { if (!destroyed && !busy && document.visibilityState !== "hidden") void run(read, true); };
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  const timer = setInterval(wake, 60_000);
  void run(read, true);
  return { root, destroy() {
    destroyed = true; generation++;
    clearInterval(timer);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", wake);
    view?.destroy();
    root.remove();
    epicLibrary.destroy();
    epicConnection.destroy();
  } };
}

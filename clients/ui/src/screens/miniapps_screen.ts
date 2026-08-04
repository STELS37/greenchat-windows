import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { describeError } from "./api.ts";
import {
  parseMiniAppAnalytics,
  type MiniAppAnalytics,
  type MiniAppScope,
  type MiniAppView,
  type OwnedBotListItem,
} from "./miniapps_model.ts";
import { miniAppScopeText, miniAppsText } from "./miniapps_strings.ts";

export interface MiniAppsScreenDeps {
  api: ApiLike;
  i18n: I18n;
  onBack(): void;
  onOpen(appId: number): void;
}

type Mode = "catalog" | "mine";

export function createMiniAppsScreen(deps: MiniAppsScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const root = el("main", { class: "gc-miniapps" });
  let mode: Mode = "catalog";
  let loading = true;
  let busy = false;
  let error = "";
  let notice = "";
  let catalog: MiniAppView[] = [];
  let mine: MiniAppView[] = [];
  let bots: OwnedBotListItem[] = [];
  let editing: MiniAppView | null = null;
  let formOpen = false;
  let destroyed = false;
  const analyticsByApp = new Map<number, MiniAppAnalytics>();
  const analyticsOpen = new Set<number>();
  const analyticsLoading = new Set<number>();
  const analyticsFailed = new Set<number>();

  const t = (key: Parameters<typeof miniAppsText>[1]): string => miniAppsText(i18n.locale, key);

  const load = async (): Promise<void> => {
    loading = true;
    error = "";
    render();
    try {
      const [catalogResult, mineResult, botResult] = await Promise.all([
        api.get<{ apps: MiniAppView[] }>("/v1/miniapps/catalog"),
        api.get<{ apps: MiniAppView[] }>("/v1/miniapps/mine"),
        api.get<{ bots: OwnedBotListItem[] }>("/v1/bots"),
      ]);
      if (destroyed) return;
      catalog = catalogResult.apps;
      mine = mineResult.apps;
      bots = botResult.bots;
    } catch (err) {
      if (destroyed) return;
      error = describeError(err, i18n);
    } finally {
      if (!destroyed) {
        loading = false;
        render();
      }
    }
  };

  const statusLabel = (status: MiniAppView["status"]): string => t(status);

  const renderScopeList = (scopes: MiniAppScope[]): HTMLElement =>
    el("ul", { class: "gc-miniapp-scopes" }, scopes.map((scope) =>
      el("li", {}, [miniAppScopeText(i18n.locale, scope)]),
    ));

  const loadAnalytics = async (appId: number): Promise<void> => {
    if (analyticsLoading.has(appId)) return;
    analyticsLoading.add(appId);
    analyticsFailed.delete(appId);
    render();
    try {
      const raw = await api.get<unknown>(`/v1/miniapps/${appId}/analytics?days=30`);
      const parsed = parseMiniAppAnalytics(raw, appId);
      if (!parsed) throw new Error("invalid mini app analytics payload");
      analyticsByApp.set(appId, parsed);
    } catch {
      analyticsByApp.delete(appId);
      analyticsFailed.add(appId);
    } finally {
      analyticsLoading.delete(appId);
      if (!destroyed) render();
    }
  };

  const toggleAnalytics = (appId: number): void => {
    if (analyticsOpen.has(appId)) {
      analyticsOpen.delete(appId);
      render();
      return;
    }
    analyticsOpen.add(appId);
    render();
    void loadAnalytics(appId);
  };

  const analyticsPanel = (appId: number): HTMLElement => {
    if (analyticsLoading.has(appId)) {
      return el("section", { class: "gc-miniapp-analytics is-loading", "aria-live": "polite" }, [t("loading")]);
    }
    if (analyticsFailed.has(appId)) {
      const retry = el("button", { type: "button", class: "gc-btn" }, [t("retry")]);
      retry.addEventListener("click", () => void loadAnalytics(appId));
      return el("section", { class: "gc-miniapp-analytics is-error", role: "alert" }, [
        el("p", {}, [t("analyticsUnavailable")]),
        retry,
      ]);
    }
    const data = analyticsByApp.get(appId);
    if (!data) return el("section", { class: "gc-miniapp-analytics" });
    const totals = [
      [t("analyticsLaunches"), data.totals.launches],
      [t("analyticsChatLaunches"), data.totals.chat_launches],
      [t("analyticsGrants"), data.totals.grants],
      [t("analyticsVerifications"), data.totals.verifications],
    ] as const;
    const date = new Intl.DateTimeFormat(i18n.locale, { month: "short", day: "numeric" });
    const recent = data.daily.slice(-7);
    return el("section", { class: "gc-miniapp-analytics", "aria-label": t("analytics") }, [
      el("div", { class: "gc-miniapp-analytics-head" }, [
        el("div", {}, [el("h3", {}, [t("analytics")]), el("small", {}, [t("analyticsPeriod")])]),
        el("span", { class: "gc-miniapp-analytics-private" }, [icon("shield"), t("analyticsPrivacy")]),
      ]),
      el("dl", { class: "gc-miniapp-analytics-totals" }, totals.map(([label, value]) =>
        el("div", {}, [el("dt", {}, [label]), el("dd", {}, [String(value)])]),
      )),
      el("div", { class: "gc-miniapp-analytics-trend" }, [
        el("strong", {}, [t("analyticsTrend")]),
        el("ol", {}, recent.map((day) => el("li", {}, [
          el("time", { datetime: new Date(day.day_start * 1000).toISOString() }, [date.format(new Date(day.day_start * 1000))]),
          el("span", {}, [String(day.launches)]),
        ]))),
      ]),
    ]);
  };

  const appCard = (app: MiniAppView, owner: boolean): HTMLElement => {
    const badge = el("span", { class: `gc-miniapp-status is-${app.status}` }, [statusLabel(app.status)]);
    const actions: HTMLElement[] = [];
    if (app.status === "active") {
      const open = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [t("open")]);
      open.addEventListener("click", () => deps.onOpen(app.id));
      actions.push(open);
    }
    if (owner) {
      const analyticsButton = el("button", { type: "button", class: "gc-btn" }, [t("analytics")]);
      analyticsButton.addEventListener("click", () => toggleAnalytics(app.id));
      actions.push(analyticsButton);
      const edit = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.settings")]);
      edit.addEventListener("click", () => {
        editing = app;
        formOpen = true;
        notice = "";
        error = "";
        render();
      });
      actions.push(edit);
      if (app.status !== "active") {
        const publish = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [t("publish")]);
        publish.addEventListener("click", () => void mutate(async () => {
          await api.post(`/v1/miniapps/${app.id}/publish`, {});
          notice = t("published");
          await reloadQuiet();
        }));
        actions.push(publish);
      } else {
        const disable = el("button", { type: "button", class: "gc-btn gc-btn-danger" }, [t("disable")]);
        disable.addEventListener("click", () => void mutate(async () => {
          await api.delete(`/v1/miniapps/${app.id}`);
          notice = t("disabledDone");
          await reloadQuiet();
        }));
        actions.push(disable);
      }
    }
    return el("article", { class: "gc-miniapp-card" }, [
      el("div", { class: "gc-miniapp-card-head" }, [
        el("div", { class: "gc-miniapp-mark", "aria-hidden": true }, [icon("spark")]),
        el("div", { class: "gc-miniapp-card-copy" }, [
          el("div", { class: "gc-miniapp-title-line" }, [
            el("h2", { class: "gc-miniapp-card-title" }, [app.title]),
            badge,
          ]),
          el("p", { class: "gc-miniapp-bot" }, [`@${app.bot.username}`]),
        ]),
      ]),
      el("p", { class: "gc-miniapp-description" }, [app.description || app.bot.name]),
      renderScopeList(app.requested_scopes),
      el("div", { class: "gc-miniapp-actions" }, actions),
      ...(owner && analyticsOpen.has(app.id) ? [analyticsPanel(app.id)] : []),
    ]);
  };

  const reloadQuiet = async (): Promise<void> => {
    const [catalogResult, mineResult] = await Promise.all([
      api.get<{ apps: MiniAppView[] }>("/v1/miniapps/catalog"),
      api.get<{ apps: MiniAppView[] }>("/v1/miniapps/mine"),
    ]);
    catalog = catalogResult.apps;
    mine = mineResult.apps;
    if (editing) editing = mine.find((app) => app.id === editing?.id) ?? null;
  };

  const mutate = async (task: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    error = "";
    render();
    try {
      await task();
    } catch (err) {
      error = describeError(err, i18n);
    } finally {
      busy = false;
      if (!destroyed) render();
    }
  };

  const form = (): HTMLElement => {
    const botSelect = el("select", { class: "gc-input", disabled: Boolean(editing) || busy }) as HTMLSelectElement;
    for (const bot of bots) {
      const id = bot.bot_user_id ?? bot.id;
      const option = el("option", { value: String(id) }, [`${bot.name || bot.username} · @${bot.username}`]) as HTMLOptionElement;
      if (id === editing?.id) option.selected = true;
      botSelect.append(option);
    }
    const titleInput = el("input", {
      class: "gc-input",
      value: editing?.title ?? "",
      maxlength: 64,
      placeholder: t("titleField"),
      disabled: busy,
    }) as HTMLInputElement;
    const descriptionInput = el("textarea", {
      class: "gc-input gc-miniapp-textarea",
      maxlength: 512,
      placeholder: t("description"),
      disabled: busy,
    }) as HTMLTextAreaElement;
    descriptionInput.value = editing?.description ?? "";
    const urlInput = el("input", {
      class: "gc-input",
      type: "url",
      inputmode: "url",
      value: editing?.launch_url ?? "",
      placeholder: "https://app.example.com/",
      disabled: busy,
    }) as HTMLInputElement;

    const scopeChecks = new Map<MiniAppScope, HTMLInputElement>();
    const scopeRows = ([
      "user.basic",
      "theme",
      "chat.context",
      "clipboard.write",
      "payments.invoice",
    ] as MiniAppScope[]).map((scope) => {
      const check = el("input", {
        type: "checkbox",
        class: "gc-toggle",
        checked: scope === "user.basic" || scope === "theme" || editing?.requested_scopes.includes(scope),
        disabled: busy || scope === "user.basic" || scope === "theme",
      }) as HTMLInputElement;
      scopeChecks.set(scope, check);
      return el("label", { class: "gc-miniapp-scope-row" }, [
        check,
        el("span", {}, [miniAppScopeText(i18n.locale, scope)]),
      ]);
    });

    const save = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy || bots.length === 0 }, [t("saveDraft")]);
    save.addEventListener("click", () => void mutate(async () => {
      const botId = editing?.id ?? Number(botSelect.value);
      const scopes = [...scopeChecks.entries()].filter(([, input]) => input.checked).map(([scope]) => scope);
      const body = {
        ...(editing ? { if_version: editing.version } : { bot_user_id: botId }),
        title: titleInput.value,
        description: descriptionInput.value,
        launch_url: urlInput.value,
        scopes,
      };
      const saved = editing
        ? await api.patch<MiniAppView>(`/v1/miniapps/${botId}`, body)
        : await api.post<MiniAppView>("/v1/miniapps", body);
      notice = t("saved");
      editing = saved;
      await reloadQuiet();
    }));
    const cancel = el("button", { type: "button", class: "gc-btn", disabled: busy }, [t("cancel")]);
    cancel.addEventListener("click", () => {
      formOpen = false;
      editing = null;
      render();
    });

    return el("section", { class: "gc-miniapp-editor" }, [
      el("h2", { class: "gc-miniapp-section-title" }, [editing ? editing.title : t("create")]),
      el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [t("bot")]), botSelect]),
      el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [t("titleField")]), titleInput]),
      el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [t("description")]), descriptionInput]),
      el("label", { class: "gc-field" }, [el("span", { class: "gc-field-label" }, [t("launchUrl")]), urlInput]),
      el("fieldset", { class: "gc-miniapp-scope-field" }, [
        el("legend", {}, [t("scopes")]),
        ...scopeRows,
      ]),
      el("div", { class: "gc-miniapp-actions" }, [save, cancel]),
    ]);
  };

  const render = (): void => {
    clear(root);
    const back = el("button", { type: "button", class: "gc-icon-btn", title: t("back"), "aria-label": t("back") }, [icon("back")]);
    back.addEventListener("click", deps.onBack);
    const create = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy || bots.length === 0 }, [t("create")]);
    create.addEventListener("click", () => {
      editing = null;
      formOpen = true;
      mode = "mine";
      render();
    });
    root.append(el("header", { class: "gc-miniapp-header" }, [
      back,
      el("div", { class: "gc-miniapp-header-copy" }, [
        el("h1", { class: "gc-miniapp-page-title" }, [t("title")]),
        el("p", { class: "gc-miniapp-page-subtitle" }, [t("subtitle")]),
      ]),
      create,
    ]));

    const catalogTab = el("button", { type: "button", class: `gc-miniapp-tab${mode === "catalog" ? " is-active" : ""}` }, [t("catalog")]);
    const mineTab = el("button", { type: "button", class: `gc-miniapp-tab${mode === "mine" ? " is-active" : ""}` }, [t("myApps")]);
    catalogTab.addEventListener("click", () => { mode = "catalog"; formOpen = false; render(); });
    mineTab.addEventListener("click", () => { mode = "mine"; render(); });
    root.append(el("nav", { class: "gc-miniapp-tabs", "aria-label": t("title") }, [catalogTab, mineTab]));

    if (notice) root.append(el("p", { class: "gc-miniapp-notice", role: "status" }, [notice]));
    if (error) {
      const retry = el("button", { type: "button", class: "gc-btn" }, [t("retry")]);
      retry.addEventListener("click", () => void load());
      root.append(el("div", { class: "gc-miniapp-error", role: "alert" }, [el("span", {}, [error]), retry]));
    }
    if (loading) {
      root.append(el("div", { class: "gc-miniapp-loading" }, [t("loading")]));
      return;
    }
    if (formOpen && mode === "mine") root.append(form());
    const rows = mode === "catalog" ? catalog : mine;
    if (rows.length === 0) {
      root.append(el("section", { class: "gc-miniapp-empty" }, [
        el("div", { class: "gc-miniapp-empty-mark" }, [icon("spark")]),
        el("p", {}, [mode === "catalog" ? t("emptyCatalog") : t("emptyMine")]),
      ]));
      return;
    }
    root.append(el("section", { class: "gc-miniapp-grid" }, rows.map((app) => appCard(app, mode === "mine"))));
  };

  const relocalise = i18n.subscribe(() => render());
  void load();
  return {
    root,
    destroy() {
      destroyed = true;
      relocalise();
    },
  };
}

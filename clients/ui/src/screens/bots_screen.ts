// clients/ui/src/screens/bots_screen.ts — owner-facing Bot Center (BotFather equivalent).
// A user can create, discover and fully administer GreenChat bots without keeping plaintext tokens:
// profile, command menu, webhook status/configuration, credential rotation and terminal deletion.
// Tokens are deliberately rendered only after create/rotate and disappear once the user dismisses them.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { describeError, isNetworkError } from "./api.ts";
import { failureLine, failureState } from "./state_view.ts";
import { consumeBotCreateIntent } from "./bot_center_handoff.ts";

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotWebhookView {
  configured: boolean;
  enabled: boolean;
  url: string | null;
  cursor?: number;
  event_head?: number;
  fail_streak: number;
  next_retry_at: number | null;
  last_error: string | null;
  updated_at: number | null;
}

export interface BotDiscoveryView {
  listed: boolean;
  category: string;
  keywords: string[];
}

export interface OwnedBotView {
  id: number;
  bot_user_id: number;
  username: string;
  name: string;
  description: string;
  avatar_file_id: number | null;
  suspended: boolean;
  created_at: number;
  webhook: BotWebhookView;
  commands?: BotCommand[];
  // Optional while old cached responses are still being replaced after the granular-scope rollout.
  scopes?: string[];
  available_scopes?: string[];
  discovery?: BotDiscoveryView;
  discovery_categories?: string[];
}

interface BotAnalyticsView {
  period_days: number;
  sent_messages: number;
  active_chats: number;
  polls_created: number;
  media_messages: number;
  callbacks_received: number;
  reactions_received: number;
  memberships: number;
  daily: Array<{
    day: string;
    sent_messages: number;
    active_chats: number;
    polls_created: number;
  }>;
}

interface BotCreateResult {
  bot_user_id: number;
  username: string;
  token: string;
  bot: OwnedBotView;
}

interface TokenRotationResult {
  bot_user_id: number;
  token: string;
  rotated_at: number;
}

export interface BotsScreenDeps {
  api: ApiLike;
  i18n: I18n;
  onBack: () => void;
}

export interface BotCommandParseResult {
  commands: BotCommand[];
  errors: Array<{ line: number; reason: "format" | "duplicate" | "description" }>;
}

const COMMAND_RE = /^[a-z0-9_]{1,32}$/;

// Human-friendly editor format: one command per line, e.g. `/start — Start the bot`.
// The parser accepts a hyphen, en/em dash, colon or tab as a separator, but emits the canonical
// lowercase command token expected by the server. It never silently drops a malformed non-empty line.
export function parseBotCommands(text: string): BotCommandParseResult {
  const commands: BotCommand[] = [];
  const errors: BotCommandParseResult["errors"] = [];
  const seen = new Set<string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  lines.forEach((source, index) => {
    const line = source.trim();
    if (!line) return;
    const match = /^\/?([A-Za-z0-9_]{1,32})\s*(?:—|–|-|:|\t)\s*(.+)$/.exec(line);
    if (!match) {
      errors.push({ line: index + 1, reason: "format" });
      return;
    }
    const command = (match[1] ?? "").toLowerCase();
    const description = (match[2] ?? "").trim();
    if (!COMMAND_RE.test(command)) {
      errors.push({ line: index + 1, reason: "format" });
      return;
    }
    if (!description || description.length > 256) {
      errors.push({ line: index + 1, reason: "description" });
      return;
    }
    if (seen.has(command)) {
      errors.push({ line: index + 1, reason: "duplicate" });
      return;
    }
    seen.add(command);
    commands.push({ command, description });
  });
  return { commands, errors };
}

export function formatBotCommands(commands: BotCommand[]): string {
  return commands.map((item) => `/${item.command} — ${item.description}`).join("\n");
}

/**
 * Select the token text so the USER can copy it through the operating system's own menu.
 *
 * This replaces a "Copy token" button that wrote the token into the system clipboard through the
 * browser clipboard interface, with the legacy synchronous copy command as a fallback. That version
 * failed the forensic self-test — measured, not assumed:
 * `SMOKE-FORENSIC: FAIL: S23-no-unmanaged-clipboard: clients/ui/src/screens/bots_screen.ts`
 * (external CI run 20260802T203702Z on 30cfb258, forensic job exit 1). The gate at
 * scripts/forensic-selftest.mjs:174 forbids every runtime clipboard API across
 * clients/{core,ui,web}/src and clients/mobile/bridge — as a text scan, so its own vocabulary must
 * not be spelled out even in a comment — and the tree carries no managed clipboard helper to route
 * this through; clients/ui/src/screens/wallet_ops.ts:73 writes out the same decision for deposit
 * addresses. The reason applies with more force to a bot token than to an address: the token is a
 * bearer credential, the system clipboard is readable by every other installed app, it survives in
 * clipboard history, and it is captured by device backups.
 *
 * Selection is not a clipboard operation: nothing leaves the page until the user presses copy.
 */
function selectTokenText(node: HTMLElement): void {
  if (typeof document === "undefined") return;
  const view = globalThis as { getSelection?: () => Selection | null };
  const selection = view.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

type Mode = "list" | "create" | "detail";
type Confirmation = "rotate" | "delete" | "removeWebhook" | null;

type DetailDraft = {
  name: string;
  description: string;
  commands: string;
  webhookUrl: string;

  scopes: string[];
  discoveryListed: boolean;
  discoveryCategory: string;
  discoveryKeywords: string;
  webhookSecret: string;
};

type CreateDraft = { username: string; name: string; description: string };

export function createBotsScreen(deps: BotsScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const root = el("section", { class: "gc-bot-center" });
  let alive = true;
  let mode: Mode = consumeBotCreateIntent() ? "create" : "list";
  let bots: OwnedBotView[] = [];
  let selected: OwnedBotView | null = null;
  let analytics: BotAnalyticsView | null = null;
  let analyticsLoading = false;
  let analyticsError = "";
  let busy = false;
  let loading = true;
  let error = "";
  // The error of the LIST read specifically. `error` above is the write-side feedback line; a failed
  // read needs its own memory, because the answer differs by what is already on screen.
  let listError: unknown = null;
  // Only the newest owner-list read may publish. The create form is reachable while the initial GET
  // is still pending, and createBot starts a newer list read after POST succeeds; without a generation
  // guard the late pre-create snapshot can erase the newly proven bot from the list.
  let listEpoch = 0;
  let noticeKey = "";
  let confirmation: Confirmation = null;
  let oneTimeToken: { botId: number; value: string } | null = null;
  let createDraft: CreateDraft = { username: "", name: "", description: "" };
  let detailDraft: DetailDraft = {
    name: "",
    description: "",
    commands: "",
    webhookUrl: "",

    scopes: [],
    discoveryListed: false,
    discoveryCategory: "other",
    discoveryKeywords: "",
    webhookSecret: "",
  };

  const setError = (err: unknown): void => {
    error = describeError(err, i18n);
    noticeKey = "";
  };

  // Same failure, different sentence, because a READ that failed queued nothing. `describeError`
  // offline says «Действие поставлено в очередь.» — correct for a write, a lie for opening a bot.
  const setReadError = (err: unknown): void => {
    error = isNetworkError(err) ? i18n.t("state.offlineTitle") : describeError(err, i18n);
    noticeKey = "";
  };

  const resetFeedback = (): void => {
    error = "";
    noticeKey = "";
  };

  const syncDetailDraft = (bot: OwnedBotView): void => {
    detailDraft = {
      name: bot.name,
      description: bot.description,
      commands: formatBotCommands(bot.commands ?? []),
      webhookUrl: bot.webhook.url ?? "",
      scopes: [...(bot.scopes ?? [])],
      discoveryListed: bot.discovery?.listed === true,
      discoveryCategory: bot.discovery?.category ?? "other",
      discoveryKeywords: (bot.discovery?.keywords ?? []).join(", "),
      webhookSecret: "",
    };
  };

  const loadAnalytics = async (botId: number): Promise<void> => {
    analyticsLoading = true;
    analyticsError = "";
    render();
    try {
      const result = await api.get<BotAnalyticsView>(`/v1/bots/${botId}/analytics?days=30`);
      if (!alive || selected?.id !== botId) return;
      analytics = result;
    } catch (err) {
      if (!alive || selected?.id !== botId) return;
      analyticsError = failureLine(err, i18n);
    } finally {
      if (alive && selected?.id === botId) {
        analyticsLoading = false;
        render();
      }
    }
  };

  const loadBots = async (keepSelection = false): Promise<void> => {
    const epoch = ++listEpoch;
    loading = true;
    listError = null;
    resetFeedback();
    render();
    try {
      const result = await api.get<{ bots: OwnedBotView[] }>("/v1/bots");
      if (!alive || epoch !== listEpoch) return;
      bots = result.bots;
      if (keepSelection && selected) {
        const fresh = bots.find((bot) => bot.id === selected?.id) ?? null;
        selected = fresh;
      }
    } catch (err) {
      if (!alive || epoch !== listEpoch) return;
      listError = err;
      // Two different situations, two different answers. Nothing on screen yet -> renderList draws
      // the failure block with a retry. Rows already on screen -> keep them and say only that they
      // may be stale. Never `describeError` here: it says "the action was queued", which is a write's
      // sentence, and a failed list read queues nothing.
      // `listError` is the durable stale-data fact. Do not store it in transient feedback: navigating
      // into a bot and back calls resetFeedback(), but the owner still needs to know the list is old.
      error = "";
      noticeKey = "";
    } finally {
      if (alive && epoch === listEpoch) {
        loading = false;
        render();
      }
    }
  };

  const openBot = async (id: number): Promise<void> => {
    busy = true;
    resetFeedback();
    confirmation = null;
    render();
    try {
      const bot = await api.get<OwnedBotView>(`/v1/bots/${id}`);
      if (!alive) return;
      selected = bot;
      syncDetailDraft(bot);
      analytics = null;
      analyticsError = "";
      mode = "detail";
      void loadAnalytics(bot.id);
    } catch (err) {
      if (!alive) return;
      setReadError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const createBot = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const result = await api.post<BotCreateResult>("/v1/bots", {
        username: createDraft.username.trim(),
        name: createDraft.name.trim(),
        description: createDraft.description.trim(),
      });
      if (!alive) return;
      oneTimeToken = { botId: result.bot.id, value: result.token };
      // POST is authoritative even if the two follow-up reads fail. Publish the created bot into the
      // last-known list immediately; a failed refresh may mark it stale, but can never make it vanish.
      bots = [result.bot, ...bots.filter((bot) => bot.id !== result.bot.id)];
      selected = result.bot;
      syncDetailDraft(result.bot);
      createDraft = { username: "", name: "", description: "" };
      mode = "detail";
      noticeKey = "bots.created";
      await loadBots(true);
      if (!alive) return;
      // loadBots resets feedback because it is also the generic retry path. Restore the durable create
      // verdict before enriching the card; that GET is only a refresh and cannot redefine the POST.
      noticeKey = "bots.created";
      try {
        const detail = await api.get<OwnedBotView>(`/v1/bots/${result.bot.id}`);
        if (!alive) return;
        selected = detail;
        syncDetailDraft(detail);
        analytics = null;
        analyticsError = "";
        mode = "detail";
        void loadAnalytics(detail.id);
      } catch (err) {
        if (!alive) return;
        error = failureLine(err, i18n);
        noticeKey = "bots.created";
      }
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        loading = false;
        render();
      }
    }
  };

  const saveProfile = async (): Promise<void> => {
    if (!selected || busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const bot = await api.patch<OwnedBotView>(`/v1/bots/${selected.id}`, {
        name: detailDraft.name.trim(),
        description: detailDraft.description.trim(),
      });
      if (!alive) return;
      selected = bot;
      syncDetailDraft(bot);
      noticeKey = "bots.profileSaved";
      bots = bots.map((item) => (item.id === bot.id ? bot : item));
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const saveScopes = async (): Promise<void> => {
    if (!selected || busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const result = await api.put<{ scopes: string[]; available_scopes: string[] }>(
        `/v1/bots/${selected.id}/scopes`,
        { scopes: detailDraft.scopes },
      );
      if (!alive) return;
      const updated = {
        ...selected,
        scopes: result.scopes,
        available_scopes: result.available_scopes,
      };
      selected = updated;
      detailDraft.scopes = [...result.scopes];
      bots = bots.map((item) => (item.id === updated.id ? updated : item));
      noticeKey = "bots.scopesSaved";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const saveDiscovery = async (): Promise<void> => {
    if (!selected || busy) return;
    const keywords = detailDraft.discoveryKeywords
      .split(/[,\n]/)
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    busy = true;
    resetFeedback();
    render();
    try {
      const result = await api.put<{
        discovery: BotDiscoveryView;
        categories: string[];
      }>(`/v1/bots/${selected.id}/discovery`, {
        listed: detailDraft.discoveryListed,
        category: detailDraft.discoveryCategory,
        keywords,
      });
      if (!alive) return;
      const updated = {
        ...selected,
        discovery: result.discovery,
        discovery_categories: result.categories,
      };
      selected = updated;
      detailDraft.discoveryListed = result.discovery.listed;
      detailDraft.discoveryCategory = result.discovery.category;
      detailDraft.discoveryKeywords = result.discovery.keywords.join(", ");
      bots = bots.map((item) => (item.id === updated.id ? updated : item));
      noticeKey = "bots.discoverySaved";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const saveCommands = async (): Promise<void> => {
    if (!selected || busy) return;
    const parsed = parseBotCommands(detailDraft.commands);
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0];
      error = i18n.t(`bots.commandError.${first?.reason ?? "format"}`, { line: first?.line ?? 1 });
      noticeKey = "";
      render();
      return;
    }
    busy = true;
    resetFeedback();
    render();
    try {
      const result = await api.put<{ commands: BotCommand[] }>(`/v1/bots/${selected.id}/commands`, {
        commands: parsed.commands,
      });
      if (!alive) return;
      selected = { ...selected, commands: result.commands };
      detailDraft.commands = formatBotCommands(result.commands);
      noticeKey = "bots.commandsSaved";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const saveWebhook = async (): Promise<void> => {
    if (!selected || busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const webhook = await api.put<BotWebhookView>(`/v1/bots/${selected.id}/webhook`, {
        url: detailDraft.webhookUrl.trim(),
        secret: detailDraft.webhookSecret,
      });
      if (!alive) return;
      const updated = { ...selected, webhook };
      selected = updated;
      bots = bots.map((item) => (item.id === updated.id ? updated : item));
      detailDraft.webhookUrl = webhook.url ?? "";
      detailDraft.webhookSecret = "";
      confirmation = null;
      noticeKey = "bots.webhookSaved";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const removeWebhook = async (): Promise<void> => {
    if (!selected || busy) return;
    if (confirmation !== "removeWebhook") {
      confirmation = "removeWebhook";
      render();
      return;
    }
    busy = true;
    resetFeedback();
    render();
    try {
      await api.delete<{ deleted: true }>(`/v1/bots/${selected.id}/webhook`, { body: {} });
      if (!alive) return;
      const updated = {
        ...selected,
        webhook: {
          configured: false,
          enabled: false,
          url: null,
          fail_streak: 0,
          next_retry_at: null,
          last_error: null,
          updated_at: null,
        },
      };
      selected = updated;
      bots = bots.map((item) => (item.id === updated.id ? updated : item));
      detailDraft.webhookUrl = "";
      detailDraft.webhookSecret = "";
      confirmation = null;
      noticeKey = "bots.webhookRemoved";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const rotateToken = async (): Promise<void> => {
    if (!selected || busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const result = await api.post<TokenRotationResult>(`/v1/bots/${selected.id}/token`, {});
      if (!alive) return;
      oneTimeToken = { botId: result.bot_user_id, value: result.token };
      confirmation = null;
      noticeKey = "bots.tokenRotated";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const deleteBot = async (): Promise<void> => {
    if (!selected || busy) return;
    busy = true;
    resetFeedback();
    render();
    try {
      const id = selected.id;
      await api.delete<{ deleted: true }>(`/v1/bots/${id}`, { body: {} });
      if (!alive) return;
      bots = bots.filter((bot) => bot.id !== id);
      selected = null;
      analytics = null;
      analyticsError = "";
      oneTimeToken = null;
      confirmation = null;
      mode = "list";
      noticeKey = "bots.deleted";
    } catch (err) {
      if (!alive) return;
      setError(err);
    } finally {
      if (alive) {
        busy = false;
        render();
      }
    }
  };

  const header = (title: string, back: () => void, action?: HTMLElement): HTMLElement => {
    const backButton = el("button", {
      type: "button",
      class: "gc-icon-btn",
      title: i18n.t("common.back"),
      "aria-label": i18n.t("common.back"),
    }, [icon("back")]);
    backButton.addEventListener("click", back);
    return el("header", { class: "gc-bot-header" }, [
      backButton,
      el("div", { class: "gc-bot-header-copy" }, [
        el("h1", { class: "gc-bot-title" }, [title]),
        el("p", { class: "gc-bot-subtitle" }, [i18n.t("bots.subtitle")]),
      ]),
      action ?? el("span", { class: "gc-bot-header-spacer" }),
    ]);
  };

  const feedback = (): HTMLElement[] => {
    const nodes: HTMLElement[] = [];
    if (error) nodes.push(el("p", { class: "gc-bot-feedback gc-bot-feedback-error", role: "alert" }, [error]));
    if (noticeKey) nodes.push(el("p", { class: "gc-bot-feedback gc-bot-feedback-ok", role: "status" }, [i18n.t(noticeKey)]));
    return nodes;
  };

  const field = (
    label: string,
    input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    hint?: string,
  ): HTMLElement => el("label", { class: "gc-field gc-bot-field" }, [
    el("span", { class: "gc-field-label" }, [label]),
    input,
    ...(hint ? [el("span", { class: "gc-field-hint" }, [hint])] : []),
  ]);

  const tokenCard = (): HTMLElement | null => {
    if (!selected || !oneTimeToken || oneTimeToken.botId !== selected.id) return null;
    const tokenValue = oneTimeToken.value;
    const code = el("code", { class: "gc-bot-token-value" }, [tokenValue]);
    const select = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("bots.tokenSelect")]);
    // Deliberately no render() here. The card is rebuilt from scratch on every state change, and a
    // rebuild destroys the selection this click just made — the button would then appear to do
    // nothing. The hint below is therefore permanent instead of a transient notice.
    select.addEventListener("click", () => selectTokenText(code));
    const dismiss = el("button", { type: "button", class: "gc-btn" }, [i18n.t("bots.tokenSaved")]);
    dismiss.addEventListener("click", () => {
      oneTimeToken = null;
      noticeKey = "";
      render();
    });
    return el("section", { class: "gc-bot-card gc-bot-token-card", role: "region", "aria-label": i18n.t("bots.tokenTitle") }, [
      el("div", { class: "gc-bot-card-heading" }, [
        el("div", { class: "gc-bot-card-icon" }, [icon("lock")]),
        el("div", {}, [
          el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.tokenTitle")]),
          el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.tokenWarning")]),
        ]),
      ]),
      code,
      el("p", { class: "gc-bot-card-note gc-bot-token-hint" }, [i18n.t("bots.tokenSelectHint")]),
      el("div", { class: "gc-bot-actions" }, [select, dismiss]),
    ]);
  };

  const renderList = (): void => {
    const add = el("button", { type: "button", class: "gc-btn gc-btn-accent gc-bot-create-btn" }, [
      icon("plus"),
      el("span", {}, [i18n.t("bots.create")]),
    ]);
    add.addEventListener("click", () => {
      mode = "create";
      resetFeedback();
      confirmation = null;
      render();
    });
    root.append(header(i18n.t("bots.title"), deps.onBack, add), ...feedback());
    if (listError && bots.length > 0) {
      root.append(el("p", { class: "gc-bot-feedback gc-bot-feedback-error", role: "alert" }, [
        failureLine(listError, i18n),
      ]));
    }
    if (loading) {
      root.append(el("div", { class: "gc-bot-loading", role: "status" }, [i18n.t("common.loading")])) ;
      return;
    }
    // A failed read is not an empty account. Before V160 an owner of three bots with no network was
    // shown «У вас пока нет ботов» and «Создать первого бота» — the same false-empty defect V146 took
    // out of the calls log, in the one screen where believing it means creating a duplicate bot.
    if (listError && bots.length === 0) {
      root.append(failureState(listError, i18n, () => void loadBots()));
      return;
    }
    if (bots.length === 0) {
      const emptyAdd = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("bots.createFirst")]);
      emptyAdd.addEventListener("click", () => {
        mode = "create";
        resetFeedback();
        render();
      });
      root.append(el("div", { class: "gc-bot-empty" }, [
        el("div", { class: "gc-bot-empty-icon" }, [icon("spark")]),
        el("h2", {}, [i18n.t("bots.emptyTitle")]),
        el("p", {}, [i18n.t("bots.emptyText")]),
        emptyAdd,
      ]));
      return;
    }
    const list = el("div", { class: "gc-bot-list" });
    for (const bot of bots) {
      const button = el("button", { type: "button", class: "gc-bot-row", disabled: busy }, [
        el("span", { class: "gc-bot-avatar" }, [bot.name.trim().slice(0, 1).toUpperCase() || "B"]),
        el("span", { class: "gc-bot-row-main" }, [
          el("strong", {}, [bot.name || `@${bot.username}`]),
          el("span", { class: "gc-bot-handle" }, [`@${bot.username}`]),
          el("span", { class: "gc-bot-row-note" }, [
            bot.webhook.configured ? i18n.t("bots.webhookActive") : i18n.t("bots.longPollMode"),
          ]),
        ]),
        el("span", { class: `gc-bot-state${bot.suspended ? " is-suspended" : ""}` }, [
          bot.suspended ? i18n.t("bots.suspended") : i18n.t("bots.active"),
        ]),
        icon("chevron"),
      ]);
      button.addEventListener("click", () => void openBot(bot.id));
      list.append(button);
    }
    root.append(list);
  };

  const renderCreate = (): void => {
    const username = el("input", {
      class: "gc-input",
      type: "text",
      autocomplete: "off",
      autocapitalize: "none",
      spellcheck: "false",
      placeholder: "my_service_bot",
      value: createDraft.username,
      disabled: busy,
    }) as HTMLInputElement;
    username.addEventListener("input", () => { createDraft.username = username.value; });
    const name = el("input", {
      class: "gc-input",
      type: "text",
      autocomplete: "off",
      placeholder: i18n.t("bots.namePlaceholder"),
      value: createDraft.name,
      disabled: busy,
    }) as HTMLInputElement;
    name.addEventListener("input", () => { createDraft.name = name.value; });
    const description = el("textarea", {
      class: "gc-input gc-textarea gc-bot-description",
      rows: "4",
      placeholder: i18n.t("bots.descriptionPlaceholder"),
      disabled: busy,
    }) as HTMLTextAreaElement;
    description.value = createDraft.description;
    description.addEventListener("input", () => { createDraft.description = description.value; });
    const submit = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [
      busy ? i18n.t("auth.submitting") : i18n.t("bots.create"),
    ]);
    const form = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.createTitle")]),
      el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.createNote")]),
      field(i18n.t("bots.username"), username, i18n.t("bots.usernameHint")),
      field(i18n.t("bots.name"), name),
      field(i18n.t("bots.description"), description),
      el("div", { class: "gc-bot-actions" }, [submit]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void createBot();
    });
    root.append(
      header(i18n.t("bots.createTitle"), () => {
        mode = "list";
        resetFeedback();
        render();
      }),
      ...feedback(),
      form,
    );
  };

  const renderDetail = (): void => {
    if (!selected) {
      mode = "list";
      renderList();
      return;
    }
    const bot = selected;
    root.append(
      header(bot.name || `@${bot.username}`, () => {
        mode = "list";
        selected = null;
        analytics = null;
        analyticsError = "";
        confirmation = null;
        resetFeedback();
        render();
      }),
      ...feedback(),
    );

    const overview = el("section", { class: "gc-bot-card gc-bot-overview" }, [
      el("span", { class: "gc-bot-avatar gc-bot-avatar-large" }, [bot.name.trim().slice(0, 1).toUpperCase() || "B"]),
      el("div", { class: "gc-bot-overview-copy" }, [
        el("h2", {}, [bot.name || `@${bot.username}`]),
        el("p", { class: "gc-bot-handle" }, [`@${bot.username}`]),
        el("div", { class: "gc-bot-meta" }, [
          el("span", {}, [`ID ${bot.id}`]),
          el("span", {}, [bot.webhook.configured ? i18n.t("bots.webhookActive") : i18n.t("bots.longPollMode")]),
          el("span", { class: bot.suspended ? "is-danger" : "is-success" }, [
            bot.suspended ? i18n.t("bots.suspended") : i18n.t("bots.active"),
          ]),
        ]),
      ]),
    ]);
    root.append(overview);

    const name = el("input", {
      class: "gc-input",
      type: "text",
      value: detailDraft.name,
      disabled: busy,
    }) as HTMLInputElement;
    name.addEventListener("input", () => { detailDraft.name = name.value; });
    const description = el("textarea", {
      class: "gc-input gc-textarea gc-bot-description",
      rows: "4",
      disabled: busy,
    }) as HTMLTextAreaElement;
    description.value = detailDraft.description;
    description.addEventListener("input", () => { detailDraft.description = description.value; });
    const profileSave = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [i18n.t("common.save")]);
    const profile = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.profile")]),
      field(i18n.t("bots.name"), name),
      field(i18n.t("bots.description"), description),
      el("div", { class: "gc-bot-actions" }, [profileSave]),
    ]);
    profile.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveProfile();
    });
    root.append(profile);


    const scopeOptions = bot.available_scopes ?? bot.scopes ?? [];
    const scopeGrid = el("div", { class: "gc-bot-scope-grid" });
    for (const scope of scopeOptions) {
      const checkbox = el("input", {
        type: "checkbox",
        class: "gc-bot-scope-checkbox",
        disabled: busy,
      }) as HTMLInputElement;
      checkbox.checked = detailDraft.scopes.includes(scope);
      checkbox.addEventListener("change", () => {
        const selectedScopes = new Set(detailDraft.scopes);
        if (checkbox.checked) selectedScopes.add(scope);
        else selectedScopes.delete(scope);
        detailDraft.scopes = scopeOptions.filter((item) => selectedScopes.has(item));
      });
      scopeGrid.append(el("label", { class: "gc-bot-scope-option" }, [
        checkbox,
        el("span", {}, [i18n.t(`bots.scope.${scope}`)]),
      ]));
    }
    const allScopes = el("button", { type: "button", class: "gc-btn", disabled: busy }, [
      i18n.t("bots.scopesAll"),
    ]);
    allScopes.addEventListener("click", () => {
      detailDraft.scopes = [...scopeOptions];
      render();
    });
    const clearScopes = el("button", { type: "button", class: "gc-btn", disabled: busy }, [
      i18n.t("bots.scopesNone"),
    ]);
    clearScopes.addEventListener("click", () => {
      detailDraft.scopes = [];
      render();
    });
    const scopeSave = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [
      i18n.t("common.save"),
    ]);
    const scopeForm = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.scopes")]),
      el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.scopesHint")]),
      scopeGrid,
      el("div", { class: "gc-bot-actions" }, [allScopes, clearScopes, scopeSave]),
    ]);
    scopeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveScopes();
    });
    root.append(scopeForm);

    const listed = el("input", {
      type: "checkbox",
      class: "gc-toggle",
      disabled: busy,
    }) as HTMLInputElement;
    listed.checked = detailDraft.discoveryListed;
    listed.addEventListener("change", () => {
      detailDraft.discoveryListed = listed.checked;
    });
    const category = el("select", {
      class: "gc-input gc-bot-select",
      disabled: busy,
    }) as HTMLSelectElement;
    for (const value of bot.discovery_categories ?? ["other"]) {
      const option = el("option", { value }, [i18n.t(`bots.category.${value}`)]) as HTMLOptionElement;
      option.selected = value === detailDraft.discoveryCategory;
      category.append(option);
    }
    category.addEventListener("change", () => {
      detailDraft.discoveryCategory = category.value;
    });
    const keywords = el("input", {
      class: "gc-input",
      type: "text",
      value: detailDraft.discoveryKeywords,
      placeholder: i18n.t("bots.discoveryKeywordsPlaceholder"),
      disabled: busy,
    }) as HTMLInputElement;
    keywords.addEventListener("input", () => {
      detailDraft.discoveryKeywords = keywords.value;
    });
    const discoverySave = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [
      i18n.t("common.save"),
    ]);
    const discoveryForm = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.discovery")]),
      el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.discoveryHint")]),
      el("label", { class: "gc-bot-toggle-row" }, [
        el("span", {}, [i18n.t("bots.discoveryListed")]),
        listed,
      ]),
      field(i18n.t("bots.discoveryCategory"), category),
      field(i18n.t("bots.discoveryKeywords"), keywords, i18n.t("bots.discoveryKeywordsHint")),
      el("div", { class: "gc-bot-actions" }, [discoverySave]),
    ]);
    discoveryForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveDiscovery();
    });
    root.append(discoveryForm);

    const refreshAnalytics = el("button", {
      type: "button",
      class: "gc-btn",
      disabled: analyticsLoading,
    }, [i18n.t("bots.analyticsRefresh")]);
    refreshAnalytics.addEventListener("click", () => void loadAnalytics(bot.id));
    const analyticsBody: HTMLElement[] = [];
    if (analyticsLoading) {
      analyticsBody.push(el("p", { class: "gc-bot-card-note", role: "status" }, [i18n.t("common.loading")]));
    } else if (analyticsError) {
      analyticsBody.push(el("p", { class: "gc-bot-feedback gc-bot-feedback-error", role: "alert" }, [analyticsError]));
    } else if (analytics) {
      const metrics: Array<[string, number]> = [
        ["sent", analytics.sent_messages],
        ["chats", analytics.active_chats],
        ["memberships", analytics.memberships],
        ["media", analytics.media_messages],
        ["polls", analytics.polls_created],
        ["callbacks", analytics.callbacks_received],
        ["reactions", analytics.reactions_received],
      ];
      analyticsBody.push(el("div", { class: "gc-bot-analytics-grid" }, metrics.map(([key, value]) =>
        el("div", { class: "gc-bot-analytics-metric" }, [
          el("strong", {}, [String(value)]),
          el("span", {}, [i18n.t(`bots.analytics.${key}`)]),
        ]),
      )));
    }
    root.append(el("section", { class: "gc-bot-card gc-bot-form" }, [
      el("div", { class: "gc-bot-card-heading gc-bot-analytics-heading" }, [
        el("div", {}, [
          el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.analytics")]),
          el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.analyticsHint")]),
        ]),
        refreshAnalytics,
      ]),
      ...analyticsBody,
    ]));

    const commands = el("textarea", {
      class: "gc-input gc-textarea gc-bot-command-editor",
      rows: "7",
      placeholder: i18n.t("bots.commandsPlaceholder"),
      spellcheck: "false",
      disabled: busy,
    }) as HTMLTextAreaElement;
    commands.value = detailDraft.commands;
    commands.addEventListener("input", () => { detailDraft.commands = commands.value; });
    const commandSave = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [i18n.t("bots.saveCommands")]);
    const commandForm = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.commands")]),
      el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.commandsHint")]),
      commands,
      el("div", { class: "gc-bot-actions" }, [commandSave]),
    ]);
    commandForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCommands();
    });
    root.append(commandForm);

    const webhookUrl = el("input", {
      class: "gc-input",
      type: "url",
      inputmode: "url",
      placeholder: "https://example.com/greenchat/webhook",
      value: detailDraft.webhookUrl,
      disabled: busy,
    }) as HTMLInputElement;
    webhookUrl.addEventListener("input", () => { detailDraft.webhookUrl = webhookUrl.value; });
    const webhookSecret = el("input", {
      class: "gc-input",
      type: "password",
      autocomplete: "new-password",
      placeholder: i18n.t("bots.webhookSecretPlaceholder"),
      value: detailDraft.webhookSecret,
      disabled: busy,
    }) as HTMLInputElement;
    webhookSecret.addEventListener("input", () => { detailDraft.webhookSecret = webhookSecret.value; });
    const webhookSave = el("button", { type: "submit", class: "gc-btn gc-btn-accent", disabled: busy }, [i18n.t("bots.saveWebhook")]);
    const webhookActions: HTMLElement[] = [webhookSave];
    if (bot.webhook.configured) {
      const remove = el("button", { type: "button", class: "gc-btn gc-btn-danger", disabled: busy }, [
        confirmation === "removeWebhook" ? i18n.t("bots.confirmRemoveWebhook") : i18n.t("bots.removeWebhook"),
      ]);
      remove.addEventListener("click", () => void removeWebhook());
      webhookActions.push(remove);
    }
    const webhookState = bot.webhook.configured
      ? `${i18n.t("bots.webhookStatus")}: ${bot.webhook.enabled ? i18n.t("bots.active") : i18n.t("bots.disabled")}${bot.webhook.fail_streak ? ` · ${i18n.t("bots.webhookFailures", { count: bot.webhook.fail_streak })}` : ""}`
      : i18n.t("bots.webhookNotConfigured");
    const webhookForm = el("form", { class: "gc-bot-card gc-bot-form" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.webhook")]),
      el("p", { class: "gc-bot-card-note" }, [i18n.t("bots.webhookHint")]),
      el("p", { class: "gc-bot-webhook-state" }, [webhookState]),
      ...(bot.webhook.last_error ? [el("p", { class: "gc-bot-webhook-error" }, [bot.webhook.last_error])] : []),
      field(i18n.t("bots.webhookUrl"), webhookUrl),
      field(i18n.t("bots.webhookSecret"), webhookSecret, i18n.t("bots.webhookSecretHint")),
      el("div", { class: "gc-bot-actions" }, webhookActions),
    ]);
    webhookForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveWebhook();
    });
    root.append(webhookForm);

    // Keep the freshly issued credential inside the bot's settings, directly beside the action that
    // created it. Previously the card was inserted at the top of a long page while the owner stayed
    // scrolled at the bottom, so a successful rotation looked like a button that did nothing.
    const issuedToken = tokenCard();
    if (issuedToken) root.append(issuedToken);

    const securityActions: HTMLElement[] = [];
    let securityNote = i18n.t("bots.securityHint");
    if (confirmation === "rotate") {
      securityNote = i18n.t("bots.rotateWarning");
      const confirm = el("button", { type: "button", class: "gc-btn gc-btn-accent", disabled: busy }, [i18n.t("bots.confirmRotate")]);
      confirm.addEventListener("click", () => void rotateToken());
      const cancel = el("button", { type: "button", class: "gc-btn", disabled: busy }, [i18n.t("common.cancel")]);
      cancel.addEventListener("click", () => { confirmation = null; render(); });
      securityActions.push(confirm, cancel);
    } else if (confirmation === "delete") {
      securityNote = i18n.t("bots.deleteWarning");
      const confirm = el("button", { type: "button", class: "gc-btn gc-btn-danger", disabled: busy }, [i18n.t("bots.confirmDelete")]);
      confirm.addEventListener("click", () => void deleteBot());
      const cancel = el("button", { type: "button", class: "gc-btn", disabled: busy }, [i18n.t("common.cancel")]);
      cancel.addEventListener("click", () => { confirmation = null; render(); });
      securityActions.push(confirm, cancel);
    } else {
      const rotate = el("button", { type: "button", class: "gc-btn", disabled: busy }, [i18n.t("bots.rotateToken")]);
      rotate.addEventListener("click", () => { resetFeedback(); confirmation = "rotate"; render(); });
      const remove = el("button", { type: "button", class: "gc-btn gc-btn-danger", disabled: busy }, [i18n.t("bots.delete")]);
      remove.addEventListener("click", () => { resetFeedback(); confirmation = "delete"; render(); });
      securityActions.push(rotate, remove);
    }
    root.append(el("section", { class: "gc-bot-card gc-bot-danger-zone" }, [
      el("h2", { class: "gc-bot-card-title" }, [i18n.t("bots.security")]),
      el("p", { class: "gc-bot-card-note" }, [securityNote]),
      el("div", { class: "gc-bot-actions" }, securityActions),
    ]));
  };

  function render(): void {
    if (!alive) return;
    clear(root);
    if (mode === "create") renderCreate();
    else if (mode === "detail") renderDetail();
    else renderList();
  }

  const stopI18n = i18n.subscribe(() => render());
  render();
  void loadBots();

  return {
    root,
    destroy(): void {
      alive = false;
      stopI18n();
      oneTimeToken = null;
      analytics = null;
      analyticsError = "";
      clear(root);
    },
  };
}

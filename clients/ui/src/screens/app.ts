// clients/ui/src/screens/app.ts — the route-gated shell that ties the T-405 screens together.
// Responsibilities: mount one screen at a time into a host element, gate account surfaces on auth
// (public profile/server links remain read-only before login; authing or losing the session swaps the
// tree), and map the hash router to the chat-list / settings screens. It is DOM-only glue — every
// mounted screen owns its own data; the app only decides which screen is live and tears the previous
// one down. Injected deps keep
// it shell-agnostic (web passes the browser router/i18n/session; a test could pass fakes).
import type { I18n } from "../i18n.ts";
import type { HashRouter } from "../router.ts";
import { correctedPath } from "../router.ts";
import type { Session } from "./session.ts";
import type { ApiLike } from "./api.ts";
import { clear, el } from "../dom.ts";
import { icon, type IconName } from "../icons.ts";
import { createAuthScreen } from "./auth_screen.ts";
import type { RegistrationModePort } from "./auth_screen.ts";
import { createChatListScreen } from "./chat_list_screen.ts";
import { createSettingsScreen } from "./settings_screen.ts";
import type {
  DiagnosticsConsentPort,
  LanguagePort,
  MoreHubItem,
  NotifyModePort,
  ScreenPrivacyPort,
  DesktopSystemPort,
} from "./settings_screen.ts";
import type { TelegramConnectionPort } from "./telegram_settings.ts";
import { createServerScreen } from "./server_screen.ts";
import type { ServerPort } from "./server_screen.ts";
import { createImportScreen } from "./import_screen.ts";
import type { ImportPorts, ImportSource } from "./import_model.ts";
import { createFeedScreen } from "./feed_screen.ts";
import type { FeedScrollStabilityController } from "./feed_scroll_stability.ts";
import { createCallsScreen } from "./calls_screen.ts";
import { createContactsScreen } from "./contacts_screen.ts";
import { createFinanceScreen, type FinanceView } from "./finance_screen.ts";
import {
  createDeepLinkScreen,
  createPublicUserLinkScreen,
  type DeepLinkKind,
} from "./deep_link_screen.ts";
import { createQrLoginScreen } from "./qr_login_screen.ts";

import { createBotsScreen } from "./bots_screen.ts";

import { createMiniAppsScreen } from "./miniapps_screen.ts";
import { createMiniAppHost } from "./miniapp_host.ts";
import { miniAppsText } from "./miniapps_strings.ts";
import type { OutboxPort, EventFeed } from "./feed_screen.ts";
import type { MediaPort, MediaEnv } from "./media.ts";
import type { SupportPrefill } from "./support_overlay.ts";
import type { SupportStatusPort } from "./support_status.ts";
import { createNetStrip, type NetStrip } from "./net_strip.ts";
import type { ReportTarget } from "./report_overlay.ts";

import type { CachePolicyPort } from "./cache_policy_model.ts";

import { createLockScreen } from "./lock_screen.ts";
import type { AppLockUiPort } from "./lock_screen.ts";

import { createLegalGate } from "./reconsent_model.ts";
import { serverFeatures, visibleDestinations, type ServerFeatures } from "./server_features.ts";
import { createReconsentFailureScreen, createReconsentScreen } from "./reconsent_screen.ts";

// T-417: everything the /import screen needs, assembled by the shell (parse worker + core driver over
// the ApiClient/FileUploader, and the two source builders). Optional — a shell without it simply has no
// import route (the app falls back to the chat list).
export interface ImportShell {
  ports: ImportPorts;
  folderSource(files: FileList): ImportSource;
  zipSource(bytes: Uint8Array): ImportSource;
}

// T-512 (MS-2): the in-app support/feedback capability (optional). Present → a «Помощь» tab in Settings
// (Мои обращения + «Написать в поддержку»), plus a «?» entry in the chat list and the feed that open the
// feedback overlay. `open(prefill?)` snapshots the current screen + the diagnostics ring at open
// time; the shell (web/main.ts) owns the controller, the offline queue and the toast.
// T-514 (MS-4 §3.1.3): `status`, when supplied, backs the "Состояние сервиса" card in the Help tab — a
// client-side probe of the public GET /health + the live WS state; no new server endpoint.
export interface SupportShell {
  open(prefill?: SupportPrefill): void;
  status?: SupportStatusPort;
}

// Placing a call needs a browser (getUserMedia/RTCPeerConnection) and a live socket, neither of which
// the screens layer is allowed to touch. The shell that owns both supplies this port; a shell that
// wires no calling simply omits it and every call entry point disappears instead of rendering a
// decorative button that does nothing (V75).
export interface CallShell {
  start(peer: { id: number; name: string; username?: string | null }, video: boolean): void;
}

export interface ConferenceShell {
  join(conferenceId: string, video: boolean): Promise<void> | void;
  create(chatId: number, video: boolean): Promise<void> | void;
  open(chatId: number, video: boolean): Promise<void> | void;
}

// Abuse reporting is a platform-safety control, not a support-ticket feature. Keeping the port separate
// prevents an optional help implementation from accidentally hiding the mandatory moderation action.
export interface ModerationShell {
  openReport(target?: ReportTarget): void;
}

export interface AppDeps {
  host: HTMLElement;
  api: ApiLike;
  session: Session;
  router: HashRouter;
  i18n: I18n;
  outbox: OutboxPort;
  events: EventFeed;
  // T-407: media transport + environment, threaded into the feed screen (optional).
  media?: MediaPort;
  mediaEnv?: MediaEnv;
  // T-417: Telegram import capability (optional).
  importer?: ImportShell;
  // T-418: opt-in diagnostics consent port (optional). Present → the settings screen shows a «Диагностика» tab.
  diagnostics?: DiagnosticsConsentPort;

  // T-452: native official Telegram connector, surfaced as Settings→Connections.
  telegram?: TelegramConnectionPort;
  // Interface language is a device-local preference. It must be changeable without a server response.
  language?: LanguagePort;
  // T-531: local notification display mode shared with the service worker.
  notifyMode?: NotifyModePort;
  // T-530: local native screenshot/task-switcher protection for ordinary screens.
  screenPrivacy?: ScreenPrivacyPort;
  // Installed desktop-only notification/autostart controls. Tests may inject; production discovers bridge.
  desktopSystem?: DesktopSystemPort;

  // T-529: encrypted global/per-chat cache minimization policy.
  cachePolicy?: CachePolicyPort;
  // T-419: server-address port (optional). Present → the /connect screen + the auth-screen «Сменить сервер»
  // link are enabled ("свой сервер" + failover toggle).
  server?: ServerPort;
  // T-125: corrected server clock and registration policy learned from public /v1/config.
  now?: () => number;
  registration?: RegistrationModePort;
  // T-512: in-app support/feedback (optional). Present → Settings→Помощь tab + «?» entry points.
  support?: SupportShell;
  moderation?: ModerationShell;
  // V75: live 1:1 calling. Present → the dialog header shows call buttons and the call log can redial.
  calls?: CallShell;
  // V178: SFU-backed group calls. Kept separate so a deployment can retain 1:1 P2P calls while the
  // conference media plane is intentionally disabled or undergoing maintenance.
  conferences?: ConferenceShell;

  // T-523: local application lock. Present on shells that persist a crypto-container.
  lock?: AppLockUiPort;
  // 2026-07 redesign: lets the Settings ui_theme select drive the shell's local ThemeController.
  onUiTheme?: (pref: "light" | "dark" | "system") => void;
}

interface Mounted {
  root: HTMLElement;
  destroy(): void;
  focus?(messageId: number): void;
  // Re-entering the section you are already in must return it to its own root, the way tapping the
  // active tab does in every mainstream messenger. Settings is a drill-down now, so without this a
  // user who left it inside "Приватность" comes back into "Приватность" and finds no list of
  // sections — the screen looks like it lost its navigation.
  reset?(): void;
}

export interface App {
  start(): void;
  destroy(): void;
}

export function createApp(deps: AppDeps): App {
  const { host, api, session, router, i18n, outbox, events } = deps;

  // Which optional server contours exist here. Starts "everything off" and is corrected by one public
  // /v1/config probe: a tab that briefly appears and vanishes would be worse than one that appears a
  // beat late, and a server that never answers keeps the honest messenger-only bar.
  //
  // V104 (measured on the P0 device — redroid Android 15, signed direct APK 1000013): the probe used
  // to be fired exactly ONCE from start(). Sign in through a dead minute of network and the bar stayed
  // «Чаты | Звонки | Ещё» for the rest of the session — restoring the network, switching tabs and
  // backgrounding the app never asked again (CDP request log: 4 failed /v1/config attempts at start,
  // then zero), and only killing the process brought «Кошелёк» and «Биржа» back. A silence is not an
  // answer, so it must not be treated as one: keep asking, with a backoff, and ask immediately when the
  // app wakes or the device reports it is online. An answer, once received, is final for the session —
  // nothing below can make a live destination vanish under the user's finger.
  let contours: ServerFeatures = { cards: false, payments: false, known: false, demoFinance: false };
  let contourRetry: ReturnType<typeof setTimeout> | null = null;
  let contourAttempts = 0;
  let contourInFlight = false;
  let contourStopped = false;
  let stopContourWake: (() => void) | null = null;
  // Backoff, not a tight loop: an unreachable server must cost one request a minute at worst, and the
  // first steps are short because the common case is a few seconds of no signal, not an outage.
  const CONTOUR_RETRY_MS = [1_000, 3_000, 8_000, 20_000, 60_000];
  const probeContours = (): void => {
    if (contourStopped || contours.known || contourInFlight) return;
    if (contourRetry !== null) {
      clearTimeout(contourRetry);
      contourRetry = null;
    }
    contourInFlight = true;
    void serverFeatures(api).then((next) => {
      contourInFlight = false;
      if (contourStopped) return; // the shell was destroyed while the probe was in flight
      if (next.known) {
        contourAttempts = 0;
        const changed = next.cards !== contours.cards || next.payments !== contours.payments;
        contours = next;
        if (changed) hardRoute(); // the navigation bar is rebuilt with the shell, so re-render
        return;
      }
      const wait = CONTOUR_RETRY_MS[Math.min(contourAttempts, CONTOUR_RETRY_MS.length - 1)] ?? 60_000;
      contourAttempts += 1;
      contourRetry = setTimeout(() => {
        contourRetry = null;
        probeContours();
      }, wait);
      // Node keeps the process alive for a pending timer; a test that never answers the probe would
      // otherwise hang on this one. Browsers have no unref and need none.
      (contourRetry as unknown as { unref?: () => void }).unref?.();
    });
  };
  // Wake triggers: the phone came back online, or the user returned to the app after fixing the
  // network. Both are no-ops once the probe has an answer, so this costs nothing in the normal case.
  const watchContourWake = (): (() => void) => {
    const offs: Array<() => void> = [];
    const listen = (target: unknown, type: string): void => {
      const t = target as { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
      const add = t?.addEventListener as ((k: string, cb: () => void) => void) | undefined;
      const remove = t?.removeEventListener as ((k: string, cb: () => void) => void) | undefined;
      if (typeof add !== "function" || typeof remove !== "function") return;
      const cb = (): void => probeContours();
      add.call(t, type, cb);
      offs.push(() => remove.call(t, type, cb));
    };
    listen(globalThis, "online");
    listen(globalThis, "focus");
    if (typeof document !== "undefined") listen(document, "visibilitychange");
    return () => {
      for (const off of offs) off();
      offs.length = 0;
    };
  };
  let current: Mounted | null = null;
  let currentKey = ""; // de-dupes redundant remounts when the route changes but the screen doesn't.

  // A copied @username link starts as a public, read-only landing page. Only an explicit
  // “Войти и написать” press turns that same route into the authentication screen.
  let authRequestedForPublicPath: string | null = null;

  let stopLockSubscription: (() => void) | null = null;

  let stopCacheSubscription: (() => void) | null = null;
  let stopDesktopNotificationTarget: (() => void) | null = null;

  type DesktopNativeHost = {
    desktopSystem?: DesktopSystemPort;
    notifications?: { markChat(chatId: number): void };
  };
  const desktopNative = typeof window !== "undefined"
    ? (window as Window & { __GC_NATIVE?: DesktopNativeHost }).__GC_NATIVE
    : undefined;
  const desktopSystem = deps.desktopSystem ?? desktopNative?.desktopSystem;
  if (desktopNative?.notifications) {
    stopDesktopNotificationTarget = events.subscribe((event) => {
      if (event.type !== "message.new" || !event.payload || typeof event.payload !== "object") return;
      const message = (event.payload as { message?: unknown }).message;
      if (!message || typeof message !== "object") return;
      const row = message as { chat_id?: unknown; sender?: unknown };
      const chatId = Number(row.chat_id);
      const sender = row.sender;
      const senderId = typeof sender === "number"
        ? sender
        : sender && typeof sender === "object" && "id" in sender
          ? Number((sender as { id?: unknown }).id)
          : 0;
      const selfId = session.currentUser()?.id ?? 0;
      if (Number.isInteger(chatId) && chatId > 0 && Number.isInteger(senderId) && senderId > 0 && senderId !== selfId) {
        desktopNative.notifications?.markChat(chatId);
      }
    });
  }

  const support = deps.support;
  type ShellSection = "chats" | "calls" | "contacts" | "wallet" | "exchange" | "import" | "settings";
  type ShellMode = "home" | "detail" | "single";

  const makeChatList = (activeChatId?: number): Mounted =>
    createChatListScreen({
      api,
      i18n,
      events,
      self: session.currentUser() ?? { id: 0, username: "", name: "" },
      onOpenChat: (id) => router.navigate(`/chat/${id}`),
      onOpenSettings: () => router.navigate("/settings"),
      onLogout: () => { void session.logout(); },
      ...(deps.lock?.enabled ? { onLock: () => deps.lock?.lock() } : {}),
      ...(deps.importer ? { onOpenImport: () => router.navigate("/import") } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(support ? { onOpenSupport: () => support.open() } : {}),
      ...(deps.media ? { media: deps.media } : {}),
      ...(activeChatId !== undefined ? { activeChatId } : {}),
    });

  // The desktop pane that shows while no conversation is open. It used to be a marketing landing page
  // — an eyebrow ("ВАШЕ ЦИФРОВОЕ ПРОСТРАНСТВО"), a 64 px headline, a lead paragraph, three action
  // buttons and three feature cards — rendered *inside* the signed-in workspace. Nobody who has
  // already installed and logged into a messenger needs to be sold its three advantages every time
  // they close a chat, and no messenger on any platform does this: the space between conversations is
  // a quiet placeholder. So: a mark, one line of guidance, nothing to read and nothing to dismiss.
  // The three buttons are not lost — Settings and the destinations live in the rail, and the Telegram
  // import moved into the chat-list overflow menu, where a phone can reach it too.
  // The browser tells us about the radio the moment it changes; the socket does not, so the strip also
  // re-samples when the app comes back to the foreground (a phone that slept usually wakes up with a
  // dead socket) and on its own slow tick. Returns the unsubscribe, because a shell is remounted on
  // every section change and a leaked listener would keep a dead strip alive.
  const watchNet = (strip: NetStrip): (() => void) => {
    const offs: Array<() => void> = [];
    const listen = (target: unknown, type: string): void => {
      const t = target as { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
      const add = t?.addEventListener as ((k: string, cb: () => void) => void) | undefined;
      const remove = t?.removeEventListener as ((k: string, cb: () => void) => void) | undefined;
      if (typeof add !== "function" || typeof remove !== "function") return;
      const cb = (): void => strip.refresh();
      add.call(t, type, cb);
      offs.push(() => remove.call(t, type, cb));
    };
    listen(globalThis, "online");
    listen(globalThis, "offline");
    listen(globalThis, "focus");
    if (typeof document !== "undefined") listen(document, "visibilitychange");
    return () => { for (const off of offs) off(); offs.length = 0; };
  };

  const createHomePanel = (): Mounted => {
    const root = el("main", { class: "gc-home gc-home-quiet" }, [
      el("div", { class: "gc-home-glow", "aria-hidden": true }),
      el("section", { class: "gc-home-hero" }, [
        el("div", { class: "gc-home-mark", "aria-hidden": true }, [icon("chats")]),
        el("h1", { class: "gc-home-title" }, [i18n.t("shell.chooseChatTitle")]),
        el("p", { class: "gc-home-lead" }, [i18n.t("shell.chooseChatHint")]),
      ]),
    ]);
    return { root, destroy() {} };
  };

  // The destinations the shell advertises in the tab bar / rail. Extracted from wrapInShell because the
  // «Ещё» hub is defined as "everything this build can reach that the bar did NOT advertise": one list,
  // so a destination can never be both missing from the bar and missing from the hub (which is what
  // happened to «Карты», reachable by typed URL only), nor appear twice.
  interface Destination {
    section: ShellSection;
    label: string;
    route: string;
    glyph: IconName;
    // Set when the destination only exists while an optional server contour is on. Filtered through
    // visibleDestinations() so nothing ever advertises a route that answers 403/404.
    requires?: "payments" | "cards";
  }
  const mainDestinations = (): Destination[] => [
    {
      section: "chats",
      label: i18n.t("shell.chats"),
      route: "/",
      glyph: "chats",
    },
    {
      section: "calls",
      label: i18n.t("shell.calls"),
      route: "/calls",
      glyph: "calls",
    },
    // V161. The fifth slot used to be «Биржа» and that was one door too many: the exchange is already
    // reachable from the wallet (its own Wallet|Exchange segmented control, plus the «Обмен» action
    // tile), so the tab advertised a third entrance to a room the wallet opens — and on a deployment
    // where no pair has both assets enabled that room is empty by construction (/v1/ex/pairs and
    // /v1/ex/tickers both answered with empty lists when measured). It is not lost: the rule below
    // hands every destination the bar does not advertise to the «Ещё» hub, so «Биржа» simply moved
    // one tap away and every /exchange address still resolves. The freed slot goes to «Контакты» —
    // the one deployed server contour with no front door at all (/v1/contacts, T-113), and the list
    // three shipped privacy defaults (birthday / find_by_phone / find_by_email = "contacts") are
    // silently filtering against. No `requires`: contacts exist on every build, with or without payments.
    {
      section: "contacts",
      label: i18n.t("shell.contacts"),
      route: "/contacts",
      glyph: "users",
    },
    {
      section: "wallet",
      label: i18n.t("shell.wallet"),
      route: "/wallet",
      glyph: "wallet",
      requires: "payments",
    },
    {
      section: "settings",
      label: i18n.t("shell.more"),
      route: "/settings",
      glyph: "more",
    },
  ];

  // The service catalogue behind «Ещё». Each entry states what it needs to exist: an optional server
  // contour (`requires`) and/or a shell port (`available`). Entries whose route is already a tab are
  // dropped, so trimming the tab bar automatically hands the destination to the hub instead of losing
  // it, and widening the bar never leaves the same service listed twice.
  const moreHubItems = (): MoreHubItem[] => {
    const advertised = new Set(
      visibleDestinations(mainDestinations(), contours).map((item) => item.route),
    );
    const catalogue: Array<
      MoreHubItem & { route?: string; requires?: "payments" | "cards"; available?: boolean }
    > = [
      {
        id: "wallet",
        label: i18n.t("shell.wallet"),
        hint: i18n.t("more.walletHint"),
        glyph: "wallet",
        tone: "brand",
        route: "/wallet",
        requires: "payments",
        open: () => router.navigate("/wallet"),
      },
      {
        id: "exchange",
        label: i18n.t("shell.exchange"),
        hint: i18n.t("more.exchangeHint"),
        glyph: "exchange",
        tone: "cyan",
        route: "/exchange",
        requires: "payments",
        open: () => router.navigate("/exchange"),
      },
      {
        id: "cards",
        label: i18n.t("finance.cards"),
        hint: i18n.t("more.cardsHint"),
        glyph: "cards",
        // V95: the tone marks follow the brand arc (amber → green → teal). Cards are money, so they
        // sit next to the wallet on the amber end; the old "violet" was the one colour in the
        // product that belonged to no part of the identity.
        tone: "gold",
        route: "/cards",
        requires: "cards",
        open: () => router.navigate("/cards"),
      },
      {
        id: "contacts",
        label: i18n.t("shell.contacts"),
        hint: i18n.t("more.contactsHint"),
        glyph: "users",
        tone: "brand",
        route: "/contacts",
        open: () => router.navigate("/contacts"),
      },
      {
        id: "calls",
        label: i18n.t("shell.calls"),
        hint: i18n.t("more.callsHint"),
        glyph: "calls",
        // The tile is painted like the section it opens: Звонки is the teal end of the arc.
        tone: "cyan",
        route: "/calls",
        open: () => router.navigate("/calls"),
      },
      {
        id: "import",
        label: i18n.t("shell.import"),
        hint: i18n.t("more.importHint"),
        glyph: "import",
        // V95: was "violet" — the only paint in the product outside the GreenChat arc.
        tone: "brand",
        route: "/import",
        available: Boolean(deps.importer),
        open: () => router.navigate("/import"),
      },
      {
        id: "bots",
        label: i18n.t("bots.title"),
        hint: i18n.t("more.botsHint"),
        glyph: "spark",
        tone: "brand",
        route: "/bots",
        open: () => router.navigate("/bots"),
      },
      {
        id: "miniapps",
        label: miniAppsText(i18n.locale, "title"),
        // V175: the tile hint is a tile hint, not the page subtitle — the page keeps its own long
        // sentence, the tile gets the sibling-sized one that fits its two-line box.
        hint: i18n.t("more.miniappsHint"),
        glyph: "layers",
        tone: "cyan",
        route: "/miniapps",
        open: () => router.navigate("/miniapps"),
      },
      {
        id: "support",
        label: i18n.t("more.support"),
        hint: i18n.t("more.supportHint"),
        glyph: "help",
        tone: "cyan",
        available: Boolean(support),
        open: () => support?.open(),
      },
      {
        id: "server",
        label: i18n.t("server.title"),
        hint: i18n.t("more.serverHint"),
        glyph: "globe",
        tone: "neutral",
        route: "/connect",
        available: Boolean(deps.server),
        open: () => router.navigate("/connect"),
      },
      {
        id: "lock",
        label: i18n.t("lock.lockNow"),
        hint: i18n.t("more.lockHint"),
        glyph: "lock",
        tone: "neutral",
        available: Boolean(deps.lock?.enabled),
        open: () => deps.lock?.lock(),
      },
    ];
    return visibleDestinations(catalogue, contours)
      .filter((entry) => entry.available !== false)
      .filter((entry) => !entry.route || !advertised.has(entry.route))
      .map(({ id, label, hint, glyph, tone, open }) => ({
        id,
        label,
        glyph,
        open,
        // Conditional spreads, not `hint: hint` — the project compiles with exactOptionalPropertyTypes,
        // where an optional property may be absent but never explicitly undefined.
        ...(hint === undefined ? {} : { hint }),
        ...(tone === undefined ? {} : { tone }),
      }));
  };

  const wrapInShell = (
    content: Mounted,
    section: ShellSection,
    mode: ShellMode = "single",
    side: Mounted | null = null,
  ): Mounted => {
    const brand = el("button", { type: "button", class: "gc-shell-brand", title: i18n.t("common.appName") }, [
      el("span", { class: "gc-shell-brand-mark", "aria-hidden": true }, [icon("logo")]),
      el("span", { class: "gc-shell-brand-word" }, ["Green"]),
    ]);
    brand.addEventListener("click", () => router.navigate("/"));

    const nav = el("nav", {
      class: "gc-shell-nav",
      "aria-label": i18n.t("shell.navigation"),
    });
    for (const item of visibleDestinations(mainDestinations(), contours)) {
      const button = el("button", {
        type: "button",
        class: `gc-shell-item${section === item.section ? " is-active" : ""}`,
        "aria-current": section === item.section ? "page" : undefined,
        title: item.label,
      }, [
        el("span", { class: "gc-shell-item-icon", "aria-hidden": true }, [icon(item.glyph)]),
        el("span", { class: "gc-shell-item-label" }, [item.label]),
      ]);
      button.addEventListener("click", () => router.navigate(item.route));
      nav.append(button);
    }

    const user = session.currentUser();
    const displayName = user?.name.trim() || user?.username || i18n.t("common.appName");
    const initial = displayName.slice(0, 1).toUpperCase();
    const account = el("button", { type: "button", class: "gc-shell-account", title: i18n.t("common.settings") }, [
      el("span", { class: "gc-shell-account-avatar", "aria-hidden": true }, [initial]),
      el("span", { class: "gc-shell-account-copy" }, [
        el("strong", {}, [displayName]),
        el("span", {}, [user?.username ? `@${user.username}` : i18n.t("shell.secure")]),
      ]),
    ]);
    account.addEventListener("click", () => router.navigate("/settings"));

    const utility: Node[] = [];
    if (deps.lock?.enabled) {
      const lock = el("button", { type: "button", class: "gc-shell-utility", title: i18n.t("lock.lockNow") }, [
        icon("lock"),
        el("span", {}, [i18n.t("shell.lock")]),
      ]);
      lock.addEventListener("click", () => deps.lock?.lock());
      utility.push(lock);
    }

    const rail = el("aside", { class: "gc-app-rail" }, [
      brand,
      nav,
      el("div", { class: "gc-shell-spacer" }),
      ...utility,
      account,
    ]);

    const view = el("section", { class: "gc-superapp-view" }, [content.root]);
    const stageBody = side
      ? el("div", { class: "gc-superapp-split" }, [
          el("aside", { class: "gc-superapp-list", "aria-label": i18n.t("shell.chats") }, [side.root]),
          view,
        ])
      : view;
    // V112: the connectivity strip. Measured on the installed artifact (var/ux-audit/v121-apk): with the
    // transport cut the WebView knew it was offline (navigator.onLine === false) and not one element on
    // screen said so, because the only offline wording in the app lives on the LOAD path (state_view.ts)
    // and a screen that already holds data never loads again. It hangs off the stage, not the shell
    // root, so it travels with the content and never covers the rail; it is hidden while the link is
    // healthy, and net_strip.ts decides when a degraded link is worth a word.
    const netStrip = deps.support?.status ? createNetStrip({
      i18n,
      sample: () => {
        const port = deps.support?.status;
        // Reading a port must never take the shell down with it: an unreachable/throwing probe means
        // "we do not know", and not knowing is not the same as being offline.
        try {
          const online = port ? port.online() : true;
          const ws = port ? port.wsState() : "open";
          const delivery = port?.deliveryState?.();
          return delivery === undefined ? { online, ws } : { online, ws, delivery };
        } catch { return { online: true, ws: "open" }; }
      },
    }) : null;
    const stage = el("div", { class: "gc-superapp-stage" }, netStrip ? [netStrip.root, stageBody] : [stageBody]);
    // navigator.onLine flips before any timer would notice, so the events drive the strip and the
    // 1 s tick only exists for the socket, which has no event this layer may listen to.
    const stopNetWatch = netStrip ? watchNet(netStrip) : null;
    // The section is published on the shell root so the stylesheet can give each destination its own
    // identity. Before V78 every screen painted the same near-white header over the same
    // rgb(243,247,245) page: measured at 390x844, chats/calls/«Ещё» differed in content only, which is
    // what "все разделы одинаковые бело-зелёные" describes. The tone is a *wash and accent*, never the
    // primary action colour — the brand stays green everywhere.
    const root = el("div", { class: `gc-superapp gc-superapp-${mode}`, "data-gc-section": section }, [rail, stage]);

    return {
      root,
      destroy() {
        stopNetWatch?.();
        netStrip?.destroy();
        side?.destroy();
        content.destroy();
      },
      focus(messageId: number) { content.focus?.(messageId); },
      reset() { content.reset?.(); },
    };
  };

  // Legal re-consent gate (legal v2): probed after login/restore; while it reports a consent debt the
  // route() below swaps EVERY authenticated screen for the blocking re-consent screen. Fail-open —
  // see reconsent_model.ts for why a failed probe never locks the user out.
  const legalGate = createLegalGate({ api });
  let stopLegalSubscription: (() => void) | null = null;
  let stopLocaleSubscription: (() => void) | null = null;
  // Locale listeners rebuild the shell synchronously. Keep General open only during its own language write.
  let preserveGeneral = false;

  // A messenger reads as a navigation stack: opening a conversation pushes forward, "back" pops. The
  // web client used to hard-cut between screens — the screen simply blinked into place, which is a
  // large part of why it felt like a page reload rather than an app. Depth drives the direction of the
  // mount animation; the CSS behind it is disabled under prefers-reduced-motion.
  const screenDepth = (key: string): number => (key.startsWith("chat:") ? 2 : 1);

  // V79. Depth alone could not tell «Чаты»→«Звонки» from «Звонки»→«Чаты»: both are depth 1, so both
  // fell into the `fade` branch and every tab tap played the same 150ms opacity blink (measured:
  // probe var/ux-audit/tools/m_motion_v79.mjs reported `gc-screen-fade on gc-superapp` for all three
  // switches). Two consequences, both visible: the direction of travel carried no meaning, and the
  // animated node was the SHELL ROOT — so the tab bar and the brand rail faded on every tap, which is
  // exactly the "page reload" feeling. Sibling tabs now move along the horizontal axis in the
  // direction the bar is read (Material's shared-axis X), and only the content stage moves.
  const tabOrder = (key: string): number => {
    const section = key.startsWith("finance:") ? key.slice("finance:".length) : key;
    const order = mainDestinations().map((d) => d.section as string);
    const at = order.indexOf(section);
    // Screens that are reachable but never advertised in the bar (e.g. «Перенос данных», «Адрес
    // сервера») are opened FROM the hub, which is the last tab: entering them travels forward.
    return at >= 0 ? at : order.length;
  };

  const swap = (key: string, make: () => Mounted): void => {
    if (key === currentKey && current) {
      // Same destination, already mounted: never rebuild (that would drop scroll position and any
      // in-flight state), but do pop the screen back to its own root if it knows how.
      current.reset?.();
      return;
    }
    const previousKey = currentKey;
    const from = previousKey ? screenDepth(previousKey) : 0;
    const to = screenDepth(key);
    current?.destroy();
    clear(host);
    current = make();
    currentKey = key;
    // from === 0 is the very first mount (cold start): nothing to transition away from.
    if (from !== 0) {
      const dir = to > from
        ? "forward"
        : to < from
          ? "back"
          // Same depth: siblings in the tab bar. Left-to-right in the bar is "forward".
          : tabOrder(key) >= tabOrder(previousKey ?? key) ? "forward" : "back";
      // Move the CONTENT, not the chrome. `current.root` is the whole shell for a tab screen (rail +
      // stage), and animating it dragged the tab bar through every transition.
      const node = (current.root as unknown as { querySelector?: (s: string) => unknown })
        .querySelector?.(".gc-superapp-stage") as HTMLElement | null | undefined
        ?? current.root;
      node.setAttribute("data-gc-nav", dir);
      // The attribute is dropped once the animation is over so that no transform survives on a screen
      // root: a lingering transform would turn every position:fixed overlay inside it into a
      // container-relative box. The animation is intentionally shorter than this timer.
      setTimeout(() => { try { node.removeAttribute("data-gc-nav"); } catch { /* detached */ } }, 320);
    }
    host.append(current.root);
  };

  // Decide the live screen from (auth state, route). The «Адрес сервера» screen is reachable regardless of
  // auth (before login + via the greenchat://connect deep link); everything else stays behind the auth gate.
  const route = (): void => {
    const r = router.current();

    // An address that no route matches used to fall through to the home branch further down: the
    // chat list was drawn while the URL still read `#/more` or `#/typo` (measured on the signed APK
    // 1000012 via CDP, 2026-07-31). A lying address is not cosmetic — reload, share and back-press
    // all replay it, so the person is returned to a screen they never opened. Rewrite it instead,
    // and re-enter with the corrected address in the same tick so no blank frame is shown. The
    // targets are always real patterns, so the corrected address matches on the next pass.
    //
    // Deliberately NOT re-entered by hand: HashRouter.current() is refreshed by its own emit, so a
    // recursive route() here would read the stale not-found route again and recurse forever. The
    // hash change the line below performs is what re-enters, exactly once.
    const corrected = correctedPath(r);
    if (corrected !== null) {
      router.navigate(corrected);
      return;
    }

    // Leaving the copied profile address cancels an unfinished login intent. Returning to the link
    // later must show its useful public preview again instead of surprising the visitor with auth.
    if (authRequestedForPublicPath !== null && authRequestedForPublicPath !== r.path) {
      authRequestedForPublicPath = null;
    }

    // WIPED is device state, not auth state: after an automatic wipe the auth slice is intentionally
    // cleared, but the user must still see the explicit local-wipe receipt and reset this device before
    // the ordinary sign-in screen. COLD/LOCKED gate only authenticated sessions; a signed-out user with an
    // enabled container cannot access account data anyway and signs in before unlocking that account.
    if (deps.lock?.state === "WIPED") {
      const lock = deps.lock;
      swap("lock-wiped", () => createLockScreen({ i18n, lock }));
      return;
    }
    // The lock gate precedes every authenticated screen (including server/settings routes). The lock
    // screen is intentionally account-agnostic: no user snapshot, chat title or unread count is passed.
    if (session.isAuthed() && deps.lock && deps.lock.state !== "DISABLED" && deps.lock.state !== "UNLOCKED") {
      const lock = deps.lock;
      swap("lock", () => createLockScreen({ i18n, lock }));
      return;
    }
    // Signed-out users may reach server selection before authentication. For an authenticated user,
    // the same route is evaluated only AFTER the legal gate below so it cannot bypass re-consent.
    if (!session.isAuthed() && r.name === "connect" && deps.server) {
      const server = deps.server;
      swap("connect", () => createServerScreen({
        i18n,
        server,
        onBack: () => router.navigate("/"),
      }));
      return;
    }
    // Telegram-style @username links are useful to a signed-out visitor: show the public identity
    // first and expose an explicit native-app action. Authentication begins only after the web action
    // is pressed, and the hash stays untouched so a successful sign-in can resume this profile.
    if (!session.isAuthed() && r.name === "user" && authRequestedForPublicPath !== r.path) {
      const username = r.params.username;
      if (username) {
        swap(`public-user:${username}`, () => createPublicUserLinkScreen({
          api,
          i18n,
          value: username,
          onBack: () => {
            authRequestedForPublicPath = null;
            router.navigate("/");
          },
          onContinueWeb: () => {
            authRequestedForPublicPath = r.path;
            route();
          },
        }));
        return;
      }
    }

    if (!session.isAuthed()) {
      swap("auth", () =>
        createAuthScreen({
          session,
          i18n,
          onAuthed: () => {
            // Authentication must never discard the action encoded by a copied link. QR approval,
            // public profiles, invitations and invoices all resume at the same address; an ordinary
            // login from Home still lands Home.
            const resume = r.name === "authQr" || r.name === "user" || r.name === "join" || r.name === "pay";
            authRequestedForPublicPath = null;
            if (resume) route();
            else { router.navigate("/"); route(); }
          },
          ...(deps.registration ? { registration: deps.registration } : {}),
          ...(typeof window !== "undefined" &&
            (window as Window & { __GC_NATIVE?: { platform?: string } }).__GC_NATIVE?.platform === "desktop"
            ? { allowQrLogin: true }
            : {}),
        }),
      );
      return;
    }
    // Legal re-consent gate (legal v2): a known consent debt blocks EVERY authenticated screen until
    // the person accepts the new edition (→ markAccepted reopens) or declines (→ logout; the session
    // emit above swaps to the auth screen). Placed after the auth gate — the status probe itself is
    // an authenticated call — and before all routed screens so no account surface can slip past it.
    const legalFailure = legalGate.failure();
    if (legalFailure !== null) {
      swap("reconsent-error", () => createReconsentFailureScreen({
        i18n,
        error: legalFailure,
        onRetry: () => { void legalGate.check(); },
        onDecline: () => { void session.logout(); },
      }));
      return;
    }
    const owedLegal = legalGate.blocking();
    if (owedLegal) {
      swap(`reconsent:${owedLegal.current_version}`, () =>
        createReconsentScreen({
          api,
          i18n,
          status: owedLegal,
          onAccepted: () => legalGate.markAccepted(),
          onDecline: () => { void session.logout(); },
        }),
      );
      return;
    }
    if (r.name === "authQr") {
      const token = r.params.token?.trim() ?? "";
      swap(`auth-qr:${token}`, () => createQrLoginScreen({
        api,
        i18n,
        token,
        onDone: () => router.navigate("/"),
      }));
      return;
    }
    if (r.name === "calls") {
      swap("calls", () =>
        wrapInShell(createCallsScreen({
          api,
          i18n,
          atShellRoot: true,
          onBack: () => router.navigate("/"),
          onOpenChat: (id) => router.navigate(`/chat/${id}`),
          // V75: the log's people rows carry a phone glyph — with a call shell wired it now places
          // the call instead of merely opening the chat that glyph promised.
          ...(deps.calls ? { onStartCall: (peer, video) => deps.calls?.start(peer, video) } : {}),
          ...(deps.conferences ? {
            onJoinConference: (conferenceId: string, video: boolean) => deps.conferences?.join(conferenceId, video),
            onCreateConference: (chatId: number, video: boolean) => deps.conferences?.create(chatId, video),
          } : {}),
          events,
        }), "calls"),
      );
      return;
    }
    if (r.name === "contacts") {
      swap("contacts", () =>
        wrapInShell(createContactsScreen({
          api,
          i18n,
          self: session.currentUser() ?? { id: 0, username: "", name: "" },
          atShellRoot: true,
          onBack: () => router.navigate("/"),
          onOpenChat: (id) => router.navigate(`/chat/${id}`),
        }), "contacts"),
      );
      return;
    }
    if (r.name === "wallet" || r.name === "exchange" || r.name === "cards") {
      const view = r.name as FinanceView;
      const section: ShellSection = view === "exchange" ? "exchange" : "wallet";
      swap(`finance:${view}`, () =>
        wrapInShell(createFinanceScreen({
          api,
          i18n,
          view,
          atShellRoot: true,
          onBack: () => router.navigate("/"),
          onNavigate: (next) => router.navigate(`/${next}`),
        }), section),
      );
      return;
    }
    if (r.name === "bots") {
      swap("bots", () =>
        wrapInShell(createBotsScreen({
          api,
          i18n,
          onBack: () => router.navigate("/settings"),
        }), "settings"),
      );
      return;
    }
    if (r.name === "miniapps") {
      swap("miniapps", () =>
        wrapInShell(createMiniAppsScreen({
          api,
          i18n,
          onBack: () => router.navigate("/settings"),
          onOpen: (appId) => router.navigate(`/miniapp/${appId}`),
        }), "settings"),
      );
      return;
    }
    if (r.name === "user" || r.name === "join" || r.name === "pay") {
      const kind: DeepLinkKind = r.name;
      const value = r.name === "user" ? r.params.username : r.name === "join" ? r.params.invite : r.params.code;
      if (value) {
        const section: ShellSection = r.name === "pay" ? "wallet" : "chats";
        swap(`deep:${r.name}:${value}`, () => wrapInShell(createDeepLinkScreen({
          api,
          i18n,
          kind,
          value,
          onBack: () => router.navigate("/"),
          onOpenChat: (id) => router.navigate(`/chat/${id}`),
        }), section));
        return;
      }
    }
    if (r.name === "miniapp" || r.name === "miniappChat" || r.name === "miniappChatStart") {
      const appId = Number(r.params.id);
      const chatId = r.name === "miniapp" ? undefined : Number(r.params.chat);
      const startParam = r.name === "miniappChatStart" ? r.params.start : undefined;
      const validChat = chatId === undefined || (Number.isSafeInteger(chatId) && chatId > 0);
      if (Number.isSafeInteger(appId) && appId > 0 && validChat) {
        const key = `miniapp:${appId}:${chatId ?? 0}:${startParam ?? ""}`;
        swap(key, () => createMiniAppHost({
          api,
          i18n,
          appId,
          ...(chatId === undefined ? {} : { chatId }),
          ...(startParam ? { startParam } : {}),
          onBack: () => router.navigate(chatId === undefined ? "/miniapps" : `/chat/${chatId}`),
        }));
        return;
      }
    }

    // Authenticated server selection is evaluated only after the legal gate above, so switching
    // servers can never bypass re-consent (T-807 finding; the signed-out variant sits before auth).
    if (r.name === "connect" && deps.server) {
      const server = deps.server;
      swap("connect", () => wrapInShell(createServerScreen({
        i18n,
        server,
        onBack: () => router.navigate("/settings"),
      }), "settings"));
      return;
    }
    if (r.name === "settings") {
      swap("settings", () =>
        wrapInShell(
          createSettingsScreen({
            api,
            i18n,
            atShellRoot: true,
            initialSection: preserveGeneral ? "settings" : null,
            onBack: () => router.navigate("/"),
            // «Ещё» is this build's service directory, not only its settings menu.
            hub: { items: moreHubItems() },
            ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
            ...(deps.telegram ? { telegram: deps.telegram } : {}),
            ...(deps.language ? { language: {
              get: () => deps.language!.get(),
              set: async (pref: string) => {
                preserveGeneral = true;
                try { await deps.language!.set(pref); } finally { preserveGeneral = false; }
              },
            } } : {}),
            ...(deps.notifyMode ? { notifyMode: deps.notifyMode } : {}),
            ...(deps.screenPrivacy ? { screenPrivacy: deps.screenPrivacy } : {}),
            ...(desktopSystem ? { desktopSystem } : {}),

            ...(deps.cachePolicy ? { cachePolicy: deps.cachePolicy } : {}),
            ...(deps.media ? { media: deps.media } : {}),
            ...(deps.lock ? { lock: deps.lock } : {}),
            ...(deps.onUiTheme ? { onUiTheme: deps.onUiTheme } : {}),
            safety: {
              selfId: session.currentUser()?.id ?? 0,
              deleteAccount: (password: string) =>
                session.deleteAccount(password),
              ...(deps.moderation
                ? { onReport: () => deps.moderation?.openReport() }
                : {}),
            },
            // T-512: the «Помощь» tab — «Мои обращения» (open a ticket's @support dialog) + «Написать в поддержку».
            // T-514: also thread the service-status probe (when the shell provides one) into the Help card.
            ...(support
              ? {
                  support: {
                    onOpenChat: (id: number) => router.navigate(`/chat/${id}`),
                    onContact: () => support.open(),
                    ...(support.status ? { status: support.status } : {}),
                  },
                }
              : {}),
          }),
          "settings",
        ),
      );
      return;
    }
    // T-417: the Telegram-import screen, when the shell wired the capability. Reached via the Ctrl+K
    // palette / #/import; falls through to the chat list when the shell has no importer.
    if (r.name === "import" && deps.importer) {
      const importer = deps.importer;
      swap("import", () =>
        wrapInShell(createImportScreen({
          i18n,
          ports: importer.ports,
          folderSource: importer.folderSource,
          zipSource: importer.zipSource,
          onBack: () => router.navigate("/"),
          onOpenChat: (id) => router.navigate(`/chat/${id}`),
        }), "import"),
      );
      return;
    }
    if (r.name === "chat" || r.name === "message") {
      const chatId = Number(r.params.id);
      const focus = r.name === "message" ? Number(r.params.mid) : NaN;
      if (Number.isFinite(chatId)) {
        const self = session.currentUser() ?? { id: 0, username: "", name: "" };
        const key = `chat:${chatId}`;
        // Reuse an already-mounted feed for the same chat; deep-links to a specific message just re-focus.
        if (key === currentKey && current && Number.isFinite(focus)) {
          current.focus?.(focus);
          return;
        }
        swap(key, () => {
          const feed = createFeedScreen({
            api, i18n, chatId, self, outbox, events,
            onBack: () => router.navigate("/"),
            ...(Number.isFinite(focus) ? { focusMessageId: focus } : {}),
            ...(deps.media && deps.mediaEnv ? { media: deps.media, mediaEnv: deps.mediaEnv } : {}),
            ...(deps.now ? { now: deps.now } : {}),
            ...(support ? { onOpenSupport: () => support.open() } : {}), // T-512: «?» in the feed header
            ...(deps.moderation
              ? {
                  onReport: (target: ReportTarget) =>
                    deps.moderation?.openReport(target),
                }
              : {}),
            onOpenMiniApp: (appId, contextChatId, startParam) => {
              const base = `/miniapp/${appId}/chat/${contextChatId}`;
              router.navigate(startParam ? `${base}/${encodeURIComponent(startParam)}` : base);
            },
            ...(deps.cachePolicy ? { cachePolicy: deps.cachePolicy } : {}),
            // V75: a call belongs to the conversation — that is where the person is — so the entry
            // point is the dialog header. The "Звонки" tab stays a log.
            ...(deps.calls ? { onStartCall: (peer, video) => deps.calls?.start(peer, video) } : {}),
            // A group gets one call affordance in the same header. The shell resolves whether that
            // action means create or join, keeping the screen independent of the LiveKit runtime.
            ...(deps.conferences
              ? { onOpenConference: (groupChatId: number, video: boolean) => deps.conferences?.open(groupChatId, video) }
              : {}),
          });
          // Android WebView and mobile browsers may scroll the focused feed without a reader gesture.
          // Load that platform guard only for an opened conversation, keeping the launch bundle lean.
          let stability: FeedScrollStabilityController | null = null;
          let feedDestroyed = false;
          void import("./feed_scroll_stability.ts").then(({ installFeedScrollStability }) => {
            if (!feedDestroyed) stability = installFeedScrollStability(feed.root);
          }, () => {});
          const stableFeed: Mounted = {
            root: feed.root,
            focus(messageId) {
              const navigate = (): void => feed.focus(messageId);
              if (stability) stability.allowNavigation(navigate); else navigate();
            },
            destroy() {
              feedDestroyed = true;
              stability?.destroy();
              feed.destroy();
            },
          };
          return wrapInShell(stableFeed, "chats", "detail", makeChatList(chatId));
        });
        return;
      }
    }
    // Home: chats stay live in the desktop list pane; the detail area becomes a branded command centre.
    swap("chats", () => wrapInShell(createHomePanel(), "chats", "home", makeChatList()));
  };

  // Force a re-evaluation from scratch (used on auth transitions where the screen identity flips).
  const hardRoute = (): void => { currentKey = ""; route(); };

  return {
    start() {
      router.subscribe(() => route());
      // Auth transitions drive the legal probe: login/restore → ask the server for the consent
      // position (fail-open — route() proceeds now and re-blocks if the probe answers "owed");
      // sign-out → forget it (the next account starts from a clean gate).
      session.subscribe((user) => {
        if (user) void legalGate.check(); else legalGate.reset();
        hardRoute();
      });
      stopLegalSubscription = legalGate.subscribe(() => hardRoute());
      if (deps.lock) stopLockSubscription = deps.lock.subscribe(() => hardRoute());

      if (deps.cachePolicy) stopCacheSubscription = deps.cachePolicy.subscribe(() => hardRoute());
      // Every mounted screen reads copy while constructing its DOM. Rebuild the current destination as
      // soon as the locale changes so the visible interface never remains half translated.
      stopLocaleSubscription = i18n.subscribe(() => hardRoute());
      router.start();
      if (session.isAuthed()) void legalGate.check(); // session restored before start() (web boot order)
      contourStopped = false;
      stopContourWake?.();
      stopContourWake = watchContourWake();
      probeContours();
      route();
    },
    destroy() {
      contourStopped = true;
      stopContourWake?.();
      stopContourWake = null;
      if (contourRetry !== null) {
        clearTimeout(contourRetry);
        contourRetry = null;
      }
      stopLegalSubscription?.();
      stopLegalSubscription = null;
      stopLocaleSubscription?.();
      stopLocaleSubscription = null;
      stopLockSubscription?.();
      stopLockSubscription = null;

      stopCacheSubscription?.();
      stopCacheSubscription = null;
      stopDesktopNotificationTarget?.();
      stopDesktopNotificationTarget = null;
      current?.destroy();
      current = null;
    },
  };
}

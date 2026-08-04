// clients/ui/src/screens/chat_list_screen.ts — the chat list (T-405, T-019). Loads GET /v1/chats and
// GET /v1/badge, paints a virtualised list (the own scroller from T-404) of pinned-first rows with an
// unread badge, mute icon, and a media/text preview. An All / Archive tab switches the filter, and each
// row exposes pin / mute / archive actions that PUT /v1/chats/:id/settings and optimistically restate
// the row. DOM-only; the row/preview/filter logic is the node-tested chat_model.ts.
import type { I18n } from "../i18n.ts";
import type { ApiLike, DialogChat } from "./api.ts";
import type { ChatEntry, Badge, ChatSettings } from "./types.ts";
import { el, clear } from "../dom.ts";
import { createModalLayer } from "../modal_layer.ts";
import { createFocusTrap } from "../a11y.ts";

import { icon } from "../icons.ts";
import { VirtualList, sanitiseHeight } from "../virtual_list.ts";
import { browserTextZoomEnv } from "../text_zoom.ts";
import { filterChats, chatRowView, sortChats, applyListEvent, upsertChat, dialogToEntry, LIST_EVENTS } from "./chat_model.ts";
import type { ChatTab, SelfRef } from "./chat_model.ts";
import { describeError } from "./api.ts";
import { failureState, failureLine, skeletonList } from "./state_view.ts";
import { createNewChatOverlay } from "./new_chat_overlay.ts";
import { loadContacts, type ContactRow } from "./contacts_model.ts";
import { openBotCreateFlow } from "./bot_center_handoff.ts";
import { openMessageMenu, bindLongPress, avatarTone, initials, type MessageMenuItem } from "./message_menu.ts";
import { createWidthFitter } from "../fit_width.ts";
import { bindAvatarImage } from "./avatar_media.ts";
import type { MediaPort } from "./media.ts";

// A minimal event feed (same shape the feed screen consumes) — the list subscribes to keep rows live.
export interface ChatListEventFeed {
  subscribe(handler: (evt: { type: string; payload: unknown }) => void | Promise<void>): () => void;
}

export interface ChatListDeps {
  api: ApiLike;
  i18n: I18n;
  onOpenChat: (id: number) => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  events?: ChatListEventFeed; // live updates (T-424); omitted → static list (still loads once)
  self?: SelfRef; // T-426/T-427: the signed-in user — opens Saved Messages + labels the self-dialog
  selfId?: number; // deprecated alias for self.id (kept for callers that only have the id)
  now?: () => number; // injectable clock (seconds) — defaults to Date.now.
  onOpenSupport?: () => void; // T-512: «Помощь и поддержка» — opens the support/feedback overlay (§3.1).
  media?: Pick<MediaPort, "upload">; // V187: topic-scoped photo/video/audio/file uploads to support.

  onLock?: () => void; // T-523: immediate local application lock.

  // T-417 (Telegram import). Until now /import was reachable only from the desktop placeholder panel
  // and the command palette, so on a phone — the only device most people ever install this on — the
  // migration flow had no entry point at all. It belongs in the list's overflow menu, which exists on
  // every width.
  onOpenImport?: () => void;

  activeChatId?: number; // Desktop split-view: visually marks the dialog currently open in the detail pane.
}

const ROW_HEIGHT = 72;

// V187 — system destinations are visible from the first signed-in frame, before a server-side dialog
// exists. Negative ids are UI-only and can never collide with SQLite AUTOINCREMENT chat ids. Once the
// real @support dialog is created by the first ticket, it replaces the shortcut and participates in the
// normal newest-activity sort. The Bot Center remains a destination until a native BotFather dialog is
// introduced; the aliases below make that migration duplicate-free.
export const SYSTEM_CHAT_SHORTCUT_KIND = "system_shortcut";
export const SYSTEM_SUPPORT_SHORTCUT_ID = -900_000_001;
export const SYSTEM_BOT_CENTER_SHORTCUT_ID = -900_000_002;
const BOT_CENTER_USERNAMES = new Set(["botfather", "greenchat_botfather", "bot_center"]);

function shortcutEntry(id: number, title: string, username: string, subtitle: string, bot: boolean): ChatEntry {
  return {
    id,
    kind: SYSTEM_CHAT_SHORTCUT_KIND,
    title,
    username,
    photo_file_id: null,
    peer_is_bot: bot,
    last_message: { id, sender_id: null, kind: "text", text: subtitle, created_at: 0 },
    unread_count: 0,
    muted_until: 0,
    pinned: false,
    archived: false,
    my_role: "member",
    message_ttl_sec: 0,
    draft: null,
    updated_at: 0,
  };
}

// Group/channel creation must not appear empty merely because the explicit GreenChat address book
// has not been curated yet. A recent ordinary 1:1 dialog is already a relationship the owner can see,
// so supplement contacts with those peers. Explicit contacts win to preserve aliases; bots, Saved
// Messages and non-dialog rows are excluded from the fallback.
export function mergeParticipantSuggestions(
  contacts: readonly ContactRow[],
  chats: readonly ChatEntry[],
  selfId: number,
): ContactRow[] {
  const merged = new Map<number, ContactRow>();
  for (const contact of contacts) merged.set(contact.id, contact);
  for (const chat of chats) {
    const peerId = chat.peer_user_id;
    if (
      chat.kind !== "dialog" ||
      chat.peer_is_bot === true ||
      typeof peerId !== "number" ||
      !Number.isSafeInteger(peerId) ||
      peerId <= 0 ||
      peerId === selfId ||
      merged.has(peerId)
    ) continue;
    merged.set(peerId, {
      id: peerId,
      username: chat.username ?? "",
      name: chat.title,
      alias: "",
      avatar_file_id: chat.photo_file_id ?? null,
      is_bot: false,
    });
  }
  return [...merged.values()];
}

/** Append discoverable system destinations without disturbing the server's real-chat ordering. */
export function withSystemChatShortcuts(entries: ChatEntry[], i18n: I18n): ChatEntry[] {
  const usernames = new Set(
    entries
      .map((entry) => entry.username?.trim().toLocaleLowerCase())
      .filter((username): username is string => typeof username === "string" && username.length > 0),
  );
  const out = [...entries];
  if (!usernames.has("support")) {
    out.push(shortcutEntry(
      SYSTEM_SUPPORT_SHORTCUT_ID,
      i18n.t("support.help"),
      "support",
      i18n.t("more.supportHint"),
      false,
    ));
  }
  if (![...BOT_CENTER_USERNAMES].some((username) => usernames.has(username))) {
    out.push(shortcutEntry(
      SYSTEM_BOT_CENTER_SHORTCUT_ID,
      i18n.t("bots.title"),
      "bot_center",
      i18n.t("bots.subtitle"),
      true,
    ));
  }
  return out;
}

/**
 * Pure (V119): the height one virtualised chat row must take, from the two things that can demand
 * it — `styled` is what the stylesheet asks for (the design's comfortable row, 72px in the classic
 * shell and 76px in the superapp shell) and `natural` is what the content actually occupies at the
 * platform's current font size. The row must satisfy both, so it is the larger of the two; a
 * measurement taken while the list is hidden reads 0 and keeps `previous` instead.
 */
export function chatRowHeight(styled: number, natural: number, previous: number): number {
  return sanitiseHeight(Math.max(styled, natural), previous);
}

// Local filter over the already-loaded rows (V5). Instant, offline-safe, and independent of the
// server-side message search — it answers the far more common "where is that chat?" question. Match is
// case-insensitive over the visible title and the preview text, so it works for both Latin and Cyrillic.
export function matchesQuery(title: string, subtitle: string, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q.length === 0) return true;
  return title.toLocaleLowerCase().includes(q) || subtitle.toLocaleLowerCase().includes(q);
}

export function createChatListScreen(deps: ChatListDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const self: SelfRef = deps.self ?? { id: deps.selfId ?? 0, name: "", username: "" };
  let entries: ChatEntry[] = [];
  let tab: ChatTab = "all";
  let query = "";
  let disposed = false;

  const root = el("div", { class: "gc-chats" });
  // Everything this screen mounts on the document body is owned here: one at a time, and gone when the
  // screen goes. See modal_layer.ts for why that is a shared primitive and not a local variable.
  const modals = createModalLayer(root);
  const badgeEl = el("span", { class: "gc-tab-badge" });
  // V67: the tab's label lives in its own box so the active underline can be as wide as the WORD
  // rather than as wide as the slot. Measured at 390x844: the "Все" tab is 179 px (two tabs sharing
  // the row), its label plus badge 58 px — and the accent line spanned all 179 px, which reads as a
  // painted half-header instead of a marker. FilterTabsView does the same split: the tab keeps the
  // full slot as its tap target (additionalTabWidth, Tabs.java:1554, spreads spare width evenly over
  // the tabs), while the indicator is bounded by the title (titleWidth + counter + TAB_INTERNAL_PADDING
  // on each side, Tabs.java:1497-1510) and centred inside that slot. The button stays the target; the
  // span is the indicator. A CSS-only version is impossible: a bare text node cannot be measured or
  // bordered, so the wrapper is the minimum structural change that lets the line hug the text.
  const allLabel = el("span", { class: "gc-tab-label" }, [i18n.t("chat.tabAll"), badgeEl]);
  const archLabel = el("span", { class: "gc-tab-label" }, [i18n.t("chat.tabArchived")]);
  const allTab = el("button", { type: "button", class: "gc-tab", role: "tab" }, [allLabel]);
  const archTab = el("button", { type: "button", class: "gc-tab", role: "tab" }, [archLabel]);
  // V102: a tab label is a word inside a fixed slot, and the system font multiplier is applied
  // after any font-size arithmetic — so at 320 dp with the system font at 2.0 the "Archived" label
  // measured 97 px inside a 75 px box (signed APK 1000012, redroid 15, `wm density 540`,
  // font_scale 2.0, CDP, 2026-07-31) and the word was painted straight through the tab's edge, as
  // "Archive". The same measured fitter the wallet headline uses scales the label only when it
  // actually overflows, so a default font renders byte-identically to before.
  const tabFitter = createWidthFitter();
  tabFitter.track(allLabel);
  tabFitter.track(archLabel);
  // The primary action of a chat list is "start a conversation", so it gets a floating button over
  // the list instead of a 44 px icon wedged into the top-right corner (see the titlebar note below).
  const fab = el("button", {
    type: "button",
    class: "gc-fab",
    title: i18n.t("chatList.newChat"),
    "aria-label": i18n.t("chatList.newChat"),
  }, [icon("plus")]);

  // V6: the header used to line up five icon buttons — plus, help, lock, settings, logout — in the
  // corner of a 360 px phone screen. Five 44 px targets plus a title do not fit: they shrank the
  // title, and four of the five duplicated destinations the tab bar and Settings already own. A
  // messenger header holds a name and, at most, one overflow affordance. So: the account/system
  // actions collapse into a single "⋮" menu (the same sheet the rows already use), and "new chat"
  // becomes a floating action button over the list — the primary action deserves the thumb zone,
  // not the hardest-to-reach corner of the screen.
  const overflowBtn = el("button", {
    type: "button",
    class: "gc-icon-btn gc-chats-overflow",
    title: i18n.t("chat.rowActions"),
    "aria-label": i18n.t("chat.rowActions"),
    "aria-haspopup": "menu",
  }, [icon("more")]);
  const titleBar = el("div", { class: "gc-chats-titlebar" }, [
    el("div", { class: "gc-chats-heading" }, [
      el("span", { class: "gc-chats-logo", "aria-hidden": true }, [icon("logo")]),
      el("h1", { class: "gc-chats-title" }, [i18n.t("shell.chats")]),
    ]),
    el("div", { class: "gc-chats-actions" }, [overflowBtn]),
  ]);
  // V5: a search field is the first thing a chat list needs — before this the only way to reach an old
  // conversation was scrolling. It filters the loaded rows locally (see matchesQuery), so it responds
  // instantly and keeps working offline.
  const searchInput = el("input", {
    type: "search",
    class: "gc-chats-search-input",
    placeholder: i18n.t("chat.searchPlaceholder"),
    "aria-label": i18n.t("chat.searchPlaceholder"),
  });
  const searchBox = el("div", { class: "gc-chats-search" }, [
    el("span", { class: "gc-chats-search-icon", "aria-hidden": true }, [icon("search")]),
    searchInput,
  ]);
  searchInput.addEventListener("input", () => { query = searchInput.value; paint(); });
  const header = el("header", { class: "gc-chats-header" }, [
    titleBar,
    searchBox,
    el("div", { class: "gc-tabs", role: "tablist" }, [allTab, archTab]),
  ]);

  const listBox = el("div", { class: "gc-chat-list", role: "list", tabindex: 0, "aria-label": i18n.t("chat.tabAll") });
  // T-426: the empty state is a live entry point, not dead text — a CTA opens the same "New chat" overlay.
  const startBtn = el("button", { type: "button", class: "gc-btn gc-btn-accent" }, [i18n.t("chatList.startFirst")]);
  const emptyText = el("p", {}, [i18n.t("chat.emptyList")]);
  const emptyEl = el("div", { class: "gc-chats-empty" }, [
    emptyText,
    startBtn,
  ]);
  const statusEl = el("p", { class: "gc-chats-status", role: "status", "aria-live": "polite" });

  // V76: three states, three answers. Before this, a dead network painted «Пока нет чатов» plus a
  // «Начать первый чат» button over an account with six chats, and the first paint was a blank white
  // page. `phase` is what the screen actually knows; `lastError` is why the last attempt failed.
  let phase: "loading" | "ready" | "failed" = "loading";
  let lastError: unknown = null;
  const skeletonEl = skeletonList(7, { height: ROW_HEIGHT });
  const failEl = el("div", { class: "gc-chats-fail" });

  root.append(header, statusEl, skeletonEl, listBox, emptyEl, failEl, fab);

  // V119 — device evidence (redroid Android 15, widths 320/360/412 dp via `wm density` 540/480/420,
  // `settings put system font_scale` 1.0/1.3/2.0, ru-RU, signed direct APK, CDP probe
  // var/ux-audit/tools/v119_matrix.mjs, 2026-08-01). The list is virtualised at a fixed row height,
  // and VirtualList writes that height onto every row as an INLINE style, which outranks every
  // stylesheet rule. At `font_scale` 2.0 a row needs 87px of content but was pinned to 72px, so at
  // ALL THREE widths every row overflowed (scrollHeight > clientHeight): the next avatar collided
  // with the previous preview line and the discs were sliced by the row edge. The same inline height
  // was also silently overriding the superapp shell's own `height: 76px`.
  //
  // The fix is to stop dictating the height: measure what the stylesheet plus the platform font
  // actually need for a real row, feed that number back into the scroll geometry, and re-measure
  // whenever the system font size can change. A uniform height is still required — this is a
  // fixed-height virtualiser and every row has the same shape.
  let rowHeightPx = ROW_HEIGHT;
  const measureRowHeight = (): number => {
    const row = listBox.querySelector<HTMLElement>(".gc-chat-row");
    if (!row || typeof row.getBoundingClientRect !== "function") return rowHeightPx;
    const inline = row.style.height;
    // Two questions, two measurements: what the stylesheet asks for (the design's comfortable row)
    // and what the content actually needs at this font size. The row must satisfy both.
    row.style.height = "";
    const styled = row.getBoundingClientRect().height;
    row.style.height = "auto";
    const natural = row.getBoundingClientRect().height;
    row.style.height = inline;
    return chatRowHeight(styled, natural, rowHeightPx);
  };

  const vlist = new VirtualList<ChatEntry>({
    container: listBox,
    itemHeight: () => rowHeightPx,
    renderItem: (entry) => renderRow(entry),
  });

  // paint() also runs on every keystroke in the search box, and the measurement above forces two
  // synchronous layouts. Only two things can move the answer — the platform font factor and the
  // width class — so remember the pair and skip the measurement while it holds.
  let rowHeightKey = "";
  const syncRowHeight = (): void => {
    const zoom = listBox.ownerDocument?.documentElement?.style?.getPropertyValue?.("--gc-sys-text-zoom") ?? "";
    const key = `${zoom}|${listBox.clientWidth ?? 0}`;
    if (key === rowHeightKey) return;
    const next = measureRowHeight();
    rowHeightKey = key;
    if (next === rowHeightPx) return;
    rowHeightPx = next;
    // The loading skeleton stands in for real rows, so it has to grow with them or the list jumps
    // by 15px the moment the data lands.
    for (const node of Array.from(skeletonEl.children)) (node as HTMLElement).style.height = `${next}px`;
    vlist.refreshItemHeight();
  };

  // Android changes the system font size while the app is backgrounded; the WebView reports it as a
  // resize plus a visibilitychange, which is exactly what the text-zoom environment already listens
  // for. Re-using it keeps one definition of "the platform font may have moved".
  const zoomEnv = browserTextZoomEnv();
  const offRowHeightWatch = zoomEnv ? zoomEnv.onChange(() => syncRowHeight()) : null;

  // Optimistically apply a settings change to the in-memory row, repaint, then confirm with the server;
  // on failure re-load from the server (the source of truth) and surface the error.
  const applySettings = async (id: number, patch: Partial<Pick<ChatEntry, "pinned" | "archived" | "muted_until">>): Promise<void> => {
    const idx = entries.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const prev = entries[idx]!;
    entries[idx] = { ...prev, ...patch };
    paint();
    try {
      const res = await api.put<ChatSettings>(`/v1/chats/${id}/settings`, patch);
      const cur = entries.findIndex((c) => c.id === id);
      if (cur >= 0) entries[cur] = { ...entries[cur]!, pinned: res.pinned, archived: res.archived, muted_until: res.muted_until };
      paint();
    } catch (err) {
      statusEl.textContent = describeError(err, i18n);
      await load();
    }
  };

  const openSupportTopics = async (): Promise<void> => {
    if (disposed) return;
    try {
      const { createSupportHelp } = await import("./support_help.ts");
      if (disposed) return;
      modals.open("support-topics", (release) => {
      let closed = false;
      const help = createSupportHelp({
        api,
        i18n,
        ...(deps.media ? { media: deps.media } : {}),
        ...(deps.onOpenSupport ? { onContact: () => { close(); deps.onOpenSupport?.(); } } : {}),
        onOpenChat: (id) => { close(); deps.onOpenChat(id); },
      });
      const closeBtn = el("button", { type: "button", class: "gc-btn" }, [i18n.t("common.close")]);
      const panel = el("div", {
        class: "gc-forward-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": i18n.t("support.help"),
      }, [
        el("h3", { class: "gc-forward-title" }, [i18n.t("support.help")]),
        help.root,
        el("div", { class: "gc-support-actions" }, [closeBtn]),
      ]);
      const overlay = el("div", { class: "gc-overlay" }, [panel]);
      const trap = createFocusTrap(overlay, { initialFocus: closeBtn });
      function close(): void {
        if (closed) return;
        closed = true;
        help.destroy();
        trap.release();
        overlay.remove();
        release();
      }
      closeBtn.addEventListener("click", close);
      overlay.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Escape") { event.preventDefault(); close(); }
      });
      overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
        return {
          node: overlay,
          focus() { trap.activate(); closeBtn.focus(); },
          close,
        };
      });
    } catch (err) {
      if (!disposed) statusEl.textContent = describeError(err, i18n);
    }
  };

  const renderRow = (entry: ChatEntry): HTMLElement => {
    const view = chatRowView(entry, now(), i18n, self);
    const isShortcut = entry.kind === SYSTEM_CHAT_SHORTCUT_KIND;
    const isSupport = entry.username?.trim().toLocaleLowerCase() === "support";
    const isBotCenter = isShortcut && entry.id === SYSTEM_BOT_CENTER_SHORTCUT_ID;
    const isSystemDestination = isShortcut || isSupport;
    // T-427: the Saved-Messages self-dialog shows a bookmark rather than the owner's initial.
    // V5: every other peer gets a deterministic tone + two-letter monogram, so a list of five chats is
    // no longer five identical green discs.
    const avatar = view.isSelf
      ? el("div", { class: "gc-avatar is-saved", "aria-hidden": true }, [icon("spark", "gc-icon gc-avatar-icon")])
      : isSupport
        ? el("div", { class: "gc-avatar", "data-tone": "0", "aria-hidden": true }, [icon("help", "gc-icon gc-avatar-icon")])
        : isBotCenter
          ? el("div", { class: "gc-avatar", "data-tone": "1", "aria-hidden": true }, [icon("layers", "gc-icon gc-avatar-icon")])
          : el("div", { class: "gc-avatar", "data-tone": String(avatarTone(view.title)), "aria-hidden": true }, [
              initials(view.title),
            ]);

    if (!view.isSelf && !isSystemDestination) void bindAvatarImage(avatar, api, entry.photo_file_id, view.title);

    const titleRow = el("div", { class: "gc-row-top" }, [
      el("span", { class: "gc-row-title" }, [view.title]),
      view.pinned ? el("span", { class: "gc-row-pin", title: i18n.t("chat.pinned") }, [icon("pin")]) : "",
      el("span", { class: "gc-row-time" }, [view.time]),
    ]);
    const subRow = el("div", { class: "gc-row-bottom" }, [
      el("span", { class: "gc-row-sub" }, [view.subtitle]),
      view.muted ? el("span", { class: "gc-row-mute", title: i18n.t("chat.muted") }, [icon("bellOff")]) : "",
      view.unread > 0
        ? el("span", { class: view.muted ? "gc-badge gc-badge-muted" : "gc-badge" }, [view.unreadLabel])
        : "",
    ]);

    const main = el("button", { type: "button", class: "gc-chat-open" }, [titleRow, subRow]);
    main.addEventListener("click", () => {
      if (isBotCenter) openBotCreateFlow();
      else if (isSupport) openSupportTopics();
      else deps.onOpenChat(entry.id);
    });

    // Row actions (pin / mute / archive). Before V5 they were three buttons revealed by :hover — which
    // never fires on a touch screen, so on a phone they were unreachable. They now live in the same
    // action sheet the feed uses, opened by long-press, right-click, or the always-present "⋯" button.
    const row = el("div", { class: `gc-chat-row${deps.activeChatId === entry.id ? " is-active" : ""}`, role: "listitem" });
    const rowItems = (): MessageMenuItem[] => [
      {
        id: "pin",
        label: i18n.t("chat.pin"),
        glyph: entry.pinned ? "pinOff" : "pin",
        run: () => void applySettings(entry.id, { pinned: !entry.pinned }),
      },
      {
        id: "mute",
        label: i18n.t("chat.mute"),
        glyph: view.muted ? "bell" : "bellOff",
        run: () => void applySettings(entry.id, { muted_until: view.muted ? 0 : now() + 100 * 365 * 24 * 3600 }),
      },
      {
        id: "archive",
        label: i18n.t("chat.archive"),
        glyph: entry.archived ? "unarchive" : "archive",
        run: () => void applySettings(entry.id, { archived: !entry.archived }),
      },
    ];
    const openRowMenu = (): void => {
      openRowMenuHandle?.close();
      openRowMenuHandle = openMessageMenu({
        i18n,
        host: root,
        anchor: row,
        label: i18n.t("chat.rowActions"),
        title: view.title,
        items: rowItems(),
      });
    };
    const moreBtn = el("button", {
      type: "button",
      class: "gc-row-more",
      title: i18n.t("chat.rowActions"),
      "aria-label": i18n.t("chat.rowActions"),
      "aria-haspopup": "menu",
    }, [icon("more")]);
    moreBtn.addEventListener("click", (event) => { event.stopPropagation(); openRowMenu(); });
    bindLongPress(row, { onTrigger: () => openRowMenu() });

    if (isSystemDestination) row.append(avatar, main);
    else row.append(avatar, main, moreBtn);
    return row;
  };

  let openRowMenuHandle: { close: () => void } | null = null;

  // V162: which VIEW the scroll offset belongs to. A chat list repaints for two very different
  // reasons — its content changed (a message arrived, a row was pinned) or the reader asked for a
  // different list (a query, the other tab) — and until now both were answered the same way: keep
  // the offset. Measured in headless Chromium at the list's own 72px row and a 640px viewport: 100
  // chats, offset 3000 (row 41), type a query that leaves 20 matches → the content is now 1440px
  // tall, the browser clamps the offset to its new maximum 800, and the results open at match #12 of
  // 20. Eleven better matches sit above the top edge with nothing to suggest they exist; the number
  // 800 is not a place anybody chose, it is a leftover trimmed to fit. «Архив» opened the same way.
  //
  // So the offset is stored per view and the view is named. Searching always starts at the first
  // match (the results are new to the reader, and a new query is a new view — that is why the query
  // text is part of the name). A tab keeps its own place, which is what makes leaving the search
  // return the reader to the row they were on rather than to the top of everything.
  const viewOffsets = new Map<string, number>();
  let viewKey = `tab:${tab}`;
  const viewKeyNow = (): string => (query.trim().length === 0 ? `tab:${tab}` : `search:${query.trim()}`);

  const paint = (): void => {
    const source = tab === "all" ? withSystemChatShortcuts(entries, i18n) : entries;
    const inTab = filterChats(source, tab);
    // V147: the collection's accessible name must follow the selected filter. The list used to be
    // created once as «Все» and kept that name after switching to «Архив», so a screen-reader
    // announced an archived collection as the all-chats collection whenever archived rows existed.
    listBox.setAttribute("aria-label", i18n.t(tab === "all" ? "chat.tabAll" : "chat.tabArchived"));
    const shown = query.trim().length === 0
      ? inTab
      : inTab.filter((entry) => {
          const v = chatRowView(entry, now(), i18n, self);
          return matchesQuery(v.title, v.subtitle, query);
        });
    // A view change is the only thing allowed to move the reader; a repaint under an incoming message
    // must leave the list exactly where the reader put it.
    //
    // The order of these three steps is the whole fix, and the first attempt got it wrong. The
    // outgoing offset is read BEFORE setItems(), because setItems() resizes the sizer and the browser
    // immediately clamps scrollTop to the new, shorter content — measured in Chromium: leaving a
    // 100-row list at 3000 for a 20-row result set turns 3000 into 800 before any line here runs, so
    // saving afterwards stores 800 and «return to where I was» quietly becomes «return to a leftover».
    // The restore happens AFTER, for the mirror-image reason: the new content must exist before an
    // offset into it means anything.
    const nextKey = viewKeyNow();
    const viewChanged = nextKey !== viewKey;
    if (viewChanged && viewKey.startsWith("tab:")) viewOffsets.set(viewKey, listBox.scrollTop);
    vlist.setItems(shown);
    if (viewChanged) {
      viewKey = nextKey;
      vlist.scrollToOffset(nextKey.startsWith("tab:") ? (viewOffsets.get(nextKey) ?? 0) : 0);
    }
    const isEmpty = shown.length === 0;
    const searching = query.trim().length > 0;
    // Which of the four states is true right now. Order matters: never claim "no chats" for a list
    // that was never loaded (loading) or failed to load (failed) — both told the user the account is
    // empty, which is the one thing the client does NOT know in those states.
    const busy = phase === "loading" && entries.length === 0;
    const broken = phase === "failed" && entries.length === 0;
    // "flex", not "block": the container has to FILL the space the list would have taken, or the
    // state block floats at the top of a 800px white page (V70: a view that is the whole screen owns
    // the screen).
    skeletonEl.style.display = busy ? "block" : "none";
    failEl.style.display = broken ? "flex" : "none";
    emptyEl.style.display = !busy && !broken && isEmpty ? "block" : "none";
    listBox.style.display = busy || broken || isEmpty ? "none" : "block";
    root.setAttribute("aria-busy", busy ? "true" : "false");
    if (broken) {
      clear(failEl);
      failEl.append(failureState(lastError, i18n, () => { void load(); }));
    }
    // The floating "new chat" button is a promise the offline client cannot keep, and during the
    // first load there is nothing to sit on top of.
    if (busy || broken) {
      fab.style.display = "none";
      allTab.setAttribute("aria-selected", String(tab === "all"));
      archTab.setAttribute("aria-selected", String(tab === "archived"));
      allTab.classList.toggle("is-active", tab === "all");
      archTab.classList.toggle("is-active", tab === "archived");
      return;
    }
    // Two states, two answers. An empty search is not an empty account: offering "start your first
    // chat" as the reply to a query that matched nothing was a non-answer, so a failed search says so
    // and keeps the CTA out of the way.
    emptyText.textContent = i18n.t(searching ? "feed.searchEmpty" : "chat.emptyList");
    startBtn.style.display = searching ? "none" : "";
    // The empty state already carries a full-width "start your first chat" button. Painting the
    // floating button on top of it put two identical accent-green calls to action on one screen, which
    // reads as a layout bug rather than a hierarchy; the FAB belongs over a populated list.
    fab.style.display = isEmpty && !searching ? "none" : "";
    allTab.setAttribute("aria-selected", String(tab === "all"));
    archTab.setAttribute("aria-selected", String(tab === "archived"));
    allTab.classList.toggle("is-active", tab === "all");
    archTab.classList.toggle("is-active", tab === "archived");
    // V119: only here — past every `return` above — is the list actually visible and populated, so
    // this is the first moment a row can be measured. Measuring a `display: none` list yields 0 and
    // is discarded by design.
    syncRowHeight();
  };

  const load = async (strict = false): Promise<void> => {
    // A retry must look like a retry: go back to the loading state so the skeleton replaces the
    // failure block instead of the screen sitting on stale text while the request is in flight.
    if (entries.length === 0) { phase = "loading"; paint(); }
    try {
      const [chats, badge] = await Promise.all([
        api.get<ChatEntry[]>("/v1/chats?filter=all"),
        api.get<Badge>("/v1/badge"),
      ]);
      if (disposed) return;
      entries = sortChats(chats);
      setBadge(badge.total_unread);
      phase = "ready";
      lastError = null;
      statusEl.textContent = "";
      paint();
    } catch (err) {
      if (disposed) return;
      phase = "failed";
      lastError = err;
      // With rows already on screen the honest line is "this is the last data we have" — the old
      // wording ("the action was queued") described a write that never happened.
      statusEl.textContent = entries.length > 0 ? failureLine(err, i18n) : "";
      paint();
      if (strict) throw err;
    }
  };

  const setBadge = (total: number): void => {
    badgeEl.textContent = total > 0 ? String(total) : "";
    badgeEl.style.display = total > 0 ? "inline-flex" : "none";
  };

  // Refresh just the tab badge from the server (source of truth) after a live patch changed unread.
  const refreshBadge = async (): Promise<void> => {
    try {
      const badge = await api.get<Badge>("/v1/badge");
      if (!disposed) setBadge(badge.total_unread);
    } catch { /* badge is best-effort */ }
  };

  // ---- live updates (T-424): patch rows from the event stream, coalescing refetch on a burst ----
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefetch = (): void => {
    if (refetchTimer) return; // coalesce ≤ 1 reload/second under a burst
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      void load();
    }, 1000);
  };

  let unsubscribe: (() => void) | null = null;
  if (deps.events) {
    unsubscribe = deps.events.subscribe((evt) => {
      if (disposed) return;
      if (evt.type === "sync.resync") return load(true);
      if (!LIST_EVENTS.has(evt.type)) return;
      const res = applyListEvent(entries, evt, {
        selfId: self.id,
        openChatId: null, // the list is only mounted when no chat is open (home route)
      });
      if (res.refetch) { scheduleRefetch(); return; }
      if (res.changed) {
        entries = res.entries;
        paint();
        void refreshBadge();
      }
    });
  }

  allTab.addEventListener("click", () => { tab = "all"; paint(); });
  archTab.addEventListener("click", () => { tab = "archived"; paint(); });
  // The system actions that used to be five separate header icons. Order follows how often they are
  // needed; "logout" is marked danger so it never sits visually next to a routine action.
  // T-512 §3.1: «Помощь и поддержка» stays present only when the shell wired the capability.
  let overflowHandle: { close: () => void } | null = null;
  const overflowItems = (): MessageMenuItem[] => {
    const items: MessageMenuItem[] = [];
    if (deps.onOpenSupport) {
      items.push({ id: "support", label: i18n.t("support.help"), glyph: "help", run: () => deps.onOpenSupport?.() });
    }
    items.push({ id: "settings", label: i18n.t("common.settings"), glyph: "settings", run: () => deps.onOpenSettings() });
    if (deps.onOpenImport) {
      items.push({ id: "import", label: i18n.t("shell.import"), glyph: "import", run: () => deps.onOpenImport?.() });
    }
    if (deps.onLock) {
      items.push({ id: "lock", label: i18n.t("lock.lockNow"), glyph: "lock", run: () => deps.onLock?.() });
    }
    items.push({ id: "logout", label: i18n.t("auth.logout"), glyph: "logout", danger: true, run: () => deps.onLogout() });
    return items;
  };
  overflowBtn.addEventListener("click", () => {
    overflowHandle?.close();
    overflowHandle = openMessageMenu({
      i18n,
      host: root,
      anchor: overflowBtn,
      label: i18n.t("chat.rowActions"),
      title: i18n.t("shell.chats"),
      items: overflowItems(),
    });
  });

  // T-426: open the unified creation hub — people/Saved Messages plus groups, broadcasts, channels
  // and the existing Bot Center creation flow.
  // The real ApiClient always supplies searchGlobal/createDialog (they are only optional on the
  // structural ApiLike so legacy fakes still satisfy it); `!` asserts their presence at this seam.
  //
  // QA evidence (headless Chromium 1280x860, ru-RU, live stand, 2026-08-03): the sheet is mounted on
  // `document.body` and nothing owned it, which cost the ordinary user twice.
  //   1. An impatient double tap on «Начать первый чат» (or the + button) built TWO sheets. Each
  //      `.gc-overlay` paints its own `rgba(2,12,8,.58)` scrim, so the page went visibly darker and
  //      dismissing the top sheet uncovered an identical one — the app read as refusing to close.
  //   2. Tapping «Контакты» with the sheet open changed the section underneath and left the sheet
  //      stranded over it: a modal from a screen the person had already left, blocking the new one.
  // Both are the same missing fact — nothing owned the sheet once modalRoot() moved it out of this
  // screen's subtree. The layer below is that owner, and it is the same owner for every screen.
  const openNewChat = (): void => {
    if (disposed) return;
    modals.open("new-chat", (release) => {
      const overlay = createNewChatOverlay({
        i18n,
        self,
        search: (q) => api.searchGlobal!(q),
        listContacts: async () => {
          try {
            return mergeParticipantSuggestions(await loadContacts(api), entries, self.id);
          } catch (error) {
            // A temporary contacts-route failure must not erase already visible recent people.
            const recent = mergeParticipantSuggestions([], entries, self.id);
            if (recent.length > 0) return recent;
            throw error;
          }
        },
        createDialog: (userId) => api.createDialog!(userId),
        createGroup: ({ title, about, memberIds }) => api.post<DialogChat>("/v1/chats/group", {
          title,
          about,
          member_ids: memberIds,
        }),
        createChannel: ({ title, about, username, joinMode }) => api.post<DialogChat>("/v1/chats/channel", {
          title,
          about,
          username,
          join_mode: joinMode,
        }),
        addMembers: (chatId, userIds) => api.post<DialogChat>(`/v1/chats/${chatId}/members`, {
          user_ids: userIds,
        }),
        onCreateBot: () => openBotCreateFlow(),
        onOpenChat: (id) => deps.onOpenChat(id),
        // Slot the just-created dialog in immediately so it is already present if the user comes back.
        onCreated: (chat) => { entries = upsertChat(entries, dialogToEntry(chat, now())); paint(); },
        onClose: release,
      });
      return { node: overlay.root, focus: () => overlay.focus(), close: () => overlay.close() };
    });
  };
  fab.addEventListener("click", () => openNewChat());
  startBtn.addEventListener("click", () => openNewChat());

  paint();
  void load();

  return {
    root,
    destroy() {
      disposed = true;
      if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null; }
      if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      // Body-mounted modals do NOT go away with our subtree — without this the sheet stays on screen
      // over whatever section the person navigated to.
      modals.closeAll();
      offRowHeightWatch?.();
      vlist.destroy();
      tabFitter.destroy();
    },
  };
}

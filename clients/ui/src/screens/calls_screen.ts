// clients/ui/src/screens/calls_screen.ts — the call surface (V74 call log).
//
// WebRTC media stays peer-to-peer; the server exposes ICE configuration, owns the call state machine
// and writes every OUTCOME into the pair's dialog as a service row (T-202 finalize → {status,
// duration_sec, video}). FEATURES.md §M2 states the call log IS a selection over those rows, but
// nothing selected them until GET /v1/calls/history (V74): this screen therefore used to show a list
// of dialogs and no history at all, so a phone that had made twenty calls looked like it had made none.
//
// The screen now answers, in order: what happened recently (the log, newest first, grouped by day),
// and who I can call (my dialogs). It still never renders a fake call button — placing a call lives in
// the conversation — and it never invents history: an empty log says so in one line.
import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import { failureLine, failureState, skeletonList, stateView } from "./state_view.ts";
import type { ChatEntry } from "./types.ts";
import type { EventFeed } from "./feed_screen.ts";
import { avatarTone, initials } from "./message_menu.ts";
import { bindAvatarImage, type AvatarImageBinding } from "./avatar_media.ts";
import { createWidthFitter } from "../fit_width.ts";
import {
  type CallHistoryItem,
  describeCall,
  groupCallsByDay,
  isMissedIncoming,
  missedCount,
  parseCallHistory,
} from "./calls_model.ts";
import { createConferenceHub } from "./conference_hub.ts";

export interface CallsScreenDeps {
  api: ApiLike;
  i18n: I18n;
  onBack(): void;
  onOpenChat(chatId: number): void;
  // True when this screen is one of the shell's own tab destinations. A root destination has nothing
  // to go back TO — the tab bar is already on screen and names every sibling — so the header must not
  // carry a back arrow. Left undefined the arrow stays, which is right for a pushed screen.
  atShellRoot?: boolean;
  // Injectable clock so the day separators ("Сегодня"/"Вчера") are testable.
  now?(): number;
  // V75 — place a call. Optional: without it the screen stays a pure log and the people rows keep
  // their "open the chat" behaviour, because a button that cannot call must not look like one.
  onStartCall?(peer: { id: number; name: string; username?: string | null }, video: boolean): void;
  // V75 — live event feed. A call that just ended became a durable row on the server a moment ago, so
  // the log must refetch instead of showing the state of the world before the conversation. Optional:
  // without it the screen still has its manual refresh.
  events?: EventFeed;
  // V178 — real SFU-backed group calls. Both callbacks are required as a pair: without them the Calls
  // tab remains the 1:1 log and never advertises a group action the shell cannot execute.
  onJoinConference?(conferenceId: string, video: boolean): Promise<void> | void;
  onCreateConference?(chatId: number, video: boolean): Promise<void> | void;
}

interface CallsConfig {
  ice_servers: Array<{ urls: string | string[]; username?: string }>;
  ring_sec: number;
}

const PAGE = 30;

export function createCallsScreen(deps: CallsScreenDeps): { root: HTMLElement; destroy(): void } {
  const { api, i18n } = deps;
  const nowSec = (): number => Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  let disposed = false;
  // Every full reload gets a generation. A slower older request must not overwrite a newer refresh
  // or a call.finished-triggered reload after the newer state has already been rendered.
  let loadEpoch = 0;
  let activeLoadEpoch: number | null = null;
  // A refresh failure must preserve a screen or call log that was already proven valid. These flags
  // distinguish first load (where an explicit failure block is required) from stale-data fallback.
  let hasScreenSnapshot = false;
  let hasHistorySnapshot = false;
  // The accumulated log across pages, plus the cursor for "show earlier". Kept on the closure so a
  // second page appends instead of re-rendering from scratch.
  let history: CallHistoryItem[] = [];
  let cursor: number | null = null;
  // `null` means the endpoint answered successfully (possibly with a genuinely empty page). The
  // wrapper is intentional: JavaScript permits Promise.reject(null), so the reason itself cannot be
  // used as the sentinel that distinguishes "no failure" from "failed with a null reason".
  let historyFailure: { error: unknown } | null = null;
  // Which slice of the log is on screen. Lives on the closure so appending a page keeps the choice.
  let logFilter: "all" | "missed" = "all";
  let chatAvatarById = new Map<number, number | null>();
  let logAvatarBindings: AvatarImageBinding[] = [];
  let peopleAvatarBindings: AvatarImageBinding[] = [];
  const resetBindings = (bindings: AvatarImageBinding[]): void => {
    for (const binding of bindings) binding.destroy();
    bindings.length = 0;
  };
  const callAvatar = (
    title: string,
    fileId: number | null | undefined,
    bindings: AvatarImageBinding[],
  ): HTMLElement => {
    const avatar = el("span", { class: "gc-avatar gc-call-avatar", "data-tone": String(avatarTone(title)), "aria-hidden": true }, [
      initials(title),
    ]);
    bindings.push(bindAvatarImage(avatar, api, fileId ?? null, title));
    return avatar;
  };

  const back = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.back"), "aria-label": i18n.t("common.back") }, [icon("back")]);
  back.addEventListener("click", deps.onBack);
  const refresh = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.retry"), "aria-label": i18n.t("common.retry") }, [icon("refresh")]);
  const header = el("header", { class: "gc-calls-header" }, [
    ...(deps.atShellRoot === true ? [] : [back]),
    el("div", { class: "gc-calls-heading" }, [el("h1", {}, [i18n.t("calls.title")]), el("p", {}, [i18n.t("calls.subtitle")])]),
    refresh,
  ]);
  const status = el("p", { class: "gc-calls-status", role: "status", "aria-live": "polite" });
  // V76: the loading state now has the shape of the thing being loaded — a list of call rows, not two
  // 132px cards. A placeholder that lies about the layout makes the screen jump when data lands.
  const body = el("main", { class: "gc-calls-body", "aria-busy": "true" }, [skeletonList(5)]);
  const root = el("div", { class: "gc-calls" }, [header, status, body]);
  const conferenceHub = deps.onJoinConference && deps.onCreateConference
    ? createConferenceHub({
        api,
        i18n,
        ...(deps.events ? { events: deps.events } : {}),
        onJoin: deps.onJoinConference,
        onCreate: deps.onCreateConference,
      })
    : null;

  // One log line: direction arrow, the peer's avatar (same seed as everywhere else), name, outcome
  // text, and the clock. Tapping it opens the dialog, which is where a call is placed — so the row is
  // an action, not a dead record.
  const logRow = (item: CallHistoryItem): HTMLElement => {
    const line = describeCall(item, i18n);
    // V83: the direction mark rides WITH the words it qualifies ("↗ Исходящий · 0:47") instead of
    // standing in a 22px column of its own. Measured at 390x844 that column pushed the avatar to
    // x=52 and the name to x=104, while the chat list put them at 12 and 76 — so switching tabs
    // shifted every name 28px sideways and shrank every face by 6px. One list grid, one left edge.
    const meta = [
      // data-dir carries the fact the glyph already draws so the stylesheet can tone the mark
      // (incoming green / outgoing neutral / missed alert) without re-deriving it from the icon name.
      el("span", { class: "gc-call-log-arrow", "data-dir": line.missed ? "missed" : item.direction, "aria-hidden": true }, [icon(line.icon)]),
      el("span", { class: "gc-call-log-outcome" }, [line.detail]),
    ];
    if (line.video) {
      meta.push(el("span", { class: "gc-call-log-video", title: i18n.t("calls.logVideoBadge") }, [icon("video")]));
    }
    const row = el(
      "button",
      {
        type: "button",
        class: line.missed ? "gc-call-log-row gc-call-log-row-missed" : "gc-call-log-row",
        "aria-label": i18n.t("calls.logOpenChat", { name: line.title }),
      },
      [
        callAvatar(line.title, chatAvatarById.get(item.chat_id), logAvatarBindings),
        el("span", { class: "gc-call-log-copy" }, [
          el("strong", {}, [line.title]),
          el("span", { class: "gc-call-log-meta" }, meta),
        ]),
        el("span", { class: "gc-call-log-time" }, [line.time]),
      ],
    );
    if (item.chat_id > 0) row.addEventListener("click", () => deps.onOpenChat(item.chat_id));
    else row.disabled = true;
    // Redial. A log entry already carries the peer, so the one action a call log exists for — "call
    // them back" — is a single tap here instead of a trip through the conversation. Rendered only
    // when the shell can actually place a call and the peer still exists.
    const peer = item.peer;
    if (!deps.onStartCall || !peer) return row;
    const redial = el(
      "button",
      {
        type: "button",
        class: "gc-call-log-redial",
        title: i18n.t("calls.logRedial", { name: line.title }),
        "aria-label": i18n.t("calls.logRedial", { name: line.title }),
      },
      [icon(item.video ? "video" : "phone")],
    );
    redial.addEventListener("click", (ev) => {
      ev.stopPropagation(); // the row underneath opens the chat; a redial must not do both
      deps.onStartCall?.({ id: peer.id, name: peer.name, username: peer.username ?? null }, item.video);
    });
    return el("div", { class: "gc-call-log-line" }, [row, redial]);
  };

  // V83: the log used to open with an `<h2>Недавние звонки` directly under the header's own
  // `<h1>Звонки` — the same word twice, costing 147 of 844 measured points before the first call.
  // A system call log spends that row on a filter instead, so the strip below both names the list
  // and does something: «Все» / «Пропущенные», the second carrying the count the old chip carried.
  // The filter applies to the pages already loaded (the endpoint has no status parameter); "показать
  // ещё" keeps loading whole pages, so the count grows as history is pulled in rather than lying
  // about a server-side total.
  const tabFitter = createWidthFitter();
  const filterTab = (key: "all" | "missed", label: string, badge?: string): HTMLElement => {
    const inner: (string | HTMLElement)[] = [label];
    if (badge) inner.push(el("span", { class: "gc-tab-badge" }, [badge]));
    // V102: the same fixed-slot tab label the chat list carries — at 320 dp with the system font
    // at 2.0 the word is wider than its slot and was painted through the tab's edge. The fitter
    // scales it only when it actually overflows (measured, not a breakpoint).
    const labelEl = el("span", { class: "gc-tab-label" }, inner);
    const tab = el(
      "button",
      {
        type: "button",
        class: logFilter === key ? "gc-tab is-active" : "gc-tab",
        role: "tab",
        "aria-selected": logFilter === key ? "true" : "false",
      },
      [labelEl],
    );
    tabFitter.track(labelEl);
    tab.addEventListener("click", () => {
      if (logFilter === key) return;
      logFilter = key;
      body.querySelector(".gc-call-log")?.replaceWith(renderLog());
    });
    return tab;
  };

  const renderLog = (): HTMLElement => {
    resetBindings(logAvatarBindings);
    const missed = missedCount(history);
    const section = el("section", { class: "gc-calls-section gc-call-log" }, [
      el("div", { class: "gc-tabs gc-call-log-tabs", role: "tablist" }, [
        filterTab("all", i18n.t("calls.logFilterAll")),
        filterTab("missed", i18n.t("calls.logFilterMissed"), missed > 0 ? String(missed) : undefined),
      ]),
    ]);
    if (historyFailure !== null) {
      // Keep the People section usable, but never substitute an empty-log claim for a failed read.
      // The shared failure state distinguishes offline from a server response and supplies retry.
      section.append(failureState(historyFailure.error, i18n, () => { void load(); }));
      return section;
    }
    const rows = logFilter === "missed" ? history.filter((item) => isMissedIncoming(item)) : history;
    if (rows.length === 0) {
      // Not a full-page stage: the People section below is real content, so the empty log is one
      // honest line inside its own section (V70 reserved `.gc-finance-empty:only-child` for a screen
      // that has nothing else at all). An empty FILTER is a different sentence from an empty log —
      // "you have missed nothing" is good news, "you have never called" is an onboarding line (V76).
      const [title, lead] =
        logFilter === "missed"
          ? [i18n.t("calls.logNoMissed"), i18n.t("calls.logNoMissedLead")]
          : [i18n.t("calls.logEmpty"), i18n.t("calls.logEmptyLead")];
      section.append(el("div", { class: "gc-call-log-empty" }, [el("strong", {}, [title]), el("span", {}, [lead])]));
      return section;
    }
    const list = el("div", { class: "gc-call-log-list" });
    for (const group of groupCallsByDay(rows, nowSec(), i18n)) {
      list.append(el("div", { class: "gc-call-log-day" }, [group.label]));
      for (const item of group.items) list.append(logRow(item));
    }
    section.append(list);
    if (cursor !== null) {
      const more = el("button", { type: "button", class: "gc-call-log-more" }, [i18n.t("calls.logMore")]);
      more.addEventListener("click", () => {
        if (activeLoadEpoch !== null) return;
        more.disabled = true;
        more.textContent = i18n.t("common.loading");
        void loadMore();
      });
      section.append(more);
    }
    return section;
  };

  const renderPeople = (chats: ChatEntry[]): HTMLElement => {
    resetBindings(peopleAvatarBindings);
    const dialogList = el("div", { class: "gc-call-dialog-list" });
    // Whom can I call: every one-to-one chat I actually have. The handle is a subtitle, not an entry
    // ticket — a peer without one (or a deleted account) still gets a row.
    const dialogs = chats.filter((chat) => chat.kind === "dialog" && chat.peer_is_bot !== true).slice(0, 12);
    for (const chat of dialogs) {
      const subtitle = chat.username ? `@${chat.username}` : i18n.t("calls.recentActivity");
      const open = el("button", { type: "button", class: "gc-call-dialog" }, [
        // Same seed as every other avatar in the client (see avatar_tone_consistency.test.ts).
        callAvatar(chat.title, chat.photo_file_id, peopleAvatarBindings),
        el("span", { class: "gc-call-dialog-copy" }, [el("strong", {}, [chat.title]), el("span", {}, [subtitle])]),
        // The action of this row is "open the conversation" (that is where the call buttons live), so
        // the affordance says exactly that. It used to draw a phone, which promised a call the row
        // could not place — a chat entry carries no peer user id.
        el("span", { class: "gc-call-open-icon", "aria-hidden": true }, [icon("chevron")]),
      ]);
      open.addEventListener("click", () => deps.onOpenChat(chat.id));
      dialogList.append(open);
    }
    return el("section", { class: "gc-calls-section" }, [
      el("div", { class: "gc-section-heading" }, [el("h2", {}, [i18n.t("calls.people")]), el("span", {}, [i18n.t("calls.openChatHint")])]),
      dialogs.length
        ? dialogList
        // V85: was a second `.gc-finance-empty` block. One language for "there is nothing here".
        : stateView({ tone: "empty", icon: "calls", title: i18n.t("calls.noDialogs"), body: i18n.t("calls.noDialogsLead") }),
    ]);
  };

  // "Show earlier": one more page appended in place. A failure restores the button rather than
  // wiping the log that is already on screen.
  const loadMore = async (): Promise<void> => {
    if (cursor === null || activeLoadEpoch !== null) return;
    const epoch = loadEpoch;
    const before = cursor;
    try {
      const page = parseCallHistory(await api.get<unknown>(`/v1/calls/history?limit=${PAGE}&before=${before}`));
      if (disposed || epoch !== loadEpoch || cursor !== before) return;
      history = [...history, ...page.items];
      cursor = page.next_before;
      const log = body.querySelector(".gc-call-log");
      log?.replaceWith(renderLog());
    } catch (err) {
      if (disposed || epoch !== loadEpoch || cursor !== before) return;
      status.textContent = failureLine(err, i18n);
      const log = body.querySelector(".gc-call-log");
      log?.replaceWith(renderLog());
    }
  };

  const load = async (): Promise<void> => {
    const epoch = ++loadEpoch;
    activeLoadEpoch = epoch;
    body.setAttribute("aria-busy", "true");
    status.textContent = i18n.t("common.loading");
    const more = body.querySelector(".gc-call-log-more") as HTMLButtonElement | null;
    if (more) more.disabled = true;
    // Only a full-page first-load failure becomes a skeleton on retry. A nested empty/partial state on
    // an otherwise valid screen must not make refresh erase the snapshot it is supposed to protect.
    if (!hasScreenSnapshot && body.querySelector(".gc-state")) { clear(body); body.append(skeletonList(5)); }
    try {
      // Config and chats are required for the screen. History is independent: handle its rejection
      // immediately, but do not make a required failure wait for a history request that may hang.
      const historyRequest = api.get<unknown>(`/v1/calls/history?limit=${PAGE}`).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const [config, chats] = await Promise.all([
        api.get<CallsConfig>("/v1/calls/config"),
        api.get<ChatEntry[]>("/v1/chats?filter=all"),
      ]);
      if (disposed || epoch !== loadEpoch) return;
      const historyResult = await historyRequest;
      if (disposed || epoch !== loadEpoch) return;
      chatAvatarById = new Map(chats.map((chat) => [chat.id, chat.photo_file_id]));
      resetBindings(logAvatarBindings);
      resetBindings(peopleAvatarBindings);
      clear(body);
      const turnReady = config.ice_servers.some((server) => {
        const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
        return urls.some((url) => url.startsWith("turn:") || url.startsWith("turns:"));
      });
      // Readiness is one sentence and belongs in the status line the header already reserves — not in
      // a card (V69 removed the 358x211 billboard whose only fact was hidden on every phone).
      const readiness = [
        turnReady ? i18n.t("calls.turnReady") : i18n.t("calls.stunOnly"),
        i18n.t("calls.ringTime", { seconds: String(config.ring_sec) }),
      ].join(" · ");

      let nextStatus = readiness;
      if (historyResult.ok) {
        const page = parseCallHistory(historyResult.value);
        history = page.items;
        cursor = page.next_before;
        historyFailure = null;
        hasHistorySnapshot = true;
      } else if (hasHistorySnapshot) {
        // A refresh failure does not invalidate data that was already rendered successfully.
        historyFailure = null;
        nextStatus = failureLine(historyResult.error, i18n);
      } else {
        history = [];
        cursor = null;
        historyFailure = { error: historyResult.error };
      }

      conferenceHub?.setChats(chats);
      const hasCallablePeople = chats.some((chat) => chat.kind === "dialog" && chat.peer_is_bot !== true);
      const hasConferenceChats = conferenceHub !== null && chats.some((chat) => chat.kind !== "dialog");
      const firstUseEmpty = historyFailure === null && history.length === 0 && !hasCallablePeople && !hasConferenceChats;
      if (firstUseEmpty) {
        // A new account has one condition, not two: no call history because there is nobody to call
        // yet. Rendering the compact log-empty line above the full People empty state repeated that
        // absence in two visual languages. Let one screen-level state own the free area; as soon as
        // either history or a dialog exists, the two independent sections return below.
        body.append(stateView({
          tone: "empty",
          icon: "calls",
          title: i18n.t("calls.noDialogs"),
          body: i18n.t("calls.noDialogsLead"),
        }));
      } else {
        body.append(renderLog(), renderPeople(chats));
        if (conferenceHub) body.append(conferenceHub.root);
      }
      hasScreenSnapshot = true;
      activeLoadEpoch = null;
      status.textContent = nextStatus;
      body.setAttribute("aria-busy", "false");
    } catch (err) {
      if (disposed || epoch !== loadEpoch) return;
      activeLoadEpoch = null;
      if (hasScreenSnapshot) {
        // The read failed, but the currently rendered screen is still a truthful last-known snapshot.
        status.textContent = failureLine(err, i18n);
        body.querySelector(".gc-call-log")?.replaceWith(renderLog());
        body.setAttribute("aria-busy", "false");
        return;
      }
      clear(body);
      // V76: the screen used to print the failure and stop there — a dead end with no way back. It
      // also drew the same warning glyph for a dropped connection and for a server 500; those are
      // different facts with different answers, so failureState() picks the wording and the glyph.
      body.append(failureState(err, i18n, () => { void load(); }));
      status.textContent = "";
      body.setAttribute("aria-busy", "false");
    }
  };

  refresh.addEventListener("click", () => void load());
  void load();

  // A finished call (and a full resync) invalidates the log. Reloading the whole screen is right here:
  // the page is two short sections, and a partial merge would have to reconcile pagination cursors.
  const stopEvents = deps.events?.subscribe((evt) => {
    if (evt.type !== "call.finished" && evt.type !== "sync.resync") return;
    // Keep the last-known log until the refetch succeeds; clearing first turns an offline event refresh
    // into a false empty state and defeats stale-data fallback.
    void load();
  }) ?? null;

  return {
    root,
    destroy() {
      disposed = true;
      stopEvents?.();
      conferenceHub?.destroy();
      resetBindings(logAvatarBindings);
      resetBindings(peopleAvatarBindings);
      tabFitter.destroy();
    },
  };
}

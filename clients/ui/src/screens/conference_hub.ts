import type { I18n } from "../i18n.ts";
import { clear, el } from "../dom.ts";
import { icon } from "../icons.ts";
import type { ApiLike } from "./api.ts";
import type { EventFeed } from "./feed_screen.ts";
import type { ChatEntry } from "./types.ts";
import { conferenceText } from "./conference_strings.ts";
import type { ConferenceMode } from "./conference_model.ts";

export interface ConferenceSummary {
  id: string;
  chatId: number;
  mode: ConferenceMode;
  video: boolean;
  createdAt: number;
  participantCount: number;
}

export interface ConferenceHubDeps {
  api: ApiLike;
  i18n: I18n;
  events?: EventFeed;
  onJoin(conferenceId: string, video: boolean): Promise<void> | void;
  onCreate(chatId: number, video: boolean): Promise<void> | void;
}

export interface ConferenceHub {
  root: HTMLElement;
  setChats(chats: readonly ChatEntry[]): void;
  refresh(): Promise<void>;
  destroy(): void;
}

function safeMode(raw: unknown): ConferenceMode {
  return raw === "stage" || raw === "broadcast" ? raw : "conversation";
}

export function parseConferenceList(raw: unknown): ConferenceSummary[] {
  const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const list = Array.isArray(source.items) ? source.items : [];
  const out: ConferenceSummary[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const chatId = Number(row.chat_id);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(chatId) || chatId <= 0) continue;
    out.push({
      id,
      chatId,
      mode: safeMode(row.mode),
      video: row.video === true,
      createdAt: Number.isFinite(Number(row.created_at)) ? Number(row.created_at) : 0,
      participantCount: Array.isArray(row.participants) ? row.participants.length : 0,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

export function canStartConference(chat: ChatEntry): boolean {
  if (chat.kind === "dialog") return false;
  return chat.my_role === "owner" || chat.my_role === "admin";
}

export function createConferenceHub(deps: ConferenceHubDeps): ConferenceHub {
  const { api, i18n } = deps;
  const locale = i18n.locale;
  let chats: readonly ChatEntry[] = [];
  let rooms: ConferenceSummary[] = [];
  let available = false;
  let disposed = false;
  let epoch = 0;
  let busy = false;
  let loaded = false;
  let failure: unknown = null;

  const heading = el("div", { class: "gc-section-heading gc-conference-heading" }, [
    el("div", {}, [
      el("h2", {}, [conferenceText(locale, "sectionTitle")]),
      el("span", {}, [conferenceText(locale, "sectionLead")]),
    ]),
    el("span", { class: "gc-conference-live-dot", "aria-hidden": "true" }),
  ]);
  const status = el("p", { class: "gc-conference-status", role: "status", "aria-live": "polite" });
  const body = el("div", { class: "gc-conference-hub-body", "aria-busy": "true" });
  const root = el("section", { class: "gc-calls-section gc-conference-hub" }, [heading, status, body]);

  const modeLabel = (mode: ConferenceMode): string => conferenceText(locale,
    mode === "stage" ? "modeStage" : mode === "broadcast" ? "modeBroadcast" : "modeConversation");

  const run = async (task: () => Promise<void> | void): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      await task();
      failure = null;
      await load();
    } catch (error) {
      failure = error;
      render();
    } finally {
      busy = false;
      render();
    }
  };

  const action = (label: string, glyph: "phone" | "video", onClick: () => void): HTMLButtonElement => {
    const button = el("button", {
      type: "button",
      class: "gc-conference-action",
      disabled: busy ? true : undefined,
      "aria-label": label,
      title: label,
    }, [icon(glyph), el("span", {}, [label])]);
    button.addEventListener("click", onClick);
    return button;
  };

  const renderActive = (): HTMLElement => {
    const section = el("div", { class: "gc-conference-block" }, [
      el("h3", {}, [conferenceText(locale, "activeTitle")]),
    ]);
    if (rooms.length === 0) {
      section.append(el("p", { class: "gc-conference-empty" }, [conferenceText(locale, "noActive")]));
      return section;
    }
    const list = el("div", { class: "gc-conference-list" });
    for (const room of rooms) {
      const chat = chats.find((item) => item.id === room.chatId);
      const title = chat?.title.trim() || `#${room.chatId}`;
      const join = action(conferenceText(locale, "join"), room.video ? "video" : "phone", () => {
        void run(() => deps.onJoin(room.id, room.video));
      });
      join.classList.add("gc-conference-join");
      list.append(el("article", { class: "gc-conference-row" }, [
        el("span", { class: "gc-conference-row-icon", "aria-hidden": "true" }, [icon(room.video ? "video" : "phone")]),
        el("span", { class: "gc-conference-row-copy" }, [
          el("strong", {}, [title]),
          el("span", {}, [
            `${modeLabel(room.mode)} · ${conferenceText(locale, "participants", { count: String(room.participantCount) })}`,
          ]),
        ]),
        join,
      ]));
    }
    section.append(list);
    return section;
  };

  const renderStart = (): HTMLElement => {
    const section = el("div", { class: "gc-conference-block" }, [
      el("h3", {}, [conferenceText(locale, "startTitle")]),
    ]);
    const activeChats = new Set(rooms.map((room) => room.chatId));
    const candidates = chats.filter((chat) => canStartConference(chat) && !activeChats.has(chat.id)).slice(0, 12);
    if (candidates.length === 0) {
      section.append(el("p", { class: "gc-conference-empty" }, [conferenceText(locale, "noGroups")]));
      return section;
    }
    const list = el("div", { class: "gc-conference-start-list" });
    for (const chat of candidates) {
      const controls = el("span", { class: "gc-conference-start-actions" }, [
        action(conferenceText(locale, "startAudio"), "phone", () => {
          void run(() => deps.onCreate(chat.id, false));
        }),
        action(conferenceText(locale, "startVideo"), "video", () => {
          void run(() => deps.onCreate(chat.id, true));
        }),
      ]);
      list.append(el("article", { class: "gc-conference-start-row" }, [
        el("span", { class: "gc-conference-row-copy" }, [
          el("strong", {}, [chat.title]),
          el("span", {}, [conferenceText(locale, chat.kind === "channel" ? "channelKind" : "groupKind")]),
        ]),
        controls,
      ]));
    }
    section.append(list);
    return section;
  };

  function render(): void {
    if (disposed) return;
    body.setAttribute("aria-busy", loaded ? "false" : "true");
    status.textContent = failure
      ? conferenceText(locale, "unavailable")
      : loaded ? "" : conferenceText(locale, "loading");
    clear(body);
    if (!loaded && rooms.length === 0) return;
    if (!available && !failure) {
      body.append(el("p", { class: "gc-conference-empty gc-conference-disabled" }, [
        conferenceText(locale, "disabled"),
      ]));
      return;
    }
    body.append(renderActive(), renderStart());
    if (failure) {
      const retry = el("button", { type: "button", class: "gc-conference-retry" }, [conferenceText(locale, "retry")]);
      retry.addEventListener("click", () => { void load(); });
      body.append(retry);
    }
  }

  async function load(): Promise<void> {
    const runEpoch = ++epoch;
    if (!loaded) render();
    try {
      const raw = await api.get<unknown>("/v1/conferences");
      const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const next = parseConferenceList(source);
      if (disposed || runEpoch !== epoch) return;
      available = source.enabled === true;
      rooms = next;
      loaded = true;
      failure = null;
    } catch (error) {
      if (disposed || runEpoch !== epoch) return;
      failure = error;
      loaded = true;
    }
    render();
  }

  const stopEvents = deps.events?.subscribe((event) => {
    if (!event.type.startsWith("conference.")) return;
    void load();
  }) ?? null;

  render();
  void load();

  return {
    root,
    setChats(next) {
      chats = [...next];
      render();
    },
    refresh: load,
    destroy() {
      disposed = true;
      epoch += 1;
      stopEvents?.();
    },
  };
}

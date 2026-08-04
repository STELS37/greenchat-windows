// clients/ui/src/screens/feed_screen.ts — the web message feed (T-406). DOM-only orchestration on top
// of the pure feed_model and the core substrate (ApiClient + Outbox + SyncEngine) reached through the
// structural ports below (the UI never imports clients/core). It owns: virtualised history with
// before_id/after_id paging + jump-to-message, optimistic send/edit/delete with a 5 s undo and Outbox
// status ticks (🕓/✓/⚠+retry), reply/forward/pin, reactions, drafts, @mentions and in-chat search.
import type { I18n } from "../i18n.ts";
import type { ApiLike } from "./api.ts";
import type { ReportTarget } from "./report_overlay.ts";
import type { Message, ChatMember, ChatEntry, MsgReaction, MsgInlineButton, ChatReceiptState } from "./types.ts";
import { el, clear, modalRoot, safeUrl } from "../dom.ts";
import { createModalLayer } from "../modal_layer.ts";

import { icon } from "../icons.ts";

import { describeError, isNetworkError } from "./api.ts";
import { failureLine, stateView } from "./state_view.ts";
import { createComposer } from "./composer.ts";
import type { ComposerSubmit } from "./composer.ts";
import { takePendingShare } from "./share.ts";
import { renderAttachment, renderAlbumGroup, cleanupMedia, openViewer } from "./media.ts";
import type { MediaPort, MediaEnv, AttachmentDeps } from "./media.ts";
import { createChatInfoOverlay } from "./chat_info.ts";
import { bindAvatarImage, type AvatarImageBinding } from "./avatar_media.ts";
import { createAttachTray } from "./attach_tray.ts";
import type { AttachTray } from "./attach_tray.ts";
import { voiceNoteFormat, voiceNoteStrings } from "./voice_note_strings.ts";
import { createStickerPicker } from "./sticker_picker.ts";
import { stickerSendBody } from "./sticker_model.ts";
import {
  mergeMessages, upsertMessage, applyDelete, removeMessage, applyReactionUpdate, toggleReaction,
  historyPath, oldestId, newestId, trimWindow, tickFor,
  receiptForMessage, receiptGlyph,
  bubbleView, canEdit, needsDaySeparator, dayLabel, isServiceMessage, serviceText, serviceFoldKey,
  serviceRunText, presenceLabel, remoteDraftDecision,
} from "./feed_model.ts";
import type { PresenceState } from "./feed_model.ts";
import { isSelfDialog } from "./chat_model.ts";
import {
  openMessageMenu,
  bindLongPress,
  avatarTone,
  initials,
  type MessageMenuItem,
} from "./message_menu.ts";

import {
  CHAT_CACHE_OPTIONS,
  normalizeChatCacheMode,
  type CachePolicyPort,
  type ChatCacheMode,
} from "./cache_policy_model.ts";

// ---- structural ports (a concrete Outbox / event bus is injected by the shell; UI stays core-free) ----

export interface OutboxItemView {
  id: string;
  chat_id: number;
  kind: "message" | "edit" | "delete";
  status: "queued" | "sending" | "sent" | "failed";
  body?: Record<string, unknown>;
  created_at: number;
  error?: { code: string; message: string };
  result?: unknown;
}

export interface OutboxChangeView {
  item: OutboxItemView;
  removed?: boolean;
}

export interface OutboxPort {
  enqueueMessage(chatId: number, body: Record<string, unknown>): Promise<string>;
  enqueueEdit(chatId: number, messageId: number, text: string): Promise<string>;
  enqueueDelete(chatId: number, messageId: number): Promise<string>;
  cancel(id: string): Promise<boolean>;
  retry(id: string): Promise<void>;
  subscribe(handler: (change: OutboxChangeView) => void): () => void;
}

export interface EventFeed {
  // A resync handler may return a Promise; the shell awaits every mounted screen before acknowledging
  // the server head. Ordinary live-event handlers may continue returning void.
  subscribe(handler: (evt: { type: string; payload: unknown }) => void | Promise<void>): () => void;
}

export interface FeedSelf {
  id: number;
  username: string;
  name: string;
}

export interface FeedDeps {
  api: ApiLike;
  i18n: I18n;
  chatId: number;
  self: FeedSelf;
  outbox: OutboxPort;
  events: EventFeed;
  onBack: () => void;
  focusMessageId?: number;
  now?: () => number;
  // T-407: media transport + live environment. Optional — when absent the feed renders text only and
  // the composer shows no attach button (graceful degradation for shells that don't wire media).
  media?: MediaPort;
  mediaEnv?: MediaEnv;
  onOpenSupport?: () => void; // T-512 §3.1: «?» in the feed header — opens the support/feedback overlay.
  onReport?: (target: ReportTarget) => void;
  // V75 — place a call. A call belongs to the conversation (that is where the person is), so the
  // entry point is the dialog header, not the "Звонки" tab, which stays a log. Optional: a shell that
  // wires no calling simply renders no button instead of a decorative one that does nothing.
  onStartCall?: (peer: { id: number; name: string; username?: string | null }, video: boolean) => void;

  // Native GreenChat Mini App launcher from a bot inline keyboard. The route host receives the chat
  // context and optional start parameter; no external messenger or token is involved.
  onOpenMiniApp?: (appId: number, chatId: number, startParam?: string) => void;

  // T-529: per-chat local-cache override. Cloud-only keeps history/media/outbox off disk.
  cachePolicy?: CachePolicyPort;
}

interface Pending {
  cmid: string;
  text: string;
  replyToId: number | null;
  status: "queued" | "sending" | "sent" | "failed";
  created_at: number;
}

// V92 — "does focusing the input summon an on-screen keyboard?"
// Measured on the signed APK 1000010 (redroid 15, Chrome DevTools Protocol against the WebView):
// opening a chat took the viewport from 820x343 to 820x113 in landscape, i.e. the keyboard covered
// the conversation the user had just asked to read, before a single message was visible. Telegram
// for Android does the same thing only when it is opened to write (share/draft), never on a plain
// open. A coarse pointer is the standard signal for "the keyboard is virtual and steals the screen";
// a mouse/trackpad shell keeps the old behaviour, where focusing costs nothing.
const hasVirtualKeyboard = (): boolean => {
  const mm = (globalThis as { matchMedia?: (q: string) => { matches: boolean } }).matchMedia;
  if (typeof mm !== "function") return false;
  try {
    return mm("(pointer: coarse)").matches === true;
  } catch {
    return false; // a shell with a broken/partial matchMedia must not lose the desktop behaviour
  }
};

// V105 — the conversation header gave 18% of its width to the one thing that says WHO you are
// talking to. Measured on the signed superapp APK 1000013 through the device WebView (redroid 15,
// 391 dp viewport, route #/chat/17, var/ux-audit/tools/m_feedhdr_v105.mjs, 2026-07-31), 1:1 dialog,
// DEFAULT system font:
//
//   .gc-feed-header          391.2   padding-inline 16, gap 10
//   back button               44
//   .gc-feed-identity        135.2   38 avatar + 26 gaps/padding  =>  71 px for the names
//   .gc-feed-header-actions  176.0   4 x 44 (call, video, search, overflow), flex: 0 0 auto
//   .gc-feed-title            71 wide / 111 needed  ->  «Артём Волков» painted «Артём Вол…»
//   .gc-feed-subtitle         71 wide /  80 needed  ->  «был(а) в 10:49» painted «был(а) в 10:4…»
//
// The bar's arithmetic is names = vw − 144 − 44·actions, so with four actions a 12-character name
// needs a 431 dp viewport: every phone in portrait (320–430 dp) truncated the peer's name and their
// presence line out of the box, and at an enlarged system font the same bar showed «Ар…». The icons
// cannot yield — the actions row is `flex: 0 0 auto` — so the identity absorbs the whole shortfall.
//
// Search is the least-used of the four and the one every phone messenger keeps in the overflow menu
// (WhatsApp for Android: video, call and ⋮ in the bar, "Search" inside the menu). Folding it there
// buys 44 dp of name at every phone width and removes nothing: the menu is already in the bar and
// already carries the support destination and the per-chat cache modes.
//
// 480 px is the breakpoint: the arithmetic starves at 431, the widest phone in portrait is 430 dp
// (iPhone 14 Pro Max), and 480 sits below the 560/760 tablet layers the stylesheet already uses.
// V113b measures the BAR against the same number, so a two-pane layout whose conversation column is
// narrower than a phone folds exactly like a phone does.
const PHONE_HEADER_PX = 480;
const PHONE_HEADER_QUERY = `(max-width: ${PHONE_HEADER_PX}px)`;

interface HeaderViewport {
  matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

/** The viewport class the header reads; `null` when the shell cannot answer (then nothing folds). */
const phoneHeaderViewport = (): HeaderViewport | null => {
  const mm = (globalThis as { matchMedia?: (q: string) => HeaderViewport }).matchMedia;
  if (typeof mm !== "function") return null;
  try {
    const mq = mm(PHONE_HEADER_QUERY);
    return mq && typeof mq.matches === "boolean" ? mq : null;
  } catch {
    return null; // a shell with a broken/partial matchMedia keeps every action on screen
  }
};

const PAGE = 40;
const MAX_WINDOW = 160; // retained bubbles before trimming the far end (keeps the DOM bounded)
const NEAR_EDGE = 120; // px from top/bottom that triggers a page load
const AT_BOTTOM = 48; // px slack that still counts as "pinned to the newest message"
const UNDO_MS = 5000;
const EDIT_WINDOW_SEC = 48 * 3600;
// U+2764 alone is a TEXT-presentation code point: without the U+FE0F variation selector the browser
// draws a black outline heart, which is exactly how the quick-reaction strip shipped. Every glyph here
// must be emoji-presentation so the strip renders in colour on every platform.
const QUICK_REACTIONS = ["👍", "❤️", "🔥", "😁", "😮", "🙏"];
// V5 grouping: consecutive messages by the same author within this window are painted as one run
// (author shown once, tight spacing, pointed corner + avatar only on the last bubble).
const GROUP_WINDOW_SEC = 300;

// V179 — public usernames inside ordinary message text are navigation, not dead typography. This
// mirrors the canonical server username shape (ASCII letter + 3..31 ASCII letters/digits/underscores)
// and deliberately refuses email addresses, doubled @ signs and truncated overlong handles.
const USERNAME_MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_])/g;

function messageTextNodes(text: string): Array<Node | string> {
  const nodes: Array<Node | string> = [];
  let cursor = 0;
  for (const match of text.matchAll(USERNAME_MENTION_RE)) {
    const prefix = match[1] ?? "";
    const username = match[2];
    const matchAt = match.index;
    if (!username || matchAt === undefined) continue;
    const at = matchAt + prefix.length;
    if (at > cursor) nodes.push(text.slice(cursor, at));
    const link = el("a", {
      class: "gc-message-mention",
      href: `#/user/${encodeURIComponent(username)}`,
      "data-username": username,
    }, [`@${username}`]) as HTMLAnchorElement;
    // The bubble row owns long-press/context-menu gestures. A username link must own its own press:
    // stop bubbling without preventDefault so the browser still performs the internal hash navigation.
    const stop = (event: Event): void => event.stopPropagation();
    link.addEventListener("pointerdown", stop);
    link.addEventListener("contextmenu", stop);
    link.addEventListener("click", stop);
    nodes.push(link);
    cursor = at + username.length + 1;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length > 0 ? nodes : [text];
}

function senderKey(msg: Message): string {
  const s = msg.sender;
  if (s && typeof s === "object" && "id" in s && typeof (s as { id?: unknown }).id === "number") {
    return `u${(s as { id: number }).id}`;
  }
  return "anon";
}

// Do bubble `b` and the run ending at `a` belong together?
function sameRun(a: { head: Message; album?: Message[] }, b: { head: Message }): boolean {
  const last = a.album && a.album.length > 0 ? a.album[a.album.length - 1]! : a.head;
  if (senderKey(last) !== senderKey(b.head)) return false;
  if (!!last.deleted !== !!b.head.deleted) return false;
  const t1 = last.created_at;
  const t2 = b.head.created_at;
  if (typeof t1 !== "number" || typeof t2 !== "number") return true;
  return Math.abs(t2 - t1) <= GROUP_WINDOW_SEC;
}

export function createFeedScreen(deps: FeedDeps): { root: HTMLElement; focus(messageId: number): void; destroy(): void } {
  const { api, i18n, chatId, self, outbox, events } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  let messages: Message[] = [];
  // Aggregate peer watermarks. They are restored from the durable endpoint and advanced by live
  // chat.delivered/chat.read events; never inferred from presence or local rendering.
  let deliveredUpToMessageId = 0;
  let readUpToMessageId = 0;
  let receiptRevision = 0;
  const pending = new Map<string, Pending>();
  let members: ChatMember[] = [];
  let atHead = true; // the newest loaded message is the chat's newest (live tail)
  let reachedTop = false;
  let loadingOlder = false;
  let loadingNewer = false;
  let disposed = false;
  // V89 — "no messages" and "no answer" are different facts, so the screen tracks which one is true.
  // `loading` holds until the first history read settles; a read that fails with nothing cached is
  // `failed` (and keeps the thrown value, because a 500 and a dead socket earn different wording).
  let readPhase: "loading" | "ready" | "failed" = "loading";
  let readError: unknown = null;

  // recovery bookkeeping for optimistic edit/delete
  const editPrev = new Map<string, string>(); // outboxId -> previous text
  const deleteBackup = new Map<string, Message>(); // outboxId -> removed message

  // ---- client message id (used by sends, forwards and the attach tray) ----
  const genCmid = (): string => {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    return c && typeof c.randomUUID === "function" ? c.randomUUID() : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  // ---- media wiring (T-407): active only when the shell injected a MediaPort/MediaEnv ----
  const baseMedia = deps.media ?? null;
  const mediaPort: MediaPort | null = baseMedia
    ? {
        upload: (data, opts) => baseMedia.upload(data, opts),
        objectUrl: async (fileId, mime) => {
          const persist = deps.cachePolicy?.shouldPersist(chatId) ?? true;
          if (persist && deps.cachePolicy) await deps.cachePolicy.recordMedia(chatId, fileId);
          return baseMedia.objectUrl(fileId, mime, persist);
        },
        revoke: (url) => baseMedia.revoke(url),
        setCacheLimit: (bytes) => baseMedia.setCacheLimit(bytes),
      }
    : null;
  const mediaEnv = deps.mediaEnv ?? null;
  const attachmentDeps: AttachmentDeps | null =
    mediaPort && mediaEnv
      ? { i18n, media: mediaPort, env: mediaEnv, onOpenViewer: (fileId) => openViewer(messages, fileId, { i18n, media: mediaPort, env: mediaEnv }) }
      : null;
  let refreshComposerAction = (): void => {};
  const tray: AttachTray | null = mediaPort
    ? createAttachTray({ i18n, media: mediaPort, genCmid, onChange: () => refreshComposerAction() })
    : null;
  const albumIdOf = (m: Message): string | null => (typeof m.album_id === "string" && m.album_id.length > 0 ? m.album_id : null);

  // ---- chrome ----
  // In a 1:1 dialog the peer's name above every incoming bubble is pure noise (there are only two
  // participants) — authors and avatars are painted for groups/channels only. Until the chat kind is
  // known the group layout is used, then loadTitle() narrows it.
  let showAuthors = true;
  const backBtn = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.back") }, [icon("back")]);
  const headerAvatar = el("span", { class: "gc-feed-avatar gc-avatar", "aria-hidden": "true" });
  let headerAvatarBinding: AvatarImageBinding | null = null;
  const titleEl = el("span", { class: "gc-feed-title" }, [i18n.t("common.loading")]);
  const subtitleEl = el("span", { class: "gc-feed-subtitle" });
  // V52: the avatar+name block is a BUTTON, not a decorative div. It used to have no handler at all
  // (390x844 route probe, 2026-07-30), which made the single most-tapped affordance of any messenger
  // header — "who am I talking to" — unreachable: a peer's @handle and bio, a group's description and
  // its participant roster had no entry point anywhere in the client.
  const identityEl = el("button", {
    type: "button",
    class: "gc-feed-identity",
    title: i18n.t("chatInfo.open"),
    "aria-label": i18n.t("chatInfo.open"),
  }, [
    el("span", { class: "gc-feed-avatar-wrap" }, [headerAvatar]),
    el("span", { class: "gc-feed-names" }, [titleEl, subtitleEl]),
  ]);

  // V7 — presence. The subtitle of a 1:1 dialog used to be the constant word "личный чат", which tells
  // the reader nothing they cannot see. The server already broadcasts `presence.update` and serves
  // `last_seen` on the public profile, so the header now carries the same line every messenger does:
  // "в сети" (plus a dot on the avatar) or "был(а) в 12:30". Groups/channels keep their kind label.
  let peerId: number | null = null;
  let isPresenceChat = false;
  let peerIsBot = false;
  let presence: PresenceState = { online: false, lastSeen: null };
  let kindSubtitle = "";
  let chatKind = "";
  // A group header used to read the bare word "группа", which the reader already knows from the avatar
  // and the author names. Every messenger puts the live participant count there instead. The roster is
  // already fetched for @mention autocomplete, so this costs no extra request; the kind word stays as
  // the fallback until that fetch lands (or if it fails).
  const countSubtitle = (): string | null => {
    if (members.length === 0) return null;
    if (chatKind === "group") return i18n.t("chat.memberCount", { count: members.length });
    if (chatKind === "channel") return i18n.t("chat.subscriberCount", { count: members.length });
    return null;
  };
  const renderSubtitle = (): void => {
    const live = peerIsBot || peerId === null ? null : presenceLabel(presence, Math.floor(Date.now() / 1000), i18n);
    subtitleEl.textContent = peerIsBot ? i18n.t("chat.botSubtitle") : live ?? countSubtitle() ?? kindSubtitle;
    const online = !peerIsBot && peerId !== null && presence.online;
    subtitleEl.classList.toggle("is-online", online);
    identityEl.classList.toggle("has-presence", online);
    // The same moment that decides "this header describes one other person" decides whether a call is
    // possible, so the two never disagree (V75).
    syncCallButtons();
  };
  const searchBtn = el("button", { type: "button", class: "gc-icon-btn", title: i18n.t("common.search") }, [icon("search")]);

  // The per-chat media cache policy used to be a native `<select>` parked in the conversation header —
  // measured at 168 px on a 1280 px desktop, an OS dropdown standing beside the search icon as if it
  // were primary chrome, and on a phone it collapsed to width 0 (unreachable). It is a rarely-touched
  // preference, so it belongs in the header's overflow menu as three radio items, exactly where the
  // chat list already keeps its system actions.
  const setCacheMode = async (next: ChatCacheMode): Promise<void> => {
    if (!deps.cachePolicy) return;
    try {
      await deps.cachePolicy.setChat(chatId, next);
    } catch (err) {
      showStatus(describeError(err, i18n));
    }
  };
  const cacheMenuItems = (): MessageMenuItem[] => {
    if (!deps.cachePolicy) return [];
    const active = normalizeChatCacheMode(deps.cachePolicy.getChat(chatId));
    return CHAT_CACHE_OPTIONS.map((mode) => ({
      id: `cache-${mode}`,
      label: i18n.t(`cache.chat.${mode}`),
      glyph: "layers" as const,
      heading: i18n.t("cache.chat.title"),
      checked: mode === active,
      run: () => void setCacheMode(mode),
    }));
  };
  // T-512 §3.1: «Помощь и поддержка» from inside a chat — present only when the shell wired the
  // capability. It is a destination, not a per-message action, so it rides in the same overflow menu
  // rather than as a second icon competing with search.
  const overflowItems = (): MessageMenuItem[] => {
    const items: MessageMenuItem[] = [];
    // V113: the video call folded out of the bar leads the menu — it is the only entry here that is
    // an action ON the person named above, and it is offered only while a call is actually possible,
    // exactly as its icon was (V75). A group or Saved Messages sees no dead item.
    if (videoCallFolded() && callable()) {
      items.push({
        id: "chat-video-call",
        label: i18n.t("call.startVideo"),
        glyph: "video",
        run: () => startCall(true),
      });
    }
    // V105: on a phone the search icon is not in the bar — it is here, because it is the only
    // one of these entries a reader reaches for mid-conversation.
    if (searchFolded()) {
      items.push({
        id: "chat-search",
        label: i18n.t("feed.searchAction"),
        glyph: "search",
        run: () => searchPanel.toggle(),
      });
    }
    if (deps.onOpenSupport) {
      items.push({
        id: "chat-support",
        label: i18n.t("support.help"),
        glyph: "help",
        run: () => deps.onOpenSupport?.(),
      });
    }
    items.push(...cacheMenuItems());
    return items;
  };
  const hasOverflow = Boolean(deps.onOpenSupport || deps.cachePolicy);
  const overflowBtn = hasOverflow
    ? el("button", {
        type: "button",
        class: "gc-icon-btn gc-feed-overflow",
        title: i18n.t("chat.rowActions"),
        "aria-label": i18n.t("chat.rowActions"),
        "aria-haspopup": "menu",
      }, [icon("more")])
    : null;
  // V105 — the fold itself. It happens only when there IS a menu to fold into: a shell that wires
  // neither support nor a cache policy has no overflow button, and hiding the icon there would
  // delete in-chat search instead of moving it.
  const headerViewport = phoneHeaderViewport();
  // V113b — the WINDOW is not the BAR. Measured on the signed APK (redroid 15, `wm density 443`
  // = 390 dp, landscape, route #/chat/17, DEFAULT system font, 2026-07-31):
  //
  //   innerWidth 819   (max-width: 480px) = false  ->  nothing folded, 4 x 44 = 188 px of actions
  //   .gc-superapp-list 318 wide + .gc-app-rail 82  ->  the conversation pane is only 388 px
  //   .gc-feed-title    106 wide / 109 needed       ->  «Артём Волков» painted «Артём Волко»
  //
  // A landscape phone runs the two-pane layout, so the chat lives beside the chat list and the bar
  // is less than half the window. Asking the window whether this is "a phone" therefore answered a
  // question nobody asked. The bar measures ITSELF and folds on its own width; the media query is
  // kept as the answer for a shell that has no layout to measure (the DOM test stub, SSR), which is
  // exactly when a rendered width of 0 must not be read as "the narrowest bar there is".
  let headerBox: { getBoundingClientRect?: () => { width: number } } | null = null;
  const barIsNarrow = (): boolean => {
    const width = headerBox?.getBoundingClientRect?.().width ?? 0;
    if (Number.isFinite(width) && width > 0) return width <= PHONE_HEADER_PX;
    return headerViewport?.matches === true;
  };
  const searchFolded = (): boolean => hasOverflow && barIsNarrow();
  // V113 — one fold was not enough. V105 was measured with FOUR actions in the bar; by the time the
  // signed APK was measured on a 320 dp phone the call pair had joined them, so the row was
  // 3 x 44 = 132 px and the identity got 72 px of a 320 px bar. Probed through the device WebView
  // (redroid 15, `wm density 540`, route #/chat/17, peer «Артём Волков», 2026-07-31):
  //
  //   font_scale  actions   title box / needed   painted
  //   1.0         3 x 44     72 / 111            «Артём В»
  //   1.0         2 x 44    111 / 111            «Артём Волков»      <- video folded
  //   1.3         3 x 44     72 / 145            «Артём »
  //   1.3         2 x 44    116 / 145            «Артём Вол»         <- fold alone is not enough
  //   2.0         3 x 44     72 / 223            «Арт»
  //
  // Video is the one to fold: the audio call is the action a 1:1 dialog exists for, it is the one
  // Android's own dialer surfaces first, and — unlike search — the folded item is not a mode of this
  // screen but the same `startCall`, so nothing about it changes inside the menu. The remaining
  // shortfall at an enlarged system font is not a width problem and is not solved by folding a third
  // icon (the bar would stop offering a call at all); it is answered in CSS by letting the name wrap
  // (styles.css V113), which is what the same stylesheet already does for screen titles at V109.
  const videoCallFolded = (): boolean => searchFolded();
  const syncSearchAffordance = (): void => { searchBtn.hidden = searchFolded(); };
  // Rotation and window resizing cross the breakpoint under a live screen (V93 fixed the tab bar
  // vanishing on rotation for the same reason), so the bar re-decides instead of freezing at the
  // width it was born on. The listener is dropped in destroy().
  // V113b: the observer below fires on every size change of the bar, including the one the fold
  // itself causes, so the work is done only when the ANSWER changed. Without this the pair
  // "hide an icon -> the row resizes -> re-decide" would run on every frame of a rotation.
  let foldedNow: boolean | null = null;
  const onViewportChange = (): void => {
    const narrow = searchFolded();
    if (narrow === foldedNow) return;
    foldedNow = narrow;
    syncSearchAffordance();
    syncCallButtons();
  };
  headerViewport?.addEventListener?.("change", onViewportChange);
  syncSearchAffordance();

  if (overflowBtn) {
    overflowBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      // One menu on screen at a time — and "menu" is the same key the per-message menu uses, so the
      // header menu and a bubble's menu can never be open together either.
      modals.close("menu");
      modals.open("menu", (release) => ({
        close: openMessageMenu({
          i18n,
          host: modalRoot(root),
          anchor: overflowBtn,
          label: i18n.t("chat.rowActions"),
          items: overflowItems(),
          onClose: release,
        }).close,
      }));
    });
  }
  // V75 — the call buttons. Hidden until the chat is KNOWN to be a two-person dialog with a real peer:
  // a group, a channel and Saved Messages have nobody to ring, and showing a dead handset there is the
  // exact "button that does nothing" this release is removing. `peerId`/`isPresenceChat` are resolved
  // by loadTitle()/loadMembers(), so the reveal happens in renderSubtitle() once both are known.
  const callBtn = deps.onStartCall
    ? el("button", {
        type: "button",
        class: "gc-icon-btn gc-feed-call",
        title: i18n.t("call.startAudio"),
        "aria-label": i18n.t("call.startAudio"),
        hidden: true,
      }, [icon("phone")])
    : null;
  const videoCallBtn = deps.onStartCall
    ? el("button", {
        type: "button",
        class: "gc-icon-btn gc-feed-call",
        title: i18n.t("call.startVideo"),
        "aria-label": i18n.t("call.startVideo"),
        hidden: true,
      }, [icon("video")])
    : null;
  const startCall = (video: boolean): void => {
    if (!deps.onStartCall || peerId === null || peerIsBot) return;
    const peer = members.find((m) => m.id === peerId);
    if (peer?.is_bot) return;
    deps.onStartCall(
      { id: peerId, name: peer?.name ?? titleEl.textContent ?? "", username: peer?.username ?? null },
      video,
    );
  };
  callBtn?.addEventListener("click", () => startCall(false));
  videoCallBtn?.addEventListener("click", () => startCall(true));
  /** Is there somebody on the other side to ring? (V75: a group/channel/Saved Messages has not.) */
  const callable = (): boolean => isPresenceChat && peerId !== null && !peerIsBot;
  const syncCallButtons = (): void => {
    const on = callable();
    for (const btn of [callBtn, videoCallBtn]) {
      if (!btn) continue;
      // V113: on a phone the video icon is not in the bar — it is the first item of the header menu.
      // It is hidden for the same reason the search icon is, never because the call is impossible.
      if (on && !(btn === videoCallBtn && videoCallFolded())) btn.removeAttribute("hidden");
      else btn.setAttribute("hidden", "");
    }
  };

  const header = el("header", { class: "gc-feed-header" }, [
    backBtn, identityEl, el("div", { class: "gc-feed-header-actions" }, [
      ...(callBtn ? [callBtn] : []),
      ...(videoCallBtn ? [videoCallBtn] : []),
      searchBtn,
      ...(overflowBtn ? [overflowBtn] : []),
    ]),
  ]);
  // V113b: from here the fold reads the bar's own width. Before the header exists — and in a shell
  // with no layout at all — `barIsNarrow()` falls back to the media query, so nothing changes for
  // the DOM stub or for a first paint that happens before insertion.
  headerBox = header as unknown as { getBoundingClientRect?: () => { width: number } };

  const pinnedBar = el("button", { type: "button", class: "gc-feed-pinned", hidden: true });
  const listBox = el("div", { class: "gc-feed-list", role: "log", "aria-live": "polite", "aria-label": i18n.t("common.appName") });
  // V89 — the conversation's own read states. Measured on a FRESH device (no local history) at
  // 390x844 (probe var/ux-audit/tools/m_thread_v89b.mjs, 2026-07-30):
  //   • history in flight  → a blank 727px page, 0 skeletons: the app looked broken while it worked;
  //   • history 200 []     → a 306x44 white pill floating at centerY=406, radius 999px — the shape
  //                          of a toast, used as the empty state of the app's most-used screen;
  //   • history aborted    → the SAME pill, «Пока нет сообщений. Поздоровайтесь!», i.e. the client
  //                          told the user their conversation was empty when it had simply not got
  //                          an answer, plus a red line claiming the (read-only) action was queued;
  //   • history 500        → same lie, generic toast, and no way to retry.
  // The chat list learned this vocabulary in V76; the thread never did. `.gc-feed-stage` owns the
  // space the messages would have taken and shows exactly one of: silhouette, empty, offline, error.
  const stageEl = el("div", { class: "gc-feed-stage", hidden: true });
  const statusEl = el("p", { class: "gc-feed-status", role: "status", "aria-live": "polite" });
  const undoBar = el("div", { class: "gc-feed-undo", hidden: true });

  // V166b — the way back. Nothing in a conversation told a reader who had scrolled into history that
  // new messages had arrived, and nothing brought them back: all 23 controls of the chat screen were
  // enumerated on the deployed build and not one scrolls to the newest message; the only
  // `scrollToBottom()` in the source is internal. That was survivable only while the app quietly
  // marked everything read behind the reader's back — once the unread state is honest (V166), the
  // route back has to exist, or the fix would trade a wrong receipt for a badge with no door.
  const jumpCount = el("span", { class: "gc-feed-jump-count", hidden: true });
  const jumpBtn = el("button", { type: "button", class: "gc-feed-jump", hidden: true }, [
    el("span", { class: "gc-feed-jump-icon", "aria-hidden": "true" }, [icon("chevron")]),
    jumpCount,
  ]) as HTMLElement & { hidden: boolean; title: string };

  let root!: HTMLElement;
  // Every sheet, menu and recorder this screen puts on the document body is owned here: one per key at a
  // time, and all of them gone when the screen goes. `root` is filled in below, hence the getter.
  const modals = createModalLayer(() => root);
  let composer!: ReturnType<typeof createComposer>;
  const stickerPicker = mediaPort
    ? createStickerPicker({
        i18n,
        api,
        media: mediaPort,
        onPick: async (sticker) => {
          await submitSticker(sticker.id, composer.replyTarget());
          composer.reset();
        },
      })
    : null;
  composer = createComposer({
    i18n,
    members: () => members,
    onSubmit: (p) => onComposerSubmit(p),
    onDraft: (text) => void saveDraft(text),
    ...(tray ? { onAttach: (files: FileList) => tray.add(files), hasStaged: () => tray.count() > 0 } : {}),
    ...(mediaPort ? {
      onVoiceNote: () => openVoiceNote(true),
      onVideoNote: () => openVideoNote(true),
    } : {}),
    ...(stickerPicker ? { stickers: stickerPicker } : {}),
  });

  refreshComposerAction = () => composer.refreshAction();
  composer.refreshAction();

  // Web Share Target: text shared into the PWA seeds the first chat opened afterwards. Consuming it here
  // marks the composer "active", so the async draft load below leaves the shared text in place.
  const shared = takePendingShare();
  if (shared) composer.setText(shared);

  const searchPanel = buildSearchPanel();

  root = el("div", { class: "gc-feed" }, [
    header, pinnedBar, searchPanel.root,
    // V193: transient feedback belongs to the conversation canvas, not to the document flow. Keeping
    // it inside the positioned main stage lets CSS render a compact overlay without pushing the
    // composer and message history apart when the keyboard is open.
    el("div", { class: "gc-feed-main" }, [listBox, stageEl, jumpBtn, statusEl]),
    undoBar, ...(tray ? [tray.root] : []), composer.root,
  ]);

  // ── V118 — on a 320 dp phone the thread's own chrome ate the thread ───────────────────────────
  // Measured with the real IME up on the signed artifact (device gc-android-p0, `wm density 540`
  // = 320 dp, ru-RU, route #/chat/17, CDP against the device WebView, APK sha256 c53407eb…,
  // 2026-08-01). The probe (var/ux-audit/tools/m_shortcol_v118.mjs) only reads — a probe that
  // scrolls answers its own question:
  //
  //   case                     window     header   pinned   composer   .gc-feed-main   newest bubble
  //   320 dp landscape fs1.0   664 x 112     — ¹     48       60.9         3.1 px       11 px under it
  //   320 dp portrait  fs2.0   320 x 393   210.3     48      134.9         0.0 px       14 px under it
  //   ¹ already hidden by shortscreen.css V114
  //
  // Neither is the V98/V115/V116 pin: both probes report scrollHeight - scrollTop - clientHeight
  // = 0, i.e. the scroller IS at its end and the box itself reaches under the composer. This is
  // static layout — 48 + 60.9 = 108.9 of a 112 px window, and 210.3 + 48 + 134.9 = 393.2 of a
  // 393 px one. `.gc-feed-list` cannot absorb it either: a border box is never shorter than its
  // own padding, so 14 px + 20 px give the messages box a 34 px floor whatever `min-height: 0`
  // says. At 320 dp portrait `.gc-feed-main` is exactly 0 px tall and — outside the 300 px media
  // query — `overflow: visible`, so those 34 px are simply painted over the composer. A user
  // typing a reply at system font size 2.0 sees no conversation at all.
  //
  // Why this lives in TypeScript and not in a media query: the threshold has to know the Android
  // system font size, and a media query cannot see it. Measured (m_mqem_v118.mjs, same device, font
  // size 2.0x): `(min-height: N em)` resolves em to 15.99 px while the root font is 32 px — MQ `em`
  // tracks the browser default, not the user's text size. The window does not move either: 320 dp
  // portrait with the IME up is 393 px at 1.0x, 1.3x AND 2.0x. Only the RATIO of the two separates
  // the failing cases from the passing ones (KB verdicts of the 18-cell matrix, IME up):
  //
  //   dp / orientation   window   /16 px   /20.8 px   /32 px    verdict before this change
  //   320 landscape        112      7.0      5.4       3.5      FAIL at all three font sizes
  //   320 portrait         393     24.6     18.9      12.3      FAIL at 2.0x only
  //   390 landscape        154      9.6      7.4       4.8      ok
  //   390 portrait         513     32.1     24.7      16.0      ok
  //   430 landscape        176     11.0      8.5       5.5      ok
  //   430 portrait         577     36.1     27.7      18.0      ok
  //
  // Hence 14 root-font units: every measured failure is at 12.3 or below, the nearest passing case
  // is 16.0, and 14 is also what the chrome costs — header 6.6 + pinned bar 1.5 + composer 4.2 =
  // 12.3 units at 2.0x (4.6 + 3.0 + 3.8 = 11.4 at 1.0x) plus about one message row. Below it the
  // window cannot hold the chrome AND a message, so the conversation wins: shortscreen.css V118
  // drops the pinned bar and the header and trims the list padding. Nothing is stranded — Android's
  // back key closes the IME first (verified on the device: mInputShown true -> false), the window
  // grows back and the header returns with it, exactly as V114 argued for its own threshold.
  // No feedback loop is possible: neither the window height nor the root font size depends on the
  // class this sets.
  const CRAMPED_UNITS = 14;
  const windowIsCramped = (): boolean => {
    const view = globalThis as { innerHeight?: number; visualViewport?: { height?: number } };
    const heights = [view.innerHeight, view.visualViewport?.height]
      .filter((h): h is number => typeof h === "number" && Number.isFinite(h) && h > 0);
    if (heights.length === 0) return false; // a shell with no layout at all keeps the full chrome
    const rootPx = typeof getComputedStyle === "function"
      ? parseFloat(getComputedStyle(document.documentElement).fontSize)
      : NaN;
    const unit = Number.isFinite(rootPx) && rootPx > 0 ? rootPx : 16;
    return Math.min(...heights) < CRAMPED_UNITS * unit;
  };
  let crampedNow: boolean | null = null;
  const syncCramped = (): void => {
    const cramped = windowIsCramped();
    if (cramped === crampedNow) return; // V113b's lesson: touch the DOM only when the ANSWER changed
    crampedNow = cramped;
    root.classList.toggle("is-cramped", cramped);
  };
  // The IME resizes the window on Android (measured 801 -> 393), but on a shell where it only
  // overlays, `visualViewport` is the one that moves — both are watched and the smaller wins.
  const shortWindowView = globalThis as {
    addEventListener?: (t: string, h: () => void) => void;
    removeEventListener?: (t: string, h: () => void) => void;
    visualViewport?: {
      addEventListener?: (t: string, h: () => void) => void;
      removeEventListener?: (t: string, h: () => void) => void;
    };
  };
  const onWindowResize = (): void => { if (!disposed) syncCramped(); };
  shortWindowView.addEventListener?.("resize", onWindowResize);
  shortWindowView.visualViewport?.addEventListener?.("resize", onWindowResize);
  syncCramped(); // decided before insertion, so the first paint is already correct

  backBtn.addEventListener("click", () => deps.onBack());
  searchBtn.addEventListener("click", () => searchPanel.toggle());

  // Tapping the header opens the chat-info sheet. The header already knows the title, the subtitle,
  // the kind and the roster, so the sheet paints instantly and the two network reads only ENRICH it
  // (description, @handle, bio) — nothing is blocked on them.
  // Measured 2026-08-03 before this screen had an owner: three taps on the title built three stacked
  // info sheets, and all three survived leaving the chat — a card about a conversation the person had
  // already walked away from, painted over the one they went to.
  identityEl.addEventListener("click", () => {
    modals.open("chat-info", (release) => {
      const sheet = createChatInfoOverlay({
        i18n,
        title: titleEl.textContent ?? "",
        subtitle: subtitleEl.textContent ?? "",
        kind: chatKind,
        peerId,
        members,
        loadChat: () => api.get(`/v1/chats/${chatId}`),
        loadUser: (userId: number) => api.get(`/v1/users/${userId}`),
        photoApi: api,
        ...(mediaPort ? { media: mediaPort } : {}),
        updatePhoto: (fileId: number) => api.patch(`/v1/chats/${chatId}`, { photo_file_id: fileId }),
        loadJoinRequests: () => api.get(`/v1/chats/${chatId}/join_requests`),
        approveJoinRequest: (userId: number) => api.post(`/v1/chats/${chatId}/join_requests/${userId}/approve`, {}),
        denyJoinRequest: (userId: number) => api.post(`/v1/chats/${chatId}/join_requests/${userId}/deny`, {}),
        onPhotoChanged: (fileId: number) => { void headerAvatarBinding?.set(fileId); },
        onClose: release,
      });
      return { node: sheet.root, focus: () => sheet.focus(), close: () => sheet.close() };
    });
  });

  // ---- transient feedback ---------------------------------------------------------------
  // V193: `.gc-feed-status` used to be an unconditional red, full-width row, so a successful copy
  // looked like a failure and reflowed the composer. Tones keep success/error semantics explicit;
  // setStatus is also used by upload progress so an earlier green success can never leak into it.
  type FeedStatusTone = "error" | "success" | "info";
  const STATUS_EXIT_MS = 140;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelStatusTimer = (): void => {
    if (!statusTimer) return;
    clearTimeout(statusTimer);
    statusTimer = null;
  };
  const clearStatus = (): void => {
    cancelStatusTimer();
    statusEl.classList.remove("is-leaving");
    statusEl.textContent = "";
    statusEl.removeAttribute("data-tone");
  };
  const setStatus = (text: string, tone: FeedStatusTone): void => {
    cancelStatusTimer();
    statusEl.classList.remove("is-leaving");
    statusEl.setAttribute("data-tone", tone);
    statusEl.textContent = text;
  };
  const showStatus = (text: string, tone: FeedStatusTone = "error", timeoutMs = 4000): void => {
    setStatus(text, tone);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      statusEl.classList.add("is-leaving");
      statusTimer = setTimeout(() => clearStatus(), STATUS_EXIT_MS);
    }, timeoutMs);
  };

  function openVoiceNote(autoStart = false): void {
    if (!mediaPort || disposed) return;
    const replyToId = composer.replyTarget();
    const text = voiceNoteStrings(i18n.locale);
    // Voice capture is a cold-path feature. Keep MediaRecorder/Web Audio out of the initial chat
    // bundle and load it only after the user deliberately holds the action button.
    void import("./voice_note_recorder.ts").then(({ createVoiceNoteRecorder }) => {
      if (disposed) return;
      modals.open("voice-note", (release) => {
        const recorder = createVoiceNoteRecorder({
          i18n,
          autoStart,
          onClose: release,
          onSend: async (note, signal) => {
            setStatus(text.uploading, "info");
            try {
              const uploaded = await mediaPort.upload(note.data, {
                name: note.name,
                mime: note.mime,
                signal,
                meta: { duration: note.duration, waveform: note.waveform },
                onProgress: (loaded, total) => {
                  if (total <= 0) return;
                  const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
                  setStatus(voiceNoteFormat(text.uploadingProgress, { percent }), "info");
                },
              });
              if (signal.aborted) throw new DOMException("Voice note upload cancelled", "AbortError");
              await outbox.enqueueMessage(chatId, {
                client_msg_id: genCmid(),
                file_id: uploaded.file_id,
                kind: "voice",
                ...(replyToId !== null ? { reply_to_id: replyToId } : {}),
              });
              composer.reset();
              showStatus(text.sent, "success", 1800);
              scrollToBottom();
            } catch (err) {
              clearStatus();
              throw err;
            }
          },
        });
        return {
          node: recorder.root,
          focus: () => recorder.focus(),
          mounted: () => { void recorder.start(); },
          close: () => recorder.destroy(),
        };
      });
    }).catch(() => showStatus(text.failed));
  }

  function openVideoNote(autoStart = false): void {
    if (!mediaPort || disposed) return;
    const replyToId = composer.replyTarget();
    void import("./video_note_recorder.ts").then(({ createVideoNoteRecorder }) => {
      if (disposed) return;
      modals.open("video-note", (release) => {
        const recorder = createVideoNoteRecorder({
          i18n,
          autoStart,
          onClose: release,
          onSend: async (note, signal) => {
            setStatus(i18n.t("media.videoNoteUploading"), "info");
            try {
              const uploaded = await mediaPort.upload(note.data, {
                name: note.name,
                mime: note.mime,
                signal,
                meta: {
                  width: note.width,
                  height: note.height,
                  duration: note.duration,
                  round: true,
                },
                onProgress: (loaded, total) => {
                  if (total <= 0) return;
                  const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
                  setStatus(i18n.t("media.videoNoteUploadingProgress", { percent }), "info");
                },
              });
              if (signal.aborted) throw new DOMException("Video note upload cancelled", "AbortError");
              await outbox.enqueueMessage(chatId, {
                client_msg_id: genCmid(),
                file_id: uploaded.file_id,
                kind: "video",
                ...(replyToId !== null ? { reply_to_id: replyToId } : {}),
              });
              composer.reset();
              showStatus(i18n.t("media.videoNoteSent"), "success", 1800);
              scrollToBottom();
            } catch (err) {
              clearStatus();
              throw err;
            }
          },
        });
        // The recorder holds camera and microphone tracks, so leaving the screen must reach destroy().
        return {
          node: recorder.root,
          focus: () => recorder.focus(),
          mounted: () => { void recorder.start(); },
          close: () => recorder.destroy(),
        };
      });
    }).catch(() => showStatus(i18n.t("media.videoNoteFailed")));
  }
  // ---- read states (V89) ----
  // A silhouette of the thread, not of a list: alternating incoming/outgoing blocks at bubble widths,
  // so the page has the shape of the content that is coming instead of being blank for a second.
  const skeletonThread = (): HTMLElement => {
    const widths = [62, 44, 78, 38, 56];
    const rows = widths.map((w, i) => {
      const bar = el("span", { class: "gc-skeleton-bubble" });
      bar.style.width = `${w}%`;
      return el("div", { class: `gc-skeleton-msg${i % 2 === 1 ? " is-out" : ""}` }, [bar]);
    });
    return el("div", { class: "gc-skeleton-thread", "aria-hidden": true }, rows);
  };

  // Exactly one of: silhouette (still reading), empty (the server answered, and answered "none"),
  // offline/error (no answer — never call that empty). The stage owns the list's space; the list is
  // hidden while it shows, so nothing floats over a blank page.
  const renderStage = (): void => {
    const show = messages.length === 0 && pending.size === 0;
    stageEl.hidden = !show;
    listBox.hidden = show;
    if (!show) { clear(stageEl); return; }
    clear(stageEl);
    if (readPhase === "loading") {
      // A thread rests ON the composer (the list does the same with an auto margin), so the
      // silhouette is bottom-aligned; a centred block would slide upward when the messages land.
      // setAttribute, not .dataset: the unit-test DOM stub models attributes but not the dataset
      // proxy, and reading it there threw before this screen could even mount (feed_header_v6).
      stageEl.setAttribute("data-mode", "loading");
      stageEl.append(skeletonThread());
      return;
    }
    stageEl.setAttribute("data-mode", "state");
    if (readPhase === "failed") {
      const offline = isNetworkError(readError);
      stageEl.append(stateView({
        tone: offline ? "offline" : "error",
        icon: offline ? "offline" : "warning",
        title: i18n.t(offline ? "state.threadOfflineTitle" : "state.errorTitle"),
        body: offline ? i18n.t("state.offlineBody") : describeError(readError, i18n),
        actionLabel: i18n.t("common.retry"),
        onAction: () => { readPhase = "loading"; renderStage(); void loadNewest(); },
      }));
      return;
    }
    stageEl.append(stateView({
      tone: "empty",
      icon: "chats",
      title: i18n.t("state.threadEmptyTitle"),
      body: i18n.t("state.threadEmptyBody"),
    }));
  };

  // ---- rendering ----
  // Whether the reader is parked on the newest message. Every scroll re-answers the question, so the
  // flag is the reader's own intent, not a guess made at render time.
  let pinnedToBottom = true;
  // V115 — the slack has to grow with the text, because a fixed 48 px stops meaning "the bottom"
  // once the system font scale is large. Measured on the signed APK (redroid, 320 dp, system font
  // size 2.0x, route #/chat/17, keyboard down): the feed settled at scrollTop 748 of a possible 805,
  // i.e. 57 px short of the true bottom, with no scrolling by the user at all. 57 > 48, so the reader
  // was classified as "browsing history", the keyboard re-pin was suppressed, and raising the IME
  // buried the newest message 285 px below the composer. The cause was then isolated on the device:
  // forcing a genuine bottom (gap 0) and raising the same keyboard left the newest bubble at 238 px
  // against a composer top of 258 px — fully visible. Nothing but this classification differed.
  // One line of large text is ~3 * the root font size, so the slack is expressed in that unit and
  // floored at the old constant, which keeps small-text behaviour byte-for-byte identical.
  const bottomSlack = (): number => {
    const root = typeof getComputedStyle === "function"
      ? parseFloat(getComputedStyle(document.documentElement).fontSize)
      : NaN;
    return Number.isFinite(root) && root > 0 ? Math.max(AT_BOTTOM, root * 3) : AT_BOTTOM;
  };
  const isAtBottom = (): boolean => listBox.scrollHeight - listBox.scrollTop - listBox.clientHeight < bottomSlack();
  // The same late large-text layout is why the newest bubble was clipped even BEFORE the keyboard
  // appeared: at rest the list box ended at 505 px while the last bubble ended at 543 px, so 38 px of
  // the message the reader had just opened the chat to read sat behind the composer. The height that
  // caused it is only known one frame later, so the pin is re-applied then — feature-detected so the
  // DOM test stub keeps working, and still gated on the flag so a reader who scrolled away in the
  // meantime is never yanked to the end.
  const reassertPin = (): void => {
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      if (disposed || !pinnedToBottom) return;
      if (listBox.scrollHeight - listBox.scrollTop - listBox.clientHeight > 0) listBox.scrollTop = listBox.scrollHeight;
    });
  };
  const scrollToBottom = (): void => { listBox.scrollTop = listBox.scrollHeight; pinnedToBottom = true; reassertPin(); };

  // V166b — the button mirrors the same flag the read pointer now obeys, so the affordance and the
  // receipt can never disagree about where the reader is. `awayNew` counts only what arrived while
  // they were in history, so the badge answers "what did I miss", not "how long is this chat".
  let awayNew = 0;
  const syncJump = (): void => {
    const show = !pinnedToBottom;
    if (!show) awayNew = 0;
    jumpBtn.hidden = !show;
    const label = awayNew > 0 ? i18n.t("feed.jumpNew", { count: String(awayNew) }) : i18n.t("feed.jumpNewest");
    jumpBtn.title = label;
    jumpBtn.setAttribute("aria-label", label);
    jumpCount.hidden = awayNew === 0;
    jumpCount.textContent = awayNew > 99 ? "99+" : String(awayNew);
  };
  jumpBtn.addEventListener("click", () => {
    scrollToBottom();
    // Pressing it IS the reader arriving at the newest message, so the pointer held back while they
    // read history is released here too — the scroll handler alone would not fire on every platform.
    flushDeferredRead();
    syncJump();
  });

  const reactionStrip = (msg: Message): HTMLElement | null => {
    const rs = msg.reactions ?? [];
    if (rs.length === 0) return null;
    const strip = el("div", { class: "gc-bubble-reactions" });
    for (const r of rs) {
      const chip = el("button", {
        type: "button",
        class: r.me ? "gc-reaction is-mine" : "gc-reaction",
        title: r.emoji,
      }, [`${r.emoji} ${r.count}`]);
      chip.addEventListener("click", () => void react(msg.id, r.emoji));
      strip.append(chip);
    }
    return strip;
  };

  // ---- per-message actions (V5) --------------------------------------------------------------
  // One surface for every action instead of the old hover-only toolbar (unreachable on touch, since
  // :hover never fires there) plus the permanent "report this message" link that used to sit inside
  // every incoming bubble. Opened by long-press, right-click, or the "⋯" button on the row.
  const copyText = (text: string): void => {
    const nav = (globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => Promise<void> } } }).navigator;
    const write = nav?.clipboard?.writeText;
    if (!write) { showStatus(i18n.t("feed.copyUnavailable")); return; }
    void write.call(nav.clipboard, text).then(
      () => showStatus(i18n.t("feed.copied"), "success", 1800),
      () => showStatus(i18n.t("feed.copyUnavailable")),
    );
  };

  const menuItemsFor = (msg: Message): MessageMenuItem[] => {
    const v = bubbleView(msg, self.id, i18n);
    const items: MessageMenuItem[] = [];
    items.push({
      id: "reply",
      label: i18n.t("feed.reply"),
      glyph: "reply",
      run: () => composer.startReply(msg.id, v.author || i18n.t("feed.anonymous")),
    });
    if (typeof msg.text === "string" && msg.text.length > 0) {
      items.push({ id: "copy", label: i18n.t("feed.copy"), glyph: "copy", run: () => copyText(msg.text as string) });
    }
    items.push({ id: "forward", label: i18n.t("feed.forward"), glyph: "forward", run: () => openForwardPicker(msg.id) });
    items.push({ id: "pin", label: i18n.t("feed.pin"), glyph: "pin", run: () => void pin(msg.id) });
    if (canEdit(msg, self.id, now(), EDIT_WINDOW_SEC)) {
      items.push({
        id: "edit",
        label: i18n.t("feed.edit"),
        glyph: "edit",
        run: () => composer.startEdit(msg.id, typeof msg.text === "string" ? msg.text : ""),
      });
    }
    if (!v.mine && !v.deleted && deps.onReport) {
      items.push({
        id: "report",
        label: i18n.t("report.messageAction"),
        glyph: "warning",
        danger: true,
        run: () => deps.onReport?.({
          kind: "message",
          targetId: msg.id,
          label: i18n.t("report.messageTarget", { id: msg.id }),
        }),
      });
      // The author byline is painted in groups/channels only, so in a 1:1 dialog the menu is the ONLY
      // route to "report this user" — it is offered here for every chat kind rather than depending on
      // a byline that may not exist (T-512 safety contract, CLIENTS §12).
      const s = msg.sender;
      if (s && typeof s === "object" && "username" in s && typeof s.username === "string"
        && Number.isSafeInteger(s.id) && s.id > 0) {
        const uid = s.id;
        const uname = s.username;
        items.push({
          id: "report-user",
          label: i18n.t("report.profileAction"),
          glyph: "warning",
          danger: true,
          run: () => deps.onReport?.({ kind: "user", targetId: uid, label: `@${uname}` }),
        });
      }
    }
    if (v.mine) {
      items.push({ id: "delete", label: i18n.t("feed.delete"), glyph: "trash", danger: true, run: () => void deleteMessage(msg) });
    }
    return items;
  };

  const showMessageMenu = (msg: Message, anchor: HTMLElement): void => {
    // A menu belongs to the bubble it was opened from, so a second bubble REPLACES the first — unlike a
    // sheet, which is handed back. Closing first is what makes that explicit.
    modals.close("menu");
    modals.open("menu", (release) => ({
      close: openMessageMenu({
        i18n,
        host: modalRoot(root),
        anchor,
        quickReactions: QUICK_REACTIONS,
        onReact: (emoji) => void react(msg.id, emoji),
        items: menuItemsFor(msg),
        onClose: release,
      }).close,
    }));
  };

  const renderInlineKeyboard = (msg: Message): HTMLElement | null => {
    const rows = msg.reply_markup?.inline_keyboard;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const keyboard = el("div", { class: "gc-inline-keyboard", role: "group" });

    let renderedRows = 0;
    const callback = async (button: HTMLButtonElement, data: string): Promise<void> => {
      if (button.disabled) return;
      button.disabled = true;
      button.dataset.state = "loading";
      try {
        await api.post(`/v1/messages/${msg.id}/callback`, { data });
        button.dataset.state = "sent";
      } catch (err) {
        button.dataset.state = "error";
        button.title = describeError(err, i18n);
      } finally {
        window.setTimeout(() => {
          button.disabled = false;
          delete button.dataset.state;
        }, 700);
      }
    };
    const renderButton = (button: MsgInlineButton): HTMLElement => {
      if ("mini_app" in button && button.mini_app) {
        const control = el("button", { type: "button", class: "gc-inline-button is-miniapp" }, [
          icon("layers"),
          el("span", {}, [button.text]),
        ]) as HTMLButtonElement;
        control.addEventListener("click", (event) => {
          event.stopPropagation();
          deps.onOpenMiniApp?.(
            button.mini_app.app_id,
            msg.chat_id,
            button.mini_app.start_param,
          );
        });
        if (!deps.onOpenMiniApp) control.disabled = true;
        return control;
      }
      if ("callback_data" in button && typeof button.callback_data === "string") {
        const control = el("button", { type: "button", class: "gc-inline-button is-callback" }, [button.text]) as HTMLButtonElement;
        control.addEventListener("click", (event) => {
          event.stopPropagation();
          void callback(control, button.callback_data);
        });
        return control;
      }
      if ("url" in button && typeof button.url === "string") {
        const href = safeUrl(button.url);
        const external = href?.startsWith("https:") === true;
        const link = el("a", {
          class: `gc-inline-button is-link${href ? "" : " is-disabled"}`,
          href: href ?? undefined,
          ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}),
          ...(href ? {} : { "aria-disabled": true }),
        }, [button.text]) as HTMLAnchorElement;
        link.addEventListener("click", (event) => {
          event.stopPropagation();
          if (!href) event.preventDefault();
        });
        return link;
      }
      const fallbackText = typeof (button as { text?: unknown }).text === "string"
        ? (button as { text: string }).text
        : "";
      return el("button", { type: "button", class: "gc-inline-button", disabled: true }, [fallbackText]);
    };
    for (const row of rows) {
      if (!Array.isArray(row) || row.length === 0) continue;
      keyboard.append(el("div", { class: "gc-inline-keyboard-row" }, row.map(renderButton)));
      renderedRows += 1;
    }
    return renderedRows > 0 ? keyboard : null;
  };

  // Render one message bubble. When albumGroup is supplied (2..10 same-album members) the whole grid is
  // rendered in place of msg's single attachment, and msg is the album's head (it carries the caption).
  // `head`/`tail` mark the first/last bubble of a run by the same author (V5 grouping): only the head
  // shows the author, only the tail carries the pointed corner and the avatar, and the rows in between
  // are packed tightly — the layout messengers have used for a decade.
  const renderBubble = (msg: Message, group: { head: boolean; tail: boolean }, albumGroup?: Message[]): HTMLElement => {
    const v = bubbleView(msg, self.id, i18n);
    const parts: Array<Node | string> = [];
    const sender = msg.sender;
    const reportableSender =
      !v.mine &&
      sender !== null &&
      typeof sender === "object" &&
      "username" in sender &&
      typeof sender.username === "string" &&
      Number.isSafeInteger(sender.id) &&
      sender.id > 0;
    if (!v.mine && v.author && showAuthors && group.head) {
      if (reportableSender && deps.onReport) {
        const author = el(
          "button",
          {
            type: "button",
            class: "gc-bubble-author gc-link",
            title: i18n.t("report.profileAction"),
          },
          [v.author],
        );
        author.addEventListener("click", (event) => {
          event.stopPropagation();
          deps.onReport?.({
            kind: "user",
            targetId: sender.id,
            label: `@${sender.username}`,
          });
        });
        parts.push(author);
      } else {
        parts.push(el("div", { class: "gc-bubble-author" }, [v.author]));
      }
    }
    if (v.forwarded) parts.push(el("div", { class: "gc-bubble-fwd" }, [v.forwarded]));
    if (v.reply) {
      const jump = el("button", { type: "button", class: "gc-bubble-reply" }, [v.reply.text]);
      jump.addEventListener("click", () => void jumpTo(v.reply!.id));
      parts.push(jump);
    }
    // Attachment (T-407): the album grid, or a single photo/video/voice/file tile. Only the caption
    // (a real msg.text) rides under the media; a media-only message hides the "Photo"/"Video" label.
    let attNode: HTMLElement | null = null;
    if (attachmentDeps && !v.deleted) {
      attNode = albumGroup ? renderAlbumGroup(albumGroup, attachmentDeps) : renderAttachment(msg, attachmentDeps);
    }
    if (attNode) parts.push(attNode);
    const hasCaption = typeof msg.text === "string" && msg.text.length > 0;
    // Meta = "edited · time · receipt". Server-authoritative watermarks make the progression honest:
    // ✓ stored on the server, grey ✓✓ delivered to a peer, accented ✓✓ read by a peer. The hidden copy
    // below reserves the exact width of whichever state is currently visible.
    // V90: that reservation is a hidden COPY of these very nodes, not a pixel constant. The constants
    // (44/60px) were sized for a 24-hour clock, so at en-US ("06:49 PM ✓") the meta was painted over
    // the last character — measured on the signed APK 1000010, screenshot /root/gc-p0-b5-sent.png.
    // Building both from one factory keeps them identical in every locale and at every font zoom.
    const receipt = receiptForMessage(msg.id, deliveredUpToMessageId, readUpToMessageId);
    const receiptTitle = receipt === "sent"
      ? i18n.t("feed.tickSent")
      : receipt === "delivered"
        ? (i18n.locale === "ru" ? "Доставлено получателю" : "Delivered to recipient")
        : (i18n.locale === "ru" ? "Прочитано" : "Read");
    const metaNodes = (withTitles: boolean): Array<Node | string> => [
      v.edited ? el("span", { class: "gc-bubble-edited" }, [i18n.t("feed.edited")]) : "",
      el("span", { class: "gc-bubble-time" }, [v.time]),
      v.mine && !v.deleted
        ? el(
            "span",
            withTitles
              ? { class: `gc-bubble-tick tick-${receipt}`, title: receiptTitle, "aria-label": receiptTitle }
              : { class: `gc-bubble-tick tick-${receipt}` },
            [receiptGlyph(receipt)],
          )
        : "",
    ];
    if (!attNode || hasCaption) {
      const bodyNodes = !v.deleted && typeof msg.text === "string" && msg.text.length > 0
        ? messageTextNodes(v.body)
        : [v.body];
      const body = el("div", { class: "gc-bubble-body" }, bodyNodes);
      body.append(el("span", { class: "gc-bubble-metaspace", "aria-hidden": "true" }, metaNodes(false)));
      parts.push(body);
    }
    const keyboard = !v.deleted ? renderInlineKeyboard(msg) : null;
    if (keyboard) parts.push(keyboard);
    const meta = el("div", { class: "gc-bubble-meta" }, metaNodes(true));
    const rstrip = reactionStrip(msg);
    // With reactions the corner is taken, so the meta rides at the end of the reaction row instead of
    // overlapping the chips (the arrangement Telegram uses too).
    if (rstrip) { rstrip.append(meta); parts.push(rstrip); } else { parts.push(meta); }

    const mediaOnly = attNode !== null && !hasCaption;
    const cls =
      `gc-bubble ${v.mine ? "is-mine" : "is-theirs"}${v.deleted ? " is-deleted" : ""}` +
      `${rstrip ? " has-reactions" : ""}${mediaOnly ? " is-mediaonly" : ""}` +
      `${keyboard ? " has-inline-keyboard" : ""}`;
    const bubble = el("div", { class: cls }, parts);
    const rowCls = [
      "gc-bubble-row",
      v.mine ? "align-end" : "align-start",
      group.head ? "is-head" : "is-cont",
      group.tail ? "is-tail" : "is-mid",
    ].join(" ");
    const row = el("div", { class: rowCls, "data-mid": msg.id });

    // Incoming group messages get the sender's avatar on the run's last row; the earlier rows keep a
    // matching spacer so the bubbles stay on one vertical rail (Telegram's arrangement).
    if (!v.mine && showAuthors) {
      row.append(
        group.tail
          ? el("span", {
              class: "gc-bubble-avatar gc-avatar",
              "data-tone": String(avatarTone(v.author || "?")),
              "aria-hidden": "true",
            }, [initials(v.author || "?")])
          : el("span", { class: "gc-bubble-avatar is-spacer", "aria-hidden": "true" }),
      );
    }
    row.append(bubble);

    if (!v.deleted) {
      // Keyboard/pointer affordance for the action menu; long-press and right-click open the same one.
      const moreBtn = el("button", {
        type: "button",
        class: "gc-bubble-more",
        "aria-label": i18n.t("feed.messageActions"),
        "aria-haspopup": "menu",
      }, [icon("more")]);
      moreBtn.addEventListener("click", (event) => { event.stopPropagation(); showMessageMenu(msg, row); });
      row.append(moreBtn);
      bindLongPress(row, { onTrigger: () => showMessageMenu(msg, row) });
    }
    return row;
  };

  const renderPending = (p: Pending): HTMLElement => {
    const tick = tickFor(p.status);
    // V176: transport state is quiet vector chrome inside the bubble, never a colour emoji that reads
    // as a second standalone message on Android.
    const statusIcon = tick === "clock" ? icon("clock", "gc-icon gc-bubble-status-icon")
      : tick === "failed" ? icon("warning", "gc-icon gc-bubble-status-icon")
        : icon("check", "gc-icon gc-bubble-status-icon");
    const meta = el("div", { class: "gc-bubble-meta" }, [
      el("span", { class: `gc-bubble-tick tick-${tick}`, title: p.status }, [statusIcon]),
    ]);
    const parts: Array<Node | string> = [el("div", { class: "gc-bubble-body" }, messageTextNodes(p.text)), meta];
    if (p.status === "failed") {
      const retry = el("button", { type: "button", class: "gc-bubble-retry" }, [i18n.t("common.retry")]);
      retry.addEventListener("click", () => void outbox.retry(p.cmid));
      parts.push(retry);
    }
    const bubble = el("div", { class: `gc-bubble is-mine${p.status === "failed" ? " is-failed" : ""}` }, parts);
    return el("div", { class: "gc-bubble-row align-end", "data-cmid": p.cmid }, [bubble]);
  };

  const paint = (opts: { keepBottom?: boolean; anchorTop?: number } = {}): void => {
    // V179 — `pinnedToBottom` carries the reader's intent across our own relayouts. Opening the IME,
    // growing the composer or finishing a late bubble layout can temporarily create a geometric gap
    // after scrollToBottom(). V116 deliberately keeps the pin through that changed geometry; asking
    // isAtBottom() again here discarded it on the next Outbox repaint and left the just-sent bubble
    // below the composer. A genuine scroll into history is already recorded by the stable scroll
    // handler as `pinnedToBottom = false`, so preserving the flag never yanks that reader to the tail.
    const wasBottom = opts.keepBottom ?? pinnedToBottom;
    const prevH = listBox.scrollHeight;
    const prevTop = listBox.scrollTop;

    if (attachmentDeps) cleanupMedia(listBox); // revoke the prior render's blob URLs before discarding it
    clear(listBox);

    // Pass 1 — split the window into render units (a service chip, a single bubble, or an album grid)
    // so pass 2 can decide grouping by looking at the neighbouring units rather than raw messages.
    interface Unit { head: Message; album?: Message[]; service: boolean; daySep: boolean; run?: Message[] }
    const units: Unit[] = [];
    let prev: Message | null = null;
    let i = 0;
    while (i < messages.length) {
      const m = messages[i]!;
      const daySep = needsDaySeparator(prev, m) && typeof m.created_at === "number";
      if (isServiceMessage(m)) {
        // Fold a contiguous run of identical per-person events into one chip: creating a group posts a
        // separate member_joined row per invitee, which stacked N identical chips above the first
        // message. Grouping stops at a day boundary so the chip never spans two dates.
        const fold = serviceFoldKey(m);
        if (fold) {
          const run: Message[] = [m];
          let j = i + 1;
          while (j < messages.length) {
            const next = messages[j]!;
            if (serviceFoldKey(next) !== fold) break;
            if (needsDaySeparator(run[run.length - 1]!, next)) break;
            run.push(next);
            j++;
          }
          if (run.length >= 2) {
            units.push({ head: m, service: true, daySep, run });
            prev = run[run.length - 1]!;
            i = j;
            continue;
          }
        }
        units.push({ head: m, service: true, daySep });
        prev = m;
        i++;
        continue;
      }
      // Group a contiguous run of same-album messages (T-214/T-407) into one grid bubble.
      const aid = attachmentDeps ? albumIdOf(m) : null;
      if (aid) {
        const album: Message[] = [];
        let j = i;
        while (j < messages.length && albumIdOf(messages[j]!) === aid) { album.push(messages[j]!); j++; }
        if (album.length >= 2) {
          units.push({ head: m, album, service: false, daySep });
          prev = album[album.length - 1]!;
          i = j;
          continue;
        }
      }
      units.push({ head: m, service: false, daySep });
      prev = m;
      i++;
    }

    // Pass 2 — paint, marking the first/last bubble of every same-author run.
    for (let u = 0; u < units.length; u++) {
      const unit = units[u]!;
      if (unit.daySep && typeof unit.head.created_at === "number") {
        listBox.append(el("div", { class: "gc-feed-daysep" }, [dayLabel(unit.head.created_at, now(), i18n)]));
      }
      if (unit.service) {
        // A service event (member joined, call, …) is a centered chip, not a bubble. data-mid stays
        // on the row so reply-jump anchors keep working.
        listBox.append(el("div", { class: "gc-service-row", "data-mid": unit.head.id }, [
          el("span", { class: "gc-service-chip" }, [
            unit.run ? serviceRunText(unit.run, i18n) : serviceText(unit.head, i18n),
          ]),
        ]));
        continue;
      }
      const before = units[u - 1];
      const after = units[u + 1];
      const head = !before || before.service || unit.daySep || !sameRun(before, unit);
      const tail = !after || after.service || after.daySep || !sameRun(unit, after);
      listBox.append(renderBubble(unit.head, { head, tail }, unit.album));
    }
    for (const p of [...pending.values()].sort((a, b) => a.created_at - b.created_at)) {
      listBox.append(renderPending(p));
    }

    renderStage();

    if (opts.anchorTop !== undefined) {
      listBox.scrollTop = opts.anchorTop + (listBox.scrollHeight - prevH);
    } else if (wasBottom) {
      scrollToBottom();
    } else {
      listBox.scrollTop = prevTop;
    }
  };

  // ---- receipt-state loading ----
  const safeReceiptCursor = (raw: unknown): number => {
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  };

  const loadReceiptState = async (): Promise<void> => {
    const revisionAtStart = receiptRevision;
    try {
      const state = await api.get<ChatReceiptState>(`/v1/chats/${chatId}/receipt-state`);
      if (disposed || state.chat_id !== chatId) return;
      const nextRead = safeReceiptCursor(state.read_up_to_message_id);
      const nextDelivered = Math.max(
        safeReceiptCursor(state.delivered_up_to_message_id),
        nextRead, // reading necessarily proves delivery even if a transport cursor was missed
      );
      const beforeDelivered = deliveredUpToMessageId;
      const beforeRead = readUpToMessageId;
      if (receiptRevision === revisionAtStart) {
        // No live receipt raced this request: the response is authoritative, including privacy-driven
        // zeroes after receipts were disabled on another device.
        deliveredUpToMessageId = nextDelivered;
        readUpToMessageId = nextRead;
      } else {
        // A newer live event won the race; an older HTTP snapshot may only advance, never regress it.
        deliveredUpToMessageId = Math.max(deliveredUpToMessageId, nextDelivered);
        readUpToMessageId = Math.max(readUpToMessageId, nextRead);
      }
      if (beforeDelivered !== deliveredUpToMessageId || beforeRead !== readUpToMessageId) paint();
    } catch {
      // Older/self-hosted servers may not expose the recovery endpoint yet. Live receipts still work;
      // the single server-stored check is the honest fail-closed fallback.
    }
  };

  // ---- history loading ----
  const loadNewest = async (strict = false): Promise<void> => {
    try {
      const page = await api.get<Message[]>(historyPath(chatId, { limit: PAGE }));
      if (disposed) return;
      messages = mergeMessages([], page);
      atHead = true;
      reachedTop = page.length < PAGE;
      readPhase = "ready";
      readError = null;
      paint({ keepBottom: true });
      void markRead();
    } catch (err) {
      if (disposed) { if (strict) throw err; return; }
      // V89 — a failed READ is not a queued write. With nothing on screen the stage carries the
      // failure (with a retry); with messages already painted from the local cache the thread stays
      // usable and only says the refresh did not land.
      if (messages.length === 0 && pending.size === 0) {
        readPhase = "failed";
        readError = err;
        renderStage();
      } else {
        showStatus(failureLine(err, i18n));
      }
      if (strict) throw err;
    }
  };

  const loadOlder = async (): Promise<void> => {
    if (loadingOlder || reachedTop) return;
    const before = oldestId(messages);
    if (before === null) return;
    loadingOlder = true;
    try {
      const page = await api.get<Message[]>(historyPath(chatId, { before_id: before, limit: PAGE }));
      if (disposed) return;
      if (page.length === 0) { reachedTop = true; return; }
      const anchorTop = listBox.scrollTop;
      messages = trimWindow(mergeMessages(messages, page), MAX_WINDOW, "top");
      if (messages.length >= MAX_WINDOW) atHead = false;
      paint({ anchorTop });
    } catch (err) {
      if (!disposed) showStatus(failureLine(err, i18n)); // paging older history is a read too
    } finally {
      loadingOlder = false;
    }
  };

  const loadNewer = async (): Promise<void> => {
    if (loadingNewer || atHead) return;
    const after = newestId(messages);
    if (after === null) return;
    loadingNewer = true;
    try {
      const page = await api.get<Message[]>(historyPath(chatId, { after_id: after, limit: PAGE }));
      if (disposed) return;
      if (page.length === 0) { atHead = true; return; }
      messages = trimWindow(mergeMessages(messages, page), MAX_WINDOW, "bottom");
      if (page.length < PAGE) atHead = true;
      paint();
    } catch (err) {
      if (!disposed) showStatus(describeError(err, i18n));
    } finally {
      loadingNewer = false;
    }
  };

  const jumpTo = async (mid: number): Promise<void> => {
    const present = messages.find((m) => m.id === mid);
    if (!present) {
      try {
        const [older, newer] = await Promise.all([
          api.get<Message[]>(historyPath(chatId, { before_id: mid + 1, limit: PAGE })),
          api.get<Message[]>(historyPath(chatId, { after_id: mid, limit: PAGE })),
        ]);
        if (disposed) return;
        messages = mergeMessages(mergeMessages([], older), newer);
        atHead = newer.length < PAGE;
        reachedTop = older.length < PAGE;
        paint({ keepBottom: false });
      } catch (err) {
        if (!disposed) showStatus(describeError(err, i18n));
        return;
      }
    }
    const target = listBox.querySelector(`[data-mid="${mid}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "center" });
      target.classList.add("is-highlight");
      setTimeout(() => target.classList.remove("is-highlight"), 1600);
    }
  };

  // V116 — the reader's intent must be judged in the layout the reader was actually looking at.
  //
  // Measured on the signed APK (redroid, 320 dp, system font size 2.0x, cold open of the first
  // conversation) with a probe that only records and never scrolls, because every probe that
  // re-pinned the box hid the defect (one such A/B passed 16/16 and proved nothing). Under the
  // passive probe 6 of 16 cold starts settled at scrollTop 1263 with the newest message clipped
  // 85 px behind the composer, matching 4 of 14 under an independent two-evaluate probe. And
  // 1611 - 348 = 1263 exactly — the box was parked at the true bottom of the PRE-shrink layout and
  // never re-pinned once the box became 242 px.
  //
  // The recorded traces show why. During first layout the list box shrinks towards 242 px, and the
  // outcome depends only on how the browser happens to deliver that shrink:
  //   passing  348 -> 300 -> 242, intermediate gaps 48 and 58 px, both under the V115 slack of 96,
  //            so the pin survives each step and the ResizeObserver re-pins (1263 -> 1311 -> 1368);
  //   failing  348 -> 242 in one step, gap 106 px > 96, pin cleared here, and the ResizeObserver
  //            fires 1 ms later with the final geometry but is suppressed by its own flag.
  // Widening the slack again is not the fix: 106 > 96 was already the widened slack, and chasing it
  // upward starts swallowing real intent.
  //
  // Note what the traces refuted: "the scroll event arrives with scrollTop unchanged" is true in
  // only 3 of the 6 failures. In the other 3 scrollTop DID change (1353.8 -> 1262.8) — but that move
  // was the browser clamping the offset when scrollHeight shrank 1773 -> 1611, not the reader. That
  // rule would have fixed half the failures and looked like a fix for all of them.
  // What all 6 share is that the event arrives with the box geometry ALREADY changed.
  //
  // Verified on the device before shipping, without a rebuild: across 40 further cold starts the
  // recorded event stream was replayed through both rules, and the SHIPPED rule's prediction was
  // checked against what the device actually did — 40/40 agreement, so the model is not assumed.
  // On those same 40 runs the shipped rule lost the pin 11 times (all 11 clipped, as predicted) and
  // this rule lost it 0 times. The replay is only read up to the last resize, because past the point
  // where the two rules act differently the recorded trace no longer describes what would happen.
  //
  // So: a reader can only express intent within the layout in front of them. A scroll event that
  // reports a box whose size or content just changed is the app's own relayout being echoed back,
  // carries no information about the reader, and therefore leaves the flag exactly as it was. Only
  // an event on a STABLE box re-answers the question. Pagination is deliberately left outside this
  // gate: a relayout can genuinely expose an edge, and refusing to fetch there would strand the feed.
  let lastSh = listBox.scrollHeight;
  let lastCh = listBox.clientHeight;
  listBox.addEventListener("scroll", () => {
    const top = listBox.scrollTop;
    const sh = listBox.scrollHeight;
    const ch = listBox.clientHeight;
    const relaidOut = sh !== lastSh || ch !== lastCh;
    lastSh = sh;
    lastCh = ch;
    if (!relaidOut) pinnedToBottom = isAtBottom();
    // V166 — the only place the reader can tell the app "I am back at the newest message"; the read
    // pointer held back while they were reading history is released here, and nowhere else.
    if (pinnedToBottom) flushDeferredRead();
    syncJump();
    if (top < NEAR_EDGE) void loadOlder();
    if (sh - top - ch < NEAR_EDGE) void loadNewer();
  });

  // Keyboard-open regression (device run 2026-07-31, redroid 393x873, LatinIME): raising the soft
  // keyboard shrinks the visual viewport (measured 801 -> 494 CSS px), so the feed's own box loses
  // ~307 px in one frame. The browser keeps `scrollTop` where it was, which means the newest bubble
  // slides under the composer: measured scrollTop=0 with scrollHeight 410 > clientHeight 377, i.e.
  // 33 px of the last message ("Договорились 👍") were clipped, and the user had to scroll by hand
  // to see the very message they had just come to answer.
  //
  // The fix watches the LIST BOX, not `visualViewport`: the same shrink also happens when the media
  // tray, the reply banner or a multi-line composer grows, and one rule then covers all of them.
  // It only re-pins when the reader was already at the bottom — someone reading history must never be
  // yanked to the end because the keyboard appeared. `ResizeObserver` is feature-detected exactly as
  // in virtual_list.ts, so the DOM test stub (which has none) keeps working.
  const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => { observe(el: Element): void; disconnect(): void } }).ResizeObserver;
  const boxResize = typeof RO === "function"
    ? new RO(() => { if (!disposed && pinnedToBottom) scrollToBottom(); })
    : null;
  boxResize?.observe(listBox);
  // V113b — the bar re-decides when the BAR changes width, not when the window does. Rotation into
  // the two-pane layout keeps the window wide (819 px) while the conversation column becomes 388 px,
  // which no media query on the window can see. Feature-detected like the observer above, so the DOM
  // test stub keeps working; the media-query listener stays as the fallback path for that same stub.
  const headerResize = typeof RO === "function"
    ? new RO(() => { if (!disposed) onViewportChange(); })
    : null;
  headerResize?.observe(header);

  // ---- send / edit / delete ----
  const onComposerSubmit = (p: ComposerSubmit): void => {
    if (p.mode === "edit") { void submitEdit(p.messageId, p.text); return; }
    if (tray && tray.count() > 0) { void submitMedia(p.text, p.replyToId); return; }
    void submitSend(p.text, p.replyToId);
  };

  // Compress + upload the staged files, then enqueue the resulting send bodies (one album body when
  // eligible, else one per file). The Outbox echoes each sent message back via subscribe → upserted.
  const submitMedia = async (caption: string, replyToId: number | null): Promise<void> => {
    if (!tray) return;
    setStatus(i18n.t("common.loading"), "info");
    let bodies: Array<Record<string, unknown>>;
    try {
      bodies = await tray.flush(caption, replyToId);
    } catch (err) {
      showStatus(describeError(err, i18n));
      return;
    }
    for (const body of bodies) {
      try { await outbox.enqueueMessage(chatId, body); }
      catch (err) { showStatus(describeError(err, i18n)); }
    }
    if (bodies.length > 0) { clearStatus(); scrollToBottom(); }
  };

  const submitSticker = async (stickerId: number, replyToId: number | null): Promise<void> => {
    const sent = await api.post<Message>(
      `/v1/chats/${chatId}/sticker`,
      stickerSendBody(stickerId, genCmid(), replyToId),
    );
    messages = upsertMessage(messages, sent);
    paint();
    scrollToBottom();
  };

  const submitSend = async (text: string, replyToId: number | null): Promise<void> => {
    const cmid = genCmid();
    const p: Pending = { cmid, text, replyToId, status: "queued", created_at: now() };
    pending.set(cmid, p);
    // Бюджет PRODUCT_UX §4.16 «свой текст: ввод → появление в ленте < 50 мс»: НЕ перерисовываем
    // всю ленту — paint() это clear()+полная перестройка O(n), и перф-аудит кампании №13 показал
    // рост латентности отправки с длиной ленты (при CPU x4 p99 ~104 мс до фикса, ~27 мс после).
    // Новое pending всегда хронологически последнее (created_at = now()), поэтому его достаточно
    // ДОПИСАТЬ в конец; renderPending — чистый текстовый пузырёк (без blob-URL), так что
    // cleanupMedia не нужен. Ближайший авторитетный paint() (тик Outbox, echo из sync, история)
    // перерисует ленту как раньше — источником правды остаётся paint().
    listBox.append(renderPending(p));
    renderStage();
    scrollToBottom();
    const body: Record<string, unknown> = { client_msg_id: cmid, text };
    if (replyToId !== null) body.reply_to_id = replyToId;
    try {
      await outbox.enqueueMessage(chatId, body);
    } catch (err) {
      const cur = pending.get(cmid);
      if (cur) { cur.status = "failed"; paint(); }
      showStatus(describeError(err, i18n));
    }
  };

  const submitEdit = async (messageId: number, text: string): Promise<void> => {
    const idx = messages.findIndex((m) => m.id === messageId);
    const prevText = idx >= 0 ? (typeof messages[idx]!.text === "string" ? (messages[idx]!.text as string) : "") : "";
    if (idx >= 0) { messages[idx] = { ...messages[idx]!, text, edited_at: now() }; paint(); }
    try {
      const outboxId = await outbox.enqueueEdit(chatId, messageId, text);
      editPrev.set(outboxId, prevText);
    } catch (err) {
      if (idx >= 0) { messages[idx] = { ...messages[idx]!, text: prevText }; paint(); }
      showStatus(describeError(err, i18n));
    }
  };

  const deleteMessage = async (msg: Message): Promise<void> => {
    messages = removeMessage(messages, msg.id);
    paint();
    try {
      const outboxId = await outbox.enqueueDelete(chatId, msg.id);
      deleteBackup.set(outboxId, msg);
      showUndo(i18n.t("feed.undoDelete"), outboxId, () => { deleteBackup.delete(outboxId); });
    } catch (err) {
      messages = upsertMessage(messages, msg);
      paint();
      showStatus(describeError(err, i18n));
    }
  };

  // ---- undo bar ----
  let undoTimer: ReturnType<typeof setTimeout> | null = null;
  const hideUndo = (): void => {
    undoBar.hidden = true;
    clear(undoBar);
    if (undoTimer) { clearTimeout(undoTimer); undoTimer = null; }
  };
  const showUndo = (label: string, outboxId: string, onUndo?: () => void): void => {
    clear(undoBar);
    const btn = el("button", { type: "button", class: "gc-link gc-undo-btn" }, [i18n.t("common.undo")]);
    btn.addEventListener("click", () => {
      void outbox.cancel(outboxId);
      onUndo?.();
      hideUndo();
    });
    undoBar.append(el("span", {}, [label]), btn);
    undoBar.hidden = false;
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, UNDO_MS);
  };

  // ---- reactions ----
  const react = async (messageId: number, emoji: string): Promise<void> => {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx >= 0) { messages[idx] = { ...messages[idx]!, reactions: toggleReaction(messages[idx]!.reactions, emoji) }; paint(); }
    try {
      const res = await api.post<{ message_id: number; reactions: MsgReaction[] }>(`/v1/messages/${messageId}/reactions`, { emoji });
      const at = messages.findIndex((m) => m.id === res.message_id);
      if (at >= 0) { messages[at] = { ...messages[at]!, reactions: res.reactions }; paint(); }
    } catch (err) {
      showStatus(describeError(err, i18n));
    }
  };

  // ---- forward / pin ----
  const openForwardPicker = (messageId: number): void => {
    modals.open("forward", (release) => {
      const list = el("div", { class: "gc-forward-list" });
      const panel = el("div", { class: "gc-forward-panel" }, [
        el("h3", { class: "gc-forward-title" }, [i18n.t("feed.forwardTo")]), list,
      ]);
      const overlay = el("div", { class: "gc-overlay" }, [panel]);
      // Reachable from the scrim, a chosen chat, a failed load and the screen's destroy() — so it has to
      // survive being called twice, and announce the departure exactly once.
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        overlay.remove();
        release();
      };
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      void (async () => {
        try {
          const chats = await api.get<ChatEntry[]>("/v1/chats?filter=all");
          clear(list);
          for (const c of chats) {
            const row = el("button", { type: "button", class: "gc-forward-row" }, [c.title]);
            row.addEventListener("click", () => { close(); void forward(messageId, c.id); });
            list.append(row);
          }
        } catch (err) { showStatus(describeError(err, i18n)); close(); }
      })();
      return { node: overlay, close };
    });
  };

  const forward = async (messageId: number, toChatId: number): Promise<void> => {
    try {
      await api.post(`/v1/messages/${messageId}/forward`, { to_chat_id: toChatId, client_msg_id: genCmid() });
      showStatus(i18n.t("feed.forward"), "success", 1800);
    } catch (err) { showStatus(describeError(err, i18n)); }
  };

  const pin = async (messageId: number): Promise<void> => {
    try {
      await api.post(`/v1/messages/${messageId}/pin`, {});
      await loadPins();
    } catch (err) { showStatus(describeError(err, i18n)); }
  };

  const loadPins = async (): Promise<void> => {
    try {
      const pins = await api.get<Message[]>(`/v1/chats/${chatId}/pins`);
      if (disposed) return;
      if (pins.length === 0) { pinnedBar.hidden = true; return; }
      const latest = pins[pins.length - 1]!;
      clear(pinnedBar);
      // Caption above text, not beside it. Side by side the caption competed with the message for the
      // same 390 px row and wrapped onto two lines ("Закреплённое" / "сообщение"), which is why the bar
      // read as a green banner rather than the one-line strip every messenger puts under the header.
      pinnedBar.append(
        el("span", { class: "gc-feed-pinned-rail", "aria-hidden": "true" }),
        el("span", { class: "gc-feed-pinned-body" }, [
          el("span", { class: "gc-feed-pinned-label" }, [i18n.t("feed.pinnedTitle")]),
          el("span", { class: "gc-feed-pinned-text" }, [bubbleView(latest, self.id, i18n).body]),
        ]),
        el("span", { class: "gc-feed-pinned-glyph", "aria-hidden": "true" }, [icon("pin")]),
      );
      pinnedBar.hidden = false;
      pinnedBar.onclick = () => void jumpTo(latest.id);
    } catch { /* pins are best-effort chrome */ }
  };

  // ---- drafts ----
  const saveDraft = async (text: string): Promise<void> => {
    try {
      if (text.trim().length === 0) await api.delete(`/v1/chats/${chatId}/draft`);
      else await api.put(`/v1/chats/${chatId}/draft`, { text });
    } catch { /* draft persistence is best-effort */ }
  };

  // ---- read receipts ----
  // V166 — a read pointer is the reader's own claim, "I have seen everything up to here", so it may
  // only advance for messages that actually reached the reader. Until now it advanced to the newest
  // message in the LOADED WINDOW on every inbound event, gated only by `atHead` — which is a fact
  // about the data (the window still contains the tail), not about the person.
  //
  // Measured on the deployed build (2026-08-03, greenchat.globalsystem.cc, accounts 66 -> 67, chat 27,
  // CloakBrowser 412x915 ru-RU): the reader sat at `.gc-feed-list` scrollTop 0 with 965 px of feed
  // still below the fold while the peer sent 28 messages and then a single control message (id 114).
  // `GET /v1/chats` AS THE READER answered `unread_count: 0` after every burst. Two people were
  // misinformed by one line: the sender was told messages had been read that nobody had looked at,
  // and the reader lost the only marker that leads back to them.
  //
  // The honest gate already exists in this file: `pinnedToBottom` is re-answered by every scroll on a
  // STABLE box (V116), so it carries the reader's intent instead of a guess made at render time.
  // While the reader is away from the tail the pointer is held back and the newest id is only
  // remembered; returning to the bottom flushes it. A reader who never scrolls away takes the old
  // path request for request, which is why the at-bottom case needed no other change.
  let deferredRead: number | null = null;
  const sendRead = async (upTo: number): Promise<void> => {
    try { await api.post(`/v1/chats/${chatId}/read`, { up_to_message_id: upTo }); } catch { /* best-effort */ }
  };
  const markRead = async (): Promise<void> => {
    const top = newestId(messages);
    if (top === null) return;
    if (!pinnedToBottom) { deferredRead = deferredRead === null ? top : Math.max(deferredRead, top); return; }
    deferredRead = null;
    await sendRead(top);
  };
  // Arriving at the bottom is the moment the held-back messages are genuinely on screen, so that is
  // where the pointer is released. The newest loaded id wins over the remembered one: anything that
  // landed while the reader was travelling down is now under their eyes too.
  const flushDeferredRead = (): void => {
    if (deferredRead === null) return;
    const top = newestId(messages);
    const upTo = top !== null && top > deferredRead ? top : deferredRead;
    deferredRead = null;
    void sendRead(upTo);
  };

  // ---- in-chat search (T-017) ----
  function buildSearchPanel(): { root: HTMLElement; toggle(): void } {
    let open = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const input = el("input", { type: "search", class: "gc-input", placeholder: i18n.t("feed.searchPlaceholder"), "aria-label": i18n.t("feed.searchPlaceholder") }) as HTMLInputElement;
    const results = el("div", { class: "gc-search-results" }, [el("p", { class: "gc-search-hint" }, [i18n.t("feed.searchHint")])]);
    const panelRoot = el("div", { class: "gc-feed-search", hidden: true }, [input, results]);

    const run = async (q: string): Promise<void> => {
      if (q.trim().length === 0) { clear(results); results.append(el("p", { class: "gc-search-hint" }, [i18n.t("feed.searchHint")])); return; }
      try {
        const hits = await api.get<Array<Message & { snippet?: string }>>(`/v1/search/messages?chat_id=${chatId}&q=${encodeURIComponent(q)}&limit=30`);
        clear(results);
        if (hits.length === 0) { results.append(el("p", { class: "gc-search-hint" }, [i18n.t("feed.searchEmpty")])); return; }
        for (const h of hits) {
          const row = el("button", { type: "button", class: "gc-search-row" }, [
            el("span", { class: "gc-search-snippet" }, [h.snippet ?? bubbleView(h, self.id, i18n).body]),
          ]);
          row.addEventListener("click", () => { toggle(); void jumpTo(h.id); });
          results.append(row);
        }
      } catch (err) { showStatus(describeError(err, i18n)); }
    };

    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void run(input.value), 300);
    });

    const toggle = (): void => {
      open = !open;
      panelRoot.hidden = !open;
      if (open) input.focus();
    };
    return { root: panelRoot, toggle };
  }

  // ---- Outbox reconciliation ----
  const unsubOutbox = outbox.subscribe((change) => {
    const { item, removed } = change;
    if (item.chat_id !== chatId) return;
    if (item.kind === "message") {
      const p = pending.get(item.id);
      if (removed && item.status === "sent") {
        if (item.result) messages = upsertMessage(messages, item.result as Message);
        pending.delete(item.id);
        paint({ keepBottom: true });
      } else if (removed) {
        pending.delete(item.id); // undo-cancelled
        paint();
      } else if (p) {
        p.status = item.status;
        paint();
      }
    } else if (item.kind === "edit") {
      if (item.status === "sent") { editPrev.delete(item.id); }
      else if (item.status === "failed" && editPrev.has(item.id)) {
        // The optimistic text stands until we can resync authoritative text from the server.
        editPrev.delete(item.id);
        showStatus(i18n.t("feed.failed"));
        void loadNewest();
      }
    } else if (item.kind === "delete") {
      const backup = deleteBackup.get(item.id);
      if (removed && item.status === "sent") { deleteBackup.delete(item.id); }
      else if (removed && backup) { messages = upsertMessage(messages, backup); deleteBackup.delete(item.id); paint(); }
      else if (item.status === "failed" && backup) { messages = upsertMessage(messages, backup); deleteBackup.delete(item.id); paint(); showStatus(i18n.t("feed.failed")); }
    }
  });

  // ---- live events ----
  const unsubEvents = events.subscribe((evt) => {
    if (evt.type === "sync.resync") {
      return Promise.all([loadNewest(true), loadTitle(true), loadReceiptState()]).then(() => undefined);
    }
    const p = evt.payload as {
      message?: Message;
      chat_id?: number;
      message_id?: number;
      user_id?: number;
      up_to_message_id?: number;
      reactions?: Array<{ emoji: string; count: number }>;
      draft?: string | null;
    };
    switch (evt.type) {
      case "chat.delivered":
      case "chat.read": {
        if (
          p.chat_id !== chatId ||
          !Number.isSafeInteger(p.user_id) ||
          (p.user_id as number) <= 0 ||
          p.user_id === self.id
        ) return;
        const upTo = safeReceiptCursor(p.up_to_message_id);
        if (upTo === 0) return;
        const beforeDelivered = deliveredUpToMessageId;
        const beforeRead = readUpToMessageId;
        if (evt.type === "chat.read") {
          readUpToMessageId = Math.max(readUpToMessageId, upTo);
          deliveredUpToMessageId = Math.max(deliveredUpToMessageId, upTo);
        } else {
          deliveredUpToMessageId = Math.max(deliveredUpToMessageId, upTo);
        }
        if (beforeDelivered !== deliveredUpToMessageId || beforeRead !== readUpToMessageId) {
          receiptRevision += 1;
          paint();
        }
        break;
      }
      case "message.new":
      case "message.edit": {
        const m = p.message;
        if (!m || m.chat_id !== chatId) return;
        if (evt.type === "message.new" && !atHead) return; // don't jam the tail into a scrolled-back window
        messages = trimWindow(upsertMessage(messages, m), MAX_WINDOW, "bottom");
        paint();
        if (evt.type === "message.new") {
          // Own messages arrive here too (other devices, the outbox echo); they are not something the
          // reader "missed", so only someone else's message raises the badge.
          if (!pinnedToBottom && m.sender?.id !== self.id) { awayNew += 1; syncJump(); }
          void markRead();
        }
        // A roster change arrives as a service message; re-fetch so the header count and the @mention
        // list stop lying the moment someone joins or leaves.
        if (m.kind === "service" && (m.service_event === "member_joined" || m.service_event === "member_left")) {
          void loadMembers();
        }
        break;
      }
      case "message.delete": {
        if (p.chat_id !== chatId || typeof p.message_id !== "number") return;
        messages = applyDelete(messages, p.message_id);
        paint();
        break;
      }
      case "reaction.update": {
        if (p.chat_id !== chatId || typeof p.message_id !== "number" || !p.reactions) return;
        messages = applyReactionUpdate(messages, p.message_id, p.reactions);
        paint();
        break;
      }
      case "presence.update": {
        const pp = evt.payload as { user_id?: number; online?: boolean; last_seen?: number | string };
        if (peerId === null || pp.user_id !== peerId) return;
        presence = {
          online: pp.online === true,
          lastSeen: typeof pp.last_seen === "number"
            ? pp.last_seen
            : pp.last_seen === "recently" ? "recently" : presence.lastSeen,
        };
        renderSubtitle();
        break;
      }
      case "draft.update": {
        if (p.chat_id !== chatId) return;
        // Only accept a draft pushed from elsewhere; ignore the server's echo of our own save while the
        // user is still typing here, which would otherwise overwrite the live textarea. A remote clear
        // (`draft: null`) must still erase an inactive stale composer on this device.
        const decision = remoteDraftDecision(p.draft, composer.isActive());
        if (decision.apply) composer.setText(decision.text);
        break;
      }
      default:
        break;
    }
  });

  // ---- members (for @mentions) ----
  const loadMembers = async (): Promise<void> => {
    try {
      const rows = await api.get<ChatMember[]>(`/v1/chats/${chatId}/members`);
      if (!disposed) {
        members = rows;
        renderSubtitle(); // the group/channel header shows this count
      }
    } catch { /* mentions autocomplete simply stays empty */ }
    if (!disposed) void loadPresence();
  };

  // ---- presence (dialog header subtitle) ----
  // The initial value can only come from the profile: `presence.update` is a change notification, so a
  // peer who is simply offline would never produce a frame and the subtitle would stay empty. The
  // server blurs a hidden timestamp to the string "recently", which the formatter renders verbatim.
  const loadPresence = async (): Promise<void> => {
    if (!isPresenceChat) return;
    const peer = members.find((m) => m.id !== self.id);
    if (!peer) return;
    peerId = peer.id;
    if (peerIsBot || peer.is_bot === true) {
      peerIsBot = true;
      presence = { online: false, lastSeen: null };
      renderSubtitle();
      return;
    }
    try {
      const profile = await api.get<{ last_seen?: number | string }>(`/v1/users/${peer.id}`);
      if (disposed) return;
      const seen = profile.last_seen;
      presence = {
        online: false,
        lastSeen: typeof seen === "number" ? seen : seen === "recently" ? "recently" : null,
      };
      renderSubtitle();
    } catch { /* a hidden or unreachable profile just leaves the kind label in place */ }
  };

  // ---- chat header title ----
  const loadTitle = async (strict = false): Promise<void> => {
    try {
      const chats = await api.get<ChatEntry[]>("/v1/chats?filter=all");
      const entry = chats.find((c) => c.id === chatId);
      if (entry && !disposed) {
        // T-427: a self-dialog reads "Saved Messages" (Избранное), not the owner's own name.
        const title = isSelfDialog(entry, self) ? i18n.t("chat.savedMessages") : entry.title;
        titleEl.textContent = title;
        // V5 header: avatar + a subtitle that says what this chat actually is, like every other
        // messenger's chat header — previously the header was a bare centred string.
        headerAvatar.textContent = initials(title);
        headerAvatar.setAttribute("data-tone", String(avatarTone(title)));
        headerAvatarBinding?.destroy();
        headerAvatarBinding = bindAvatarImage(headerAvatar, api, entry.photo_file_id, title);
        const kind = typeof entry.kind === "string" ? entry.kind : "";
        peerIsBot = entry.peer_is_bot === true;
        chatKind = isSelfDialog(entry, self) ? "" : kind;
        const wasShowingAuthors = showAuthors;
        showAuthors = kind !== "dialog";
        kindSubtitle = isSelfDialog(entry, self)
          ? i18n.t("chat.savedSubtitle")
          : kind === "channel"
            ? i18n.t("chat.kindChannel")
            : kind === "group"
              ? i18n.t("chat.kindGroup")
              : i18n.t("chat.kindDialog");
        // Presence belongs to a two-person conversation only: a group has no single "last seen", and a
        // self-dialog would report the reader back to themselves.
        isPresenceChat = kind === "dialog" && !isSelfDialog(entry, self);
        if (!isPresenceChat) { peerId = null; presence = { online: false, lastSeen: null }; }
        renderSubtitle();
        // loadTitle() and loadMembers() race at boot: whichever finishes last owns the first presence
        // fetch, so both ends call it and loadPresence() is a no-op until members are known.
        if (isPresenceChat && peerId === null) void loadPresence();
        if (wasShowingAuthors !== showAuthors) paint();
        if (entry.draft && !composer.isActive()) composer.setText(entry.draft);
      }
    } catch (error) {
      // During full resync the title/chat-list fetch is part of the snapshot barrier; ordinary boot
      // keeps the historical best-effort fallback.
      if (strict) throw error;
    }
  };

  // ---- boot ----
  // V89 — paint the silhouette BEFORE the first read, otherwise the screen is blank for as long as
  // the network takes (measured: a fully white 727px page on a fresh device).
  renderStage();
  void (async () => {
    // Recovery and history start together. Whichever lands last repaints from the same authoritative
    // cursors, so a reopened conversation cannot get stuck on the single stored check.
    await Promise.all([loadNewest(), loadReceiptState()]);
    void loadTitle();
    void loadMembers();
    void loadPins();
    if (typeof deps.focusMessageId === "number") void jumpTo(deps.focusMessageId);
    // V92: on a touch shell an unasked-for focus opens the keyboard over the history (see
    // hasVirtualKeyboard above). The user taps the field when they want to type.
    else if (!hasVirtualKeyboard()) composer.focus();
  })();

  // "был(а) 5 мин назад" must keep counting: without a ticker the line freezes at whatever it said when
  // the last frame arrived. One minute is the resolution of the label itself, so nothing finer is useful.
  const presenceTimer = setInterval(() => { if (!presence.online) renderSubtitle(); }, 60_000);

  return {
    root,
    focus(messageId: number) { void jumpTo(messageId); },
    destroy() {
      disposed = true;
      unsubOutbox();
      unsubEvents();
      composer.destroy();
      tray?.destroy();
      // Sheets, menus and the recorder all live on the document body, so none of them go away with our
      // subtree. This is the one line that takes every one of them down.
      modals.closeAll();
      if (attachmentDeps) cleanupMedia(root);
      if (statusTimer) clearTimeout(statusTimer);
      if (undoTimer) clearTimeout(undoTimer);
      clearInterval(presenceTimer);
      headerAvatarBinding?.destroy();
      headerAvatarBinding = null;
      boxResize?.disconnect();
      headerResize?.disconnect();
      headerViewport?.removeEventListener?.("change", onViewportChange);
      shortWindowView.removeEventListener?.("resize", onWindowResize);
      shortWindowView.visualViewport?.removeEventListener?.("resize", onWindowResize);
    },
  };
}

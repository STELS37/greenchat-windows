// clients/ui/src/screens/composer.ts — the message composer (T-406). DOM-only; every string decision
// (mention parsing, member filtering, send-vs-edit) is delegated to the pure feed_model so this file is
// just wiring: a growing textarea, a reply/edit banner, an @mention autocomplete popup, Enter-to-send
// (Shift+Enter = newline) and a debounced draft callback. It reports high-level intents to the screen
// via callbacks and never talks to the network itself.
import type { I18n } from "../i18n.ts";
import type { ChatMember } from "./types.ts";
import { el, clear } from "../dom.ts";
import { parseMention, filterMembers, applyMention } from "./feed_model.ts";
import { icon } from "../icons.ts";
import type { EmojiPicker, EmojiStorageLike } from "./emoji_picker.ts";
import type { StickerPicker } from "./sticker_picker.ts";

import { voiceNoteStrings } from "./voice_note_strings.ts";

export type ComposerSubmit =
  | { mode: "send"; text: string; replyToId: number | null }
  | { mode: "edit"; text: string; messageId: number };

export interface ComposerDeps {
  i18n: I18n;
  onSubmit: (payload: ComposerSubmit) => void;
  onDraft: (text: string) => void; // debounced persistence of the draft
  members: () => ChatMember[]; // current roster for @mention autocomplete
  onAttach?: (files: FileList) => void; // user picked files via the 📎 button (T-407 attach tray)
  onVoiceNote?: () => void; // open and auto-start the microphone recorder after a long press
  onVideoNote?: () => void; // open and auto-start the camera/microphone recorder after a long press
  hasStaged?: () => boolean; // true while the attach tray holds files → permit an empty-caption send
  draftDebounceMs?: number;
  recordHoldMs?: number; // tests may shorten the Telegram-style long-press threshold
  emojiStorage?: EmojiStorageLike | null | undefined; // recents persistence for the emoji panel (tests inject a fake)
  stickers?: StickerPicker; // installed/recent server-native sticker panel; omitted in media-less shells
}

export interface Composer {
  root: HTMLElement;
  focus(): void;
  isActive(): boolean;
  setText(text: string): void;
  startReply(messageId: number, authorName: string): void;
  startEdit(messageId: number, text: string): void;
  reset(): void;
  refreshAction(): void;
  replyTarget(): number | null;
  destroy(): void;
}

const MENTION_LIMIT = 6;

const insertEmojiAtCaret = (value: string, start: number, end: number, glyph: string): { value: string; caret: number } => {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + glyph + value.slice(to), caret: from + glyph.length };
};

export function createComposer(deps: ComposerDeps): Composer {
  const { i18n } = deps;
  const debounceMs = deps.draftDebounceMs ?? 600;

  const recordHoldMs = deps.recordHoldMs ?? 280;
  const recordText = voiceNoteStrings(i18n.locale);

  let mode: "send" | "edit" = "send";
  let replyToId: number | null = null;
  let editMessageId: number | null = null;
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  type RecordMode = "voice" | "video";
  let recordMode: RecordMode = deps.onVoiceNote ? "voice" : "video";
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdTriggered = false;

  // Mention popup state.
  let mentionOpen = false;
  let mentionItems: ChatMember[] = [];
  let mentionActive = 0;

  const banner = el("div", { class: "gc-composer-banner", hidden: true });
  const textarea = el("textarea", {
    class: "gc-composer-input",
    rows: 1,
    // V113: the visible hint is one word because that is what fits the pill on a 320 dp phone; the
    // ACCESSIBLE name keeps the verb, so a screen reader still announces "Написать сообщение" and
    // the shortening costs a blind user nothing.
    "aria-label": i18n.t("feed.composeLabel"),
    placeholder: i18n.t("feed.placeholder"),
  }) as HTMLTextAreaElement;
  const sendBtn = el("button", {
    type: "button",
    class: "gc-btn gc-btn-accent gc-composer-send",
    title: i18n.t("common.send"),
    "aria-label": i18n.t("common.send"),
  }, [icon("send")]) as HTMLButtonElement;
  const popup = el("ul", { class: "gc-mention-popup", role: "listbox", hidden: true });

  // Attach button + hidden multi-file input (only wired when the shell provides an onAttach handler).
  const fileInput = el("input", { type: "file", class: "gc-composer-file", multiple: true, hidden: true }) as HTMLInputElement;
  const attachBtn = el("button", { type: "button", class: "gc-icon-btn gc-composer-attach", title: i18n.t("media.attach") }, [icon("attach")]);
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files.length > 0) deps.onAttach?.(fileInput.files);
    fileInput.value = ""; // allow re-picking the same file
  });

  // Emoji is a secondary surface and its curated catalogue is several kilobytes. Keep the composer
  // interactive on the first frame and fetch the picker only after the user presses its trigger. This
  // also restores honest headroom to the strict 300 KiB initial-transfer gate without removing emoji.
  const emojiBtn = el("button", {
    type: "button",
    class: "gc-icon-btn gc-composer-emoji",
    title: i18n.t("emoji.title"),
    "aria-label": i18n.t("emoji.title"),
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
  }, [icon("smile")]);
  let emoji: EmojiPicker | null = null;
  let emojiLoad: Promise<EmojiPicker | null> | null = null;
  let emojiActivationPending = false;
  let destroyed = false;

  const syncEmojiBtn = (): void => {
    const opened = emoji?.isOpen() ?? false;
    emojiBtn.setAttribute("aria-expanded", opened ? "true" : "false");
    emojiBtn.classList.toggle("is-active", opened);
  };
  const ensureEmoji = (): Promise<EmojiPicker | null> => {
    if (emoji) return Promise.resolve(emoji);
    if (emojiLoad) return emojiLoad;
    emojiBtn.setAttribute("aria-busy", "true");
    emojiLoad = import("./emoji_picker.ts")
      .then(({ createEmojiPicker }) => {
        if (destroyed) return null;
        const next = createEmojiPicker({
          i18n,
          storage: deps.emojiStorage,
          onOpenChange: (opened) => {
            if (opened) deps.stickers?.close();
            syncEmojiBtn();
          },
          onPick: (glyph) => {
            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? start;
            const nextText = insertEmojiAtCaret(textarea.value, start, end, glyph);
            textarea.value = nextText.value;
            textareaWasEdited = true;
            textarea.setSelectionRange?.(nextText.caret, nextText.caret);
            autosize();
            scheduleDraft();
            syncAction();
            textarea.focus();
          },
        });
        if (destroyed) {
          next.destroy();
          return null;
        }
        emoji = next;
        root.prepend(next.root);
        emojiBtn.setAttribute("aria-controls", next.root.id);
        return next;
      })
      .catch(() => null)
      .finally(() => {
        emojiLoad = null;
        emojiBtn.removeAttribute("aria-busy");
      });
    return emojiLoad;
  };
  emojiBtn.addEventListener("click", () => {
    deps.stickers?.close();
    if (emoji) {
      emoji.toggle();
      return;
    }
    if (emojiActivationPending) return;
    emojiActivationPending = true;
    void ensureEmoji().then((picker) => {
      if (!destroyed) picker?.toggle();
    }).finally(() => {
      emojiActivationPending = false;
    });
  });

  const stickerBtn = deps.stickers
    ? el("button", {
        type: "button",
        class: "gc-icon-btn gc-composer-emoji gc-composer-sticker",
        title: i18n.t("sticker.title"),
        "aria-label": i18n.t("sticker.title"),
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        "aria-controls": deps.stickers.root.id,
      }, [icon("layers")]) as HTMLButtonElement
    : null;
  const syncStickerBtn = (): void => {
    if (!stickerBtn || !deps.stickers) return;
    stickerBtn.setAttribute("aria-expanded", deps.stickers.isOpen() ? "true" : "false");
    stickerBtn.classList.toggle("is-active", deps.stickers.isOpen());
  };
  const unsubscribeSticker = deps.stickers?.subscribeOpenChange(() => syncStickerBtn()) ?? null;
  stickerBtn?.addEventListener("click", () => {
    emoji?.close();
    deps.stickers?.toggle();
  });

  // The attach control lives INSIDE the input pill (Telegram/WhatsApp layout). As a sibling of the
  // pill it stole ~48 px of an already narrow phone row and left the field visually detached from it.
  const inputWrapClasses = [
    "gc-composer-inputwrap",
    "has-emoji",
    deps.onAttach ? "has-attach" : "",
  ].filter(Boolean).join(" ");
  const inputWrap = el("div", { class: inputWrapClasses }, [popup, emojiBtn, ...(stickerBtn ? [stickerBtn] : []), textarea]);
  if (deps.onAttach) inputWrap.append(attachBtn, fileInput);
  const rowKids: HTMLElement[] = [inputWrap, sendBtn];
  const root = el("div", { class: "gc-composer" }, [
    banner,
    ...(deps.stickers ? [deps.stickers.root] : []),
    el("div", { class: "gc-composer-row" }, rowKids),
  ]);

  // ---- draft debounce ----
  const scheduleDraft = (): void => {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = null; deps.onDraft(textarea.value); }, debounceMs);
  };
  const flushDraft = (): void => {
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
  };

  // ---- Telegram-style send / microphone / video-note action ----
  const hasRecordingAction = (): boolean => !!(deps.onVoiceNote || deps.onVideoNote);
  const shouldSend = (): boolean =>
    mode === "edit" || textarea.value.trim().length > 0 || (deps.hasStaged?.() ?? false);
  const recordHandler = (): (() => void) | undefined =>
    recordMode === "voice" ? deps.onVoiceNote : deps.onVideoNote;
  const normalizeRecordMode = (): void => {
    if (recordMode === "voice" && !deps.onVoiceNote && deps.onVideoNote) recordMode = "video";
    if (recordMode === "video" && !deps.onVideoNote && deps.onVoiceNote) recordMode = "voice";
  };
  const clearHold = (): void => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    sendBtn.classList.remove("is-holding");
  };
  const syncAction = (): void => {
    normalizeRecordMode();
    const send = shouldSend() || !hasRecordingAction();
    const handler = recordHandler();
    const glyph = send ? "send" : recordMode === "voice" ? "mic" : "video";
    const title = send
      ? i18n.t("common.send")
      : recordMode === "voice" ? recordText.voiceModeHint : recordText.videoModeHint;
    clear(sendBtn);
    sendBtn.append(icon(glyph));
    sendBtn.title = title;
    sendBtn.setAttribute("aria-label", title);
    sendBtn.dataset.action = send ? "send" : recordMode;
    sendBtn.classList.toggle("is-record-mode", !send);
    sendBtn.disabled = !send && !handler;
  };
  const toggleRecordMode = (): void => {
    if (deps.onVoiceNote && deps.onVideoNote) {
      recordMode = recordMode === "voice" ? "video" : "voice";
      syncAction();
      return;
    }
    recordHandler()?.();
  };
  const beginHold = (): void => {
    if (shouldSend() || !recordHandler()) return;
    clearHold();
    holdTriggered = false;
    sendBtn.classList.add("is-holding");
    holdTimer = setTimeout(() => {
      holdTimer = null;
      sendBtn.classList.remove("is-holding");
      holdTriggered = true;
      emoji?.close();
      deps.stickers?.close();
      recordHandler()?.();
    }, recordHoldMs);
  };

  // ---- growing textarea ----
  // A one-line composer keeps the compact Telegram-style rail. As soon as the text wraps, that rail
  // becomes the defect shown on Android: emoji + stickers + attachments consume most of the width,
  // so the message is rendered as a narrow vertical column with a full-height native scrollbar.
  // Measure in the compact state, then let the CSS expansion layer give the text the complete pill
  // width and move secondary actions to a bottom toolbar. The height cap remains a CSS decision.
  const autosize = (): void => {
    inputWrap.classList.remove("is-expanded");
    textarea.style.height = "auto";

    const compactViewport = textarea.clientHeight;
    const compactContent = textarea.scrollHeight;
    const expanded = compactViewport > 0
      ? compactContent > compactViewport + 1
      : textarea.value.includes("\n");

    inputWrap.classList.toggle("is-expanded", expanded);
    // The expanded state changes padding (it reserves the bottom action rail), so measure once more
    // after the class switch instead of reusing the compact scrollHeight.
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  // ---- mention popup ----
  const closeMention = (): void => {
    mentionOpen = false;
    mentionItems = [];
    popup.hidden = true;
    clear(popup);
  };

  const renderMention = (): void => {
    clear(popup);
    mentionItems.forEach((m, i) => {
      const row = el("li", {
        class: i === mentionActive ? "gc-mention-row is-active" : "gc-mention-row",
        role: "option",
        "aria-selected": i === mentionActive,
      }, [el("span", { class: "gc-mention-name" }, [m.name]), el("span", { class: "gc-mention-user" }, [`@${m.username}`])]);
      row.addEventListener("mousedown", (e) => { e.preventDefault(); pickMention(i); });
      popup.append(row);
    });
    popup.hidden = mentionItems.length === 0;
  };

  const refreshMention = (): void => {
    const caret = textarea.selectionStart ?? textarea.value.length;
    const mq = parseMention(textarea.value, caret);
    if (!mq.active) { closeMention(); return; }
    mentionItems = filterMembers(deps.members(), mq.query, MENTION_LIMIT);
    if (mentionItems.length === 0) { closeMention(); return; }
    mentionOpen = true;
    mentionActive = 0;
    renderMention();
  };

  const pickMention = (index: number): void => {
    const member = mentionItems[index];
    if (!member) return;
    const caret = textarea.selectionStart ?? textarea.value.length;
    const mq = parseMention(textarea.value, caret);
    if (!mq.active) { closeMention(); return; }
    const next = applyMention(textarea.value, mq, member.username);
    textarea.value = next.text;
    textarea.setSelectionRange(next.caret, next.caret);
    closeMention();
    autosize();
    textarea.focus();
    scheduleDraft();
    syncAction();
  };

  // ---- banner (reply / edit) ----
  const renderBanner = (): void => {
    clear(banner);
    if (mode === "send" && replyToId === null) { banner.hidden = true; return; }
    const label = mode === "edit"
      ? i18n.t("feed.editing")
      : i18n.t("feed.replyingTo", { name: bannerName });
    const closeBtn = el("button", { type: "button", class: "gc-icon-btn gc-composer-banner-x", title: i18n.t("common.cancel") }, [icon("close")]);
    closeBtn.addEventListener("click", () => { cancelContext(); textarea.focus(); });
    banner.append(el("span", { class: "gc-composer-banner-text" }, [label]), closeBtn);
    banner.hidden = false;
  };
  let bannerName = "";

  const cancelContext = (): void => {
    mode = "send";
    replyToId = null;
    editMessageId = null;
    bannerName = "";
    if (textareaWasEdited) { textarea.value = ""; textareaWasEdited = false; autosize(); }
    renderBanner();
    syncAction();
  };
  let textareaWasEdited = false;

  // ---- submit ----
  const submit = (): void => {
    const text = textarea.value.trim();
    if (mode === "edit" && editMessageId !== null) {
      if (text.length === 0) return; // an empty edit is a delete elsewhere; ignore here
      deps.onSubmit({ mode: "edit", text, messageId: editMessageId });
    } else {
      const staged = deps.hasStaged?.() ?? false;
      if (text.length === 0 && !staged) return; // nothing to send (and no staged attachments)
      deps.onSubmit({ mode: "send", text, replyToId });
    }
    flushDraft();
    emoji?.close();
    reset();
  };

  // ---- events ----
  const onKeyDown = (e: KeyboardEvent): void => {
    if (mentionOpen) {
      if (e.key === "ArrowDown") { e.preventDefault(); mentionActive = (mentionActive + 1) % mentionItems.length; renderMention(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mentionActive = (mentionActive - 1 + mentionItems.length) % mentionItems.length; renderMention(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionActive); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMention(); return; }
    }
    if (e.key === "Escape" && emoji?.isOpen()) { e.preventDefault(); emoji?.close(); return; }
    if (e.key === "Escape" && deps.stickers?.isOpen()) { e.preventDefault(); deps.stickers.close(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); return; }
    if (e.key === "Escape" && (mode === "edit" || replyToId !== null)) { e.preventDefault(); cancelContext(); }
  };

  const onInput = (): void => {
    textareaWasEdited = true;
    autosize();
    refreshMention();
    scheduleDraft();
    syncAction();
  };

  textarea.addEventListener("keydown", onKeyDown);
  textarea.addEventListener("input", onInput);
  textarea.addEventListener("blur", () => { flushDraft(); deps.onDraft(textarea.value); });
  sendBtn.addEventListener("pointerdown", () => beginHold());
  sendBtn.addEventListener("pointerup", () => clearHold());
  sendBtn.addEventListener("pointercancel", () => clearHold());
  sendBtn.addEventListener("pointerleave", () => clearHold());
  sendBtn.addEventListener("contextmenu", (event) => {
    if (!shouldSend()) event.preventDefault();
  });
  sendBtn.addEventListener("click", () => {
    if (holdTriggered) { holdTriggered = false; return; }
    if (shouldSend() || !hasRecordingAction()) {
      submit();
      textarea.focus();
      return;
    }
    toggleRecordMode();
  });

  // ---- public API ----
  const reset = (): void => {
    mode = "send";
    replyToId = null;
    editMessageId = null;
    bannerName = "";
    textareaWasEdited = false;
    textarea.value = "";
    autosize();
    closeMention();
    renderBanner();
    syncAction();
  };

  renderBanner();
  syncAction();

  return {
    root,
    focus() { textarea.focus(); },
    // "Active" = the user is engaged with LOCAL editing (focused or carrying locally changed text).
    // Programmatic/server drafts are deliberately not marked edited: otherwise a remote draft received
    // while blurred would block the next remote clear forever.
    isActive() { return document.activeElement === textarea || (textareaWasEdited && textarea.value.length > 0); },
    setText(text: string) { textarea.value = text; textareaWasEdited = false; autosize(); syncAction(); },
    startReply(messageId: number, authorName: string) {
      mode = "send";
      editMessageId = null;
      replyToId = messageId;
      bannerName = authorName;
      renderBanner();
      syncAction();
      textarea.focus();
    },
    startEdit(messageId: number, text: string) {
      mode = "edit";
      replyToId = null;
      editMessageId = messageId;
      bannerName = "";
      textarea.value = text;
      textareaWasEdited = true;
      renderBanner();
      autosize();
      syncAction();
      textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
    },
    reset,
    refreshAction: syncAction,
    replyTarget() { return replyToId; },
    destroy() {
      flushDraft();
      clearHold();
      unsubscribeSticker?.();
      deps.stickers?.destroy();
      destroyed = true;
      emoji?.destroy();
    },
  };
}

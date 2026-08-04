// clients/ui/src/screens/emoji_picker.ts — the composer emoji panel (UI redesign V7).
//
// Why this exists: the composer shipped with an attach button and a send button only, so the single most
// used control of any messenger — picking an emoji — required the OS keyboard. On desktop web there is no
// OS emoji keyboard at all, which made emoji effectively unreachable.
//
// Design constraints kept from the rest of the client:
//   • no external dependency and no network font — the catalog is a plain inline table (a few KB);
//   • the two decisions worth testing (recent-list bookkeeping, caret insertion) are PURE functions,
//     unit-tested in node; the rest of the file is DOM wiring;
//   • persistence is an injectable narrow storage (localStorage in the browser, a fake in tests).
import type { I18n } from "../i18n.ts";
import { el, clear } from "../dom.ts";
import { nextIndex } from "../a11y.ts";

// The 2 methods we need off a Web Storage — narrowed so it is trivially fakeable.
export interface EmojiStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EmojiGroup {
  key: string; // i18n key suffix: emoji.<key>
  emojis: readonly string[];
}

export const RECENT_MAX = 24;
const RECENT_KEY = "gc.emoji.recent";

// Curated catalog. Deliberately conservative: only emoji that render as a single glyph on Android,
// iOS, Windows and the common Linux fonts (no ZWJ families, no skin-tone sequences, no flags).
export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    key: "smileys",
    emojis: [
      "😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊",
      "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙", "😋", "😛", "😜", "🤪",
      "😝", "🤑", "🤗", "🤭", "🤫", "🤔", "🤐", "🤨", "😐", "😑", "😶", "😏",
      "😒", "🙄", "😬", "😌", "😔", "😪", "🤤", "😴", "😷", "🤒", "🤕", "🤢",
      "🥵", "🥶", "😵", "🤯", "🤠", "🥳", "😎", "🤓", "🧐", "😕", "😟", "🙁",
      "😮", "😯", "😲", "😳", "🥺", "😦", "😨", "😰", "😥", "😢", "😭", "😱",
      "😖", "😣", "😞", "😓", "😩", "😫", "🥱", "😤", "😡", "😠", "🤬", "😈",
      "💀", "💩", "🤡", "👻", "👽", "🤖",
    ],
  },
  {
    key: "gestures",
    emojis: [
      "👍", "👎", "👌", "🤌", "✌️", "🤞", "🤟", "🤘", "🤙", "👈", "👉", "👆",
      "👇", "☝️", "✋", "🤚", "🖐️", "🖖", "👋", "🤝", "🙏", "✍️", "💪", "🦾",
      "👏", "🙌", "👐", "🤲", "🫶", "👀", "👁️", "🧠", "🦵", "🦶", "👂", "👃",
    ],
  },
  {
    key: "hearts",
    emojis: [
      "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💔", "❣️", "💕",
      "💞", "💓", "💗", "💖", "💘", "💝", "💟", "💋", "💯", "💢", "💥", "💫",
      "💦", "💨", "🔥", "✨", "⭐", "🌟", "⚡", "🎉", "🎊", "🎈", "🎁", "🏆",
    ],
  },
  {
    key: "animals",
    emojis: [
      "🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐮",
      "🐷", "🐸", "🐵", "🙈", "🙉", "🙊", "🐔", "🐧", "🐦", "🐤", "🦆", "🦉",
      "🦄", "🐝", "🐛", "🦋", "🐌", "🐞", "🐢", "🐍", "🐙", "🦀", "🐳", "🐬",
      "🐟", "🦈", "🌵", "🌲", "🌳", "🌴", "🌱", "🍀", "🌸", "🌺", "🌻", "🌹",
    ],
  },
  {
    key: "food",
    emojis: [
      "🍏", "🍎", "🍐", "🍊", "🍋", "🍌", "🍉", "🍇", "🍓", "🍒", "🍑", "🥭",
      "🍍", "🥥", "🥝", "🍅", "🥑", "🥦", "🥕", "🌽", "🥔", "🍞", "🥐", "🥨",
      "🧀", "🥚", "🍳", "🥞", "🥓", "🍔", "🍟", "🍕", "🌭", "🌮", "🌯", "🥗",
      "🍜", "🍣", "🍤", "🍦", "🍩", "🍪", "🎂", "🍰", "🍫", "🍬", "☕", "🍵",
      "🍺", "🍻", "🥂", "🍷", "🥤", "🧊",
    ],
  },
  {
    key: "activity",
    emojis: [
      "⚽", "🏀", "🏈", "⚾", "🎾", "🏐", "🏓", "🏸", "🥊", "🏋️", "🚴", "🏊",
      "🎿", "🎯", "🎮", "🎲", "🎸", "🎹", "🎺", "🎧", "🎬", "🎤", "🥁", "🏁",
      "🚗", "🚕", "🚌", "🚑", "🚒", "🚜", "🏍️", "✈️", "🚀", "🛸", "⛵", "🚢",
      "🏝️", "🏔️", "🌋", "🏕️", "🌍", "🌙", "☀️", "☁️", "🌧️", "❄️", "🌈", "🕐",
    ],
  },
  {
    key: "objects",
    emojis: [
      "📱", "💻", "⌨️", "🖥️", "🖨️", "🖱️", "💾", "💿", "📷", "📹", "🔋", "🔌",
      "💡", "🔦", "📡", "🔍", "🔒", "🔓", "🔑", "🔨", "🧰", "⚙️", "🧲", "💰",
      "💳", "💵", "📦", "📫", "📝", "📄", "📊", "📈", "📉", "📌", "📎", "✂️",
      "📚", "🔔", "⏰", "⌛", "🎓", "🩺", "💊", "🧪", "🛒", "🧭", "🗝️", "🪪",
    ],
  },
  {
    key: "symbols",
    emojis: [
      "✅", "❌", "❗", "❓", "⚠️", "🚫", "♻️", "🔄", "🔝", "🆗", "🆕", "🔀",
      "™️", "©️", "®️", "➕", "➖", "➗", "✖️", "💲", "🔴", "🟠", "🟡", "🟢",
      "🔵", "🟣", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩", "🟦", "🟪", "⬛", "⬜",
    ],
  },
] as const;

// ---- pure logic (unit-tested) --------------------------------------------------------------

// Move `emoji` to the front of the recents, dropping any earlier copy, capped at `max`.
export function pushRecent(list: readonly string[], emoji: string, max: number = RECENT_MAX): string[] {
  const next = [emoji, ...list.filter((e) => e !== emoji)];
  return next.slice(0, Math.max(0, max));
}

// Splice `insert` into `value` over the [start,end) selection; returns the new text and caret offset.
export function insertAtCaret(
  value: string,
  start: number,
  end: number,
  insert: string,
): { value: string; caret: number } {
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  return { value: value.slice(0, from) + insert + value.slice(to), caret: from + insert.length };
}

// How many glyphs sit in one visual row, read back out of the layout the browser produced.
//
// The grid is `grid-template-columns: repeat(auto-fill, minmax(44px, 1fr))`, so the column count
// depends on the rendered width of the panel and is simply not knowable from this file. ArrowUp and
// ArrowDown have to step by a row, and the only honest source for the size of a row is where the
// browser actually put the cells — hence a list of offsetTop values in DOM order.
//
// Two shapes mean "no row to step by": nothing measured (a detached or `display:none` grid reports
// nothing usable) and every cell on the same line. Both answer 1, which turns Down into Right — the
// plain one-dimensional listbox the `role="listbox"` on the grid already promises, and exactly right
// for a grid that genuinely is one row.
export function rowStride(tops: readonly (number | undefined)[]): number {
  const first = tops[0];
  if (typeof first !== "number" || !Number.isFinite(first)) return 1;
  let n = 0;
  while (n < tops.length) {
    const top = tops[n];
    if (typeof top !== "number" || !Number.isFinite(top) || top !== first) break;
    n += 1;
  }
  return n >= tops.length ? 1 : Math.max(1, n);
}

// Parse a persisted recents payload defensively: anything that is not an array of short strings is
// treated as "no recents" rather than throwing into the composer.
export function parseRecents(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string" && e.length > 0 && e.length <= 8).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

// ---- DOM panel -------------------------------------------------------------------------------

export interface EmojiPickerDeps {
  i18n: I18n;
  onPick: (emoji: string) => void;
  storage?: EmojiStorageLike | null | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined; // lets the owner keep its trigger button in sync (aria-expanded)
}

export interface EmojiPicker {
  root: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  recents(): string[];
  destroy(): void;
}

function defaultStorage(): EmojiStorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // privacy mode / disabled storage
  }
}

// Unique per panel so the trigger button can point `aria-controls` at the thing it expands. Two
// composers can exist at once (a chat behind an open forward sheet), so a fixed id would lie.
let panelSeq = 0;

export function createEmojiPicker(deps: EmojiPickerDeps): EmojiPicker {
  const { i18n } = deps;
  const storage = deps.storage === undefined ? defaultStorage() : deps.storage;
  let recent: string[] = parseRecents(storage ? safeGet(storage, RECENT_KEY) : null);
  let open = false;
  let activeGroup = recent.length > 0 ? "recent" : EMOJI_GROUPS[0]!.key;
  // Which glyph the roving tabindex is parked on, and the column count read back from the layout.
  // Both belong to the group currently painted, so both reset when the grid is repainted.
  let activeCell = 0;
  let stride: number | null = null;
  // Where the caret came from, so close() can put it back. Captured at open(), not at construction:
  // the panel outlives any one opening.
  let restoreTo: { focus?: () => void } | null = null;

  const panelId = `gc-emoji-panel-${++panelSeq}`;
  const gridId = `${panelId}-grid`;

  const grid = el("div", { id: gridId, class: "gc-emoji-grid", role: "listbox", "aria-label": i18n.t("emoji.title") });
  // No `aria-label` on the strip, deliberately. A name for it would need a new locale string, and both
  // locale files are held by another lane mid-change (wallet tile naming) — `i18n.t()` returns the key
  // itself on a miss, so reaching for one now would have shipped the literal "emoji.categories" as an
  // accessible name. The tabs pattern says a tablist SHOULD be named; it is not required, every tab
  // inside is individually named, and the dialog around it already announces "Emoji". A named strip is
  // a one-line follow-up once the locale files are free.
  const tabs = el("div", { class: "gc-emoji-tabs", role: "tablist" });
  // V155: `aria-modal` is stated rather than implied. This panel is deliberately NOT modal — the
  // message field behind it stays live so a person can keep typing — which is exactly what separates
  // it from the sheets V152/V153 made modal, and a reader should not have to infer that from silence.
  const root = el("div", {
    id: panelId,
    class: "gc-emoji-panel",
    hidden: true,
    role: "dialog",
    "aria-modal": false,
    "aria-label": i18n.t("emoji.title"),
  }, [grid, tabs]);

  const groupEmojis = (key: string): readonly string[] =>
    key === "recent" ? recent : (EMOJI_GROUPS.find((g) => g.key === key)?.emojis ?? []);

  const groupKeys = (): string[] => [
    ...(recent.length > 0 ? ["recent"] : []),
    ...EMOJI_GROUPS.map((g) => g.key),
  ];

  const cells = (): HTMLElement[] => Array.from(grid.querySelectorAll<HTMLElement>(".gc-emoji-cell"));
  const tabButtons = (): HTMLElement[] => Array.from(tabs.querySelectorAll<HTMLElement>(".gc-emoji-tab"));

  const activeNode = (): HTMLElement | null =>
    typeof document === "undefined" ? null : ((document.activeElement as HTMLElement | null) ?? null);

  const paintGrid = (): void => {
    clear(grid);
    stride = null; // the new group may not wrap the same way; re-read it when an arrow first asks
    const list = groupEmojis(activeGroup);
    if (list.length === 0) {
      grid.append(el("p", { class: "gc-emoji-empty" }, [i18n.t("emoji.emptyRecent")]));
      return;
    }
    if (activeCell >= list.length) activeCell = list.length - 1;
    list.forEach((emoji, index) => {
      // Roving tabindex. Before V155 every glyph was a native <button>, i.e. its own tab stop: an open
      // panel turned a 3-stop composer into a 101-stop corridor, and because the panel is mounted
      // before the row holding its button, all 98 extra stops sat BEHIND the trigger. A listbox is one
      // stop; the arrows move inside it.
      const cell = el("button", {
        type: "button",
        class: "gc-emoji-cell",
        role: "option",
        tabindex: index === activeCell ? "0" : "-1",
        "aria-selected": index === activeCell,
        "aria-label": emoji,
      }, [emoji]);
      cell.addEventListener("click", () => {
        focusCell(index);
        pick(emoji);
      });
      grid.append(cell);
    });
  };

  const paintTabs = (): void => {
    clear(tabs);
    for (const key of groupKeys()) {
      const label = i18n.t(`emoji.${key}`);
      const selected = key === activeGroup;
      const btn = el("button", {
        type: "button",
        class: selected ? "gc-emoji-tab is-active" : "gc-emoji-tab",
        role: "tab",
        // Same roving ring as the grid: the strip costs the Tab key one stop, and it is the SELECTED
        // tab, so Tab lands on the category the person is already in rather than at the far left.
        tabindex: selected ? "0" : "-1",
        "aria-selected": selected,
        // The grid below is what this tab reveals, and naming it lets a screen reader jump straight
        // there instead of hunting. ARIA lets an element hold one role and the grid's is `listbox` —
        // ninety selectable glyphs, which is what a person needs to navigate — so this is a tab that
        // controls a listbox rather than a tabpanel. The relation is real and the target id exists;
        // silence would have been the only alternative.
        "aria-controls": gridId,
        title: label,
        "aria-label": label,
      }, [key === "recent" ? "🕐" : (groupEmojis(key)[0] ?? "•")]);
      btn.addEventListener("click", () => selectGroup(key, false));
      tabs.append(btn);
    }
  };

  // Park the roving stop on one glyph and take the caret there.
  const focusCell = (index: number): void => {
    const list = cells();
    if (list.length === 0) return;
    const target = Math.min(list.length - 1, Math.max(0, index));
    activeCell = target;
    list.forEach((cell, i) => {
      cell.setAttribute("tabindex", i === target ? "0" : "-1");
      cell.setAttribute("aria-selected", i === target ? "true" : "false");
    });
    list[target]!.focus();
  };

  // Switch category. `viaKeyboard` re-seats the caret on the REPLACEMENT tab: paintTabs() rebuilds the
  // whole strip, so the node the caret was standing on is discarded — before V155 that alone dropped
  // the caret on <body> every time a category was chosen with a keyboard.
  const selectGroup = (key: string, viaKeyboard: boolean): void => {
    activeGroup = key;
    activeCell = 0;
    paintTabs();
    paintGrid();
    if (!viaKeyboard) return;
    tabButtons()[groupKeys().indexOf(key)]?.focus();
  };

  // Glyphs per visual row, read back from the layout because `repeat(auto-fill, …)` makes it a
  // rendered-width fact rather than a source fact. Cached until the next repaint: an arrow key must
  // not force a fresh layout of ninety nodes on every press.
  const columns = (): number => {
    if (stride === null) {
      stride = rowStride(cells().map((cell) => (cell as { offsetTop?: number }).offsetTop));
    }
    return stride;
  };

  // Arrows are handled on the PANEL, never on the document. While the picker is open the caret may
  // equally be in the message field behind it — the panel is non-modal on purpose — so a document-level
  // arrow handler would steal the caret keys of a textarea somebody is still typing in.
  const onPanelKey = (event: Event): void => {
    if (!open) return;
    const key = (event as KeyboardEvent).key;
    if (!key) return;
    const here = activeNode();
    const claim = (): void => event.preventDefault?.();

    if (tabs.contains(here)) {
      const keys = groupKeys();
      const at = tabButtons().indexOf(here as HTMLElement);
      if (at < 0) return;
      // Horizontal tabs, and the WAI-ARIA tabs pattern wraps. Selection follows the arrow: automatic
      // activation is what the pattern recommends when revealing the panel is cheap, and repainting a
      // grid of buttons is.
      if (key === "ArrowRight" || key === "ArrowLeft") {
        claim();
        selectGroup(keys[nextIndex(at, keys.length, key === "ArrowRight" ? 1 : -1)]!, true);
        return;
      }
      if (key === "Home" || key === "End") {
        claim();
        selectGroup(keys[key === "Home" ? 0 : keys.length - 1]!, true);
      }
      return;
    }

    if (!grid.contains(here)) return;
    const list = cells();
    const at = list.indexOf(here as HTMLElement);
    if (at < 0) return;
    // A listbox does not wrap: running off the end of a ninety-glyph group and reappearing at the
    // other end is disorienting, and Home/End are the way to the ends.
    if (key === "ArrowRight" || key === "ArrowLeft") {
      claim();
      focusCell(nextIndex(at, list.length, key === "ArrowRight" ? 1 : -1, false));
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      claim();
      const step = columns();
      focusCell(nextIndex(at, list.length, key === "ArrowDown" ? step : -step, false));
      return;
    }
    if (key === "Home" || key === "End") {
      claim();
      focusCell(key === "Home" ? 0 : list.length - 1);
    }
  };
  root.addEventListener("keydown", onPanelKey);

  const pick = (emoji: string): void => {
    recent = pushRecent(recent, emoji);
    if (storage) safeSet(storage, RECENT_KEY, JSON.stringify(recent));
    // Repaint the tab strip only when the "recent" tab had to appear; repainting the open grid while
    // the user is tapping would make the glyphs jump under the finger.
    if (activeGroup !== "recent") paintTabs();
    deps.onPick(emoji);
  };

  const onDocKey = (event: { key?: string }): void => {
    if (open && event.key === "Escape") api.close();
  };
  const docRef = typeof document !== "undefined" ? document : null;
  docRef?.addEventListener?.("keydown", onDocKey as EventListener);

  const api: EmojiPicker = {
    root,
    open(): void {
      if (open) return;
      open = true;
      // Captured before anything is painted or focused, so close() knows where the person came from.
      restoreTo = activeNode();
      if (activeGroup === "recent" && recent.length === 0) activeGroup = EMOJI_GROUPS[0]!.key;
      paintTabs();
      paintGrid();
      root.hidden = false;
      root.classList.add("is-open");
      deps.onOpenChange?.(true);
      // Only now: a browser refuses to focus a node inside a `display: none` subtree, and the panel is
      // exactly that until `hidden` comes off one line above. The trigger says aria-haspopup="dialog"
      // and this says role="dialog"; a dialog that never takes the caret is announced and then never
      // arrives — which is what shipped until V155.
      const first = cells()[0] ?? tabButtons()[groupKeys().indexOf(activeGroup)];
      first?.focus();
    },
    close(): void {
      if (!open) return;
      open = false;
      // Read the caret BEFORE hiding. `.gc-emoji-panel[hidden] { display: none }`, so the instant the
      // attribute goes on, a browser blurs whatever descendant was focused and drops the caret on
      // <body> — after that there is nothing left to ask.
      const wasInside = root.contains(activeNode());
      root.hidden = true;
      root.classList.remove("is-open");
      deps.onOpenChange?.(false);
      // Hand the caret back only if it was ours. Sending a message closes this panel with the caret in
      // the message field (composer.ts submit(), and its Escape handler); yanking it to the emoji
      // button then would be a new bug of exactly the kind this change exists to remove.
      if (wasInside) restoreTo?.focus?.();
      restoreTo = null;
    },
    toggle(): void {
      if (open) api.close();
      else api.open();
    },
    isOpen: () => open,
    recents: () => [...recent],
    destroy(): void {
      api.close();
      docRef?.removeEventListener?.("keydown", onDocKey as EventListener);
      root.removeEventListener("keydown", onPanelKey);
      restoreTo = null;
      clear(grid);
      clear(tabs);
    },
  };
  return api;
}

function safeGet(storage: EmojiStorageLike, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: EmojiStorageLike, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    /* quota / privacy mode: recents are a convenience, never a hard dependency */
  }
}

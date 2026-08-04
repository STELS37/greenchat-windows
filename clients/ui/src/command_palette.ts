// clients/ui/src/command_palette.ts — Ctrl+K command palette (T-404, PRODUCT_UX §2 п.16).
// filterCommands is a pure, deterministic ranker (unit-tested). CommandPalette is a lazy DOM overlay
// that reuses filterCommands + a focus trap; all text is rendered via textContent (dom.ts).

import { el, clear } from "./dom.ts";
import { createFocusTrap, nextIndex, type FocusTrap } from "./a11y.ts";
import type { KeyEventLike } from "./shortcuts.ts";

export interface Command {
  id: string;
  title: string;
  keywords?: string[];
  section?: string;
  run: () => void;
}

function score(command: Command, q: string): number {
  const title = command.title.toLowerCase();
  if (q.length === 0) return 1;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  // word-boundary start
  if (title.split(/\s+/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 40;
  if (command.keywords?.some((k) => k.toLowerCase().includes(q))) return 20;
  return 0;
}

// Rank commands for a query. Empty query → all commands in original order. Otherwise: matches only,
// sorted by score desc, ties broken by original order (stable).
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...commands];
  const scored = commands
    .map((command, i) => ({ command, i, s: score(command, q) }))
    .filter((x) => x.s > 0);
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return scored.map((x) => x.command);
}

export interface CommandPaletteOptions {
  commands: () => Command[];
  placeholder?: string;
  emptyText?: string;
}

// Lazy DOM overlay. Constructed once; open()/close() toggle it. Arrow keys move the active row,
// Enter runs it, Escape closes. Never touches the DOM until open() is called in a browser.
export class CommandPalette {
  private readonly getCommands: () => Command[];
  private readonly placeholder: string;
  private readonly emptyText: string;
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private results: Command[] = [];
  private active = 0;
  private trap: FocusTrap | null = null;
  private open = false;

  constructor(options: CommandPaletteOptions) {
    this.getCommands = options.commands;
    this.placeholder = options.placeholder ?? "";
    this.emptyText = options.emptyText ?? "";
  }

  get isOpen(): boolean { return this.open; }

  toggle(): void { this.open ? this.close() : this.show(); }

  show(): void {
    if (this.open) return;
    this.build();
    this.open = true;
    this.overlay!.style.display = "flex";
    this.results = filterCommands(this.getCommands(), "");
    this.active = 0;
    this.renderList();
    this.input!.value = "";
    // activate() FIRST: it records where the caret came from and then moves it to the query box
    // (initialFocus below). Focusing the input by hand first made the palette remember its own input
    // as "the screen behind", so close() handed the caret to a hidden node and the keyboard was lost
    // to the page root — measured in V152, and the reason Ctrl+K then Escape stranded the person.
    this.trap?.activate();
  }

  close(): void {
    if (!this.open || !this.overlay) return;
    this.open = false;
    this.overlay.style.display = "none";
    this.trap?.release();
  }

  private build(): void {
    if (this.overlay) return;
    this.input = el("input", {
      type: "text",
      class: "gc-palette-input",
      placeholder: this.placeholder,
      "aria-label": this.placeholder,
      autocomplete: "off",
      spellcheck: false,
    });
    this.listEl = el("div", { class: "gc-palette-list", role: "listbox" });
    const panel = el("div", { class: "gc-palette-panel", role: "dialog", "aria-modal": true }, [
      this.input,
      this.listEl,
    ]);
    this.overlay = el("div", { class: "gc-palette-overlay" }, [panel]);
    this.overlay.style.display = "none";

    this.input.addEventListener("input", () => {
      this.results = filterCommands(this.getCommands(), this.input!.value);
      this.active = 0;
      this.renderList();
    });
    this.overlay.addEventListener("keydown", (e: Event) => this.onKey(e as unknown as KeyEventLike & { preventDefault(): void }));
    this.overlay.addEventListener("mousedown", (e: Event) => {
      if (e.target === this.overlay) this.close();
    });
    // The query box is the exception to the "focus the dialog itself" default: typing IS the palette's
    // primary action, and nothing here is destructive on Enter.
    this.trap = createFocusTrap(panel, { initialFocus: () => this.input });
    document.body.appendChild(this.overlay);
  }

  private onKey(e: KeyEventLike & { preventDefault(): void }): void {
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); this.active = nextIndex(this.active, this.results.length, 1); this.renderList(); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); this.active = nextIndex(this.active, this.results.length, -1); this.renderList(); return; }
    if (e.key === "Enter") { e.preventDefault(); this.runActive(); return; }
  }

  private runActive(): void {
    const cmd = this.results[this.active];
    if (!cmd) return;
    this.close();
    cmd.run();
  }

  private renderList(): void {
    if (!this.listEl) return;
    clear(this.listEl);
    if (this.results.length === 0) {
      this.listEl.append(el("div", { class: "gc-palette-empty" }, [this.emptyText]));
      return;
    }
    this.results.forEach((cmd, i) => {
      const row = el("div", {
        class: i === this.active ? "gc-palette-row is-active" : "gc-palette-row",
        role: "option",
        "aria-selected": i === this.active,
      }, [cmd.title]);
      row.addEventListener("mousedown", (e: Event) => { e.preventDefault(); this.active = i; this.runActive(); });
      this.listEl!.append(row);
    });
  }

  destroy(): void {
    this.close();
    this.overlay?.remove();
    this.overlay = null;
  }
}

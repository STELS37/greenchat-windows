export class StubNode {
  attrs: Record<string, string> = {};
  children: StubNode[] = [];
  parent: StubNode | null = null;
  listeners: Record<string, Array<(event: Record<string, unknown>) => void>> =
    {};
  // A CSSStyleDeclaration, not a bag of strings: the client styles through the CSSOM because CSP
  // `style-src 'self'` refuses `style="…"` attributes (V84), and custom properties can only be
  // written with setProperty. A stub without it turns a real code path into a TypeError.
  style: Record<string, string> & {
    setProperty(name: string, value: string): void;
    getPropertyValue(name: string): string;
    removeProperty(name: string): void;
  } = Object.assign(Object.create(null) as Record<string, string>, {
    setProperty(this: Record<string, string>, name: string, value: string): void {
      this[name] = value;
    },
    getPropertyValue(this: Record<string, string>, name: string): string {
      return this[name] ?? "";
    },
    removeProperty(this: Record<string, string>, name: string): void {
      delete this[name];
    },
  });
  value = "";
  checked = false;
  // Scroll geometry. The stub lays nothing out, so `clientHeight`/`clientWidth` hold the numbers a
  // browser would have measured and are written by the test that needs them. VirtualList drives its
  // window from container.scrollTop/clientHeight and the chat list decides where a freshly filtered
  // list starts (V162), so without them a harness could not express "the search results begin at the
  // first match" at all.
  clientHeight = 0;
  clientWidth = 0;

  // scrollTop CLAMPS, exactly as every browser does, because the clamp is the defect. Measured in
  // headless Chromium: a reader 3000px down a 100-row list types a query that leaves 20 rows, the
  // content becomes 1440px tall and the offset silently becomes 800 — a number nobody chose, which
  // reads as a position somebody did. A stub that stored 3000 unchanged would have let a fix that
  // saves the offset one line too late look correct here and lose the reader's place on a phone;
  // that is precisely what the first attempt at V162 did.
  //
  // The clamp is applied on READ as well as on write, and that is the important half: the browser
  // re-clamps when the CONTENT shrinks, not when someone assigns, so `scrollTop` read after the list
  // was refilled already answers with the leftover. Clamping only on assignment modelled a browser
  // that does not exist, and the late-save bug passed under it.
  //
  // With no content height declared there is nothing to clamp against, so an unmeasured stub keeps
  // the raw value (a test that never states a viewport is not making a claim about scrolling).
  private scrollTopValue = 0;
  private clampScroll(value: number): number {
    const wanted = Math.max(0, Number.isFinite(value) ? value : 0);
    const height = this.scrollHeight;
    if (height <= 0) return wanted;
    return Math.min(wanted, Math.max(0, height - this.clientHeight));
  }
  get scrollTop(): number {
    this.scrollTopValue = this.clampScroll(this.scrollTopValue);
    return this.scrollTopValue;
  }
  set scrollTop(value: number) {
    this.scrollTopValue = this.clampScroll(value);
  }

  // The content height of the scroll box. A layout-free stub can only know a height somebody wrote
  // down, so it is the tallest explicit `style.height` among the children — which is exactly how
  // VirtualList states it (the sizer carries the full list height while only a window is rendered).
  // An explicit assignment wins, for tests that model a scroller some other way.
  private explicitScrollHeight = 0;
  get scrollHeight(): number {
    if (this.explicitScrollHeight > 0) return this.explicitScrollHeight;
    let tallest = 0;
    for (const child of this.children) {
      const px = Number.parseFloat(child.style.height ?? "");
      if (Number.isFinite(px)) tallest = Math.max(tallest, px);
    }
    return tallest;
  }
  set scrollHeight(value: number) {
    this.explicitScrollHeight = Math.max(0, value);
  }
  // `disabled` is a REFLECTED attribute: in every browser `btn.disabled = true` also writes the
  // `disabled` content attribute, which is how `button:not([disabled])` — the selector a11y.ts uses
  // to collect focusables — knows to skip it. The stub kept the property in a separate field, so a
  // Send button disabled until the form validates still looked focusable to a selector, and a focus
  // trap wrapped Tab onto a control no browser would have stopped at (V153). Backed by `attrs` now,
  // so property and selector can no longer disagree.
  //
  // `checked` and `value` above are deliberately NOT reflected: in the real DOM those content
  // attributes are the *default* state (defaultChecked/defaultValue), not the live one.
  get disabled(): boolean {
    return "disabled" in this.attrs;
  }
  set disabled(on: boolean) {
    if (on) this.attrs.disabled = "";
    else delete this.attrs.disabled;
  }
  // Screens hide and reveal their own nodes through the `hidden` PROPERTY (`node.hidden = true`),
  // which is how the deposit sheet drops its address block and the withdraw sheet reveals the reason
  // its button is blocked. Without the field declared, that assignment still worked at runtime but
  // was invisible to the type checker, so a test could only read it through a cast — and a typo in
  // the property name would have compiled silently.
  //
  // V166b — and it is REFLECTED, like `disabled` and `id` above. A plain field was a second, private
  // truth: `el("button", { hidden: true })` sets the CONTENT attribute (dom.ts writes the empty-string
  // boolean form), which in every browser makes `node.hidden === true`, yet the stub kept answering
  // `false`. So a node the product genuinely renders hidden looked visible to a test, and a later
  // `node.hidden = false` left the attribute in place, i.e. looked hidden in the HTML forever. Both
  // directions disagreed with the platform, and the harness — not the product — decided the verdict.
  get hidden(): boolean {
    return "hidden" in this.attrs;
  }
  set hidden(on: boolean) {
    if (on) this.attrs.hidden = "";
    else delete this.attrs.hidden;
  }
  tag: string;
  private readonly textNode: boolean;
  private text = "";

  constructor(tag: string, textNode = false) {
    this.tag = tag;
    this.textNode = textNode;
  }

  // HTMLElement.dataset — a live view over the data-* attributes, not a second bag. The call overlay
  // themes itself by writing `root.dataset.phase` and deleting `root.dataset.video`, so without this
  // the whole live-call surface threw a TypeError on the first repaint and could not be tested at
  // all (which is why it had no DOM test before V152). Writes land in `attrs` under the real
  // attribute name, so a test asserts on `attrs["data-phase"]` exactly as it would read the HTML.
  readonly dataset: Record<string, string | undefined> = new Proxy(
    {} as Record<string, string | undefined>,
    {
      get: (_target, key) => (typeof key === "string" ? this.attrs[dataAttr(key)] : undefined),
      set: (_target, key, value) => {
        if (typeof key === "string") this.attrs[dataAttr(key)] = String(value);
        return true;
      },
      deleteProperty: (_target, key) => {
        if (typeof key === "string") delete this.attrs[dataAttr(key)];
        return true;
      },
      has: (_target, key) => typeof key === "string" && dataAttr(key) in this.attrs,
      ownKeys: () =>
        Object.keys(this.attrs)
          .filter((name) => name.startsWith("data-"))
          .map((name) => name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );

  setAttribute(key: string, value: string): void {
    this.attrs[key] = value;
    // `disabled` needs no special case any more — the property reads `attrs` directly.
    if (key === "checked") this.checked = true;
    if (key === "value") this.value = value;
  }
  removeAttribute(key: string): void {
    delete this.attrs[key];
  }
  // The read side of the pair. Tests used to reach into `attrs` directly, so the stub could set an
  // attribute and never read one back — which meant any product code calling getAttribute() (or any
  // assertion phrased the way a browser would phrase it) failed on the harness rather than on the
  // product. `null` for a missing attribute is the platform's answer, not `undefined`.
  getAttribute(key: string): string | null {
    return key in this.attrs ? (this.attrs[key] as string) : null;
  }
  hasAttribute(key: string): boolean {
    return key in this.attrs;
  }
  // `id` is a REFLECTED IDL attribute, like `disabled` above: `node.id` and the `id` content attribute
  // are one value in every browser. Product code that wires two elements together reads the property
  // (`emojiBtn.setAttribute("aria-controls", emoji.root.id)` in composer.ts), so a stub without it
  // silently produced the string "undefined" as an ARIA reference — a broken relation that no
  // assertion phrased the way a browser phrases it could catch.
  get id(): string {
    return this.attrs.id ?? "";
  }
  set id(value: string) {
    this.attrs.id = value;
  }
  get className(): string {
    return this.attrs.class ?? "";
  }
  hasClass(name: string): boolean {
    return this.className.split(/\s+/).includes(name);
  }
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !classes.has(name);
      if (enabled) classes.add(name);
      else classes.delete(name);
      this.attrs.class = [...classes].join(" ");
      return enabled;
    },
    add: (...names: string[]): void => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) classes.add(name);
      this.attrs.class = [...classes].join(" ");
    },
    remove: (...names: string[]): void => {
      const classes = new Set(this.className.split(/\s+/).filter(Boolean));
      for (const name of names) classes.delete(name);
      this.attrs.class = [...classes].join(" ");
    },
    contains: (name: string): boolean => this.hasClass(name),
  };

  append(...children: Array<StubNode | string>): void {
    for (const child of children) {
      const node = typeof child === "string" ? text(child) : child;
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...children: Array<StubNode | string>): void {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  // ChildNode.replaceWith(), used by screens that rerender one section in place after pagination or
  // filtering. Preserve sibling order and parent links; a detached node behaves like the browser and
  // makes the call a no-op.
  replaceWith(...replacements: Array<StubNode | string>): void {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    const nodes = replacements.map((replacement) => typeof replacement === "string" ? text(replacement) : replacement);
    for (const node of nodes) node.parent = parent;
    parent.children.splice(index, 1, ...nodes);
    this.parent = null;
  }
  // ParentNode.prepend(). The call screen builds its identity block and then puts the audio/video
  // badge in front of it, so a stub without this method turned the entire live-call surface into a
  // TypeError before a single assertion ran.
  prepend(...children: Array<StubNode | string>): void {
    const nodes = children.map((child) => (typeof child === "string" ? text(child) : child));
    for (const node of nodes) node.parent = this;
    this.children.unshift(...nodes);
  }
  // The older DOM spelling of append(); VirtualList and other imperative code paths use it.
  appendChild(child: StubNode): StubNode {
    this.append(child);
    return child;
  }
  get firstChild(): StubNode | null {
    return this.children[0] ?? null;
  }
  removeChild(child: StubNode): StubNode {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parent = null;
    return child;
  }
  remove(): void {
    this.parent?.removeChild(this);
  }
  addEventListener(
    type: string,
    listener: (event: Record<string, unknown>) => void,
  ): void {
    (this.listeners[type] ??= []).push(listener);
  }
  removeEventListener(
    type: string,
    listener: (event: Record<string, unknown>) => void,
  ): void {
    const bucket = this.listeners[type];
    if (!bucket) return;
    const index = bucket.indexOf(listener);
    if (index >= 0) bucket.splice(index, 1);
  }
  // The synthesised event carries the two methods a handler is entitled to call on a real one.
  // stopPropagation() matters for anything mounted inside a click-to-dismiss surface — the viewer's
  // prev/next buttons call it so paging does not also close the overlay — and without it the handler
  // threw a TypeError, i.e. the stub, not the product, decided the test's verdict (V151).
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners[type] ?? [])]) {
      listener({ preventDefault() {}, stopPropagation() {}, target: this, ...event });
    }
  }
  // HTMLElement.click(). Product code calls it directly — media.ts saves a file by creating a
  // temporary <a download> and clicking it — so without this method that path threw a TypeError into
  // its own catch block and a test could not tell a broken download from a harness gap.
  click(): void {
    this.dispatch("click");
  }
  // Focus is observable in the real DOM through document.activeElement, and screens branch on it
  // (V92 checks that opening a chat does NOT focus the composer on a touch shell). A no-op made that
  // branch untestable, so the stub records the focused node the way a browser does.
  //
  // Including the part where a browser REFUSES. `HTMLElement.focus()` exists on every element, but on
  // one that is not focusable — a plain <div>, a `role="presentation"` group heading — it does
  // nothing at all and reports nothing. That silence is the quietest way for a focus contract to
  // fail, and a stub that let any node become activeElement could not express it: code that focused
  // an unfocusable node looked correct here and was a no-op on a phone (V154). Mirrors the same
  // FOCUSABLE list a11y.ts uses, plus `tabindex="-1"`, which makes a node focusable in code without
  // adding it to the Tab order (that is exactly why createFocusTrap sets it).
  get focusable(): boolean {
    if (this.hasAttribute("tabindex")) return true;
    switch (this.tag.toLowerCase()) {
      case "a":
        return this.hasAttribute("href");
      case "button":
      case "input":
      case "textarea":
      case "select":
        return !this.disabled;
      default:
        return false;
    }
  }
  focus(): void {
    if (!this.focusable) return;
    const doc = (globalThis as unknown as { document?: { activeElement: unknown } }).document;
    if (doc) doc.activeElement = this;
  }
  // Components that must create sibling nodes from an existing one (VirtualList builds its sizer and
  // slab this way) reach for `node.ownerDocument` rather than the global. Without this the chat list
  // could not be mounted in a unit test at all — it threw on `undefined.createElement`.
  get ownerDocument(): {
    createElement(tag: string): StubNode;
    createElementNS(namespace: string, tag: string): StubNode;
  } {
    return (globalThis as unknown as {
      document: {
        createElement(tag: string): StubNode;
        createElementNS(namespace: string, tag: string): StubNode;
      };
    }).document;
  }
  get textContent(): string {
    return this.textNode
      ? this.text
      : this.children.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    if (this.textNode) {
      this.text = value;
      return;
    }
    this.children = [];
    if (value) this.append(value);
  }
  find(predicate: (node: StubNode) => boolean): StubNode | null {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
    return null;
  }
  findAll(predicate: (node: StubNode) => boolean): StubNode[] {
    const matches: StubNode[] = [];
    const walk = (node: StubNode): void => {
      if (predicate(node)) matches.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this);
    return matches;
  }
  // Screens legitimately re-read their own subtree (`body.querySelector(".gc-call-log")` in the calls
  // screen). Without these two the stub threw "querySelector is not a function" and every test that
  // mounted such a screen died on an unhandled rejection — a stub gap, not a product defect. Only the
  // selector grammar the UI actually uses is supported: comma lists of `tag`, `.class`, `[attr]`,
  // `[attr="value"]` and compounds of those. Combinators are deliberately NOT supported so that a
  // test can never silently pass against a selector this matcher misread.
  matches(selector: string): boolean {
    return selector.split(",").some((part) => matchesSimple(this, part.trim()));
  }
  querySelector(selector: string): StubNode | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deep = child.querySelector(selector);
      if (deep) return deep;
    }
    return null;
  }
  querySelectorAll(selector: string): StubNode[] {
    const out: StubNode[] = [];
    const walk = (node: StubNode): void => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  closest(selector: string): StubNode | null {
    let node: StubNode | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  // Node.contains(). A focus trap has to answer "did focus leave my dialog?" before it restores
  // anything, and that question is one call in the real DOM. Self-inclusive, like the browser.
  contains(other: StubNode | null): boolean {
    let node: StubNode | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
}

const dataAttr = (key: string): string =>
  `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

const SIMPLE = /^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/;

function matchesSimple(node: StubNode, selector: string): boolean {
  if (selector.length === 0) return false;
  // `:not(simple)` — the one pseudo-class the client's own selectors use. a11y.ts asks for
  // `button:not([disabled])` and `[tabindex]:not([tabindex="-1"])` when it collects the focusable
  // controls of a modal; without this the matcher threw "unsupported selector" and every focus test
  // measured the stub instead of the product. Nesting stays one level deep on purpose: anything
  // richer belongs in a real browser test, not in a matcher that could silently misread it.
  const negations: string[] = [];
  const base = selector.replace(/:not\(([^)]*)\)/g, (_match, inner: string) => {
    negations.push(inner.trim());
    return "";
  });
  if (negations.length > 0) {
    for (const inner of negations) {
      if (inner.length === 0) throw new Error(`dom_stub: empty :not() in "${selector}"`);
      if (matchesSimple(node, inner)) return false;
    }
    // `:not(x)` alone matches every element; a base part still has to match when one is present.
    return base.length === 0 ? true : matchesSimple(node, base);
  }
  const parsed = SIMPLE.exec(selector);
  if (!parsed) throw new Error(`dom_stub: unsupported selector "${selector}"`);
  const [, tag, rest = ""] = parsed;
  if (tag && node.tag.toLowerCase() !== tag.toLowerCase()) return false;
  for (const token of rest.match(/[.#][\w-]+|\[[^\]]+\]/g) ?? []) {
    if (token.startsWith(".")) {
      if (!node.hasClass(token.slice(1))) return false;
    } else if (token.startsWith("#")) {
      if (node.attrs.id !== token.slice(1)) return false;
    } else {
      const body = token.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) {
        if (!(body in node.attrs)) return false;
      } else {
        const name = body.slice(0, eq);
        const want = body.slice(eq + 1).replace(/^["']|["']$/g, "");
        if (String(node.attrs[name] ?? "") !== want) return false;
      }
    }
  }
  return true;
}

function text(value: string): StubNode {
  const node = new StubNode("#text", true);
  node.textContent = value;
  return node;
}

// Document-level listeners (Escape handling in overlays/menus) and activeElement focus restoration
// are feature-detected by the UI, so the stub implements just enough of both to exercise that code.
const docListeners: Record<
  string,
  Array<(event: Record<string, unknown>) => void>
> = {};

export function installDomStub(): void {
  for (const key of Object.keys(docListeners)) delete docListeners[key];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_namespace: string, tag: string) => new StubNode(tag),
    createTextNode: text,
    // A fragment behaves like a parentless node here: children are appended to it and then moved on,
    // which is exactly what StubNode.append already does.
    createDocumentFragment: () => new StubNode("#fragment"),
    activeElement: null,
    addEventListener(
      type: string,
      listener: (event: Record<string, unknown>) => void,
    ): void {
      (docListeners[type] ??= []).push(listener);
    },
    removeEventListener(
      type: string,
      listener: (event: Record<string, unknown>) => void,
    ): void {
      const bucket = docListeners[type];
      if (!bucket) return;
      const index = bucket.indexOf(listener);
      if (index >= 0) bucket.splice(index, 1);
    },
  };
}

// Fire a document-level event (e.g. dispatchDocument("keydown", { key: "Escape" })).
export function dispatchDocument(
  type: string,
  event: Record<string, unknown> = {},
): void {
  for (const listener of [...(docListeners[type] ?? [])]) {
    listener({ preventDefault() {}, ...event });
  }
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

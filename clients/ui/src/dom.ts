// clients/ui/src/dom.ts — tiny DOM helpers + render sanitisation (T-404, CLIENTS §10).
// Rule: user-controlled text is written via textContent ONLY (never innerHTML). Links are limited to
// an allowlist of schemes (https, greenchat, gcpay, mailto). A basic anti-phishing check flags
// punycode/mixed-script hosts (FEATURES §15). The pure helpers (safeUrl, isSuspiciousHost) are
// unit-tested; el()/clear() touch the DOM and are only called in the browser.

export type Attrs = Record<string, string | number | boolean | undefined>;

// Create an element with attributes and children. Text children are appended as text nodes (safe).
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  children?: Array<Node | string>,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined) continue;
      // ARIA state/property attributes are NOT HTML boolean attributes: they need the
      // literal strings "true"/"false" (aria-hidden="" is invalid per WAI-ARIA and axe
      // aria-valid-attr-value, WCAG 4.1.2). HTML boolean attrs (hidden, disabled…) keep
      // the empty-string form and are omitted entirely when false.
      if (k.startsWith("aria-")) {
        if (typeof v === "boolean") node.setAttribute(k, v ? "true" : "false");
        else node.setAttribute(k, String(v));
        continue;
      }
      if (v === false) continue;
      if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  if (children) {
    for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const ALLOWED_SCHEMES = new Set([
  "https:",
  "greenchat:",
  "gcpay:",
  "mailto:",
]);

// Return a safe href or null. Blocks javascript:, data:, and any non-allowlisted scheme.
export function safeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Relative in-app links (hash routes) are allowed.
    if (trimmed.startsWith("#/") || trimmed.startsWith("/")) return trimmed;
    return null;
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return null;
  return url.href;
}

// Heuristic anti-phishing hint: xn-- (punycode) hosts or hosts mixing Latin with Cyrillic/Greek.
export function isSuspiciousHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h.includes("xn--")) return true;
  const hasLatin = /[a-z]/.test(h);
  const hasCyrillic = /[Ѐ-ӿ]/.test(h);
  const hasGreek = /[Ͱ-Ͽ]/.test(h);
  return hasLatin && (hasCyrillic || hasGreek);
}

// Where a modal layer belongs in the DOM.
//
// Measured on the "Новый чат" sheet at 390×844: the sheet was appended to the chat-list root, which
// lives inside `.gc-superapp-list` — an element with `position: relative; z-index: 2`, i.e. its own
// stacking context. Everything painted inside that column is therefore stacked as a single unit
// worth 2, while the navigation bar (`.gc-app-rail`, `z-index: 100`) is a sibling one level up. No
// z-index written inside the column can ever win against it: the bottom ~66 px of every sheet were
// permanently covered by "Чаты / Звонки / Кошелёк".
//
// A modal is not part of the column it was opened from. It is mounted on the document body, the way
// the media viewer already does it, so it competes with the navigation on equal terms. The caller's
// own node stays the fallback for headless/unit environments where `document.body` is absent.
export function modalRoot(fallback: HTMLElement): HTMLElement {
  const body = (globalThis as { document?: { body?: HTMLElement | null } }).document?.body;
  return body ?? fallback;
}

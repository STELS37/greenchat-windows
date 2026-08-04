import { test } from "node:test";
import assert from "node:assert/strict";
import { safeUrl, isSuspiciousHost, el } from "../src/dom.ts";

// Minimal document stub: el() reads the GLOBAL document and only touches it when called,
// so installing this before the el() tests run is enough (imports above stay side-effect free).
class ElStub {
  attrs: Record<string, string> = {};
  children: Array<ElStub | { text: string }> = [];
  tag: string;
  constructor(tag: string) { this.tag = tag; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  hasAttribute(k: string): boolean { return k in this.attrs; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  append(c: ElStub | { text: string }): void { this.children.push(c); }
}
(globalThis as unknown as { document: unknown }).document = {
  createElement: (tag: string) => new ElStub(tag),
  createTextNode: (text: string) => ({ text }),
};

test("safeUrl: allows allowlisted schemes and in-app links", () => {
  assert.equal(safeUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeUrl("greenchat://chat/42"), "greenchat://chat/42");
  assert.equal(safeUrl("gcpay://invoice/ABC"), "gcpay://invoice/ABC");
  assert.equal(safeUrl("mailto:a@b.com"), "mailto:a@b.com");
  assert.equal(safeUrl("#/chat/42"), "#/chat/42");
  assert.equal(safeUrl("/settings"), "/settings");
});

test("safeUrl: blocks dangerous and unknown schemes", () => {
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("data:text/html,<script>"), null);
  assert.equal(safeUrl("ftp://host/x"), null);
});

test("isSuspiciousHost: flags punycode and mixed-script hosts", () => {
  assert.equal(isSuspiciousHost("xn--80ak6aa92e.com"), true);
  assert.equal(isSuspiciousHost("аpple.com"), true, "Cyrillic а + Latin");
  assert.equal(isSuspiciousHost("example.com"), false);
  assert.equal(isSuspiciousHost("яндекс.рф"), false, "pure Cyrillic is fine");
});

// a11y audit, campaign 12 (WCAG 4.1.2, axe aria-valid-attr-value): ARIA state/property
// attributes need the literal strings "true"/"false" — aria-hidden="" is invalid. HTML boolean
// attributes (hidden, disabled) keep the empty-string form and drop out entirely when false.
test("el: serialises ARIA booleans as \"true\"/\"false\", HTML booleans as empty/omitted", () => {
  const withAriaTrue = el("div", { "aria-hidden": true }) as unknown as ElStub;
  assert.equal(withAriaTrue.getAttribute("aria-hidden"), "true", "aria-hidden=true -> \"true\", not \"\"");

  const withAriaFalse = el("div", { "aria-hidden": false, "aria-modal": false }) as unknown as ElStub;
  assert.equal(withAriaFalse.getAttribute("aria-hidden"), "false", "aria-* false is meaningful, kept as \"false\"");
  assert.equal(withAriaFalse.getAttribute("aria-modal"), "false");

  const withHtmlBool = el("input", { hidden: true, disabled: false }) as unknown as ElStub;
  assert.equal(withHtmlBool.getAttribute("hidden"), "", "HTML boolean true -> empty string");
  assert.equal(withHtmlBool.hasAttribute("disabled"), false, "HTML boolean false -> omitted");

  const withStrings = el("button", { role: "tab", "aria-selected": "true" }) as unknown as ElStub;
  assert.equal(withStrings.getAttribute("role"), "tab");
  assert.equal(withStrings.getAttribute("aria-selected"), "true", "string aria value passes through");
});

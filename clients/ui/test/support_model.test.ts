// T-512 — support_model.ts (SUPPORT.md §3.2): draft validation, exact payload assembly, preview string.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateDraft, isSendable, buildPayload, withoutDiagnostics, previewJson,
  categoryLabel, statusLabel, statusLine, TEXT_MIN, TEXT_MAX, SUPPORT_CATEGORIES,
} from "../src/screens/support_model.ts";
import type { SupportDraft, SupportAutoFields } from "../src/screens/support_model.ts";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";

const AUTO: SupportAutoFields = { screen: "/chat/{id}", app_version: "0.1.0", platform: "web" };
const draft = (over: Partial<SupportDraft> = {}): SupportDraft =>
  ({ category: "bug", text: "the app crashed on send", attachDiagnostics: true, ...over });

test("validateDraft enforces the 10..4000 window", () => {
  assert.equal(validateDraft(draft({ text: "   " })), "empty");
  assert.equal(validateDraft(draft({ text: "short" })), "too_short");
  assert.equal(validateDraft(draft({ text: "x".repeat(TEXT_MIN) })), null);
  assert.equal(validateDraft(draft({ text: "x".repeat(TEXT_MAX) })), null);
  assert.equal(validateDraft(draft({ text: "x".repeat(TEXT_MAX + 1) })), "too_long");
  assert.equal(isSendable(draft()), true);
  assert.equal(isSendable(draft({ text: "no" })), false);
});

test("buildPayload trims text, carries auto-fields + client_ref, and includes diagnostics when ticked", () => {
  const diag = { env: { platform: "web" }, entries: [{ t: 1, kind: "route", data: { to: "/x" } }] };
  const p = buildPayload(draft({ text: "  hello world report  " }), AUTO, { clientRef: "ref-123", diagnostics: diag });
  assert.equal(p.category, "bug");
  assert.equal(p.text, "hello world report");
  assert.equal(p.client_ref, "ref-123");
  assert.equal(p.screen, "/chat/{id}");
  assert.equal(p.app_version, "0.1.0");
  assert.equal(p.platform, "web");
  assert.deepEqual(p.diagnostics, diag);
});

test("buildPayload omits diagnostics when the checkbox is off (privacy invariant)", () => {
  const diag = { env: {}, entries: [] };
  const p = buildPayload(draft({ attachDiagnostics: false }), AUTO, { clientRef: "r", diagnostics: diag });
  assert.equal("diagnostics" in p, false);
});

test("buildPayload omits empty auto-fields", () => {
  const p = buildPayload(draft(), { screen: "", app_version: "", platform: "" }, { clientRef: "r" });
  assert.equal("screen" in p, false);
  assert.equal("app_version" in p, false);
  assert.equal("platform" in p, false);
});

test("withoutDiagnostics strips only the diagnostics blob (S-002 resend)", () => {
  const p = buildPayload(draft(), AUTO, { clientRef: "r", diagnostics: { env: {}, entries: [] } });
  const bare = withoutDiagnostics(p);
  assert.equal("diagnostics" in bare, false);
  assert.equal(bare.text, p.text);
  assert.equal(bare.client_ref, p.client_ref);
});

test("previewJson is exactly the pretty-printed payload that will be sent", () => {
  const p = buildPayload(draft(), AUTO, { clientRef: "r", diagnostics: { env: {}, entries: [] } });
  assert.equal(previewJson(p), JSON.stringify(p, null, 2));
});

test("category + status labels resolve for every known value; statusLine embeds the ref", () => {
  const i18n = createI18n({ locale: "ru", dicts: { ru, en } });
  for (const c of SUPPORT_CATEGORIES) {
    const label = categoryLabel(i18n, c);
    assert.ok(label && !label.startsWith("support.category."), `category ${c} localised`);
  }
  for (const s of ["open", "ack", "in_progress", "waiting_user", "answered", "resolved", "closed"]) {
    const label = statusLabel(i18n, s);
    assert.ok(label && !label.startsWith("support.status."), `status ${s} localised`);
  }
  assert.equal(statusLabel(i18n, "weird_unknown"), "weird_unknown"); // graceful fallback
  const line = statusLine(i18n, "GC-000123", "resolved");
  assert.ok(line.includes("GC-000123"));
});

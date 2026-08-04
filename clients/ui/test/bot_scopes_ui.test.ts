// Bot Center platform controls: least-privilege scopes, opt-in discovery and aggregate analytics must
// remain owner-visible, localized in both shipped languages and reachable at narrow mobile widths.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const ui = (name: string): string => readFileSync(resolve(here, "../src/", name), "utf8");
const web = (name: string): string => readFileSync(resolve(here, "../../web/src/", name), "utf8");

const screen = ui("screens/bots_screen.ts");
const ru = ui("locales/ru.ts");
const en = ui("locales/en.ts");
const css = web("bot_center.css");

const SCOPES = [
  "updates",
  "messages",
  "media",
  "polls",
  "reactions",
  "message_manage",
  "chat_read",
  "chat_manage",
  "files",
  "webhooks",
  "commands",
  "payments",
  "miniapps",
] as const;

const CATEGORIES = [
  "productivity",
  "utilities",
  "finance",
  "shopping",
  "games",
  "education",
  "community",
  "support",
  "other",
] as const;

test("Bot Center renders and saves scopes, discovery and aggregate analytics", () => {
  for (const route of ["/scopes", "/discovery", "/analytics?days=30"]) {
    assert.ok(screen.includes(route), `owner route ${route} is wired into Bot Center`);
  }
  assert.match(screen, /available_scopes\?: string\[\]/);
  assert.match(screen, /discovery_categories\?: string\[\]/);
  assert.match(screen, /detailDraft\.scopes/);
  assert.match(screen, /saveScopes\(\)/);
  assert.match(screen, /saveDiscovery\(\)/);
  assert.match(screen, /loadAnalytics\(bot\.id\)/);

  for (const metric of [
    "sent_messages",
    "active_chats",
    "memberships",
    "media_messages",
    "polls_created",
    "callbacks_received",
    "reactions_received",
  ]) {
    assert.ok(screen.includes(metric), `${metric} is an aggregate rendered by the owner UI`);
  }
  for (const forbidden of ["message_text", "user_name", "user_id", "event_payload"]) {
    assert.equal(
      screen.includes(`analytics.${forbidden}`) || screen.includes(`analytics[${forbidden}]`),
      false,
      `analytics UI must not expect identity/content field ${forbidden}`,
    );
  }
});

test("every scope/category and every platform control is localized in Russian and English", () => {
  const fixed = [
    "bots.scopes",
    "bots.scopesHint",
    "bots.scopesAll",
    "bots.scopesNone",
    "bots.scopesSaved",
    "bots.discovery",
    "bots.discoveryHint",
    "bots.discoveryListed",
    "bots.discoveryCategory",
    "bots.discoveryKeywords",
    "bots.discoveryKeywordsPlaceholder",
    "bots.discoveryKeywordsHint",
    "bots.discoverySaved",
    "bots.analytics",
    "bots.analyticsHint",
    "bots.analyticsRefresh",
  ];
  const keys = [
    ...fixed,
    ...SCOPES.map((scope) => `bots.scope.${scope}`),
    ...CATEGORIES.map((category) => `bots.category.${category}`),
    ...["sent", "chats", "memberships", "media", "polls", "callbacks", "reactions"]
      .map((metric) => `bots.analytics.${metric}`),
  ];
  for (const key of keys) {
    assert.equal(ru.includes(`"${key}"`), true, `Russian locale carries ${key}`);
    assert.equal(en.includes(`"${key}"`), true, `English locale carries ${key}`);
  }
});

test("scope and analytics controls use bounded responsive layouts", () => {
  for (const selector of [
    ".gc-bot-scope-grid",
    ".gc-bot-scope-option",
    ".gc-bot-toggle-row",
    ".gc-bot-analytics-grid",
    ".gc-bot-analytics-metric",
  ]) {
    assert.ok(css.includes(selector), `${selector} has a shipped style`);
  }
  assert.match(css, /\.gc-bot-scope-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,/);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.gc-bot-scope-grid,[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /\.gc-bot-analytics-metric\s+span\s*\{[\s\S]*overflow-wrap:\s*anywhere/);
});

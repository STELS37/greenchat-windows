import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  parseMiniAppAnalytics,
  type MiniAppAnalytics,
  type MiniAppView,
} from "../src/screens/miniapps_model.ts";
import { createMiniAppsScreen } from "../src/screens/miniapps_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

const APP_ID = 42;
const DAY = 86_400;
const FROM = 1_728_000_000;

function analyticsPayload(days = 30): MiniAppAnalytics {
  const daily = Array.from({ length: days }, (_, index) => ({
    day_start: FROM + index * DAY,
    launches: index >= days - 7 ? index - (days - 7) + 1 : 0,
    chat_launches: index === days - 1 ? 2 : 0,
    grants: index === days - 1 ? 1 : 0,
    verifications: index === days - 1 ? 3 : 0,
  }));
  const totals = daily.reduce(
    (sum, row) => ({
      launches: sum.launches + row.launches,
      chat_launches: sum.chat_launches + row.chat_launches,
      grants: sum.grants + row.grants,
      verifications: sum.verifications + row.verifications,
    }),
    { launches: 0, chat_launches: 0, grants: 0, verifications: 0 },
  );
  return {
    app_id: APP_ID,
    days,
    from: FROM,
    to: FROM + days * DAY,
    totals,
    daily,
  };
}

const app: MiniAppView = {
  id: APP_ID,
  bot_user_id: APP_ID,
  bot: { id: APP_ID, username: "metricsbot", name: "Metrics Bot", avatar_file_id: null },
  title: "Metrics App",
  description: "Owner analytics",
  launch_url: "https://mini.example/app",
  launch_origin: "https://mini.example",
  icon_file_id: null,
  requested_scopes: ["user.basic", "theme"],
  status: "active",
  version: 1,
  created_at: 1,
  updated_at: 1,
  published_at: 1,
};

test("Mini App analytics parser accepts only exact aggregate UTC-day data", () => {
  const valid = analyticsPayload();
  assert.deepEqual(parseMiniAppAnalytics(valid, APP_ID), valid);

  assert.equal(parseMiniAppAnalytics({ ...valid, user_id: 7 }, APP_ID), null, "per-user fields fail closed");
  assert.equal(parseMiniAppAnalytics({ ...valid, app_id: 99 }, APP_ID), null);
  assert.equal(parseMiniAppAnalytics({ ...valid, days: 91 }, APP_ID), null);
  assert.equal(parseMiniAppAnalytics({ ...valid, totals: { ...valid.totals, launches: -1 } }, APP_ID), null);
  assert.equal(parseMiniAppAnalytics({ ...valid, totals: { ...valid.totals, launches: valid.totals.launches + 1 } }, APP_ID), null);

  const missingDay = { ...valid, daily: valid.daily.slice(1) };
  assert.equal(parseMiniAppAnalytics(missingDay, APP_ID), null);
  const shifted = {
    ...valid,
    daily: valid.daily.map((row, index) => index === 5 ? { ...row, day_start: row.day_start + DAY } : row),
  };
  assert.equal(parseMiniAppAnalytics(shifted, APP_ID), null);
});

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class AnalyticsApi implements ApiLike {
  readonly gets: string[] = [];
  private readonly malformed: boolean;

  constructor(malformed = false) {
    this.malformed = malformed;
  }

  get<T>(path: string): Promise<T> {
    this.gets.push(path);
    if (path === "/v1/miniapps/catalog") return Promise.resolve({ apps: [app] } as T);
    if (path === "/v1/miniapps/mine") return Promise.resolve({ apps: [app] } as T);
    if (path === "/v1/bots") {
      return Promise.resolve({ bots: [{ id: APP_ID, bot_user_id: APP_ID, username: "metricsbot", name: "Metrics Bot" }] } as T);
    }
    if (path === `/v1/miniapps/${APP_ID}/analytics?days=30`) {
      const value = analyticsPayload();
      return Promise.resolve((this.malformed ? { ...value, user_id: 777 } : value) as T);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }

  post<T>(): Promise<T> { return Promise.reject(new Error("unused POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

function findButton(root: StubNode, text: string): StubNode {
  const button = root.find((node) => node.tag === "button" && node.textContent === text);
  assert.ok(button, `button ${text} exists`);
  return button;
}

test("owner loads Mini App analytics on demand and sees only aggregate totals and seven-day trend", async () => {
  const api = new AnalyticsApi();
  const view = createMiniAppsScreen({ api, i18n, onBack() {}, onOpen() {} });
  await settle();
  const root = view.root as unknown as StubNode;

  assert.equal(api.gets.some((path) => path.includes("analytics")), false, "analytics are not prefetched for every catalog visitor");
  findButton(root, "My apps").dispatch("click");
  findButton(root, "Analytics").dispatch("click");
  await settle();

  assert.equal(api.gets.filter((path) => path === `/v1/miniapps/${APP_ID}/analytics?days=30`).length, 1);
  const panel = root.find((node) => node.hasClass("gc-miniapp-analytics") && !node.hasClass("is-loading"));
  assert.ok(panel);
  assert.match(panel.textContent, /Last 30 days/);
  assert.match(panel.textContent, /Aggregates only: no users, chats, or content\./);
  assert.match(panel.textContent, /Launches28/);
  assert.match(panel.textContent, /From chats2/);
  assert.match(panel.textContent, /New consents1/);
  assert.match(panel.textContent, /Backend verifications3/);
  assert.equal(panel.findAll((node) => node.tag === "time").length, 7);
  assert.equal(panel.textContent.includes("777"), false);

  findButton(root, "Analytics").dispatch("click");
  assert.equal(root.find((node) => node.hasClass("gc-miniapp-analytics")), null, "closing analytics does not leave hidden data in DOM");
  assert.equal(api.gets.filter((path) => path.includes("/analytics?")).length, 1);
  findButton(root, "Analytics").dispatch("click");
  await settle();
  assert.equal(api.gets.filter((path) => path.includes("/analytics?")).length, 2, "reopening refreshes owner metrics");
  view.destroy();
});

test("malformed analytics payload is rejected before any hidden field reaches the DOM", async () => {
  const api = new AnalyticsApi(true);
  const view = createMiniAppsScreen({ api, i18n, onBack() {}, onOpen() {} });
  await settle();
  const root = view.root as unknown as StubNode;
  findButton(root, "My apps").dispatch("click");
  findButton(root, "Analytics").dispatch("click");
  await settle();

  const error = root.find((node) => node.hasClass("gc-miniapp-analytics") && node.hasClass("is-error"));
  assert.ok(error);
  assert.match(error.textContent, /Could not verify app analytics/);
  assert.equal(root.textContent.includes("777"), false);
  view.destroy();
});

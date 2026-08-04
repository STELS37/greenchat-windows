import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type {
  ApiLike,
  GlobalSearchResult,
  ReportPayload,
  ReportResult,
  ResolvedUser,
} from "../src/screens/api.ts";
import { createReportOverlay } from "../src/screens/report_overlay.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

class ReportApi implements ApiLike {
  resolved: string[] = [];
  reports: ReportPayload[] = [];
  resolveUser(username: string): Promise<ResolvedUser> {
    this.resolved.push(username);
    return Promise.resolve({
      id: 77,
      username: "targetbot",
      name: "Target bot",
      avatar_file_id: null,
      is_bot: true,
    });
  }
  reportContent(body: ReportPayload): Promise<ReportResult> {
    this.reports.push(body);
    return Promise.resolve({
      id: 5,
      kind: body.kind,
      target_id: body.target_id,
      reason: body.reason,
      comment: body.comment ?? "",
      created_at: 1,
      resolved_at: null,
    });
  }
  get<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected GET"));
  }
  post<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected POST"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class SearchOnlyReportApi implements ApiLike {
  searches: string[] = [];
  reports: ReportPayload[] = [];

  searchGlobal(q: string): Promise<GlobalSearchResult> {
    this.searches.push(q);
    return Promise.resolve({
      users: [
        {
          id: 12,
          username: "targetbot-old",
          name: "Fuzzy result",
          avatar_file_id: null,
          is_bot: true,
        },
        {
          id: 77,
          username: "TargetBot",
          name: "Exact result",
          avatar_file_id: null,
          is_bot: true,
        },
      ],
      chats: [],
      messages: [],
    });
  }
  reportContent(body: ReportPayload): Promise<ReportResult> {
    this.reports.push(body);
    return Promise.resolve({
      id: 6,
      kind: body.kind,
      target_id: body.target_id,
      reason: body.reason,
      comment: body.comment ?? "",
      created_at: 1,
      resolved_at: null,
    });
  }
  get<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected GET"));
  }
  post<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected POST"));
  }
  put<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PUT"));
  }
  patch<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected PATCH"));
  }
  delete<T>(): Promise<T> {
    return Promise.reject(new Error("unexpected DELETE"));
  }
  refreshTokens(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

test("username report resolves one authoritative exact user before submission", async () => {
  const api = new ReportApi();
  const toasts: string[] = [];
  const view = createReportOverlay({
    api,
    i18n,
    toast: (message) => toasts.push(message),
  });
  const root = view.root as unknown as StubNode;
  const username = root.find(
    (node) =>
      node.tag === "input" &&
      node.attrs["aria-label"] === i18n.t("report.usernameLabel"),
  );
  const abuse = root.find(
    (node) => node.tag === "input" && node.attrs.value === "abuse",
  );
  const send = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("report.send"),
  );
  assert.ok(username && abuse && send);

  username.value = "@targetbot";
  abuse.checked = true;
  abuse.dispatch("change");
  send.dispatch("click");
  await settle();

  assert.deepEqual(api.resolved, ["targetbot"]);
  assert.deepEqual(api.reports, [
    { kind: "user", target_id: 77, reason: "abuse" },
  ]);
  assert.deepEqual(toasts, [i18n.t("report.thanks")]);
});

test("username report preserves searchGlobal-only ApiLike compatibility", async () => {
  const api = new SearchOnlyReportApi();
  const view = createReportOverlay({ api, i18n });
  const root = view.root as unknown as StubNode;
  const username = root.find(
    (node) =>
      node.tag === "input" &&
      node.attrs["aria-label"] === i18n.t("report.usernameLabel"),
  );
  const send = root.find(
    (node) =>
      node.tag === "button" && node.textContent === i18n.t("report.send"),
  );
  assert.ok(username && send);

  username.value = "@targetbot";
  send.dispatch("click");
  await settle();

  assert.deepEqual(api.searches, ["targetbot"]);
  assert.deepEqual(api.reports, [
    { kind: "user", target_id: 77, reason: "spam" },
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import {
  createFeedScreen,
  type EventFeed,
  type OutboxPort,
} from "../src/screens/feed_screen.ts";
import type { ReportTarget } from "../src/screens/report_overlay.ts";
import type { ChatEntry, ChatMember, Message } from "../src/screens/types.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "en", dicts: { en, ru } });

const incoming: Message = {
  id: 41,
  chat_id: 9,
  sender: { id: 2, username: "abusebot", name: "Abuse Bot" },
  kind: "text",
  text: "abusive content",
  created_at: 1_700_000_000,
};

class FeedApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/chats/9/messages?"))
      return Promise.resolve([incoming] as T);
    if (path === "/v1/chats?filter=all") {
      return Promise.resolve([
        {
          id: 9,
          kind: "dialog",
          title: "Abuse Bot",
          username: "abusebot",
          photo_file_id: null,
          last_message: null,
          unread_count: 0,
          muted_until: 0,
          pinned: false,
          archived: false,
          my_role: "member",
          message_ttl_sec: 0,
          draft: null,
          updated_at: 1,
        },
      ] as ChatEntry[] as T);
    }
    if (path === "/v1/chats/9/members") {
      return Promise.resolve([
        { id: 1, username: "alice", name: "Alice" },
        { id: 2, username: "abusebot", name: "Abuse Bot" },
      ] as ChatMember[] as T);
    }
    if (path === "/v1/chats/9/pins") return Promise.resolve([] as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(path: string): Promise<T> {
    if (path === "/v1/chats/9/read") return Promise.resolve({} as T);
    return Promise.reject(new Error(`unexpected POST ${path}`));
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

const outbox: OutboxPort = {
  enqueueMessage: () => Promise.reject(new Error("unexpected enqueue")),
  enqueueEdit: () => Promise.reject(new Error("unexpected edit")),
  enqueueDelete: () => Promise.reject(new Error("unexpected delete")),
  cancel: () => Promise.resolve(false),
  retry: () => Promise.reject(new Error("unexpected retry")),
  subscribe: () => () => {},
};
const events: EventFeed = { subscribe: () => () => {} };

test("incoming sender and message expose exact ReportTarget actions", async () => {
  const targets: ReportTarget[] = [];
  const view = createFeedScreen({
    api: new FeedApi(),
    i18n,
    chatId: 9,
    self: { id: 1, username: "alice", name: "Alice" },
    outbox,
    events,
    onBack() {},
    onReport: (target) => targets.push(target),
  });
  await settle();
  const root = view.root as unknown as StubNode;
  // V5: reporting no longer lives in the bubble body (a permanent link on every incoming message) but
  // in the per-message menu, reachable by the "⋯" button, long-press or right-click. In a 1:1 dialog
  // there is no author byline at all, so the menu is the only route to BOTH report targets.
  assert.equal(
    root.find((node) => node.tag === "button" && node.hasClass("gc-bubble-report")),
    null,
    "the permanent in-bubble report link must be gone",
  );
  const more = root.find((node) => node.tag === "button" && node.hasClass("gc-bubble-more"));
  assert.ok(more, "every incoming row exposes the message-actions button");
  more.dispatch("click", { stopPropagation() {} });

  const item = (action: string): StubNode | null =>
    root.find((node) => node.tag === "button" && node.attrs["data-action"] === action);
  const messageReport = item("report");
  assert.ok(messageReport, "menu offers 'report message'");
  messageReport.dispatch("click", {});

  more.dispatch("click", { stopPropagation() {} });
  const profileReport = item("report-user");
  assert.ok(profileReport, "menu offers 'report this user' even without an author byline");
  profileReport.dispatch("click", {});

  assert.deepEqual(targets, [
    {
      kind: "message",
      targetId: 41,
      label: i18n.t("report.messageTarget", { id: 41 }),
    },
    { kind: "user", targetId: 2, label: "@abusebot" },
  ]);
  view.destroy();
});

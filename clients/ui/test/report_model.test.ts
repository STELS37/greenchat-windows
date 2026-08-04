// clients/ui/test/report_model.test.ts — T-514 (MS-4 / T-113): the pure report model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import {
  REPORT_REASONS, REPORT_COMMENT_MAX, buildReportPayload, normalizeUsername, pickUserByUsername, reasonLabel,
} from "../src/screens/report_model.ts";
import type { GlobalSearchResult, SearchUser } from "../src/screens/api.ts";

const i18n = createI18n({ locale: "ru", dicts: { ru, en } });

function user(id: number, username: string): SearchUser {
  return { id, username, name: username, avatar_file_id: null, is_bot: false };
}
function result(users: SearchUser[]): GlobalSearchResult {
  return { users, chats: [], messages: [] };
}

test("reasons are the server's closed set", () => {
  assert.deepEqual([...REPORT_REASONS], ["spam", "abuse", "csam", "other"]);
});

test("buildReportPayload assembles the wire body; comment trimmed + capped; omitted when empty", () => {
  const bare = buildReportPayload("user", 42, { reason: "spam", comment: "   " });
  assert.deepEqual(bare, { kind: "user", target_id: 42, reason: "spam" });
  assert.ok(!("comment" in bare), "empty comment omitted");

  const withComment = buildReportPayload("message", 7, { reason: "abuse", comment: "  hello  " });
  assert.deepEqual(withComment, { kind: "message", target_id: 7, reason: "abuse", comment: "hello" });

  const long = buildReportPayload("user", 1, { reason: "other", comment: "z".repeat(600) });
  assert.equal((long.comment ?? "").length, REPORT_COMMENT_MAX);
});

test("normalizeUsername strips a leading @ and trims", () => {
  assert.equal(normalizeUsername("  @Alice "), "Alice");
  assert.equal(normalizeUsername("bob"), "bob");
  assert.equal(normalizeUsername("@@x"), "x");
});

test("pickUserByUsername returns the exact case-insensitive match, else null", () => {
  const res = result([user(1, "alice"), user(2, "bob")]);
  assert.equal(pickUserByUsername(res, "@Alice")?.id, 1);
  assert.equal(pickUserByUsername(res, "BOB")?.id, 2);
  assert.equal(pickUserByUsername(res, "al")?.id, undefined); // no fuzzy match
  assert.equal(pickUserByUsername(res, "  "), null);
  assert.equal(pickUserByUsername(result([]), "alice"), null);
});

test("reasonLabel resolves a localized label for every reason", () => {
  for (const r of REPORT_REASONS) {
    const label = reasonLabel(i18n, r);
    assert.ok(label && label !== `report.reason.${r}`, `missing ru label for ${r}`);
  }
});

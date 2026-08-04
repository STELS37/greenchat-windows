// clients/ui/test/service_account.test.ts — T-514 (§4): the service-account contract on fixture payloads
// WITH and WITHOUT the is_system flag (the server does not emit it yet, so the "absent" path is today).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { isServiceAccount, serviceAccountCaps, serviceAccountLabel } from "../src/screens/service_account.ts";
import { userRows } from "../src/screens/new_chat_model.ts";
import type { SearchUser } from "../src/screens/api.ts";

function fx(over: Partial<SearchUser> = {}): SearchUser {
  return { id: 10, username: "support", name: "Support", avatar_file_id: null, is_bot: false, ...over };
}

test("isServiceAccount only for an explicit is_system === true", () => {
  assert.equal(isServiceAccount(fx({ is_system: true })), true);
  assert.equal(isServiceAccount(fx({ is_system: false })), false);
  assert.equal(isServiceAccount(fx()), false, "flag absent (today's payload) → normal account");
  assert.equal(isServiceAccount(null), false);
  assert.equal(isServiceAccount(undefined), false);
});

test("a bot is NOT a service account (orthogonal flags)", () => {
  assert.equal(isServiceAccount(fx({ is_bot: true })), false);
  assert.equal(isServiceAccount(fx({ is_bot: true, is_system: true })), true);
});

test("caps: service account withdraws call/block/delete-for-both; normal account keeps them", () => {
  assert.deepEqual(serviceAccountCaps(fx({ is_system: true })), {
    isServiceAccount: true, allowCall: false, allowBlock: false, allowDeleteForBoth: false,
  });
  const normal = { isServiceAccount: false, allowCall: true, allowBlock: true, allowDeleteForBoth: true };
  assert.deepEqual(serviceAccountCaps(fx()), normal, "flag absent → today's behavior");
  assert.deepEqual(serviceAccountCaps(fx({ is_system: false })), normal);
});

test("badge label is localized in both locales", () => {
  for (const locale of ["ru", "en"] as const) {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    assert.ok(serviceAccountLabel(i18n) !== "user.serviceAccount", `missing ${locale} label`);
  }
});

test("directory rows carry serviceAccount only for is_system users (additive, absent otherwise)", () => {
  const rows = userRows([fx({ id: 1, is_system: true }), fx({ id: 2, username: "alice", name: "Alice" })], 999);
  assert.equal(rows[0]?.serviceAccount, true);
  assert.ok(!("serviceAccount" in rows[1]!), "normal user row must not carry the flag");
});

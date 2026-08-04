// clients/ui/test/presence_epoch_v163.test.ts — V163: the "never signed in" sentinel was rendered as a date.
//
// Measured on the running server (127.0.0.1:8990, runtime a29c2569) with two real accounts:
//   GET /v1/users/59 -> {"id":59,"last_seen":0}            <- registered, never opened a session
//   GET /v1/users/60 -> {"id":60,"last_seen":1785727799}   <- signed in 18 minutes earlier
// The chat header for user 59 read "last seen on 01/01/1970" (Russian build: «был(а) в сети
// 01.01.1970»). At the reading, now = 1785728892, so the client had computed an age of 20 668 days
// from a value that is not a moment at all: server/src/modules/users.ts::lastSeenFor hands back the
// raw `last_seen_at` column, and server/src/modules/account.ts documents 0 as "never recorded".
//
// The guard: a non-positive timestamp is the absence of knowledge, so it must produce no presence
// line (the chat-kind label stays), exactly like `null`. Anything positive keeps its old wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { presenceLabel } from "../src/screens/feed_model.ts";

const NOW = 1_785_728_892; // the exact second the defect was photographed

test("V163: the never-signed-in sentinel (0) renders no presence line, not the Unix epoch", () => {
  for (const locale of ["ru", "en"] as const) {
    const i = createI18n({ locale, dicts: { ru, en } });
    const label = presenceLabel({ online: false, lastSeen: 0 }, NOW, i);
    assert.equal(label, null, `${locale}: last_seen=0 must not produce a line, got ${JSON.stringify(label)}`);
  }
});

test("V163: a negative timestamp (clock skew / bad row) is also treated as unknown", () => {
  const i = createI18n({ locale: "en", dicts: { ru, en } });
  assert.equal(presenceLabel({ online: false, lastSeen: -1 }, NOW, i), null);
});

test("V163: no epoch date reaches the header in either locale", () => {
  for (const locale of ["ru", "en"] as const) {
    const i = createI18n({ locale, dicts: { ru, en } });
    const label = presenceLabel({ online: false, lastSeen: 0 }, NOW, i) ?? "";
    assert.ok(!/1970/.test(label), `${locale}: presence line still mentions 1970: ${label}`);
  }
});

test("V163: the sentinel guard did not swallow a real timestamp", () => {
  const i = createI18n({ locale: "en", dicts: { ru, en } });
  // the live peer measured alongside the defect
  const real = presenceLabel({ online: false, lastSeen: 1_785_727_799 }, NOW, i);
  assert.equal(real, i.t("chat.lastSeenMinutes", { count: "18" }));
  // and 1 second past the epoch is still a timestamp, however implausible
  const one = presenceLabel({ online: false, lastSeen: 1 }, NOW, i);
  assert.ok(one !== null && /1970/.test(one), `last_seen=1 must stay a date, got ${JSON.stringify(one)}`);
});

test("V163: online and privacy-blurred states are untouched by the guard", () => {
  const i = createI18n({ locale: "en", dicts: { ru, en } });
  assert.equal(presenceLabel({ online: true, lastSeen: 0 }, NOW, i), i.t("chat.online"));
  assert.equal(presenceLabel({ online: false, lastSeen: "recently" }, NOW, i), i.t("chat.lastSeenRecently"));
  assert.equal(presenceLabel({ online: false, lastSeen: null }, NOW, i), null);
});

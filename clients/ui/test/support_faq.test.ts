// clients/ui/test/support_faq.test.ts — T-514 (MS-4 §3.1.3): the static FAQ model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { FAQ_IDS, faqEntries } from "../src/screens/support_faq.ts";

test("FAQ has 5–10 entries with unique ids in display order", () => {
  assert.ok(FAQ_IDS.length >= 5 && FAQ_IDS.length <= 10, `expected 5–10, got ${FAQ_IDS.length}`);
  assert.equal(new Set(FAQ_IDS).size, FAQ_IDS.length, "ids must be unique");
});

for (const locale of ["ru", "en"] as const) {
  test(`every FAQ entry is fully localized in ${locale} (no raw keys leak)`, () => {
    const i18n = createI18n({ locale, dicts: { ru, en } });
    const entries = faqEntries(i18n);
    assert.equal(entries.length, FAQ_IDS.length);
    for (const e of entries) {
      assert.ok(e.q && e.q !== `faq.q.${e.id}`, `missing ${locale} question for ${e.id}`);
      assert.ok(e.a && e.a !== `faq.a.${e.id}`, `missing ${locale} answer for ${e.id}`);
      assert.ok(e.a.length > e.q.length, `answer should be more than a stub for ${e.id}`);
    }
  });
}

test("faqEntries preserves the declared order", () => {
  const i18n = createI18n({ locale: "en", dicts: { ru, en } });
  assert.deepEqual(faqEntries(i18n).map((e) => e.id), [...FAQ_IDS]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";

const real = () => createI18n({ locale: "ru", dicts: { ru, en } });

test("i18n: real dictionary lookup", () => {
  const i = real();
  assert.equal(i.t("common.ok"), "ОК");
  i.setLocale("en");
  assert.equal(i.t("common.ok"), "OK");
});

test("i18n: interpolation, missing key, and fallback locale", () => {
  const missing: string[] = [];
  const i = createI18n({
    locale: "ru",
    dicts: { ru: { "greet.hi": "Привет, {name}!" }, en: { "greet.hi": "Hi, {name}!", "only.en": "English only" } },
    fallbackLocale: "en",
    onMissing: (k) => missing.push(k),
  });
  assert.equal(i.t("greet.hi", { name: "Ия" }), "Привет, Ия!");
  assert.equal(i.t("only.en"), "English only", "falls back to en");
  assert.equal(i.t("no.such.key"), "no.such.key", "returns the key when truly missing");
  assert.deepEqual(missing, ["no.such.key"]);
});

test("i18n: error-code mapping (Appendix D → text)", () => {
  const i = real();
  assert.equal(i.error("VALIDATION_FAILED"), "Проверьте введённые данные");
  assert.equal(i.error("INVITE_REQUIRED"), "Введите код приглашения");
  assert.equal(i.error("INVITE_INVALID"), "Код приглашения неверен, просрочен или исчерпан");
  assert.equal(i.error("TOTALLY_UNKNOWN"), "Что-то пошло не так");
  assert.equal(i.error(null), "Что-то пошло не так");
});

test("i18n: Intl number and relative-time per locale", () => {
  const i = createI18n({ locale: "ru", dicts: { ru, en } });
  assert.ok(i.formatNumber(1234.5).includes(","), "ru uses a comma decimal");
  assert.equal(i.formatRelativeTime(-1, "day"), "вчера");
  i.setLocale("en");
  assert.ok(i.formatNumber(1234.5).includes("."), "en uses a dot decimal");
  assert.equal(i.formatRelativeTime(-1, "day"), "yesterday");
});

test("i18n: subscribe fires on locale change", () => {
  const i = real();
  const seen: string[] = [];
  i.subscribe((l) => seen.push(l));
  i.setLocale("en");
  i.setLocale("en"); // no-op
  assert.deepEqual(seen, ["en"]);
});

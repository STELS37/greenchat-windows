// V155 — the interface language must be changeable BY TAPPING, remembered, and honest to the document.
// Measured before this change on the running client (390x844, browser locale en-US, probes/hunt2.mjs):
// 7 settings sections, 22 rows, ZERO about language; the only switch was a Ctrl+K palette command
// (main.ts) — keyboard-only, so unreachable on a phone. probes/palette.mjs additionally showed that the
// palette switch died on reload and that <html lang> stayed "ru" while the interface rendered English.
// These are the guards for all four halves of that defect.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LanguageController,
  resolveLocale,
  normalizeLangPref,
  primarySubtag,
  LANG_PREFS,
  type LangEnv,
  type LangPref,
} from "../src/lang.ts";
import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { UI_LANG_ITEM } from "../src/screens/settings_model.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createSettingsScreen } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();

// ---- the controller ------------------------------------------------------------------------------
function fakeEnv(overrides: Partial<LangEnv> = {}): LangEnv & { saved: LangPref[]; lang: string[] } {
  const saved: LangPref[] = [];
  const lang: string[] = [];
  const base: LangEnv = {
    root: { setAttribute: (n, v) => { if (n === "lang") lang.push(v); } },
    systemTags: () => ["en-US"],
    onSystemChange: () => () => {},
    load: () => null,
    save: (pref) => { saved.push(pref); },
  };
  return Object.assign({}, base, overrides, { saved, lang });
}

test("V155: an explicit choice beats the system language and is persisted", () => {
  const env = fakeEnv({ systemTags: () => ["en-US", "en"] });
  const c = new LanguageController(env);
  assert.equal(c.state.locale, "en", "no choice yet → follow the platform");
  const next = c.setPref("ru");
  assert.equal(next.locale, "ru", "the user asked for Russian and must get Russian");
  assert.deepEqual(env.saved, ["ru"], "the choice must survive a reload, so it is written down");
  assert.equal(env.lang.at(-1), "ru", "<html lang> must follow the rendered locale");
});

test("V155: a stored choice wins over the browser at the next boot", () => {
  const env = fakeEnv({ systemTags: () => ["en-US"], load: () => "ru" });
  assert.equal(new LanguageController(env).state.locale, "ru");
});

test("V155: \"system\" walks the whole language list, not just the first tag", () => {
  // A device configured de → ru → en speaks no German here, but Russian is ranked above English.
  assert.equal(resolveLocale("system", ["de-DE", "ru-RU", "en-US"]), "ru");
  assert.equal(resolveLocale("system", ["fr-FR"]), "en", "nothing recognisable → the fallback locale");
  assert.equal(resolveLocale("system", []), "en");
  assert.equal(resolveLocale("en", ["ru-RU"]), "en", "an explicit choice ignores the platform entirely");
  assert.equal(primarySubtag("ru_RU"), "ru");
  assert.equal(primarySubtag("RU-Cyrl-RU"), "ru");
});

test("V155: while on \"system\" a platform language change is followed, after a choice it is not", () => {
  let tags = ["en-US"];
  let fire = (): void => {};
  const env = fakeEnv({ systemTags: () => tags, onSystemChange: (cb) => { fire = cb; return () => {}; } });
  const c = new LanguageController(env);
  tags = ["ru-RU"]; fire();
  assert.equal(env.lang.at(-1), "ru", "on \"system\" the platform still decides");
  c.setPref("en");
  tags = ["ru-RU"]; fire();
  assert.equal(env.lang.at(-1), "en", "after an explicit choice the platform must not override the user");
});

test("V155: garbage in storage degrades to \"system\", never to a broken locale", () => {
  assert.equal(normalizeLangPref("klingon"), "system");
  assert.equal(normalizeLangPref(null), "system");
  assert.equal(normalizeLangPref(42), "system");
  assert.deepEqual([...LANG_PREFS], UI_LANG_ITEM.options, "row options must mirror the controller");
});

// ---- the row -------------------------------------------------------------------------------------
class Api implements ApiLike {
  readonly settings: Record<string, unknown> | null;
  constructor(settings: Record<string, unknown> | null) { this.settings = settings; }
  get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me/settings") {
      return this.settings ? (Promise.resolve({ settings: this.settings }) as Promise<T>)
        : Promise.reject(new Error("offline"));
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unexpected POST")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const openGeneral = async (
  api: ApiLike,
  language: { get(): Promise<string>; set(v: string): Promise<void> } | undefined,
  locale: "ru" | "en" = "en",
): Promise<StubNode> => {
  const i18n = createI18n({ locale, dicts: { en, ru } });
  const view = createSettingsScreen({ api, i18n, onBack() {}, ...(language ? { language } : {}) });
  const root = view.root as unknown as StubNode;
  const tab = root.find((n) => n.tag === "button" && n.attrs["data-tab"] === "settings");
  assert.ok(tab, "the General section must exist");
  tab.dispatch("click");
  await settle();
  return root;
};

const langSelect = (root: StubNode, i18n = createI18n({ locale: "en", dicts: { en, ru } })): StubNode | null => {
  const row = root.find((n) => n.className.includes("gc-setting-row")
    && n.textContent.includes(i18n.t("settings.language")));
  return row ? row.find((n) => n.tag === "select") ?? null : null;
};

test("V155: the General section carries a tappable language row (the user's complaint)", async () => {
  const seen: string[] = [];
  const root = await openGeneral(new Api({}), {
    get: () => Promise.resolve("system"),
    set: (v) => { seen.push(v); return Promise.resolve(); },
  });
  const sel = langSelect(root);
  assert.ok(sel, "a <select> for the language must be on screen — a keyboard palette is not a control");
  const options = sel.children.map((o) => o.attrs["value"]);
  assert.deepEqual(options, ["system", "ru", "en"]);
  // Autonyms: a user staring at an interface they cannot read must recognise their own language.
  const labels = sel.children.map((o) => o.textContent);
  assert.ok(labels.includes("Русский"), "Russian must be offered as «Русский», not as \"Russian\"");
  assert.ok(labels.includes("English"));
  assert.equal(sel.attrs["value"] ?? sel.value ?? "", "" , "no stray value attribute — selection is on the option");
  const selected = sel.children.find((o) => o.attrs["value"] === "system");
  assert.ok(selected, "the stored preference must be preselected");

  sel.value = "ru";
  sel.dispatch("change");
  await settle();
  assert.deepEqual(seen, ["ru"], "choosing a language must commit through the local port");
});

test("V155: the language row stays reachable when the settings request fails", async () => {
  const root = await openGeneral(new Api(null), {
    get: () => Promise.resolve("system"),
    set: () => Promise.resolve(),
  });
  const sel = langSelect(root);
  assert.ok(sel, "an offline device is exactly when an unreadable interface must be fixable");
});

test("V155: a shell without a language port shows no row (nothing half-wired)", async () => {
  const root = await openGeneral(new Api({}), undefined);
  assert.equal(langSelect(root), null);
});

test("V155: both dictionaries name every option, in the language it names", () => {
  for (const dict of [en, ru]) {
    for (const key of ["settings.language", "settings.opt.ui_lang.system",
      "settings.opt.ui_lang.ru", "settings.opt.ui_lang.en"]) {
      assert.ok(dict[key], `${key} missing`);
    }
    assert.equal(dict["settings.opt.ui_lang.ru"], "Русский");
    assert.equal(dict["settings.opt.ui_lang.en"], "English");
  }
});

// ---- changing the language must not throw the person out of General -------------------------------

test("V155: the shell can reopen General during the synchronous locale rebuild", async () => {
  const rebuilt = createSettingsScreen({
    api: new Api({}), i18n: createI18n({ locale: "ru", dicts: { en, ru } }), onBack() {},
    initialSection: "settings",
  });
  const root = rebuilt.root as unknown as StubNode;
  await settle();
  const title = root.find((n) => n.className.includes("gc-settings-title"));
  assert.equal(title?.textContent, ru["settings.tabSettings"]);
  assert.ok(root.findAll((n) => n.className.includes("gc-setting-label")).length > 0);
});

test("V155: an unknown remembered section falls back to the index", () => {
  const view = createSettingsScreen({
    api: new Api({}), i18n: createI18n({ locale: "en", dicts: { en, ru } }), onBack() {},
    initialSection: "unknown",
  });
  const root = view.root as unknown as StubNode;
  assert.equal(root.find((n) => n.className.includes("gc-settings-title"))?.textContent, en["common.settings"]);
});

// clients/ui/test/visual_more_hub_v73.test.ts — V73 regression guard.
//
// Defect, measured on the running client at 390x844 (probes var/ux-audit/tools/m_more_v73.mjs,
// m_hub_v73.mjs, m_scrollchain_v73.mjs, 2026-07-30, pointer parked off the page):
//
//   1. The tab bar advertised «Чаты | Звонки | Ещё», and behind «Ещё» sat an account card plus seven
//      settings rows — `services=0`. «Перенос данных», «Поддержка» and «Адрес сервера» existed in the
//      build but had no phone-reachable entry point at all (desktop rail or a typed URL only), so the
//      destination named "More" was strictly less than settings.
//   2. The index was NOT a scroll container: .gc-settings-index (849px) sat in a 778px flex column
//      whose shell clips overflow (section.gc-superapp-view overflowY=hidden, client 778 / scroll 920),
//      while its sibling .gc-settings-panel had `flex: 1; overflow-y: auto`. Even before the hub the
//      last row ended at y=818 inside that 778px frame, i.e. «Лицензии» was unreachable.
//
// What is pinned here: the hub exists and is built from the shell's catalogue (not hardcoded in the
// screen), it degrades to the old settings-only screen when no ports are supplied, it never repeats a
// destination the tab bar already advertises, and the stylesheet keeps the four properties that make
// it look deliberate — a scrollable index, a column count derived from width, coloured tone marks and
// a wide last tile instead of a hole.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createSettingsScreen, type MoreHubItem } from "../src/screens/settings_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const here = fileURLToPath(new URL(".", import.meta.url));
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const redesign = strip(readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8"));
const appSource = readFileSync(resolve(here, "../src/screens/app.ts"), "utf8");

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const all = rules(redesign);
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

class OfflineApi implements ApiLike {
  // The hub must not depend on the network: a failed /v1/users/me drops the account card, and the
  // services still have to be there.
  get<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  post<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

const HUB: MoreHubItem[] = [
  { id: "import", label: "Перенос данных", hint: "Перенести чаты из Telegram", glyph: "import", tone: "brand", open() { opened.push("import"); } },
  { id: "support", label: "Поддержка", hint: "Написать команде", glyph: "help", tone: "cyan", open() { opened.push("support"); } },
  { id: "server", label: "Адрес сервера", glyph: "globe", tone: "neutral", open() { opened.push("server"); } },
];
let opened: string[] = [];

const tiles = (root: StubNode): StubNode[] =>
  root.findAll((node) => node.tag === "button" && node.className.includes("gc-more-tile") === true
    && !node.className.includes("gc-more-tile-"));

test("V73: «Ещё» opens on the services this build can reach", async () => {
  opened = [];
  const view = createSettingsScreen({ api: new OfflineApi(), i18n, onBack() {}, hub: { items: HUB } });
  const root = view.root as unknown as StubNode;
  await settle();

  const found = tiles(root);
  assert.equal(found.length, 3, "one tile per reachable service");
  assert.deepEqual(found.map((n) => n.attrs["data-service"]), ["import", "support", "server"]);
  // A tile states what the service is, not just its name: a mark, a label and (when supplied) one line.
  const first = found[0]!;
  assert.ok(first.textContent.includes("Перенос данных"), first.textContent);
  assert.ok(first.textContent.includes("Перенести чаты из Telegram"), first.textContent);
  const mark = first.find((n) => n.className.includes("gc-more-tile-icon"));
  assert.equal(mark?.attrs["data-tone"], "brand", "the mark carries its tone for the stylesheet");
  // A tile is a destination: tapping it runs the shell's own navigation, nothing screen-local.
  first.dispatch("click");
  assert.deepEqual(opened, ["import"]);

  // The header must say what the user tapped. «Настройки» here would rename the destination mid-tap.
  const title = root.find((n) => n.className.includes("gc-settings-title"));
  assert.equal(title?.textContent, i18n.t("shell.more"));
  // Settings did not disappear — they became a group under the services.
  const nav = root.find((n) => n.className.includes("gc-settings-nav"));
  assert.ok(nav?.textContent.includes(i18n.t("settings.tabLicenses")));
  view.destroy();
});

test("V73: with no hub ports the screen is exactly the settings screen it was", async () => {
  const view = createSettingsScreen({ api: new OfflineApi(), i18n, onBack() {} });
  const root = view.root as unknown as StubNode;
  await settle();

  assert.equal(tiles(root).length, 0, "no ports, no hub — and no empty «Сервисы» heading");
  assert.equal(root.find((n) => n.className.includes("gc-more-group")), null);
  const index = root.find((n) => n.className.includes("gc-settings-index"));
  assert.ok(index && !index.className.includes("is-hub"), "the hub layout class is opt-in");
  const title = root.find((n) => n.className.includes("gc-settings-title"));
  assert.equal(title?.textContent, i18n.t("settings.title"));
  view.destroy();
});

test("V73: an empty hub list is the same as no hub", async () => {
  // A build where every optional port is off must not paint a «Сервисы» caption over nothing —
  // that is the "card that says nothing" shape V69/V70 removed elsewhere.
  const view = createSettingsScreen({ api: new OfflineApi(), i18n, onBack() {}, hub: { items: [] } });
  const root = view.root as unknown as StubNode;
  await settle();
  assert.equal(root.find((n) => n.className.includes("gc-more-services")), null);
  assert.equal(root.find((n) => n.className.includes("gc-more-group")), null);
  view.destroy();
});

test("V73: the shell derives the hub from ONE catalogue, so a destination is never lost or doubled", () => {
  // The bar and the hub must be filtered by the same visibility rule, and the hub must drop whatever
  // the bar already shows. Otherwise trimming the tab bar silently deletes a destination (which is how
  // «Карты» became reachable by typed URL only) or widening it lists the same service twice.
  assert.match(appSource, /const mainDestinations\s*=/, "the bar's destinations are a named list");
  assert.match(appSource, /const moreHubItems\s*=/, "the hub is built from a named catalogue");
  assert.match(
    appSource,
    /visibleDestinations\(mainDestinations\(\), contours\)[\s\S]{0,120}\.map\(\(item\) => item\.route\)/,
    "the hub knows exactly what the bar advertises",
  );
  assert.match(appSource, /!advertised\.has\(entry\.route\)/, "and drops those routes from the tiles");
  assert.match(appSource, /visibleDestinations\(catalogue, contours\)/, "optional contours gate the tiles too");
});

test("V73: the index scrolls — the bottom of the list must be reachable", () => {
  const index = all.filter(([s, b]) =>
    /\.gc-settings-index(?![-\w])/.test(s) && /overflow-y\s*:\s*auto/.test(b));
  assert.equal(index.length, 1, "exactly one rule makes the index its own scroll container");
  const [, body] = index[0]!;
  // Without min-height:0 a flex item refuses to shrink below its content and the overflow simply moves
  // back up to the shell, which clips it — the original defect.
  assert.match(body, /min-height\s*:\s*0/, "the flex item may shrink below its content");
  assert.match(body, /flex\s*:\s*1/, "and it takes the free height instead of overflowing the column");
  assert.match(body, /padding-bottom\s*:[^;]*--gc-safe-bottom/, "the last row clears the safe area");
});

test("V73: the column count follows the width, never a hardcoded number", () => {
  const grid = all.filter(([s, b]) => /\.gc-more-grid(?![-\w])/.test(s) && /grid-template-columns/.test(b));
  assert.ok(grid.length >= 1, "the hub grid is declared");
  for (const [, body] of grid) {
    const cols = /grid-template-columns\s*:([^;]+)/.exec(body)?.[1] ?? "";
    assert.match(cols, /auto-fit/, "tracks are generated from the available width (V68 rule)");
    assert.doesNotMatch(cols, /repeat\(\s*\d/, "no repeat(N, ...): a constant column count rots");
    // P0-5, measured on the signed superapp APK at 320dp with Android's font size at 2x
    // (var/ux-audit/p0-matrix-20260731): the tile label grew with the system text zoom but the 132px
    // track floor did not, so the grid still cut two columns while «Поддержка» needed ~166px and
    // punched past the right edge. A floor in px cannot see the text growing; a rem floor can.
    assert.doesNotMatch(cols, /minmax\(\s*\d+px/, "the track floor is not frozen in px while the text zooms");
    assert.match(cols, /rem/, "the floor is expressed in a unit that follows the root font size");
    assert.match(cols, /--gc-font-scale/, "and the in-app size setting moves it too");
    // Even when the floor exceeds the phone, a track may never be wider than its container: without
    // min(100%, …) auto-fit keeps a track larger than the row and the tiles overflow again.
    assert.match(cols, /min\(\s*100%\s*,/, "and the track can never exceed the container width");
  }
});

test("V73: a lone last tile spans the row instead of leaving a hole", () => {
  const orphan = all.filter(([s, b]) =>
    /\.gc-more-tile:nth-child\(odd\):last-child/.test(s) && /grid-column\s*:\s*1\s*\/\s*-1/.test(b));
  assert.ok(orphan.length >= 1, "the odd last tile becomes a wide card");
  // The rule is only sound where auto-fit provably yields two tracks: 3 * 132 + 2 * 10 + 32 = 448px.
  const guarded = /@media\s*\(max-width:\s*447px\)/.test(redesign);
  assert.ok(guarded, "and it is scoped to the widths where 'odd' really means 'alone in its row'");
});

test("V73: tone marks reuse the pinned avatar palette, not new paint", () => {
  // The five tones must all exist (an unstyled tone would fall back to green and the hub would go back
  // to being one column of identical squares), and each must be one of the V10 avatar colours whose
  // light stop is pinned at 3.25:1 against a white glyph — WCAG 1.4.11 wants 3:1 for a graphic.
  const palette = new Set(
    // V88: the palette selector is class-agnostic now (it declares a token the call screen reuses),
    // so this guard matches the tone declaration itself rather than the avatar class.
    all.filter(([s]) => /^\[data-tone="\d"\]$/.test(s.trim()))
      .flatMap(([, b]) => [...b.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]!.toLowerCase())),
  );
  assert.ok(palette.size >= 8, `the avatar palette must still be here: ${palette.size} colours`);
  const marks = all.filter(([s]) => /\.gc-more-tile-icon\[data-tone="[a-z]+"\]/.test(s));
  const tones = marks.map(([s]) => /data-tone="([a-z]+)"/.exec(s)![1]!);
  // V95 removed "violet" from the product: the tones a screen may ask for are the arc plus the
  // neutral for plumbing. The violet rule survives only as a leak guard, and it lives in brand.css.
  for (const tone of ["brand", "cyan", "gold", "neutral"]) {
    assert.ok(tones.includes(tone), `tone ${tone} has no mark colour`);
  }
  for (const [selector, body] of marks) {
    if (/neutral/.test(selector)) continue; // plumbing: a dark slate, deliberately outside the palette
    for (const hex of [...body.matchAll(/#[0-9a-f]{6}/gi)].map((m) => m[0]!.toLowerCase())) {
      assert.ok(palette.has(hex), `${hex} in ${selector} is not from the pinned avatar palette`);
    }
  }
  // The glyph is white on that colour, which is exactly what the 3.25:1 figure was measured against.
  const glyph = all.find(([s, b]) => /\.gc-more-tile-icon(?![-\w[])/.test(s) && /color\s*:\s*#ffffff/.test(b));
  assert.ok(glyph, "the mark's glyph is white");
});

test("V73: a service tile is a card and a settings row is not — the screens must not read alike", () => {
  const tile = all.find(([s, b]) => /\.gc-more-tile(?![-\w])/.test(s) && /border-radius/.test(b));
  assert.ok(tile, "the tile has its own card shape");
  const [, body] = tile!;
  assert.match(body, /background\s*:\s*var\(--gc-bg-elevated\)/, "a surface, from tokens");
  assert.match(body, /border-radius\s*:\s*var\(--gc-radius-lg\)/, "the product's large radius");
  assert.match(body, /transition\s*:[^;]*transform/, "and it answers a touch");
  const pressed = all.find(([s, b]) => /\.gc-more-tile:active/.test(s) && /transform\s*:\s*scale\(/.test(b));
  assert.ok(pressed, "a press is visible before the finger lifts");
  const focus = all.find(([s]) => /\.gc-more-tile:focus-visible/.test(s));
  assert.ok(focus, "keyboard focus is visible too");
});

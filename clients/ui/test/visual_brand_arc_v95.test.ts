// clients/ui/test/visual_brand_arc_v95.test.ts — V95 regression guard (owner directive 2026-07-30,
// pre-beta P1 items 2 "усилить собственный визуальный стиль", 3 "фирменная графика" and 6 "убрать
// ощущение одинаковых бело-зелёных экранов").
//
// Defect, measured on the running client at 390x844, deviceScaleFactor 2, ru-RU (probe
// var/ux-audit/tools/m_hue_v94.mjs plus a pixel read of the V93 sweep, 2026-07-30):
//
//   1. One section painted a hue that exists nowhere else in the product. Sampling the page canvas
//      down x=8 gave chats h152, calls h183, wallet h40 — all inside the GreenChat arc — while «Ещё»
//      measured h248 s79 l96 at the top and h219/h213 further down, i.e. a cold violet canvas over
//      the first third of the screen. Its two group eyebrows measured h245 s53 l51 (4257px² of
//      violet type) and the «Перенос данных» tile mark was #7b82fd. The tone came from a section
//      palette that handed --gc-violet-500 to «Ещё» and to «Перенос данных»; the token was declared
//      but never earned a place in the identity of a product called GreenChat.
//   2. The hub had a tone but no signature: after the services landed there it still opened on a
//      white card over a tinted canvas — the same silhouette as every other list — so the section
//      was told apart only by an 11% wash.
//
// What is pinned here (the layer is clients/web/src/brand.css, loaded last from main.ts):
//   • the layer actually ships, and ships AFTER redesign.css, or none of its overrides win;
//   • no catalogue tile asks for the foreign tone any more, and if one ever does again the layer
//     serves it an in-arc mark instead of #7b82fd — a forgotten attribute cannot ship violet;
//   • every colour the layer itself paints lies on the arc (hue 30..200: amber money → brand green
//     → teal calls), so "brand layer" cannot quietly become "another palette";
//   • «Ещё» keeps its brand plate — the accent gradient, white type, the shipped speech-bubble mark
//     as decoration — and only in the hub build, with AA-clean contrast on both gradient stops;
//   • the markup coupling the plate depends on: the account card is a DIRECT child of the index and
//     the index carries .is-hub only when services exist. If the DOM moves, the plate silently
//     stops applying, and a screenshot would be the only way to notice.
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
const read = (rel: string): string => readFileSync(resolve(here, rel), "utf8");
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

const brandSource = read("../../web/src/brand.css");
const brand = strip(brandSource);
const mainSource = read("../../web/src/main.ts");
const appSource = read("../src/screens/app.ts");
const tokens = strip(read("../src/tokens.css"));

const rules = (css: string): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push([m[1]!.trim().replace(/\s+/g, " "), m[2]!]);
  return out;
};
const brandRules = rules(brand);
const ruleFor = (needle: string): [string, string] => {
  const hit = brandRules.find(([sel]) => sel.includes(needle));
  assert.ok(hit, `brand.css must carry a rule for ${needle}`);
  return hit!;
};

// ── colour maths (sRGB, WCAG 2.x relative luminance) ──────────────────────────────────────────────
const hex = (value: string): [number, number, number] => {
  const raw = value.replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
};
const hue = (rgb: [number, number, number]): { h: number; s: number } => {
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100 };
};
const lum = (rgb: [number, number, number]): number => {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(hex(a)), lum(hex(b))].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

// The arc GreenChat owns end to end: money amber (h≈40) → brand green (h≈152) → calls teal (h≈183).
const ARC = { lo: 30, hi: 200 } as const;

test("V95: the brand layer ships, and ships after the stylesheets it corrects", () => {
  const order = ["./styles.css", "./redesign.css", "./brand.css"].map((spec) =>
    mainSource.indexOf(`import "${spec}"`),
  );
  for (const [i, at] of order.entries()) assert.ok(at > 0, `main.ts must import layer #${i + 1}`);
  assert.ok(order[2]! > order[1]! && order[1]! > order[0]!,
    "brand.css must be imported last — a correction layer loaded before redesign.css loses every override");
});

test("V95: no screen asks for a hue outside the arc, and a forgotten one cannot leak", () => {
  // 1. The catalogue no longer hands out the foreign tone.
  const tones = [...appSource.matchAll(/tone:\s*"([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(tones.length >= 4, "the shell catalogue must still paint its tiles");
  assert.deepEqual(tones.filter((t) => t === "violet"), [],
    "a catalogue tile still asks for tone \"violet\" — the one colour outside the GreenChat arc");

  // 2. And if some future screen asks anyway, the layer repaints it in-arc instead of #7b82fd.
  const [, body] = ruleFor('[data-tone="violet"]');
  const marks = [...body.matchAll(/#[0-9a-fA-F]{3,6}/g)].map((m) => m[0]!);
  assert.ok(marks.length >= 1, "the violet leak guard must actually paint a replacement mark");
  for (const mark of marks) {
    const { h, s } = hue(hex(mark));
    assert.ok(s < 12 || (h >= ARC.lo && h <= ARC.hi),
      `leak-guard mark ${mark} sits at hue ${h.toFixed(0)} — outside the arc ${ARC.lo}..${ARC.hi}`);
  }

  // 3. The hub itself is a neutral container: its section tokens must not reach for the violet token.
  const [, hubTokens] = ruleFor('[data-gc-section="settings"]');
  assert.ok(!hubTokens.includes("--gc-violet-500"),
    "«Ещё» must not be tinted with the violet token — its identity is the brand plate, not a foreign wash");
  assert.ok(hubTokens.includes("--gc-section-ink"),
    "the section must still publish an ink tone, or the group eyebrows lose their colour");
});

test("V95: every colour the brand layer paints lies on the arc", () => {
  const literals = [...brand.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0]!);
  assert.ok(literals.length >= 3, "the layer must paint something concrete");
  const offArc: string[] = [];
  for (const value of literals) {
    const { h, s } = hue(hex(value));
    if (s < 12) continue; // white / near-neutral glass is not a hue statement
    if (h < ARC.lo || h > ARC.hi) offArc.push(`${value} (hue ${h.toFixed(0)})`);
  }
  assert.deepEqual(offArc, [], `brand layer paints off-arc colour(s): ${offArc.join(", ")}`);
});

test("V95: «Ещё» carries the brand plate, with AA-clean type on both gradient stops", () => {
  const [plateSel, plate] = ruleFor(".gc-settings-index.is-hub > .gc-account-card");
  assert.ok(plateSel.includes(".is-hub"),
    "the plate must be scoped to the hub build — a settings-only screen keeps the quiet white card");
  assert.match(plate, /background:\s*var\(--gc-accent-grad\)/,
    "the plate must use the shipped accent gradient, not a one-off colour");
  assert.match(plate, /color:\s*#ffffff/i, "plate type must be white");

  // The gradient is declared once in tokens.css; the plate inherits whatever the theme sets, so the
  // contrast claim is checked against the real stops of the light theme (the darkest and lightest).
  const grad = tokens.match(/--gc-accent-grad:\s*linear-gradient\(([^)]*)\)/);
  assert.ok(grad, "tokens.css must still declare --gc-accent-grad");
  const stops = [...grad![1]!.matchAll(/#[0-9a-fA-F]{6}/g)].map((m) => m[0]!);
  assert.ok(stops.length >= 2, "the accent gradient must have at least two stops");
  for (const stop of stops) {
    assert.ok(contrast("#ffffff", stop) >= 4.5,
      `white type on gradient stop ${stop} measures ${contrast("#ffffff", stop).toFixed(2)}:1 — below WCAG AA 4.5:1`);
  }

  // The handle must not be dimmed into failure: 82% white on the light stop measures ~3.6:1.
  const [, handle] = ruleFor(".gc-account-card-handle");
  assert.ok(!/opacity/.test(handle),
    "the handle must be separated by weight/size, not by opacity — a dimmed white fails AA on the plate");
});

test("V95: the brand mark is decoration — carried by paint, not by content", () => {
  const [sel, mark] = ruleFor(".gc-account-card::after");
  assert.ok(sel.includes(".is-hub"), "the watermark belongs to the hub plate only");
  assert.match(mark, /background-image:\s*url\("data:image\/svg\+xml/,
    "the mark must be inlined — a network fetch for decoration is a blank plate on a cold start");
  assert.match(mark, /pointer-events:\s*none/,
    "decoration must never eat the tap that opens the profile");
  const opacity = Number(mark.match(/opacity:\s*([\d.]+)/)?.[1] ?? "1");
  assert.ok(opacity > 0 && opacity <= 0.2,
    `watermark opacity ${opacity} — a mark this loud competes with the name it sits behind`);
  assert.match(mark, /content:\s*""/,
    "the mark must be an empty pseudo-element: assistive tech announces ::after content as text");
});

// ── the markup the plate is coupled to ────────────────────────────────────────────────────────────
class OfflineApi implements ApiLike {
  get<T>(_path?: string): Promise<T> { return Promise.reject(new Error("offline")); }
  post<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("offline")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}
// The plate only exists while there IS an account card: an unreachable /v1/users/me removes it (the
// hub degrades to services + settings). So the coupling is checked on a reachable session, and the
// offline path is checked for the opposite — no card, and therefore no half-painted plate.
class LiveApi extends OfflineApi {
  override get<T>(path: string): Promise<T> {
    if (path === "/v1/users/me") return Promise.resolve({ username: "uxann97382", name: "Анна Ковалёва" } as T);
    return Promise.reject(new Error("not stubbed"));
  }
}
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const HUB: MoreHubItem[] = [
  { id: "import", label: "Перенос данных", hint: "Перенести чаты", glyph: "import", tone: "brand", open: () => {} },
  { id: "support", label: "Поддержка", hint: "Написать команде", glyph: "help", tone: "cyan", open: () => {} },
];
test("V95: the plate's DOM coupling holds — .is-hub index with the card as a direct child", async () => {
  const view = createSettingsScreen({ api: new LiveApi(), i18n, onBack() {}, hub: { items: HUB } });
  const root = view.root as unknown as StubNode;
  await settle();
  const index = root.find((n) => n.className.includes("gc-settings-index"));
  assert.ok(index, "the settings index must exist");
  assert.ok(index!.className.includes("is-hub"),
    "with services the index must carry .is-hub — the plate is scoped to that class");
  const card = index!.children.find((c) => (c as StubNode).className.includes("gc-account-card"));
  assert.ok(card,
    "the account card must stay a DIRECT child of the index: brand.css selects it with '>' and a deeper nesting silently drops the plate");
  view.destroy();

  const offline = createSettingsScreen({ api: new OfflineApi(), i18n, onBack() {}, hub: { items: HUB } });
  const offlineRoot = offline.root as unknown as StubNode;
  await settle();
  const offlineIndex = offlineRoot.find((n) => n.className.includes("gc-settings-index"));
  assert.equal(offlineIndex!.children.find((c) => (c as StubNode).className.includes("gc-account-card")), undefined,
    "with /v1/users/me unreachable the card is dropped entirely — the hub must never show an empty brand plate");
  offline.destroy();

  const plain = createSettingsScreen({ api: new LiveApi(), i18n, onBack() {} });
  const plainRoot = plain.root as unknown as StubNode;
  await settle();
  const plainIndex = plainRoot.find((n) => n.className.includes("gc-settings-index"));
  assert.ok(plainIndex && !plainIndex.className.includes("is-hub"),
    "without services the screen is a settings list and must keep the quiet white card");
  plain.destroy();
});

test("V96: every section mixes its own arc token, loud enough to be seen at arm's length", () => {
  // Measured before the fix (var/ux-audit/tools/m_sectionid_v96.mjs — the average colour of the top
  // 18% of each screen at 390x844): chats h148 s40.0 l93.7, calls h178 s34.8 l90.4, wallet h54 s32.6
  // l93.5. The two sections a user actually swipes between measured Δhue 29° / Δlight 3.3 — real in a
  // colour picker, invisible on a phone. After: chats s44.6, calls h181 s40.8 l86.5, wallet h48 s43.9,
  // Δhue 33° / Δlight 5.4 for that pair, and the «Ещё» plate keeps Δlight 28.7 against both.
  const washes = new Map<string, string>();
  for (const [sel, body] of brandRules) {
    const section = sel.match(/data-gc-section="([a-z]+)"/)?.[1];
    const wash = body.match(/--gc-section-wash:\s*([^;]+);/)?.[1];
    if (section && wash) washes.set(section, wash.trim());
  }
  for (const section of ["chats", "calls", "wallet"]) {
    const wash = washes.get(section);
    assert.ok(wash, `section «${section}» must publish its own wash in the brand layer`);
    const pct = Number(wash!.match(/(\d+)%/)?.[1] ?? "0");
    assert.ok(pct >= 15,
      `section «${section}» mixes only ${pct}% of its tone — that is the strength that measured Δhue 29°/Δlight 3 and read as "all screens look the same"`);
  }
  const bases = ["chats", "calls", "wallet"].map((s) => washes.get(s)!.match(/--gc-[a-z]+-500/)?.[0]);
  assert.equal(new Set(bases).size, bases.length,
    "two sections mix the same token — then no amount of strength tells them apart");
  // The hub is the exception on purpose: it is a container for coloured services and is told apart
  // by the brand plate, not by a wash, so its own mix stays deliberately faint.
  const hub = washes.get("settings");
  assert.ok(hub && Number(hub.match(/(\d+)%/)?.[1] ?? "99") <= 8,
    "«Ещё» must stay a neutral container — its identity is the plate, and a loud wash would fight it");
});

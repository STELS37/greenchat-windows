// clients/ui/test/finance_tile_caption_v157.test.ts — V157: the wallet tile caption.
//
// Owner report 2026-08-03, two screenshots of the wallet: «зачем тут адрес если это и так есть на
// странице получить» plus a Russian device where the quick-action row printed clipped words. Both
// halves ended in the same place — the tile caption — and both fixes are invisible to the eye that
// only reads the CSS or only reads the locale file, which is why they are frozen here.
//
// What was measured (probe: Playwright Chromium, the real ancestor chain, tokens.css + styles.css +
// redesign.css in main.ts order, 7 tiles × 6 widths × 6 font steps = 252 label renders):
//
//   variant                                              clipped
//   the tree before this campaign                          29     every one of them Russian
//   + padding-block 6px (instead of 8px)                    3     ← all HEIGHT clips gone
//   + overflow-wrap: anywhere                               0
//   the shipped tree (padding 6px, wrap, soft hyphens)      0
//   the shipped tree, overflow-wrap reverted                0     ← the soft hyphen carries those 3
//   the shipped tree, the padding reverted                 30     ← wrapping with no room is WORSE
//
// So two declarations are load-bearing and one locale character is load-bearing, and none of them
// can be defended by the probe itself (a screenshot cannot see an accessible name, and a probe that
// builds its own fixture cannot tell `label` from `short`). This suite covers exactly that gap:
//
//   1. the vertical budget of the tile is arithmetic, not a literal — the guard recomputes it from
//      the CSS so that a future icon or line-height change fails here instead of on a phone;
//   2. the Russian caption breaks on U+00AD (SOFT HYPHEN) while `title`/`aria-label` stay whole, so
//      no screen reader ever announces a hyphenated word;
//   3. no tile anywhere leaks a soft hyphen into its accessible name;
//   4. the English captions stay byte-identical to the full labels — modal_focus_v152.test.ts finds
//      the money sheets by matching VISIBLE tile text against `en["finance.receive"]`, so an English
//      "short" form would break a suite two directories away with a confusing error;
//   5. every tile-caption key exists in BOTH dictionaries (i18n.test.ts asserts no such parity, and
//      a missing key silently falls back to the other locale — i.e. a Russian phone printing "PIN").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import { createFinanceScreen } from "../src/screens/finance_screen.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { installDomStub, settle, StubNode } from "./dom_stub.ts";

const SOFT_HYPHEN = "\u00AD";
const bare = (text: string): string => text.split(SOFT_HYPHEN).join("");

// ---- 1. the vertical budget, recomputed from the shipped CSS -------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = (rel: string): string =>
  strip(readFileSync(resolve(here, rel), "utf8"));

const SCOPE = ":is(.gc-superapp, .gc-overlay, .gc-palette-overlay, .gc-msgmenu-layer)";

/** Split a selector list on TOP-LEVEL commas — `:is(a, b, c)` is one selector, not three. */
function selectorList(head: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === "(") depth += 1;
    else if (head[i] === ")") depth -= 1;
    else if (head[i] === "," && depth === 0) {
      out.push(head.slice(start, i));
      start = i + 1;
    }
  }
  out.push(head.slice(start));
  return out.map((s) => s.replace(/\s+/g, " ").trim());
}

/**
 * Every declaration `<SCOPE> <selector>` collects at the DEFAULT viewport, merged in document order
 * (last wins, as the cascade does for these equal-specificity rules).
 *
 * Not `indexOf(selector + " {")`: the selection-suppression rule added in the same campaign lists
 * `.gc-finance-action, .gc-finance-action-label` together and sits ~45 lines ABOVE the label rule,
 * so a first-match lookup silently read `user-select: none` and reported the clamp as missing.
 * `@media` bodies are skipped on purpose — they are narrow-phone overrides and the budget below is
 * the default-width claim (the ≤359.98px block only narrows padding-inline).
 */
function ruleOf(css: string, selector: string): Record<string, string> {
  const want = `${SCOPE} ${selector}`;
  const out: Record<string, string> = {};
  let matched = 0;
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) break;
    const head = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth += 1;
      else if (css[j] === "}") depth -= 1;
      j += 1;
    }
    const selectors = selectorList(head);
    if (!head.startsWith("@") && selectors.includes(want)) {
      matched += 1;
      for (const part of css.slice(open + 1, j - 1).split(";")) {
        const colon = part.indexOf(":");
        if (colon === -1) continue;
        out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
      }
    }
    i = j;
  }
  assert.ok(matched > 0, `redesign.css no longer styles \`${selector}\` in the app scope`);
  return out;
}

const px = (value: string): number => {
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  assert.ok(m, `expected a px length, got "${value}"`);
  return Number(m![1]);
};

test("V157: the tile still has room for the two lines its clamp promises", () => {
  const redesign = sheet("../../web/src/redesign.css");
  const tokens = sheet("../src/tokens.css");
  const tile = ruleOf(redesign, ".gc-finance-action");
  const label = ruleOf(redesign, ".gc-finance-action-label");
  const iconBox = ruleOf(redesign, ".gc-finance-action-icon");

  // The clamp is the promise being checked. If it ever goes away this arithmetic is meaningless.
  assert.equal(label["-webkit-line-clamp"], "2", "the caption is a two-line box or this budget is moot");
  const lines = Number(label["-webkit-line-clamp"]);

  // `padding: <block> <inline>` — the block half is what the caption competes with.
  const padding = px(tile.padding!.split(/\s+/)[0]!);
  const height = px(tile.height!);
  const gap = px(tile.gap!);
  const icon = px(iconBox.height!);

  // font-size: var(--gc-fs-12) → tokens.css: --gc-fs-12: calc(12px * var(--gc-font-scale)),
  // and --gc-font-scale is 1 at the default step. The token is resolved rather than assumed so a
  // retune of the type scale lands here first.
  const token = /^var\((--gc-fs-\d+)\)$/.exec(tile["font-size"] ?? "");
  assert.ok(token, "the tile no longer takes its font size from a --gc-fs-* token");
  const declared = new RegExp(`${token![1]}:\\s*calc\\(([\\d.]+)px`).exec(tokens);
  assert.ok(declared, `tokens.css no longer defines ${token![1]} as calc(<n>px * scale)`);
  const fontSize = Number(declared![1]);
  const lineHeight = Number(tile["line-height"]);
  assert.ok(Number.isFinite(lineHeight), "the tile needs a unitless line-height to budget with");

  const room = height - 2 * padding - icon - gap;
  const needed = lines * fontSize * lineHeight;
  assert.ok(
    room >= needed,
    `the caption box has ${room}px for ${lines} lines that need ${needed}px ` +
      `(height ${height} − 2×${padding} padding − ${icon} icon − ${gap} gap). ` +
      "This is the defect the owner photographed: the clamp allows a second line the tile cannot " +
      "hold, so the glyphs are cut horizontally through the middle. Measured: 29 of 252 label " +
      "renders clipped at 8px padding, 0 at 6px.",
  );

  // The other load-bearing declaration. Its control run (soft hyphens kept, wrap reverted) also
  // measured 0 clips, so it is not what saves Send/Receive — it is the safety net for every OTHER
  // locale, which has no hand-placed break opportunity at all.
  assert.equal(
    label["overflow-wrap"],
    "anywhere",
    "without it an unbreakable caption in an untested locale clips instead of wrapping",
  );
});

// ---- 2. the DOM contract: what is painted vs what is announced -----------------------------------
const WALLET = {
  total_usd: "0",
  assets: [{
    id: "GUSD", name: "GreenChat USD", kind: "gfiat", enabled: true, balance: "0",
    hold: "0", available: "0", usd_value: "0", usd_rate: "1000000000",
  }],
  payment_settings: { has_pin: false, two_factor_enabled: false, security_hold_until: 0 },
};

class WalletApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path === "/v1/config") return Promise.resolve({ features: { payments: true, cards: false } } as unknown as T);
    if (path === "/v1/wallet") return Promise.resolve(WALLET as unknown as T);
    if (path === "/v1/wallet/history?limit=8") return Promise.resolve({ items: [], next_before_id: null } as unknown as T);
    if (path === "/v1/envelopes") return Promise.resolve({ envelopes: [] } as unknown as T);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  }
  post<T>(): Promise<T> { return Promise.resolve({ ok: true } as unknown as T); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unexpected PUT")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unexpected PATCH")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unexpected DELETE")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function walletTiles(locale: "ru" | "en"): Promise<StubNode[]> {
  installDomStub();
  const body = new StubNode("body");
  (globalThis as unknown as { document: { body: StubNode } }).document.body = body;
  const screen = createFinanceScreen({
    api: new WalletApi(),
    i18n: createI18n({ locale, dicts: { en, ru } }),
    view: "wallet",
    onNavigate: () => {},
    onBack: () => {},
  });
  const root = screen.root as unknown as StubNode;
  body.append(root);
  await settle();
  const tiles = root.findAll((n) => n.hasClass("gc-finance-action"));
  assert.ok(tiles.length >= 6, `the wallet row rendered ${tiles.length} tiles`);
  return tiles;
}

/** The tile whose ACCESSIBLE NAME is `name` — deliberately not its visible text. */
function tileNamed(tiles: StubNode[], name: string): StubNode {
  const found = tiles.filter((n) => n.getAttribute("aria-label") === name);
  assert.equal(found.length, 1, `expected exactly one tile named "${name}", found ${found.length}`);
  return found[0]!;
}
const captionOf = (tile: StubNode): string => {
  const label = tile.findAll((n) => n.hasClass("gc-finance-action-label"))[0];
  assert.ok(label, "a tile without a caption span");
  return label!.textContent;
};

test("V157: the Russian caption breaks on a soft hyphen the accessible name never sees", async () => {
  const tiles = await walletTiles("ru");

  for (const [key, hyphenated] of [
    ["finance.send", "Отпра\u00ADвить"],
    ["finance.receive", "Попол\u00ADнить"],
  ] as const) {
    const full = ru[key];
    const tile = tileNamed(tiles, full);
    assert.equal(
      captionOf(tile),
      hyphenated,
      `the painted caption of "${full}" must carry the hand-placed break opportunity`,
    );
    // Invisible, not decorative: strip the character and the word must be spelled correctly. This
    // is what catches a "Отпра-вить" typed with a real hyphen, which would print a dash on a wide
    // screen where the word fits.
    assert.equal(bare(captionOf(tile)), full, "U+00AD must be the only difference from the full word");
    assert.equal(tile.getAttribute("title"), full, "the tooltip reads the whole word");
    assert.ok(
      !tile.getAttribute("aria-label")!.includes(SOFT_HYPHEN),
      "a screen reader must never be handed a break hint",
    );
  }
});

test("V157: no tile hides a soft hyphen or a caption mismatch in its accessible name", async () => {
  for (const locale of ["ru", "en"] as const) {
    for (const tile of await walletTiles(locale)) {
      const name = tile.getAttribute("aria-label");
      assert.ok(name, `${locale}: a tile without an accessible name`);
      assert.equal(tile.getAttribute("title"), name, `${locale}: tooltip and accessible name disagree`);
      assert.ok(!name!.includes(SOFT_HYPHEN), `${locale}: "${name}" leaks U+00AD into the accessible name`);
      assert.ok(captionOf(tile).length > 0, `${locale}: "${name}" paints an empty caption`);
    }
  }
});

test("V157: the English captions stay identical to the full labels", async () => {
  // Not cosmetic. modal_focus_v152.test.ts locates the money sheets with
  //   root.findAll(hasClass("gc-finance-action")).find(n => n.textContent.includes(en["finance.receive"]))
  // i.e. it matches the VISIBLE text against the FULL label. English needs no shortening (the probe
  // measured "Send" at 32px and "Receive" at 51px against a 68px box), so the keys exist purely to
  // keep the decision translatable — and they must stay equal, or V152 fails with "no such sheet".
  assert.equal(en["finance.shortSend"], en["finance.send"]);
  assert.equal(en["finance.shortReceive"], en["finance.receive"]);
  const tiles = await walletTiles("en");
  for (const key of ["finance.send", "finance.receive"] as const) {
    const tile = tileNamed(tiles, en[key]);
    assert.ok(
      tile.textContent.includes(en[key]),
      `V152 finds this tile by its visible text: "${en[key]}" must appear in "${tile.textContent}"`,
    );
  }
});

test("V157: every tile-caption key exists in both dictionaries", () => {
  // i18n.test.ts asserts no en/ru parity, and a missing key falls back to the OTHER locale, so the
  // failure mode is silent: a Russian wallet printing an English caption next to Russian ones.
  // The six keys are the tiles that need a caption shorter than their name; `exchange`, `withdraw`
  // and `cards` pass no short form because their own label already fits the measured box.
  const used = [
    "finance.shortSend",
    "finance.shortReceive",
    "finance.shortWhitelist",
    "finance.shortPin",
    "finance.shortHistory",
    "finance.shortDemoTopUp",
  ];
  const declared = [...new Set([...Object.keys(en), ...Object.keys(ru)])].filter((k) =>
    k.startsWith("finance.short"),
  );
  assert.deepEqual(
    declared.sort(),
    [...used].sort(),
    "a tile caption key appeared or vanished — check finance_screen.ts and update this list",
  );
  for (const key of declared) {
    for (const [name, dict] of [["en", en], ["ru", ru]] as const) {
      const value = (dict as Record<string, string>)[key];
      assert.ok(value && value.trim().length > 0, `${name} is missing the tile caption ${key}`);
    }
  }
});

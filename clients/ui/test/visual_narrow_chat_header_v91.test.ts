// clients/ui/test/visual_narrow_chat_header_v91.test.ts — V91 regression guard.
//
// Defect, measured through the WebView of the signed direct APK (versionCode 1000010) on redroid 15
// with `wm density 540` (= a 320 dp phone, the narrowest width in the beta gate), route #/chat/15,
// probe clients/gc-p0-devprobe.mjs:
//
//   .gc-feed-header   x=0..320  w=320   padding-inline 16, gap 10
//   .gc-icon-btn      w=44             (back)
//   .gc-feed-identity w=152            padding 4px 8px, gap 10
//   .gc-feed-avatar   w=38
//   .gc-feed-header-actions w=88       (two 44 px buttons)
//   .gc-feed-title    w=88  scrollWidth=127  → "Saved Messages" painted as "Saved Mes…"
//
// So on the narrowest supported phone the chat title — the one thing that tells you who you are
// talking to — got 27 % of the bar, and the rest went to chrome padding. The touch targets stay at
// 44 px (Android's minimum); the width is taken back from the gutter, the gaps and the avatar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Concatenated bodies of every `@media (max-width: <=380px)` block. */
function narrowCss(): string {
  const out: string[] = [];
  const re = /@media\s*\(max-width:\s*(\d+)px\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (Number(m[1]) > 380) continue;
    let depth = 1;
    let i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(css.slice(re.lastIndex, i - 1));
  }
  return out.join("\n");
}

/** The value a property gets for `selector` inside the narrow blocks, in px. */
function narrowPx(selector: string, property: string): number | null {
  const body = narrowCss();
  const re = new RegExp(`[^{}]*\\${selector}\\s*\\{([^}]*)\\}`, "g");
  let m: RegExpExecArray | null;
  let value: number | null = null;
  while ((m = re.exec(body))) {
    const decl = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(m[1]!);
    if (decl) value = Number(decl[1]);
  }
  return value;
}

const BACK = 44;
const ACTIONS = 88; // two 44 px buttons — deliberately NOT shrunk below the touch-target minimum.

test("V91: at 320 dp the chat title gets a usable share of the header", () => {
  const gutter = narrowPx(".gc-feed-header", "padding-inline");
  const headerGap = narrowPx(".gc-feed-header", "gap");
  const identityGap = narrowPx(".gc-feed-identity", "gap");
  const identityPad = narrowPx(".gc-feed-identity", "padding-inline");
  const avatar = narrowPx(".gc-feed-avatar", "width");
  for (const [name, v] of Object.entries({ gutter, headerGap, identityGap, identityPad, avatar })) {
    assert.notEqual(v, null, `the narrow-width block must set ${name} for the chat header`);
  }
  const title =
    320 - 2 * gutter! - BACK - 2 * headerGap! - 2 * identityPad! - avatar! - identityGap! - ACTIONS;
  assert.ok(
    title >= 110,
    `the chat title would get ${title} px of a 320 dp header (measured 88 px before this rule); ` +
      "a name needs at least ~110 px to read as a name and not as an ellipsis",
  );
});

test("V91: the touch targets are not what got sacrificed", () => {
  const body = narrowCss();
  const shrunk = /\.gc-icon-btn\s*\{[^}]*(?:width|height|min-width|min-height)\s*:\s*(\d+)px/.exec(body);
  if (shrunk) {
    assert.ok(
      Number(shrunk[1]) >= 44,
      `icon buttons drop to ${shrunk[1]}px on narrow phones; 44px is the floor for a touch target`,
    );
  }
});

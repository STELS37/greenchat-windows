// clients/ui/test/text_zoom_levels.test.ts — the system-font cap has to engage on the step that
// actually breaks the layout, not one step later.
//
// Measured on the signed direct APK (versionCode 1000010) on redroid 15, 1080x2400 @440dpi (392 dp),
// `settings put system font_scale 1.30`: the wallet quick-action tile label "Addresses" is cut
// mid-word at the tile edge with no ellipsis. The cap that fixes exactly this was gated on
// `[data-gc-text-zoom="large"]`, i.e. >= 1.4, so at Android's 1.3 step it never applied and the
// screenshot still showed the clipped label. The four-up tile row is narrower than the five-cell
// bottom bar, so it needs the cap one step earlier: the two surfaces need two levels, not one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  TEXT_ZOOM_LARGE,
  TEXT_ZOOM_MEDIUM,
  isLargeTextZoom,
  textZoomLevel,
} from "../src/text_zoom.ts";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../../web/src/styles.css"), "utf8");

test("textZoomLevel: default renders unchanged, 1.3 is already capped, 1.4 is large", () => {
  assert.equal(textZoomLevel(1), null);
  assert.equal(textZoomLevel(1.1), null);
  assert.equal(textZoomLevel(TEXT_ZOOM_MEDIUM), "medium");
  assert.equal(textZoomLevel(1.3), "medium");
  assert.equal(textZoomLevel(TEXT_ZOOM_LARGE), "large");
  assert.equal(textZoomLevel(2), "large");
  assert.equal(textZoomLevel(Number.NaN), null);
  assert.ok(TEXT_ZOOM_MEDIUM < TEXT_ZOOM_LARGE);
  // The bottom bar keeps its own, later threshold.
  assert.equal(isLargeTextZoom(1.3), false);
  assert.equal(isLargeTextZoom(1.4), true);
});

test("the tile cap is not gated on the large level alone", () => {
  const index = css.indexOf(".gc-finance-action-label");
  assert.ok(index > 0, "the tile label cap must exist in styles.css");
  const block = css.slice(Math.max(0, index - 400), index + 200);
  assert.ok(
    block.includes('[data-gc-text-zoom]'),
    "the tile label cap must apply at any measured system zoom level, not only large",
  );
  assert.ok(
    !/\[data-gc-text-zoom="large"\]\s*\n?\s*\.gc-finance-action-label/.test(css),
    "the tile label cap must not be restricted to the large level",
  );
});

// V193 — copied-message confirmation regression guard.
//
// Device report (Android, dark theme, keyboard open): a successful copy painted “Copied” as a red,
// full-width row above the composer. The status class was globally styled as danger regardless of
// meaning. Success is now an explicit green compact overlay; failures retain the danger tone.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const feed = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");
const css = readFileSync(resolve(here, "../../web/src/redesign.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

test("V193: a successful clipboard write uses a short-lived success tone", () => {
  assert.match(
    feed,
    /\(\) => showStatus\(i18n\.t\("feed\.copied"\), "success", 1800\)/,
    "copy success must not inherit the error default",
  );
  assert.match(
    feed,
    /\(\) => showStatus\(i18n\.t\("feed\.copyUnavailable"\)\)/,
    "clipboard rejection remains an error",
  );
  assert.match(feed, /type FeedStatusTone = "error" \| "success" \| "info"/);
  assert.match(feed, /statusEl\.setAttribute\("data-tone", tone\)/);
  assert.match(feed, /statusEl\.classList\.add\("is-leaving"\)/, "the acknowledgement fades instead of vanishing abruptly");
  assert.match(feed, /statusEl\.removeAttribute\("data-tone"\)/, "a later status cannot inherit a stale tone");
});

test("V193: transient feedback overlays the conversation instead of reflowing the composer", () => {
  assert.match(
    feed,
    /class: "gc-feed-main"[^\n]*\[listBox, stageEl, jumpBtn, statusEl\]/,
    "the positioned conversation stage owns the feedback node",
  );
  const block = css.match(/\.gc-feed-main > \.gc-feed-status\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(block, /position:\s*absolute/);
  assert.match(block, /left:\s*50%/);
  assert.match(block, /bottom:\s*12px/);
  assert.match(block, /transform:\s*translateX\(-50%\)/, "the pill stays centred after its animation ends");
  assert.match(block, /width:\s*max-content/);
  assert.match(block, /max-width:\s*min\(calc\(100% - 112px\), 360px\)/);
  assert.match(block, /border-radius:\s*var\(--gc-radius-pill\)/);
  assert.match(block, /pointer-events:\s*none/);
  assert.doesNotMatch(block, /width:\s*100%/, "confirmation must never become the old full-width strip");
});

test("V193: success is green, errors are red, and reduced-motion users get no entrance motion", () => {
  const success = css.match(/\.gc-feed-main > \.gc-feed-status\[data-tone="success"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const error = css.match(/\.gc-feed-main > \.gc-feed-status\[data-tone="error"\]\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(success, /background:\s*var\(--gc-accent-soft\)/);
  assert.match(success, /color:\s*var\(--gc-accent-soft-fg\)/);
  assert.doesNotMatch(success, /--gc-danger/);
  assert.match(error, /color:\s*var\(--gc-danger\)/);
  assert.match(css, /\.gc-feed-main > \.gc-feed-status\.is-leaving\s*\{[^}]*animation:\s*gc-feed-status-exit 140ms/s);
  assert.match(css, /prefers-reduced-motion:\s*reduce[\s\S]*?\.gc-feed-main > \.gc-feed-status,[\s\S]*?animation:\s*none/);
});

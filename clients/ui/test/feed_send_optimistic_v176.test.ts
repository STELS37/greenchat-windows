// V176 — Telegram-like outgoing message UX regression guard.
//
// The Android screenshot reported two coupled defects: every message sat in an artificial 5-second
// outbox hold, while the feed also opened a full-width "Sending… / Undo" snackbar above the composer.
// Delivery state belongs inside the optimistic bubble; only destructive delete keeps an undo hold.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const feed = readFileSync(resolve(here, "../src/screens/feed_screen.ts"), "utf8");
const outbox = readFileSync(resolve(here, "../../core/src/outbox.ts"), "utf8");
const styles = readFileSync(resolve(here, "../../web/src/styles.css"), "utf8");
const ru = readFileSync(resolve(here, "../src/locales/ru.ts"), "utf8");
const en = readFileSync(resolve(here, "../src/locales/en.ts"), "utf8");

test("V176: a normal send is not wired to the destructive-action undo snackbar", () => {
  assert.match(feed, /await outbox\.enqueueMessage\(chatId, body\);/);
  assert.doesNotMatch(feed, /showUndo\(i18n\.t\("feed\.undoSend"\)/);
  assert.doesNotMatch(ru, /"feed\.undoSend"/);
  assert.doesNotMatch(en, /"feed\.undoSend"/);
  assert.match(feed, /showUndo\(i18n\.t\("feed\.undoDelete"\)/, "delete still has a recovery action");
});

test("V176: production outbox defaults are immediate for messages and delayed only for delete", () => {
  assert.match(outbox, /const DEFAULT_MUTATION_UNDO_MS = 0;/);
  assert.match(outbox, /const DEFAULT_DELETE_UNDO_MS = 5000;/);
  assert.match(outbox, /item\.kind === "delete" \? this\.deleteUndoMs : this\.mutationUndoMs/);
});

test("V176: pending delivery uses a compact vector icon inside the bubble, never an emoji clock", () => {
  assert.match(feed, /icon\("clock", "gc-icon gc-bubble-status-icon"\)/);
  assert.doesNotMatch(feed, /tickGlyph\(tick\)/);
  assert.match(styles, /\.gc-bubble-status-icon\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s);
});

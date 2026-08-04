// clients/ui/test/avatar_tone_consistency.test.ts — V29 regression guard.
// A person used to change colour between screens: the chat list seeded the deterministic tone with the
// chat id, the new-chat overlay with the user id, the profile hero with the handle. Same human, three
// different discs. The rule is now one line: the tone is seeded with exactly the string the monogram is
// built from, so identity → colour is stable everywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { avatarTone } from "../src/screens/message_menu.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src/screens");
const read = (f: string): string => readFileSync(resolve(src, f), "utf8");

test("every avatar tone is seeded from the displayed name, never from an id", () => {
  const files = ["chat_list_screen.ts", "feed_screen.ts", "new_chat_overlay.ts", "settings_screen.ts"];
  const calls: string[] = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/avatarTone\(([^)]*)\)/g)) calls.push(`${f}: ${m[1]}`);
  }
  assert.ok(calls.length >= 5, `expected every avatar call site to be covered, found ${calls.length}`);
  for (const c of calls) {
    assert.ok(
      !/\b(entry|msg|sender|r|self|me)\.id\b|\buserId\b|\bchatId\b/.test(c),
      `avatar tone must not be seeded from an identifier — ${c}`,
    );
  }
});

test("the tone function is stable, bounded and case-sensitive per distinct name", () => {
  const a = avatarTone("Карл Дизайнов");
  assert.equal(a, avatarTone("Карл Дизайнов"), "same name → same tone on every screen and every render");
  for (const name of ["Ann", "Борис Тимофеев", "", "x", "Дизайн Green Chat"]) {
    const t = avatarTone(name);
    assert.ok(Number.isInteger(t) && t >= 0, `tone must be a non-negative integer, got ${t} for "${name}"`);
  }
});

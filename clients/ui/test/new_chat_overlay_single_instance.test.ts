// Regression guard for the «Новый чат» sheet — QA sweep of 2026-08-03 (headless Chromium 1280x860,
// ru-RU, ephemeral stand, ordinary + hostile persona). Two defects were reproduced on the live build:
//
//   1. Double tap stacks a second sheet. Two pointer/mouse/click pairs 120 ms apart on «Начать первый
//      чат» produced TWO `.gc-overlay` nodes (measured {mid: 1, after: 2}). Each one paints its own
//      `rgba(2, 12, 8, 0.58)` scrim, so the page visibly darkened, and dismissing the top sheet
//      uncovered an identical one underneath — the app read as refusing to close. An impatient tap on
//      a slow phone is the ordinary way to hit this, not an abuse case.
//   2. The sheet outlives its screen. With the sheet open, tapping «Контакты» switched the section
//      (hash "#/contacts", both headings present) while `.gc-overlay` stayed connected to the body,
//      blocking the screen the person had just opened. `destroy()` cannot reach it because a modal is
//      mounted on `document.body` (dom.ts modalRoot), not inside the screen's own subtree.
//
// Both are the same missing fact: the screen never held a reference to its own sheet. These tests pin
// the reference down — they fail on the pre-fix build with 2 overlays and 1 stranded overlay.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike } from "../src/screens/api.ts";
import { createChatListScreen } from "../src/screens/chat_list_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

// A fresh account: no chats, so the empty state paints its «Начать первый чат» CTA — the very control
// the QA persona double-tapped.
class EmptyApi implements ApiLike {
  get<T>(path: string): Promise<T> {
    if (path.startsWith("/v1/badge")) {
      return Promise.resolve({ total_unread: 0, unread_chats: 0, mentions: 0 } as T);
    }
    return Promise.resolve([] as unknown as T);
  }
  post<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  delete<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }
}

async function openScreen() {
  const screen = createChatListScreen({
    api: new EmptyApi(),
    i18n,
    onOpenChat: () => {},
    onOpenSettings: () => {},
    onLogout: () => {},
    self: { id: 1, name: "Владелец", username: "owner" },
    now: () => 1_700_000_100,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  const cta = root
    .findAll((node) => node.hasClass("gc-btn-accent"))
    .find((node) => node.textContent.includes(i18n.t("chatList.startFirst")));
  assert.ok(cta, "the empty state offers «Начать первый чат»");
  const overlays = (): StubNode[] => root.findAll((node) => node.hasClass("gc-overlay"));
  return { screen, cta, overlays };
}

test("«Новый чат»: a second tap does not stack a second sheet", async () => {
  const { screen, cta, overlays } = await openScreen();

  cta.dispatch("click");
  assert.equal(overlays().length, 1, "the first tap opens the sheet");

  cta.dispatch("click");
  cta.dispatch("click");
  assert.equal(overlays().length, 1, "further taps re-use the open sheet instead of stacking scrims");

  screen.destroy();
});

test("«Новый чат»: leaving the screen takes the sheet with it", async () => {
  const { screen, cta, overlays } = await openScreen();

  cta.dispatch("click");
  assert.equal(overlays().length, 1, "the sheet is open");

  // What the shell does on navigation: the old screen is destroyed and the next one is mounted.
  screen.destroy();
  assert.equal(overlays().length, 0, "no modal is left hanging over the next section");
});

test("«Новый чат»: closing the sheet lets it be opened again", async () => {
  const { screen, cta, overlays } = await openScreen();

  cta.dispatch("click");
  const sheet = overlays()[0];
  assert.ok(sheet, "the sheet is open");
  // Escape is handled on the overlay element itself (new_chat_overlay.ts), so dispatch it there.
  sheet.dispatch("keydown", { key: "Escape" });
  assert.equal(overlays().length, 0, "Escape closes the sheet");

  cta.dispatch("click");
  assert.equal(overlays().length, 1, "the guard released the reference, so the CTA still works");

  screen.destroy();
});

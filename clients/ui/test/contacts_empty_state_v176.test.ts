// V176 — an empty address book announced the same absence twice: the slim status rail said
// «Адресная книга пуста», then the actual empty-state card immediately said «Контактов пока нет».
// The status rail is for loading, counts, mutation feedback and stale-refresh failures. Once a
// legitimate empty result has rendered its own role=status state, the rail must collapse instead of
// repeating the same fact in different words.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { createContactsCopy } from "../src/screens/contacts_copy.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike, GlobalSearchResult } from "../src/screens/api.ts";
import { createContactsScreen } from "../src/screens/contacts_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const contactsText = createContactsCopy(i18n);

const contact = (id: number): Record<string, unknown> => ({
  id,
  name: "Анна",
  username: "anna",
  alias: "",
  avatar_file_id: null,
  is_bot: false,
});

const apiFor = (contacts: unknown): ApiLike => ({
  get: async <T>(path: string): Promise<T> => {
    if (path === "/v1/contacts") return contacts as T;
    throw new Error(`unexpected GET ${path}`);
  },
  post: async <T>(): Promise<T> => { throw new Error("unused POST"); },
  put: async <T>(): Promise<T> => { throw new Error("unused PUT"); },
  patch: async <T>(): Promise<T> => { throw new Error("unused PATCH"); },
  delete: async <T>(): Promise<T> => { throw new Error("unused DELETE"); },
  refreshTokens: async (): Promise<boolean> => false,
  searchGlobal: async (): Promise<GlobalSearchResult> => ({ users: [], chats: [], messages: [] }),
}) as ApiLike;

const mount = async (contacts: unknown): Promise<{ screen: { destroy(): void }; root: StubNode }> => {
  const screen = createContactsScreen({
    api: apiFor(contacts),
    i18n,
    self: { id: 99, username: "owner", name: "Owner" },
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
    debounceMs: 0,
  });
  await settle();
  return { screen, root: screen.root as unknown as StubNode };
};

const byClass = (root: StubNode, className: string): StubNode[] =>
  root.findAll((node) => node.hasClass(className));

test("V176: a legitimate empty result is stated once, by the actionable empty state", async () => {
  const { screen, root } = await mount([]);
  const status = byClass(root, "gc-calls-status")[0]!;
  const state = byClass(root, "gc-contacts-empty-compact")[0]!;

  assert.ok(state.textContent.includes(contactsText("contacts.empty")), "the useful compact empty state remains");
  assert.equal(byClass(root, "gc-contact-growth-action").length, 3, "growth actions remain visible above the empty list");
  assert.equal(
    status.textContent.trim(),
    "",
    "the status rail must clear after the empty state replaces the loading announcement",
  );
  assert.equal(status.hidden, true, "an empty flex status rail must be hidden or it still reserves a line box");
  assert.ok(
    !root.textContent.includes(contactsText("contacts.countNone")),
    "the screen must not repeat the absence as «Адресная книга пуста» above «Контактов пока нет»",
  );
  screen.destroy();
});

test("V176: a non-empty address book keeps its useful count in the status rail", async () => {
  const { screen, root } = await mount([contact(1)]);
  assert.equal(byClass(root, "gc-contacts-empty-compact").length, 0, "a loaded person list is not an empty state");
  assert.equal(
    byClass(root, "gc-calls-status")[0]!.textContent.trim(),
    contactsText("contacts.count", { count: "1" }),
    "removing the duplicate empty sentence must not remove the count for a populated book",
  );
  screen.destroy();
});

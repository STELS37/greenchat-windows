// clients/ui/test/contacts_screen_v161.test.ts — V161: the fifth tab stops being «Биржа».
//
// WHAT THIS PINS. The bottom bar had five slots and spent one on the exchange, which is already
// reachable twice from the wallet (the Wallet | Exchange segmented control and the «Обмен» tile) and
// whose screen is structurally empty on this deployment (/v1/ex/pairs and /v1/ex/tickers both answer
// empty because a pair needs BOTH assets enabled). The slot now carries «Контакты» — the client half of
// a server contour shipped in T-113 that no client code called, and which three shipped privacy
// defaults (birthday / find_by_phone / find_by_email = "contacts") silently depend on.
//
// Two classes of guard live here: the model rules (a malformed body is never rendered as "you have no
// contacts", ids are validated before they reach an interpolated path) and the screen's states
// (loading, empty, failure+retry, stale snapshot, add, remove, open). Plus the navigation invariants,
// read out of the sources, so the exchange cannot quietly walk back into the bar and contacts cannot be
// gated behind a server flag.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createI18n } from "../src/i18n.ts";
import { createContactsCopy } from "../src/screens/contacts_copy.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike, DialogChat, GlobalSearchResult, SearchUser } from "../src/screens/api.ts";
import { createContactsScreen } from "../src/screens/contacts_screen.ts";
import type { AddressBookBridge } from "../src/screens/contacts_growth_model.ts";
import {
  ContactsError,
  addContact,
  addableUsers,
  contactSubtitle,
  contactTitle,
  filterContacts,
  isContactsLimit,
  loadContacts,
  matchesQuery,
  parseContacts,
  removeContact,
  type ContactRow,
} from "../src/screens/contacts_model.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });
const contactsText = createContactsCopy(i18n);

const netErr = (): Error => Object.assign(new Error("offline"), { name: "NetworkError" });
const apiErr = (code: string, httpStatus = 400, data: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(code), { name: "ApiError", code, httpStatus, data });

const wire = (id: number, name: string, username: string, alias = ""): Record<string, unknown> => ({
  id,
  name,
  username,
  alias,
  avatar_file_id: null,
  is_bot: false,
});
const row = (id: number, name: string, username: string, alias = ""): ContactRow =>
  wire(id, name, username, alias) as unknown as ContactRow;
const person = (id: number, name: string, username: string): SearchUser => ({
  id,
  name,
  username,
  avatar_file_id: null,
  is_bot: false,
});

// ---- model ----------------------------------------------------------------------------------------

test("V161: a body that is not a list of people is an error, never an empty address book", () => {
  const rejected: unknown[] = [
    null,
    { contacts: [] },                                   // the shape the route does NOT use
    [{ id: 0, name: "n", username: "u", is_bot: false, avatar_file_id: null }],   // id must be positive
    [{ id: 1.5, name: "n", username: "u", is_bot: false, avatar_file_id: null }],
    [{ id: 2, name: "n", username: "u", is_bot: false, avatar_file_id: 1.5 }],
    [{ id: 3, name: "n", username: 7, is_bot: false, avatar_file_id: null }],
    [{ id: 4, deleted: true }],
  ];
  for (const value of rejected) {
    assert.throws(
      () => parseContacts(value),
      (err: unknown) => err instanceof ContactsError && err.code === "invalid_response",
      `must reject ${JSON.stringify(value)} instead of reporting "no contacts"`,
    );
  }
  assert.deepEqual(parseContacts([]), [], "an empty list is a legitimate answer, not a failure");
  const [only] = parseContacts([{ id: 9, name: "Ann", username: "ann", is_bot: false, avatar_file_id: null }]);
  assert.equal(only?.alias, "", "a row without an alias parses with an empty one, not undefined");
});

test("V161: a row is never blank, and an alias never hides the real name", () => {
  assert.equal(contactTitle(row(1, "Анна Ким", "ann", "Мама")), "Мама", "the alias wins — that is the point of an address book");
  assert.equal(contactTitle(row(2, "Анна Ким", "ann")), "Анна Ким");
  assert.equal(contactTitle(row(3, "  ", "ann")), "@ann");
  assert.equal(contactTitle(row(4, "", "")), "4", "an id is still a name a person can read");

  assert.equal(contactSubtitle(row(1, "Анна Ким", "ann", "Мама")), "Анна Ким · @ann", "the aliased row keeps the real name visible");
  assert.equal(contactSubtitle(row(2, "Анна Ким", "ann")), "@ann");
  assert.equal(contactSubtitle(row(3, "Анна Ким", "ann", "Анна Ким")), "@ann", "an alias equal to the name is not a second line");
  assert.equal(contactSubtitle(row(4, "Анна Ким", "")), "", "no handle, no subtitle line");
});

test("V161: the local filter matches alias, name and handle, with or without the @", () => {
  const rows = [row(1, "Анна Ким", "ann", "Мама"), row(2, "Boris Petrov", "boris"), row(3, "Clara", "clara")];
  assert.deepEqual(filterContacts(rows, "").map((r) => r.id), [1, 2, 3], "an empty query hides nobody");
  assert.deepEqual(filterContacts(rows, "мам").map((r) => r.id), [1], "the alias is searchable");
  assert.deepEqual(filterContacts(rows, "@bor").map((r) => r.id), [2], "a leading @ is stripped before matching");
  assert.deepEqual(filterContacts(rows, "CLARA").map((r) => r.id), [3], "case does not matter");
  assert.deepEqual(filterContacts(rows, "zzz").map((r) => r.id), []);
  assert.equal(matchesQuery(row(5, "Анна", "ann"), "   "), true, "whitespace is not a query");
});

test("V161: the directory never offers to add yourself or someone already on the list", () => {
  const found = [person(1, "Me", "me"), person(2, "Known", "known"), person(3, "New", "new")];
  const offered = addableUsers(found, [row(2, "Known", "known")], 1);
  assert.deepEqual(offered.map((u) => u.id), [3], "self (1) and the known contact (2) are filtered out");
});

test("V161: an unusable id is refused before it reaches an interpolated path", async () => {
  const calls: string[] = [];
  const api = {
    get: async () => [],
    post: async (p: string) => { calls.push("POST " + p); return {}; },
    put: async () => ({}),
    patch: async () => ({}),
    delete: async (p: string) => { calls.push("DELETE " + p); return {}; },
    refreshTokens: async () => false,
  } as unknown as ApiLike;

  for (const bad of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => addContact(api, bad),
      (err: unknown) => err instanceof ContactsError && err.code === "invalid_user",
    );
    await assert.rejects(
      () => removeContact(api, bad),
      (err: unknown) => err instanceof ContactsError && err.code === "invalid_user",
    );
  }
  assert.deepEqual(calls, [], "no request left the client — a DELETE /v1/contacts/NaN would read as a 404");

  await assert.rejects(
    () => addContact({ ...api, post: async () => ({ id: 7 }) } as unknown as ApiLike, 7),
    (err: unknown) => err instanceof ContactsError && err.code === "invalid_response",
    "a truncated add response is an error, not a half-built row",
  );
  assert.equal(isContactsLimit(apiErr("LIMIT_EXCEEDED", 429)), true);
  assert.equal(isContactsLimit(netErr()), false, "an offline write is retryable; the 5000 cap is not");
});

test("V161: the list is read from GET /v1/contacts as a bare array", async () => {
  const seen: string[] = [];
  const api = {
    get: async (p: string) => { seen.push(p); return [wire(2, "B", "b"), wire(1, "A", "a")]; },
    post: async () => ({}), put: async () => ({}), patch: async () => ({}),
    delete: async () => ({}), refreshTokens: async () => false,
  } as unknown as ApiLike;
  const rows = await loadContacts(api);
  assert.deepEqual(seen, ["/v1/contacts"]);
  assert.deepEqual(rows.map((r) => r.id), [2, 1], "the server's own ordering is preserved, not re-sorted client-side");
});

// ---- screen ---------------------------------------------------------------------------------------

interface Rig {
  screen: { root: HTMLElement; destroy(): void };
  root: StubNode;
  api: FakeApi;
}

class FakeApi implements ApiLike {
  contacts: unknown = [wire(2, "Борис", "boris"), wire(3, "Clara", "clara", "Клара с работы")];
  getFails: unknown = null;
  getCalls = 0;
  posted: Array<{ path: string; body: unknown }> = [];
  deleted: string[] = [];
  dialogs: number[] = [];
  postFails: unknown = null;
  found: SearchUser[] = [];
  searchFails: unknown = null;

  async get<T>(path: string): Promise<T> {
    if (path === "/v1/contacts") {
      this.getCalls += 1;
      if (this.getFails) throw this.getFails;
      return this.contacts as T;
    }
    throw new Error("unexpected GET " + path);
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.posted.push({ path, body });
    if (this.postFails) throw this.postFails;
    if (path === "/v1/contacts/sync") {
      const hashes = (body as { hashes?: unknown[] } | undefined)?.hashes ?? [];
      return {
        matched: [],
        matched_count: 0,
        invite_count: hashes.length,
        added_count: 0,
        already_contact_count: 0,
      } as T;
    }
    const id = Number((body as { user_id?: number } | undefined)?.user_id);
    const hit = this.found.find((u) => u.id === id);
    return wire(id, hit?.name ?? "Added", hit?.username ?? "added") as T;
  }
  async put<T>(): Promise<T> { throw new Error("unused"); }
  async patch<T>(): Promise<T> { throw new Error("unused"); }
  async delete<T>(path: string): Promise<T> { this.deleted.push(path); return {} as T; }
  async refreshTokens(): Promise<boolean> { return false; }
  async searchGlobal(q: string): Promise<GlobalSearchResult> {
    if (this.searchFails) throw this.searchFails;
    const needle = q.trim().toLocaleLowerCase();
    return { users: this.found.filter((u) => (u.name + " " + u.username).toLocaleLowerCase().includes(needle)), chats: [], messages: [] };
  }
  async createDialog(userId: number): Promise<DialogChat> {
    this.dialogs.push(userId);
    return {
      id: 900 + userId,
      kind: "dialog",
      title: "…",
      username: null,
      my_role: "member",
      message_ttl_sec: 0,
      updated_at: 0,
    };
  }
}

const mount = async (
  tune: (api: FakeApi) => void = () => {},
  opts: { dialog?: boolean; addressBook?: AddressBookBridge | null } = {},
): Promise<Rig> => {
  const api = new FakeApi();
  tune(api);
  // A class method lives on the prototype, so `delete` would not hide it: define an own undefined
  // property, which is exactly what a transport built before POST /v1/chats/dialog looks like.
  if (opts.dialog === false) Object.defineProperty(api, "createDialog", { value: undefined, configurable: true });
  const screen = createContactsScreen({
    api,
    i18n,
    self: { id: 1, username: "me", name: "Me" },
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => { opened.push(-1); },
    debounceMs: 0,
    ...(opts.addressBook !== undefined ? { addressBook: opts.addressBook } : {}),
  });
  await settle();
  return { screen, root: screen.root as unknown as StubNode, api };
};
let opened: number[] = [];

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((n) => n.hasClass(cls));
const titles = (root: StubNode, section: string): string[] =>
  byClass(byClass(root, section)[0]!, "gc-row-title").map((n) => n.textContent.trim());
const search = (rig: Rig, text: string): void => {
  const input = byClass(rig.root, "gc-chats-search-input")[0]!;
  input.value = text;
  input.dispatch("input");
};

test("V161: a loaded address book renders one row per person, with the count on the status line", async () => {
  const rig = await mount();
  assert.equal(rig.root.hasClass("gc-contacts"), true, "the screen carries its own marker beside the shared calls chrome");
  assert.equal(rig.root.hasClass("gc-calls"), true, "and reuses the calls chrome, so no new CSS was needed");
  assert.equal(byClass(rig.root, "gc-skeleton-list").length, 0, "the skeleton is replaced once the read lands");

  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Борис", "Клара с работы"]);
  assert.deepEqual(
    byClass(rig.root, "gc-row-sub").map((n) => n.textContent.trim()),
    ["@boris", "Clara · @clara"],
    "the aliased row still shows the name its owner chose",
  );
  const status = byClass(rig.root, "gc-calls-status")[0]!;
  assert.equal(status.textContent.trim(), contactsText("contacts.count", { count: "2" }));
  assert.equal(byClass(rig.root, "gc-chats-search").length, 1, "search is available immediately, independent of the contact-list read");
  assert.equal(rig.root.findAll((n) => n.attrs["aria-busy"] === "true").length, 0, "the busy flag is cleared");
  rig.screen.destroy();
});

test("V177: an empty book is compact and the page leads with sync, invite and link actions", async () => {
  const rig = await mount((api) => { api.contacts = []; });
  const state = byClass(rig.root, "gc-contacts-empty-compact")[0]!;
  assert.ok(state.textContent.includes(contactsText("contacts.empty")));
  assert.ok(state.textContent.includes(contactsText("contacts.emptyLead")));
  assert.equal(byClass(rig.root, "gc-contact-growth").length, 1, "the acquisition hub is not hidden behind an empty-state button");
  assert.equal(byClass(rig.root, "gc-contact-growth-action").length, 3, "sync, invite and copy-link are first-class actions");
  assert.equal(byClass(rig.root, "gc-contact-growth-mark").length, 0, "the compact address book has no decorative hero tile");
  assert.equal(byClass(rig.root, "gc-contact-growth-kicker").length, 0, "the action hub does not spend mobile height on a marketing eyebrow");
  assert.ok(
    byClass(rig.root, "gc-contact-growth-privacy")[0]!.textContent.includes("SHA-256"),
    "the privacy boundary is explained beside the sync action, not buried in settings",
  );
  assert.equal(
    byClass(rig.root, "gc-calls-status")[0]!.textContent.trim(),
    "",
    "the compact empty state states the fact; the slim status rail must not repeat it",
  );

  byClass(state, "gc-contacts-empty-search")[0]!.dispatch("click");
  const active = (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement;
  assert.equal(active, byClass(rig.root, "gc-chats-search-input")[0], "the compact search action actually focuses the field");
  rig.screen.destroy();
});

test("V179: a legitimate sync limit names the exact wait instead of a generic failure", async () => {
  const addressBook: AddressBookBridge = {
    readHashes: async () => ({
      hashes: ["a".repeat(64)],
      total_numbers: 1,
      normalized_numbers: 1,
      skipped_numbers: 0,
      truncated: false,
    }),
    inviteBySms: async () => ({ opened: false }),
  };
  const rig = await mount((api) => {
    api.contacts = [];
    api.postFails = apiErr("RATE_LIMITED", 429, { retry_after: 3700 });
  }, { addressBook });

  const sync = byClass(rig.root, "gc-contact-growth-action")[0]!;
  sync.dispatch("click");
  await settle();

  const result = byClass(rig.root, "gc-contact-growth-result")[0]!;
  assert.equal(result.attrs["data-tone"], "error");
  assert.equal(result.textContent.trim(), contactsText("contacts.syncRateLimited", { minutes: "62" }));
  assert.deepEqual(rig.api.posted.map((call) => call.path), ["/v1/contacts/sync"]);
  assert.equal(sync.attrs["aria-busy"], "false", "the button is released while the timer runs on the server");
  rig.screen.destroy();
});

test("V178: contact acquisition stays width-safe on narrow phones", () => {
  const css = readFileSync(new URL("../../web/src/contacts.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const actions = css.match(/\.gc-contact-growth-actions\s*\{([^}]*)\}/)?.[1] ?? "";
  const action = css.match(/\.gc-contact-growth-action\s*\{([^}]*)\}/)?.[1] ?? "";
  const title = css.match(/\.gc-contact-growth-action-copy strong\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(actions, /display:\s*flex/, "mobile actions are a vertical native-style list, not squeezed columns");
  assert.match(actions, /flex-direction:\s*column/, "each action receives the whole mobile width");
  assert.match(action, /width:\s*100%/, "action rows cannot collapse around their labels");
  assert.match(action, /min-height:\s*58px/, "the compact redesign still exceeds the 44px touch-target contract");
  assert.match(title, /word-break:\s*normal/, "action titles keep whole words on narrow screens");
  assert.doesNotMatch(css, /overflow-wrap:\s*anywhere/, "the regression that split labels letter by letter stays removed");
});

test("the search hint fits the 320px pill and degrades to an ellipsis, never to a sliced glyph", () => {
  // Measured 2026-08-04 in Chromium on a harness loading tokens.css + styles.css + redesign.css +
  // contacts.css, 15px system stack. The pill leaves the input 228px at a 320px viewport, 268px at 360
  // and 298px at 390. The shipped hint measured 322.4px (ru) / 236.9px (en), so it overflowed on EVERY
  // phone width, and `text-overflow` was the CSS initial `clip` — the frame ended mid-letter and the
  // «@имя» affordance never reached the screen. Two guards, because there were two causes.

  // 1. Length budget. 210.4px over 23 ru characters is 9.15px per character at the default scale, so
  //    228px of room is ~24 characters. Anything longer must be re-measured, not merely re-read.
  for (const [locale, budget] of [["ru", 24], ["en", 26]] as const) {
    const copy = createContactsCopy(createI18n({ locale, dicts: { en, ru } }));
    const hint = copy("contacts.searchPlaceholder");
    assert.ok(
      hint.length <= budget,
      `${locale} search hint is ${hint.length} characters, over the ${budget} that fit a 320px pill: ${hint}`,
    );
    assert.ok(hint.includes("@"), `${locale} hint must keep the @username affordance — it is the only place it is taught`);
  }

  // 2. Overflow behaviour, which the wording alone cannot cover: the font scale is user-controlled up
  //    to 1.4x (theme.ts FONT_SCALE_MAX) and a typed query is unbounded.
  const css = readFileSync(new URL("../../web/src/contacts.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const search = css.match(/\.gc-contacts-search \.gc-chats-search-input\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(search, /text-overflow:\s*ellipsis/, "an overlong hint or query must end in «…», not in half a letter");
});

test("V161: a failed first read is a retryable failure, never «у вас нет контактов»", async () => {
  const rig = await mount((api) => { api.getFails = netErr(); });
  const state = byClass(rig.root, "gc-state")[0]!;
  assert.equal(state.attrs["data-tone"], "offline", "a transport failure keeps its offline meaning");
  assert.ok(!state.textContent.includes(contactsText("contacts.empty")), "an unknown list is not an empty list");
  assert.equal(
    byClass(rig.root, "gc-chats-search").length,
    1,
    "directory search remains available even when the saved-list refresh is offline",
  );

  rig.api.getFails = null;
  byClass(state, "gc-state-action")[0]!.dispatch("click");
  await settle();
  assert.equal(rig.api.getCalls, 2, "retry issues a real second read");
  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Борис", "Клара с работы"]);
  rig.screen.destroy();
});

test("V161: a failed refresh keeps the last proven list on screen and says so", async () => {
  const rig = await mount();
  rig.api.getFails = netErr();
  byClass(rig.root, "gc-calls-header")[0]!.findAll((n) => n.tag === "button")[0]!.dispatch("click");
  await settle();
  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Борис", "Клара с работы"], "a truthful snapshot survives a failed refresh");
  assert.equal(byClass(rig.root, "gc-state").length, 0, "and is not replaced by a failure card");
  assert.ok(byClass(rig.root, "gc-calls-status")[0]!.textContent.trim().length > 0, "the failure is still reported on the status line");
  rig.screen.destroy();
});

test("V161: typing filters the book locally and searches the directory only past the minimum length", async () => {
  const rig = await mount((api) => { api.found = [person(1, "Me", "me"), person(2, "Борис", "boris"), person(5, "Дина", "dina")]; });

  search(rig, "к");
  await settle();
  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Клара с работы"], "one letter already narrows the local list");
  assert.equal(byClass(rig.root, "gc-contacts-found").length, 1, "the directory section appears as soon as a query exists");
  assert.ok(
    byClass(rig.root, "gc-contacts-hint")[0]!.textContent.includes(contactsText("contacts.searchHint")),
    "…but below the minimum length it explains itself instead of searching",
  );

  search(rig, "дина");
  await settle();
  const found = byClass(rig.root, "gc-contacts-found")[0]!;
  assert.deepEqual(byClass(found, "gc-row-title").map((n) => n.textContent.trim()), ["Дина"]);
  assert.equal(byClass(rig.root, "gc-contacts-section")[0]!.findAll((n) => n.hasClass("gc-row-title")).length, 0);
  assert.ok(byClass(rig.root, "gc-state").some((n) => n.textContent.includes(contactsText("contacts.noMatches"))),
    "«no local match» is stated separately from the directory result");

  search(rig, "борис");
  await settle();
  const again = byClass(rig.root, "gc-contacts-found")[0]!;
  assert.ok(
    again.textContent.includes(contactsText("contacts.allAdded")),
    "a hit that is already a contact reports «already added», not «not found»",
  );

  search(rig, "нетакого");
  await settle();
  assert.ok(
    byClass(rig.root, "gc-contacts-found")[0]!.textContent.includes(contactsText("contacts.notFound")),
    "an empty directory answer is a different fact and gets its own text",
  );
  rig.screen.destroy();
});

test("V161: adding from the directory posts once, moves the person into the book, and names the 5000 cap", async () => {
  const rig = await mount((api) => { api.found = [person(5, "Дина", "dina")]; });
  search(rig, "дина");
  await settle();

  const add = byClass(byClass(rig.root, "gc-contacts-found")[0]!, "gc-icon-btn")[0]!;
  add.dispatch("click");
  add.dispatch("click");   // a double tap must not become two writes
  await settle();
  assert.deepEqual(rig.api.posted, [{ path: "/v1/contacts", body: { user_id: 5 } }]);
  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Дина"], "the new person is slotted in without a refetch");
  assert.equal(rig.api.getCalls, 1, "…and without a second GET");
  assert.equal(byClass(byClass(rig.root, "gc-contacts-found")[0]!, "gc-row-title").length, 0,
    "the directory stops offering someone who is now a contact");

  rig.api.postFails = apiErr("LIMIT_EXCEEDED", 429);
  rig.api.found = [person(6, "Дина Два", "dina2")];
  search(rig, "дина");
  await settle();
  byClass(byClass(rig.root, "gc-contacts-found")[0]!, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.equal(byClass(rig.root, "gc-calls-status")[0]!.textContent.trim(), contactsText("contacts.limit"),
    "the one failure retrying can never fix is named, not shown as a generic error");
  rig.screen.destroy();
});

test("V161: removing a contact deletes by id and drops exactly that row", async () => {
  const rig = await mount();
  const rows = byClass(byClass(rig.root, "gc-contacts-section")[0]!, "gc-chat-row");
  byClass(rows[1]!, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.deepEqual(rig.api.deleted, ["/v1/contacts/3"], "the path carries the user id, not the row index");
  assert.deepEqual(titles(rig.root, "gc-contacts-section"), ["Борис"]);
  assert.equal(
    byClass(rig.root, "gc-calls-status")[0]!.textContent.trim(),
    contactsText("contacts.removed", { name: "Клара с работы" }),
  );
  rig.screen.destroy();
});

test("V161: a row opens the conversation — and stays honest when the transport cannot", async () => {
  opened = [];
  const api = new FakeApi();
  const seen: number[] = [];
  const screen = createContactsScreen({
    api, i18n,
    self: { id: 1, username: "me", name: "Me" },
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: (id) => seen.push(id),
    debounceMs: 0,
  });
  await settle();
  const root = screen.root as unknown as StubNode;
  byClass(root, "gc-chat-open")[0]!.dispatch("click");
  await settle();
  assert.deepEqual(api.dialogs, [2], "the dialog is created for the person in the row");
  assert.deepEqual(seen, [902], "and the shell is told which chat to open");
  screen.destroy();

  const old = await mount(() => {}, { dialog: false });
  const open = byClass(old.root, "gc-chat-open")[0]!;
  assert.equal(open.disabled, true, "a shell without POST /v1/chats/dialog shows the book but does not fake a button");
  old.screen.destroy();
});

test("V161: a screen torn down mid-flight repaints nothing", async () => {
  let release: (() => void) | null = null;
  const api = new FakeApi();
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const original = api.get.bind(api);
  api.get = (async (p: string) => { await slow; return original(p); }) as typeof api.get;
  const screen = createContactsScreen({
    api, i18n,
    self: { id: 1, username: "me", name: "Me" },
    atShellRoot: true,
    onBack: () => {},
    onOpenChat: () => {},
    debounceMs: 0,
  });
  await settle();
  screen.destroy();
  release!();
  await settle();
  const root = screen.root as unknown as StubNode;
  assert.equal(byClass(root, "gc-contacts-section").length, 0, "a late answer must not paint into a discarded screen");
});

// ---- navigation invariants ------------------------------------------------------------------------

test("V161: the bar advertises contacts, the hub keeps the exchange, and the route exists", () => {
  const app = readFileSync(new URL("../src/screens/app.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("../src/router.ts", import.meta.url), "utf8");
  const index = readFileSync(new URL("../src/screens/index.ts", import.meta.url), "utf8");

  const bar = app.slice(app.indexOf("const mainDestinations"), app.indexOf("const moreHubItems"));
  assert.ok(bar.includes('section: "contacts"'), "the freed slot is taken by contacts");
  assert.ok(!bar.includes('section: "exchange"'), "the exchange is no longer a tab — the wallet already opens it");
  assert.ok(!/section: "contacts"[\s\S]{0,160}requires:/.test(bar),
    "contacts must not be gated: a stock server with payments off would lose the tab");
  assert.ok(bar.indexOf('section: "contacts"') < bar.indexOf('section: "wallet"'),
    "people come before money in the bar order the owner sees");

  assert.match(app, /id: "exchange"[\s\S]{0,220}route: "\/exchange"/, "the hub still lists the exchange, so nothing was lost");
  assert.match(app, /id: "contacts"[\s\S]{0,220}route: "\/contacts"/, "and the hub lists contacts too, as every destination is listed once");
  assert.match(app, /r\.name === "contacts"/, "the shell can actually render the route");
  assert.match(router, /name: "contacts", pattern: "\/contacts"/, "…because the router knows it");
  assert.match(router, /pattern: "\/exchange"/, "the exchange address keeps working for anyone who bookmarked it");
  assert.ok(index.includes("createContactsScreen"), "the screen is exported from the barrel like every sibling");

  for (const key of ["shell.contacts", "contacts.title", "contacts.empty", "more.contactsHint"]) {
    assert.ok(en[key as keyof typeof en], `en is missing ${key}`);
    assert.ok(ru[key as keyof typeof ru], `ru is missing ${key}`);
  }
});

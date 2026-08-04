// clients/ui/test/contacts_mutation_races_v167.test.ts — V167 regression guard.
//
// A full contacts refresh and a write used independent state clocks. If refresh captured the old
// address book, then an add/remove committed, and the old GET answered last, load() replaced the
// locally proven mutation with stale data: an added person disappeared or a deleted person returned.
import test from "node:test";
import assert from "node:assert/strict";

import { createI18n } from "../src/i18n.ts";
import { en } from "../src/locales/en.ts";
import { ru } from "../src/locales/ru.ts";
import type { ApiLike, DialogChat, GlobalSearchResult, SearchUser } from "../src/screens/api.ts";
import { createContactsScreen } from "../src/screens/contacts_screen.ts";
import { installDomStub, settle, type StubNode } from "./dom_stub.ts";

installDomStub();
const i18n = createI18n({ locale: "ru", dicts: { en, ru } });

const wire = (id: number, name: string, username: string, alias = ""): Record<string, unknown> => ({
  id,
  name,
  username,
  alias,
  avatar_file_id: null,
  is_bot: false,
});

const person = (id: number, name: string, username: string): SearchUser => ({
  id,
  name,
  username,
  avatar_file_id: null,
  is_bot: false,
});

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason?: unknown) => void;
  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class RaceApi implements ApiLike {
  readonly refresh = new Deferred<unknown>();
  readonly found: SearchUser[];
  private readonly initial: unknown;
  getCalls = 0;
  postCalls = 0;
  deleteCalls = 0;

  constructor(initial: unknown, found: SearchUser[] = [person(5, "Дина", "dina")]) {
    this.initial = initial;
    this.found = found;
  }

  get<T>(path: string): Promise<T> {
    if (path !== "/v1/contacts") return Promise.reject(new Error(`unexpected GET ${path}`));
    this.getCalls += 1;
    if (this.getCalls === 1) return Promise.resolve(this.initial as T);
    if (this.getCalls === 2) return this.refresh.promise as Promise<T>;
    return Promise.reject(new Error("unexpected third contacts read"));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    assert.equal(path, "/v1/contacts");
    this.postCalls += 1;
    const id = Number((body as { user_id?: number } | undefined)?.user_id);
    const hit = this.found.find((candidate) => candidate.id === id);
    return Promise.resolve(wire(id, hit?.name ?? "Added", hit?.username ?? "added") as T);
  }

  delete<T>(path: string): Promise<T> {
    this.deleteCalls += 1;
    assert.match(path, /^\/v1\/contacts\/\d+$/);
    return Promise.resolve({} as T);
  }

  put<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  patch<T>(): Promise<T> { return Promise.reject(new Error("unused")); }
  refreshTokens(): Promise<boolean> { return Promise.resolve(false); }

  searchGlobal(q: string): Promise<GlobalSearchResult> {
    const needle = q.trim().toLocaleLowerCase();
    return Promise.resolve({
      users: this.found.filter((candidate) =>
        `${candidate.name} ${candidate.username}`.toLocaleLowerCase().includes(needle)),
      chats: [],
      messages: [],
    });
  }

  createDialog(userId: number): Promise<DialogChat> {
    return Promise.resolve({
      id: 900 + userId,
      kind: "dialog",
      title: "…",
      username: null,
      my_role: "member",
      message_ttl_sec: 0,
      updated_at: 0,
    });
  }
}

class DialogRaceApi extends RaceApi {
  readonly dialogRequests = new Map<number, Deferred<DialogChat>>();

  override createDialog(userId: number): Promise<DialogChat> {
    const request = new Deferred<DialogChat>();
    this.dialogRequests.set(userId, request);
    return request.promise;
  }
}

const byClass = (root: StubNode, cls: string): StubNode[] => root.findAll((node) => node.hasClass(cls));
const contactTitles = (root: StubNode): string[] => {
  const section = byClass(root, "gc-contacts-section")[0];
  return section ? byClass(section, "gc-row-title").map((node) => node.textContent.trim()) : [];
};

async function mount(
  api: RaceApi,
  onOpenChat: (chatId: number) => void = () => {},
): Promise<{ root: StubNode; destroy(): void }> {
  const screen = createContactsScreen({
    api,
    i18n,
    self: { id: 1, username: "me", name: "Me" },
    atShellRoot: true,
    onBack: () => {},
    onOpenChat,
    debounceMs: 0,
  });
  await settle();
  return { root: screen.root as unknown as StubNode, destroy: () => screen.destroy() };
}

function startRefresh(root: StubNode): void {
  const header = byClass(root, "gc-calls-header")[0]!;
  const refresh = header.findAll((node) => node.tag === "button")[0]!;
  refresh.dispatch("click");
}

function search(root: StubNode, value: string): void {
  const input = byClass(root, "gc-chats-search-input")[0]!;
  input.value = value;
  input.dispatch("input");
}

test("V167: an old refresh cannot erase a contact whose add committed after that GET began", async () => {
  const oldSnapshot = [wire(2, "Борис", "boris")];
  const api = new RaceApi(oldSnapshot);
  const screen = await mount(api);
  assert.deepEqual(contactTitles(screen.root), ["Борис"]);

  startRefresh(screen.root);
  await settle();
  assert.equal(api.getCalls, 2, "the stale refresh is in flight");

  search(screen.root, "дина");
  await settle();
  const found = byClass(screen.root, "gc-contacts-found")[0]!;
  byClass(found, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.equal(api.postCalls, 1);
  assert.deepEqual(contactTitles(screen.root), ["Дина"], "the committed add is visible through the active local filter before the old GET returns");

  api.refresh.resolve(oldSnapshot);
  await settle();
  assert.deepEqual(
    contactTitles(screen.root),
    ["Дина"],
    "the late pre-add snapshot must not delete the committed contact behind the active filter",
  );
  assert.equal(byClass(screen.root, "gc-calls-body")[0]!.attrs["aria-busy"], "false");
  screen.destroy();
});

test("V167: a local add keeps the server's name order even when an existing row has an alias", async () => {
  // GET /v1/contacts orders by users.name/users.username, never by the owner's alias. "Aaron" must
  // therefore remain before "Bob" even though the visible alias "Zulu" sorts after it.
  const api = new RaceApi(
    [wire(2, "Aaron", "aaron", "Zulu")],
    [person(5, "Bob", "bob")],
  );
  const screen = await mount(api);
  assert.deepEqual(contactTitles(screen.root), ["Zulu"]);

  search(screen.root, "bob");
  await settle();
  const found = byClass(screen.root, "gc-contacts-found")[0]!;
  byClass(found, "gc-icon-btn")[0]!.dispatch("click");
  await settle();

  search(screen.root, "");
  await settle();
  assert.deepEqual(
    contactTitles(screen.root),
    ["Zulu", "Bob"],
    "the locally inserted row must occupy the same position a server reload would give it",
  );
  screen.destroy();
});

test("V167: a late older create-dialog response cannot override the user's newer contact choice", async () => {
  const api = new DialogRaceApi([wire(2, "Aaron", "aaron"), wire(3, "Bob", "bob")]);
  const opened: number[] = [];
  const screen = await mount(api, (chatId) => opened.push(chatId));
  const rows = byClass(byClass(screen.root, "gc-contacts-section")[0]!, "gc-chat-row");

  byClass(rows[0]!, "gc-chat-open")[0]!.dispatch("click");
  byClass(rows[1]!, "gc-chat-open")[0]!.dispatch("click");
  await settle();
  assert.deepEqual([...api.dialogRequests.keys()], [2, 3], "both user intents reached the transport");

  api.dialogRequests.get(3)!.resolve({
    id: 903,
    kind: "dialog",
    title: "Bob",
    username: "bob",
    my_role: "member",
    message_ttl_sec: 0,
    updated_at: 0,
  });
  await settle();
  assert.deepEqual(opened, [903], "the newer choice opens first");

  api.dialogRequests.get(2)!.resolve({
    id: 902,
    kind: "dialog",
    title: "Aaron",
    username: "aaron",
    my_role: "member",
    message_ttl_sec: 0,
    updated_at: 0,
  });
  await settle();
  assert.deepEqual(opened, [903], "the late response for the older click must be ignored");
  screen.destroy();
});

test("V167: an old refresh cannot resurrect a contact whose removal committed after that GET began", async () => {
  const oldSnapshot = [wire(2, "Борис", "boris"), wire(3, "Клара", "clara")];
  const api = new RaceApi(oldSnapshot);
  const screen = await mount(api);
  assert.deepEqual(contactTitles(screen.root), ["Борис", "Клара"]);

  startRefresh(screen.root);
  await settle();
  assert.equal(api.getCalls, 2, "the stale refresh is in flight");

  const rows = byClass(byClass(screen.root, "gc-contacts-section")[0]!, "gc-chat-row");
  byClass(rows[1]!, "gc-icon-btn")[0]!.dispatch("click");
  await settle();
  assert.equal(api.deleteCalls, 1);
  assert.deepEqual(contactTitles(screen.root), ["Борис"], "the committed removal is visible before the old GET returns");

  api.refresh.resolve(oldSnapshot);
  await settle();
  assert.deepEqual(
    contactTitles(screen.root),
    ["Борис"],
    "the late pre-delete snapshot must not resurrect the removed contact",
  );
  assert.equal(byClass(screen.root, "gc-calls-body")[0]!.attrs["aria-busy"], "false");
  screen.destroy();
});

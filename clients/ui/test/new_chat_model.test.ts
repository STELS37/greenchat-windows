import { test } from "node:test";
import assert from "node:assert/strict";
import type { SearchUser } from "../src/screens/api.ts";
import { avatarTone, initials } from "../src/screens/message_menu.ts";
import {
  normalizeQuery, shouldSearch, savedRow, savedRowVisible, userRows,
  MIN_QUERY_LEN, SEARCH_DEBOUNCE_MS,
  SearchController, type SearchState, type SearchControllerPorts,
} from "../src/screens/new_chat_model.ts";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const user = (over: Partial<SearchUser> = {}): SearchUser =>
  ({ id: 2, username: "ann", name: "Ann", avatar_file_id: null, is_bot: false, ...over });

test("normalizeQuery: trims and strips a leading @", () => {
  assert.equal(normalizeQuery("  ann "), "ann");
  assert.equal(normalizeQuery("@ann"), "ann");
  assert.equal(normalizeQuery("@@bob"), "bob");
  assert.equal(normalizeQuery("a@b"), "a@b", "an interior @ is left alone (only a leading one is noise)");
});

test("shouldSearch: gated on the min length after normalisation", () => {
  assert.equal(MIN_QUERY_LEN, 2);
  assert.equal(shouldSearch("a"), false);
  assert.equal(shouldSearch("@a"), false, "the @ doesn't count toward the min length");
  assert.equal(shouldSearch("ab"), true);
  assert.equal(shouldSearch("  x "), false);
});

test("savedRow: the pinned self row carries the localized label and the self id", () => {
  const r = savedRow({ id: 7, name: "Me", username: "me" }, "Saved Messages");
  assert.deepEqual(r, { kind: "self", userId: 7, title: "Saved Messages", subtitle: "" });
});

test("savedRowVisible: the pinned self row stops contradicting a query it cannot match", () => {
  assert.equal(savedRowVisible("", "Избранное"), true, "no query yet — the shortcut is the point of the empty state");
  assert.equal(savedRowVisible("и", "Избранное"), true, "below the search threshold nothing is filtered yet");
  assert.equal(savedRowVisible("карл", "Избранное"), false, "a real query that does not match must not keep the row");
  assert.equal(savedRowVisible("ИЗБР", "Избранное"), true, "case-insensitive match keeps it");
  assert.equal(savedRowVisible("@saved", "Saved Messages"), true, "a leading @ is noise, the label still matches");
});

test("userRows: carries a real avatar file id into every people picker", () => {
  const rows = userRows([user({ avatar_file_id: 88 })], 1);
  assert.equal(rows[0]?.avatarFileId, 88);
});

test("userRows: maps found users and drops the viewer", () => {
  const rows = userRows([user({ id: 7 }), user({ id: 2, name: "Ann", username: "ann" }), user({ id: 3, name: "", username: "bob" })], 7);
  assert.equal(rows.length, 2, "the viewer (id 7) is filtered out — they already have the self row");
  assert.deepEqual(rows[0], { kind: "user", userId: 2, title: "Ann", subtitle: "@ann" });
  assert.deepEqual(
    rows[1], { kind: "user", userId: 3, title: "@bob", subtitle: "", avatarSeed: "bob" },
    "no display name → the handle becomes the title, and is not echoed underneath it (V168)",
  );
});

// ---- V168: one row, one identity ----------------------------------------------------------------
//
// Evidence (live stand database, read-only, 2026-08-03): `users.name` is declared
// `name TEXT NOT NULL DEFAULT ''` and registration stores whatever the client sent without a fallback,
// so a blank display name is a SUPPORTED state, not corruption — 8 of the 67 accounts on the stand
// have one (ids 1, 2, 3, 4, 7, 27, 65, 66), and the same ratio holds in the 2026-08-01 backup (6/54).
//
// For every one of them the people-search drew the same string twice:
//
//     qa1785731573      <- .gc-row-title, from `u.name || u.username`
//     @qa1785731573     <- .gc-row-sub,   from `"@" + u.username`
//
// Two lines, one fact. The lower line is positioned as an extra detail about the person and adds
// nothing, and the upper line reads as a name the person chose when it is really their handle.
//
// The reason this survived is in the assertion above: it required `title: "bob", subtitle: "@bob"` and
// called it correct, so the duplicate was pinned green by the suite that was supposed to catch it.
test("userRows: a person with no display name is shown by their handle — once", () => {
  const rows = userRows([user({ id: 66, name: "", username: "qa1785731573" })], 1);
  assert.deepEqual(
    rows[0], { kind: "user", userId: 66, title: "@qa1785731573", subtitle: "", avatarSeed: "qa1785731573" },
    "the handle IS the title here, so printing it again below states the same fact twice",
  );
});

// The de-duplication moves an "@" into the title, and the overlay derives BOTH the avatar's monogram
// and its colour from what it is given. Measured, not assumed:
//   monogram — `initials("@qa1785731573")` is "@", so all 8 blank-name accounts would have lost their
//              letter. Real regression, and the reason `avatarSeed` exists.
//   colour   — unchanged, and provably so rather than by luck: `avatarTone` folds with h*31+c from 0,
//              so a one-char prefix adds c*31^n, and for "@" that is 64*odd ≡ 0 (mod AVATAR_TONES=8).
//              All eight live handles were checked and none moved. The seed keeps it independent of
//              that arithmetic coincidence, but the claim below is only what actually holds.
test("userRows: making the title a handle does not cost the avatar its letter", () => {
  const [row] = userRows([user({ id: 66, name: "", username: "qa1785731573" })], 1);
  const seed = row!.avatarSeed ?? row!.title;
  assert.equal(initials(seed), "Q", "the monogram stays the first letter of the handle");
  assert.equal(initials("@qa1785731573"), "@", "…which is exactly what the title alone would have drawn");
  assert.equal(avatarTone(seed), avatarTone("qa1785731573"), "and the tone is the one this person has elsewhere");
});

test("userRows: someone with a display name keeps the handle underneath it", () => {
  const rows = userRows([user({ id: 2, name: "Ann", username: "ann" })], 1);
  assert.deepEqual(
    rows[0], { kind: "user", userId: 2, title: "Ann", subtitle: "@ann" },
    "the two lines say different things, so both stay — the common case must be byte-identical",
  );
  assert.equal(rows[0]!.avatarSeed, undefined, "no seed is emitted where the title is already a name");
});

test("userRows: a whitespace-only name never becomes a blank title", () => {
  const rows = userRows([user({ id: 5, name: "   ", username: "ghost" })], 1);
  assert.equal(rows[0]!.title, "@ghost", "a title of spaces renders an unclickable-looking empty row");
  assert.equal(initials(rows[0]!.avatarSeed ?? rows[0]!.title), "G", "and its avatar is still a letter");
});

test("userRows: with neither a name nor a handle the id stands in, and nothing is echoed", () => {
  const rows = userRows([user({ id: 404, name: "", username: "" })], 1);
  assert.deepEqual(rows[0], { kind: "user", userId: 404, title: "404", subtitle: "" });
});

test("userRows: a service account with no display name keeps its badge", () => {
  const rows = userRows([user({ id: 9, name: "", username: "support", is_system: true })], 1);
  assert.deepEqual(
    rows[0], { kind: "user", userId: 9, title: "@support", subtitle: "", avatarSeed: "support", serviceAccount: true },
    "the de-duplication must not drop the flag the overlay renders the badge from",
  );
});

// ---- SearchController: debounce + min-length + race guard --------------------------------------

interface Harness {
  ctrl: SearchController;
  states: SearchState[];
  fire(): void;                       // run the pending debounced timer
  pending(): boolean;                 // is a debounce scheduled?
  resolveNext(users: SearchUser[]): void;
  rejectNext(err: unknown): void;
}

function harness(): Harness {
  const states: SearchState[] = [];
  let timer: (() => void) | null = null;
  const deferreds: Array<{ resolve: (u: SearchUser[]) => void; reject: (e: unknown) => void }> = [];
  const ports: SearchControllerPorts = {
    search: () => new Promise<SearchUser[]>((resolve, reject) => deferreds.push({ resolve, reject })),
    onState: (s) => states.push(s),
    setTimer: (fn) => { timer = fn; return 1; },
    clearTimer: () => { timer = null; },
    debounceMs: SEARCH_DEBOUNCE_MS,
  };
  return {
    ctrl: new SearchController(ports),
    states,
    fire() { const t = timer; timer = null; t?.(); },
    pending() { return timer !== null; },
    resolveNext(users) { deferreds.shift()!.resolve(users); },
    rejectNext(err) { deferreds.shift()!.reject(err); },
  };
}

test("SearchController: a short query is idle immediately and schedules nothing", () => {
  const h = harness();
  h.ctrl.input("a");
  assert.deepEqual(h.states.map((s) => s.phase), ["idle"]);
  assert.equal(h.pending(), false, "no network call for a 1-char query");
});

test("SearchController: a long query debounces, then loads, then shows results", async () => {
  const h = harness();
  h.ctrl.input("an");
  assert.equal(h.states.length, 0, "nothing emitted until the debounce elapses");
  assert.equal(h.pending(), true);
  h.fire();
  assert.deepEqual(h.states.map((s) => s.phase), ["loading"]);
  h.resolveNext([user()]);
  await flush();
  const last = h.states.at(-1)!;
  assert.equal(last.phase, "results");
  assert.deepEqual((last as { users: SearchUser[] }).users.map((u) => u.id), [2]);
});

test("SearchController: a successful search that returns nobody is 'empty'", async () => {
  const h = harness();
  h.ctrl.input("zz");
  h.fire();
  h.resolveNext([]);
  await flush();
  assert.equal(h.states.at(-1)!.phase, "empty");
});

test("SearchController: each keystroke restarts the debounce (only one search fires)", () => {
  const h = harness();
  h.ctrl.input("an");
  h.ctrl.input("ann");        // restart before the first timer fires
  assert.equal(h.pending(), true);
  h.fire();
  assert.deepEqual(h.states.map((s) => s.phase), ["loading"], "only the latest query searched");
});

test("SearchController: a stale in-flight response never overwrites a newer query (race guard)", async () => {
  const h = harness();
  h.ctrl.input("an"); h.fire();      // run #1 → loading, awaiting deferred #0
  h.ctrl.input("ann"); h.fire();     // run #2 → loading, awaiting deferred #1
  h.resolveNext([user({ id: 100 })]); // resolve run #1 LATE
  await flush();
  h.resolveNext([user({ id: 200 })]); // resolve run #2
  await flush();
  const last = h.states.at(-1)!;
  assert.equal(last.phase, "results");
  assert.deepEqual((last as { users: SearchUser[] }).users.map((u) => u.id), [200], "the newer query's result wins");
});

test("SearchController: cancel() drops a pending debounce and invalidates an in-flight response", async () => {
  const h = harness();
  h.ctrl.input("an"); h.fire();      // loading, awaiting
  h.ctrl.cancel();
  h.resolveNext([user()]);
  await flush();
  assert.equal(h.states.filter((s) => s.phase === "results").length, 0, "the response after cancel is ignored");
});

test("SearchController: a rejected search surfaces an error state", async () => {
  const h = harness();
  h.ctrl.input("an"); h.fire();
  h.rejectNext(new Error("boom"));
  await flush();
  const last = h.states.at(-1)!;
  assert.equal(last.phase, "error");
  assert.ok((last as { error: unknown }).error instanceof Error);
});

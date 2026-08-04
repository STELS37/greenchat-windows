// clients/ui/test/person_name.test.ts — V168: one row, one identity.
//
// Evidence (live stand database, read-only, 2026-08-03):
//   users.name is declared `name TEXT NOT NULL DEFAULT ''`, registration stores what the client sent
//   with no fallback (auth.ts: `sanitizeText(str(b.name)).trim()`), and search returns such an account
//   by username prefix with `name` projected raw (users.ts USER_COLS). A blank display name is
//   therefore a supported state, and 8 of the 67 accounts on the stand are in it:
//
//     1 livesmoke1783650283   2 liveaud23owner_1783654309   3 liveaud23newbie_1783654309
//     4 postdep24_1783657111  7 sbxtest_18439              27 p0qa402524256
//    65 pinafter478145       66 qa1785731573
//
//   The 2026-08-01 backup holds 6 of 54, the 2026-07-31 one 5 of 24 — this is not a lab artefact.
//
// For every one of them, four screens drew the same string twice: the title fell back to the bare
// handle and the line underneath printed "@handle" again. Most visibly on the viewer's OWN profile,
// where "qa1785731573" sat directly above "@qa1785731573".
import { test } from "node:test";
import assert from "node:assert/strict";
import { personLabel } from "../src/screens/person_name.ts";
import { avatarTone, initials } from "../src/screens/message_menu.ts";

test("personLabel: a display name is the title, and the handle earns the line below it", () => {
  assert.deepEqual(
    personLabel({ id: 2, name: "Ann", username: "ann" }),
    { title: "Ann", subtitle: "@ann", avatarSeed: "Ann" },
    "the common case must be byte-identical to before V168 — two lines that say different things",
  );
});

test("personLabel: with no display name the handle becomes the title, and is not echoed", () => {
  assert.deepEqual(
    personLabel({ id: 66, name: "", username: "qa1785731573" }),
    { title: "@qa1785731573", subtitle: "", avatarSeed: "qa1785731573" },
    "the handle IS the title here, so printing it again below states one fact as two",
  );
});

test("personLabel: the title carries the @ so a handle is never read as a chosen name", () => {
  assert.equal(personLabel({ id: 3, name: "", username: "bob" }).title, "@bob");
});

test("personLabel: a whitespace-only name never becomes a blank title", () => {
  const l = personLabel({ id: 5, name: "   ", username: "ghost" });
  assert.equal(l.title, "@ghost", "a title of spaces renders a row with nothing in it");
  assert.equal(l.subtitle, "");
});

test("personLabel: with neither a name nor a handle the id stands in", () => {
  assert.deepEqual(
    personLabel({ id: 404, name: "", username: "" }),
    { title: "404", subtitle: "", avatarSeed: "404" },
    "a row must never be blank, whatever the server sends",
  );
});

test("personLabel: without even an id the title is empty rather than a crash", () => {
  assert.deepEqual(personLabel({ name: "", username: "" }), { title: "", subtitle: "", avatarSeed: "" });
});

// The de-duplication moves an "@" into the title, and avatars hash whatever they are handed. Measured,
// not assumed — the seed exists because of the monogram, and the claim below is only what holds:
//   monogram: initials("@bob") is "@", so all 8 blank-name accounts would have lost their letter.
//   colour:   unchanged, and provably rather than by luck — avatarTone folds h*31+c from 0, so a
//             one-char prefix adds c*31^n, and for "@" that is 64*odd, a multiple of AVATAR_TONES=8.
test("personLabel: the avatar seed keeps the person's letter, and their colour", () => {
  const l = personLabel({ id: 66, name: "", username: "qa1785731573" });
  assert.equal(initials(l.avatarSeed), "Q", "the monogram is the first letter of the handle");
  assert.equal(initials(l.title), "@", "…which is exactly what the title alone would have drawn");
  assert.equal(avatarTone(l.avatarSeed), avatarTone("qa1785731573"), "the tone is the one they have elsewhere");
});

test("personLabel: a named person's avatar still hashes their name, not their handle", () => {
  const l = personLabel({ id: 2, name: "Ann", username: "ann" });
  assert.equal(l.avatarSeed, "Ann");
  assert.equal(avatarTone(l.avatarSeed), avatarTone("Ann"), "unchanged from before V168");
});

// The viewer's own profile hero is the most visible instance: it stacked the two lines directly.
test("personLabel: the profile hero of a viewer with no name shows one line, not two identical ones", () => {
  const l = personLabel({ id: 66, name: "", username: "qa1785731573" });
  const rendered = [l.title, l.subtitle].filter(Boolean);
  assert.deepEqual(rendered, ["@qa1785731573"], "the hero used to render both lines with the same handle");
});

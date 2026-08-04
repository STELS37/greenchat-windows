// clients/ui/src/screens/person_name.ts — V168: how a person is labelled when they never chose a name.
//
// A blank `users.name` is a SUPPORTED state, not corruption. The column is declared
// `name TEXT NOT NULL DEFAULT ''`, registration stores whatever the client sent with no fallback, and
// people-search finds such an account by its username prefix ("always discoverable — that is what a
// username is for"), projecting `name` through raw. On the live stand 8 of the 67 accounts have one.
//
// Every screen that shows a person invented its own fallback for that, and four of them arrived at the
// same mistake: the title fell back to the handle, and the line underneath printed the handle again.
//
//     qa1785731573        <- title,    from `u.name || u.username`
//     @qa1785731573       <- subtitle, from `"@" + u.username`
//
// Two lines, one fact. The lower line is positioned as an extra detail about the person and carries
// none, and the upper line reads as a name they chose when it is really their handle.
//
// So the rule lives here once, and is tested here once, instead of being re-derived per screen.

export interface PersonLike {
  name: string;
  username: string;
  id?: number;
}

export interface PersonLabel {
  /** The line a person is called by — never empty when an id is available. */
  title: string;
  /** The handle line under it, or "" when the title already IS the handle. */
  subtitle: string;
  /** What an avatar's colour and monogram must hash — never the "@" form (see below). */
  avatarSeed: string;
}

export function personLabel(p: PersonLike): PersonLabel {
  // Trimmed: a name of spaces passes `||` and would render a row with no visible title at all.
  const name = p.name.trim();
  // With the "@", because standing in for a name is exactly when it must not be mistaken for one.
  const handle = p.username ? "@" + p.username : "";
  const title = name || handle || (p.id === undefined ? "" : String(p.id));
  return {
    title,
    // The handle earns a second line only when it says something the title does not.
    subtitle: title === handle ? "" : handle,
    // The BARE handle. `initials("@bob")` is "@" — the person would lose their letter to punctuation.
    // (The colour survives the prefix today by arithmetic accident: avatarTone folds h*31+c from 0, so
    // a leading "@" adds 64*31^n and 64 is a multiple of AVATAR_TONES=8. Seeding from the bare handle
    // makes that independent of the constant rather than reliant on it.)
    avatarSeed: name || p.username || title,
  };
}

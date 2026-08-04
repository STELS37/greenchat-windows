// clients/ui/src/screens/new_chat_model.ts — pure model for the "New chat" overlay (T-426, gap G-1).
// Owns the people-search gate: query normalisation, the min-length + debounce before a
// GET /v1/search/global call, a race guard so a slow response can't overwrite a newer query, and the
// row mapping (the always-first "Saved Messages" self row + found users, minus the viewer). DOM-free,
// so the throttle/selection logic is node-tested without a browser — the overlay is the thin DOM shell.
import type { SelfRef } from "./chat_model.ts";
import type { SearchUser } from "./api.ts";
import { isServiceAccount } from "./service_account.ts";
import { personLabel } from "./person_name.ts";

export type { SelfRef };

export const MIN_QUERY_LEN = 2;
export const SEARCH_DEBOUNCE_MS = 300;

// Trim, and treat a leading "@" as noise so "@ann" and "ann" search the same handle.
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/^@+/, "");
}

// Enough to search? (min length after normalisation — avoids a request per keystroke on 1 char.)
export function shouldSearch(raw: string): boolean {
  return normalizeQuery(raw).length >= MIN_QUERY_LEN;
}

// A row in the overlay list: the pinned self "Saved Messages" entry, or a found user to open a dialog.
export interface DirectoryRow {
  kind: "self" | "user";
  userId: number;
  title: string;
  subtitle: string; // "@username" for a user, "" for self and for a user whose title IS the handle
  // V168: what the avatar's colour + monogram are derived from, when that must NOT be the title.
  // Optional and additive: absent for every row whose title is a real display name, so those avatars
  // are computed exactly as before. Set only where the title had to become "@handle", because
  // `initials("@bob")` is "@" — the person would lose their letter. (The tone survives the prefix
  // today by arithmetic accident: `avatarTone` folds h*31+c, so a leading "@" adds 64*31^n, and 64 is
  // a multiple of AVATAR_TONES=8. The seed makes that independent of the constant, not reliant on it.)
  avatarSeed?: string;
  // Real profile image. Absent keeps the deterministic initials fallback and old payload compatibility.
  avatarFileId?: number;
  // T-514 (§4): set only for a service account (users.is_system) so the overlay can render the badge.
  // Optional/additive — absent for every normal account (and for today's payloads without the flag).
  serviceAccount?: true;
}

// The always-first row: open one's own Saved Messages. `label` is i18n "chat.savedMessages".
export function savedRow(self: SelfRef, label: string): DirectoryRow {
  return { kind: "self", userId: self.id, title: label, subtitle: "" };
}

// V29: the self row is pinned to the top, but it is still a search result. Keeping it visible under a
// query it does not match ("карл" → "Избранное") makes the list look like it ignores the input, so the
// row survives only while the query is short enough not to search yet, or while the label matches it.
export function savedRowVisible(raw: string, label: string): boolean {
  const q = normalizeQuery(raw).toLocaleLowerCase();
  if (q.length < MIN_QUERY_LEN) return true;
  return label.toLocaleLowerCase().includes(q);
}

// Map found users into rows: drop the viewer (they already have the pinned self row). The label rule
// itself (name → @handle → id, and no echoing the handle under itself) lives in person_name.ts, which
// documents the measured defect and is shared with the profile hero.
export function userRows(users: SearchUser[], selfId: number): DirectoryRow[] {
  return users
    .filter((u) => u.id !== selfId)
    .map((u) => {
      const { title, subtitle, avatarSeed } = personLabel(u);
      return {
        kind: "user" as const,
        userId: u.id,
        title,
        subtitle,
        // Emitted only when the avatar must NOT hash the title — i.e. exactly when the title became
        // "@handle". Rows for people who have a display name stay byte-identical to before V168.
        ...(avatarSeed === title ? {} : { avatarSeed }),
        ...(typeof u.avatar_file_id === "number" && u.avatar_file_id > 0 ? { avatarFileId: u.avatar_file_id } : {}),
        ...(isServiceAccount(u) ? { serviceAccount: true as const } : {}),
      };
    });
}

// ---- debounced, race-safe search controller ------------------------------------------------------

export type SearchState =
  | { phase: "idle" }                         // query too short: show just the self row + a hint
  | { phase: "loading" }
  | { phase: "results"; users: SearchUser[] } // at least one match
  | { phase: "empty" }                        // searched, nobody found
  | { phase: "error"; error: unknown };

export interface SearchControllerPorts {
  search(q: string): Promise<SearchUser[]>;       // the normalised query → users (already extracted)
  onState(state: SearchState): void;              // emit a state for the view to render
  setTimer(fn: () => void, ms: number): unknown;  // injected (default: setTimeout) — tests drive it
  clearTimer(handle: unknown): void;              // injected (default: clearTimeout)
  debounceMs?: number;                            // default SEARCH_DEBOUNCE_MS
}

// Turns raw input events into a throttled, race-safe stream of search states. The view owns the DOM;
// this owns *when* to fire and *which* result wins. `seq` invalidates a stale response that lands after
// a newer query (or after cancel), so it can never repaint the wrong list.
export class SearchController {
  private handle: unknown = null;
  private seq = 0;
  private readonly ports: SearchControllerPorts;
  private readonly debounceMs: number;
  constructor(ports: SearchControllerPorts) {
    this.ports = ports;
    this.debounceMs = ports.debounceMs ?? SEARCH_DEBOUNCE_MS;
  }

  // Feed every input value here. A short query goes straight to "idle"; otherwise debounce, then search.
  input(raw: string): void {
    this.clearPending();
    const q = normalizeQuery(raw);
    if (q.length < MIN_QUERY_LEN) { this.ports.onState({ phase: "idle" }); return; }
    this.handle = this.ports.setTimer(() => { this.handle = null; void this.run(q); }, this.debounceMs);
  }

  // Abort a pending debounce and invalidate any in-flight response (on Escape / close).
  cancel(): void { this.clearPending(); this.seq++; }

  private clearPending(): void {
    if (this.handle !== null) { this.ports.clearTimer(this.handle); this.handle = null; }
  }

  private async run(q: string): Promise<void> {
    const mine = ++this.seq;
    this.ports.onState({ phase: "loading" });
    try {
      const users = await this.ports.search(q);
      if (mine !== this.seq) return;                 // a newer query (or cancel) superseded us
      this.ports.onState(users.length ? { phase: "results", users } : { phase: "empty" });
    } catch (error) {
      if (mine !== this.seq) return;
      this.ports.onState({ phase: "error", error });
    }
  }
}

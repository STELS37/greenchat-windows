// clients/ui/src/screens/contacts_model.ts — pure model behind the «Контакты» shell destination.
//
// The server has carried a complete contact contour since T-113 (modules/contacts.ts: POST/GET/DELETE
// /v1/contacts plus /v1/contacts/sync, MAX_CONTACTS = 5000) and the privacy defaults it ships depend on
// it: `birthday`, `find_by_phone` and `find_by_email` all default to "contacts", i.e. "visible to people
// on my contact list". Until this model no client code called any of those routes (grep over clients/**
// for "/v1/contacts" returned nothing), so that list could never be built and those three defaults were
// unreachable promises. This file is the DOM-free half: response validation, the local filter, and the
// add/remove calls — so the rules are node-tested without a browser (contacts_screen.ts is the shell).
import { apiErrorCode, type ApiLike, type ResolvedUser, type SearchUser } from "./api.ts";

// A row of GET /v1/contacts: publicUser + the per-owner `alias` (server: listContacts). Only the fields
// the screen renders are typed; anything else the server adds rides through untouched.
export interface ContactRow {
  id: number;
  username: string;
  name: string;
  alias: string;
  avatar_file_id: number | null;
  is_bot: boolean;
}

export type ContactsErrorCode = "invalid_response" | "invalid_user" | "search_unavailable";

export class ContactsError extends Error {
  readonly code: ContactsErrorCode;
  constructor(code: ContactsErrorCode, message: string) {
    super(message);
    this.name = "ContactsError";
    this.code = code;
  }
}

// The same structural guard the blocked-user list uses (safety_model.isSearchUser), widened by `alias`.
// A payload that is not a list of people is a bug, not an empty contact list: rendering "no contacts"
// for a malformed body would claim, in the one place the answer matters, that the person has none.
function isContactRow(value: unknown): value is ContactRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<ResolvedUser> & Record<string, unknown>;
  return (
    row.deleted !== true &&
    Number.isSafeInteger(row.id) &&
    Number(row.id) > 0 &&
    typeof row.username === "string" &&
    typeof row.name === "string" &&
    typeof row.is_bot === "boolean" &&
    (row.avatar_file_id === null || Number.isSafeInteger(row.avatar_file_id)) &&
    (row.alias === undefined || typeof row.alias === "string")
  );
}

// GET /v1/contacts answers a BARE ARRAY (not {contacts:[…]}) already ordered by
// users.name COLLATE NOCASE, then users.username COLLATE NOCASE. The alias is deliberately absent
// from that order: it changes only what the owner sees, not the server's canonical row position.
export function parseContacts(value: unknown): ContactRow[] {
  if (!Array.isArray(value) || !value.every(isContactRow)) {
    throw new ContactsError("invalid_response", "Invalid contact list response");
  }
  return value.map((row) => ({
    id: row.id,
    username: row.username,
    name: row.name,
    alias: typeof row.alias === "string" ? row.alias : "",
    avatar_file_id: row.avatar_file_id ?? null,
    is_bot: row.is_bot,
  }));
}

// What to call this person: the alias the owner gave them wins over the name they chose for themselves
// (that is the entire point of an address book), then the display name, then the handle, then the id —
// so a row is never blank, whatever the server sends.
export function contactTitle(row: ContactRow): string {
  return row.alias.trim() || row.name.trim() || (row.username ? "@" + row.username : "") || String(row.id);
}

// The handle line under the title. An alias hides the real name, so show it here instead of losing it.
export function contactSubtitle(row: ContactRow): string {
  const handle = row.username ? "@" + row.username : "";
  const aliased = row.alias.trim() && row.name.trim() && row.alias.trim() !== row.name.trim();
  if (aliased) return handle ? `${row.name.trim()} · ${handle}` : row.name.trim();
  return handle;
}

// Local filter over the already-loaded list. Deliberately NOT a server round trip: the list is capped at
// 5000 rows and already in memory, so typing filters instantly and works offline; the directory search
// (which does hit the network) is a separate, debounced concern layered on top by the screen.
export function matchesQuery(row: ContactRow, query: string): boolean {
  const q = query.trim().replace(/^@+/, "").toLocaleLowerCase();
  if (!q) return true;
  return [row.alias, row.name, row.username].some((field) => field.toLocaleLowerCase().includes(q));
}

export function filterContacts(rows: ContactRow[], query: string): ContactRow[] {
  return rows.filter((row) => matchesQuery(row, query));
}

// SQLite's built-in NOCASE folds ASCII A-Z only, then compares the resulting UTF-8 bytes. Reproduce
// that exact order for the one row inserted locally after POST /v1/contacts; localeCompare would use
// the device locale and sorting by contactTitle would incorrectly let an alias move the row.
const utf8 = new TextEncoder();

function sqliteNoCaseBytes(value: string): Uint8Array {
  return utf8.encode(value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = left[i]! - right[i]!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function compareContactsServerOrder(left: ContactRow, right: ContactRow): number {
  const byName = compareBytes(sqliteNoCaseBytes(left.name), sqliteNoCaseBytes(right.name));
  if (byName !== 0) return byName;
  return compareBytes(sqliteNoCaseBytes(left.username), sqliteNoCaseBytes(right.username));
}

export function upsertContactInServerOrder(rows: readonly ContactRow[], contact: ContactRow): ContactRow[] {
  const out = rows.filter((row) => row.id !== contact.id);
  const index = out.findIndex((row) => compareContactsServerOrder(contact, row) < 0);
  if (index < 0) out.push(contact);
  else out.splice(index, 0, contact);
  return out;
}

// Directory hits worth offering an "add" button: never yourself, never someone already on the list.
// Without this the search results would invite the person to add a contact they already have — the
// call is idempotent server-side, so nothing would break, but the button would be a lie.
export function addableUsers(found: SearchUser[], contacts: ContactRow[], selfId: number): SearchUser[] {
  const known = new Set(contacts.map((row) => row.id));
  return found.filter((user) => user.id !== selfId && !known.has(user.id));
}

// ---- transport ------------------------------------------------------------------------------------

export async function loadContacts(api: ApiLike): Promise<ContactRow[]> {
  return parseContacts(await api.get<unknown>("/v1/contacts"));
}

// POST /v1/contacts {user_id} — idempotent on the server, so a double tap cannot create a duplicate.
// The response is the added person (publicUser + alias), which the screen slots into the list without
// refetching the whole address book.
export async function addContact(api: ApiLike, userId: number): Promise<ContactRow> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ContactsError("invalid_user", "A contact id must be a positive integer");
  }
  const rows = parseContacts([await api.post<unknown>("/v1/contacts", { user_id: userId })]);
  const row = rows[0];
  if (!row) throw new ContactsError("invalid_response", "Invalid add-contact response");
  return row;
}

// DELETE /v1/contacts/:userId → {ok:true}. The id is validated here because the path is interpolated:
// a NaN would ask the server to delete "/v1/contacts/NaN" and read as a 404 "user not found" instead of
// the client-side bug it is.
export async function removeContact(api: ApiLike, userId: number): Promise<void> {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new ContactsError("invalid_user", "A contact id must be a positive integer");
  }
  await api.delete<unknown>(`/v1/contacts/${userId}`);
}

// The server caps a contact list at MAX_CONTACTS (5000) and answers LIMIT_EXCEEDED. Surfaced separately
// because it is the one add failure that is not transient: retrying will never help.
export function isContactsLimit(err: unknown): boolean {
  return apiErrorCode(err) === "LIMIT_EXCEEDED";
}

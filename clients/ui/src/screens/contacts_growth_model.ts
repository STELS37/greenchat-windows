// clients/ui/src/screens/contacts_growth_model.ts — private phonebook discovery + invite contracts.
//
// The native shell never gives the WebView names or phone numbers. Android reads the address book,
// normalises each number, hashes it locally and returns only SHA-256 digests. This model validates that
// boundary again, submits one bounded request per explicit user action and keeps the UI independent
// from Capacitor. Web/PWA may use the Contact Picker API when the browser exposes it; raw
// numbers still live only long enough to be normalised and hashed in this process.
import type { ApiLike, SearchUser } from "./api.ts";
import type { SelfRef } from "./new_chat_model.ts";

// One tap must consume exactly one server rate-limit slot. Splitting a 1,500-number phonebook into
// three 500-hash requests exhausted the server's 3/hour allowance and made the first retry fail with 429.
export const CONTACT_SYNC_BATCH = 1500;
export const CONTACT_SYNC_MAX_REQUESTS = 1;
export const CONTACT_SYNC_MAX_HASHES = CONTACT_SYNC_BATCH * CONTACT_SYNC_MAX_REQUESTS;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface AddressBookScan {
  hashes: string[];
  total_numbers: number;
  normalized_numbers: number;
  skipped_numbers: number;
  truncated: boolean;
}

export interface AddressBookBridge {
  readHashes(): Promise<AddressBookScan>;
  inviteBySms(text: string): Promise<{ opened: boolean }>;
}

export interface ContactSyncChunk {
  matched: SearchUser[];
  matched_count: number;
  invite_count: number;
  added_count: number;
  already_contact_count: number;
}

export interface ContactSyncSummary {
  matched: SearchUser[];
  checked: number;
  inviteCount: number;
  addedCount: number;
  alreadyContactCount: number;
  requestCount: number;
}

export class ContactsGrowthError extends Error {
  readonly code: "invalid_scan" | "invalid_sync" | "unsupported";
  constructor(code: "invalid_scan" | "invalid_sync" | "unsupported", message: string) {
    super(message);
    this.name = "ContactsGrowthError";
    this.code = code;
  }
}

function nonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSearchUser(value: unknown): value is SearchUser {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(row.id) && Number(row.id) > 0 &&
    typeof row.username === "string" &&
    typeof row.name === "string" &&
    typeof row.is_bot === "boolean" &&
    (row.avatar_file_id === null || Number.isSafeInteger(row.avatar_file_id))
  );
}

export function parseAddressBookScan(value: unknown): AddressBookScan {
  if (!value || typeof value !== "object") {
    throw new ContactsGrowthError("invalid_scan", "Invalid address-book scan response");
  }
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.hashes) || !raw.hashes.every((h) => typeof h === "string" && SHA256_HEX.test(h)) ||
    !nonNegativeInt(raw.total_numbers) || !nonNegativeInt(raw.normalized_numbers) ||
    !nonNegativeInt(raw.skipped_numbers) || typeof raw.truncated !== "boolean"
  ) {
    throw new ContactsGrowthError("invalid_scan", "Invalid address-book scan response");
  }
  const hashes = Array.from(new Set(raw.hashes.map((h) => h.toLowerCase()))).slice(0, CONTACT_SYNC_MAX_HASHES);
  return {
    hashes,
    total_numbers: raw.total_numbers,
    normalized_numbers: raw.normalized_numbers,
    skipped_numbers: raw.skipped_numbers,
    truncated: raw.truncated || raw.hashes.length > CONTACT_SYNC_MAX_HASHES,
  };
}

export function parseContactSyncChunk(value: unknown): ContactSyncChunk {
  if (!value || typeof value !== "object") {
    throw new ContactsGrowthError("invalid_sync", "Invalid contact-sync response");
  }
  const raw = value as Record<string, unknown>;
  if (
    !Array.isArray(raw.matched) || !raw.matched.every(isSearchUser) ||
    !nonNegativeInt(raw.matched_count) || !nonNegativeInt(raw.invite_count) ||
    !nonNegativeInt(raw.added_count) || !nonNegativeInt(raw.already_contact_count) ||
    raw.matched_count !== raw.matched.length
  ) {
    throw new ContactsGrowthError("invalid_sync", "Invalid contact-sync response");
  }
  return {
    matched: raw.matched,
    matched_count: raw.matched_count,
    invite_count: raw.invite_count,
    added_count: raw.added_count,
    already_contact_count: raw.already_contact_count,
  };
}

export function contactSyncBatches(hashes: readonly string[]): string[][] {
  const unique = Array.from(new Set(
    hashes
      .filter((h): h is string => typeof h === "string")
      .map((h) => h.toLowerCase())
      .filter((h) => SHA256_HEX.test(h)),
  )).slice(0, CONTACT_SYNC_MAX_HASHES);
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += CONTACT_SYNC_BATCH) {
    out.push(unique.slice(i, i + CONTACT_SYNC_BATCH));
  }
  return out;
}

export async function syncAddressBook(api: ApiLike, scanValue: unknown): Promise<ContactSyncSummary> {
  const scan = parseAddressBookScan(scanValue);
  const batches = contactSyncBatches(scan.hashes);
  const byId = new Map<number, SearchUser>();
  let inviteCount = 0;
  let addedCount = 0;
  let alreadyContactCount = 0;
  for (const hashes of batches) {
    const result = parseContactSyncChunk(await api.post<unknown>("/v1/contacts/sync", {
      hashes,
      add_matches: true,
    }));
    for (const user of result.matched) byId.set(user.id, user);
    inviteCount += result.invite_count;
    addedCount += result.added_count;
    alreadyContactCount += result.already_contact_count;
  }
  return {
    matched: [...byId.values()],
    checked: scan.hashes.length,
    inviteCount,
    addedCount,
    alreadyContactCount,
    requestCount: batches.length,
  };
}

export function inviteProfileUrl(self: SelfRef, origin: string): string {
  const base = origin.trim().replace(/\/+$/, "");
  const username = self.username.trim().replace(/^@+/, "");
  const path = username ? `/#/user/${encodeURIComponent(username)}` : "/#/";
  return (base || "https://greenchat.globalsystem.cc") + path;
}

function canonicalE164(raw: string): string | null {
  const compact = raw.trim().replace(/[\s().-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(compact) ? compact : null;
}

async function sha256Hex(value: string, cryptoLike: Crypto): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await cryptoLike.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface ContactPickerLike {
  select(properties: string[], options: { multiple: boolean }): Promise<Array<{ tel?: string[] }>>;
}

// Browser fallback. We intentionally accept only already-international (+E.164) values: guessing a
// country in a PWA can silently match the wrong person. Android's native bridge has SIM/network locale
// and performs the fuller normalisation path.
export async function readBrowserAddressBook(
  contacts: ContactPickerLike | undefined,
  cryptoLike: Crypto | undefined,
): Promise<AddressBookScan> {
  if (!contacts || !cryptoLike?.subtle) {
    throw new ContactsGrowthError("unsupported", "Address-book access is unavailable");
  }
  const selected = await contacts.select(["tel"], { multiple: true });
  const raw = selected.flatMap((contact) => Array.isArray(contact.tel) ? contact.tel : []);
  const parsed = raw.map(canonicalE164);
  const canonical = Array.from(new Set(parsed.filter((v): v is string => v !== null)));
  const limited = canonical.slice(0, CONTACT_SYNC_MAX_HASHES);
  const hashes = await Promise.all(limited.map((phone) => sha256Hex(phone, cryptoLike)));
  return {
    hashes,
    total_numbers: raw.length,
    normalized_numbers: canonical.length,
    // Duplicates are harmless deduplication, not malformed input. Report only numbers we could not
    // safely interpret without guessing a country.
    skipped_numbers: parsed.filter((value) => value === null).length,
    truncated: canonical.length > CONTACT_SYNC_MAX_HASHES,
  };
}

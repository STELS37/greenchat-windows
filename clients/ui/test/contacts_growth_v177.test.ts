// V177 — phonebook discovery is private, bounded and acquisition-oriented.
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import type { ApiLike, SearchUser } from "../src/screens/api.ts";
import {
  CONTACT_SYNC_BATCH,
  CONTACT_SYNC_MAX_HASHES,
  ContactsGrowthError,
  contactSyncBatches,
  inviteProfileUrl,
  parseAddressBookScan,
  readBrowserAddressBook,
  syncAddressBook,
} from "../src/screens/contacts_growth_model.ts";

const hash = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);
const user = (id: number): SearchUser => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  avatar_file_id: null,
  is_bot: false,
});

const apiWith = (post: ApiLike["post"]): ApiLike => ({
  get: async <T>(): Promise<T> => { throw new Error("unused GET"); },
  post,
  put: async <T>(): Promise<T> => { throw new Error("unused PUT"); },
  patch: async <T>(): Promise<T> => { throw new Error("unused PATCH"); },
  delete: async <T>(): Promise<T> => { throw new Error("unused DELETE"); },
  refreshTokens: async () => false,
});

test("V179: hashes are deduplicated and capped to one rate-limit-safe request", () => {
  const input = Array.from({ length: CONTACT_SYNC_MAX_HASHES + 80 }, (_v, i) => hash(i));
  input.splice(3, 0, hash(1), "not-a-hash");
  const batches = contactSyncBatches(input);
  assert.equal(batches.length, 1);
  assert.equal(CONTACT_SYNC_BATCH, 1500);
  assert.deepEqual(batches.map((batch) => batch.length), [CONTACT_SYNC_BATCH]);
  assert.equal(new Set(batches.flat()).size, CONTACT_SYNC_MAX_HASHES);
  assert.equal(batches.flat().includes("not-a-hash"), false);
});

test("V179: sync uses add_matches once for a bounded phonebook", async () => {
  const calls: Array<{ path: string; body: { hashes: string[]; add_matches: boolean } }> = [];
  const api = apiWith(async <T>(path: string, body?: unknown): Promise<T> => {
    const typed = body as { hashes: string[]; add_matches: boolean };
    calls.push({ path, body: typed });
    const index = calls.length;
    return {
      matched: [user(index)],
      matched_count: 1,
      invite_count: typed.hashes.length - 1,
      added_count: index === 1 ? 1 : 0,
      already_contact_count: index === 1 ? 0 : 1,
    } as T;
  });
  const hashes = Array.from({ length: 1001 }, (_v, i) => hash(i + 1));
  const summary = await syncAddressBook(api, {
    hashes,
    total_numbers: hashes.length,
    normalized_numbers: hashes.length,
    skipped_numbers: 0,
    truncated: false,
  });
  assert.deepEqual(calls.map((call) => call.path), ["/v1/contacts/sync"]);
  assert.ok(calls.every((call) => call.body.add_matches === true));
  assert.deepEqual(calls.map((call) => call.body.hashes.length), [1001]);
  assert.equal(summary.checked, 1001);
  assert.equal(summary.addedCount, 1);
  assert.equal(summary.alreadyContactCount, 0);
  assert.equal(summary.matched.length, 1);
  assert.equal(summary.requestCount, 1);
});

test("V177: malformed native or server data never becomes a false empty result", async () => {
  assert.throws(
    () => parseAddressBookScan({ hashes: ["raw-phone-number"], total_numbers: 1, normalized_numbers: 1, skipped_numbers: 0, truncated: false }),
    (error: unknown) => error instanceof ContactsGrowthError && error.code === "invalid_scan",
  );
  const api = apiWith(async <T>(): Promise<T> => ({ matched: [], matched_count: 0, invite_count: 1 } as T));
  await assert.rejects(
    () => syncAddressBook(api, { hashes: [hash(1)], total_numbers: 1, normalized_numbers: 1, skipped_numbers: 0, truncated: false }),
    (error: unknown) => error instanceof ContactsGrowthError && error.code === "invalid_sync",
  );
});

test("V177: browser fallback hashes only explicit international numbers in-process", async () => {
  const scan = await readBrowserAddressBook({
    select: async () => [
      { tel: ["+1 (415) 555-0001", "+1 (415) 555-0001"] },
      { tel: ["8 999 123-45-67", "+49 30 12345678"] },
    ],
  }, webcrypto as unknown as Crypto);
  assert.equal(scan.total_numbers, 4);
  assert.equal(scan.normalized_numbers, 2);
  assert.equal(scan.skipped_numbers, 1);
  assert.equal(scan.hashes.length, 2);
  assert.ok(scan.hashes.every((value) => /^[0-9a-f]{64}$/.test(value)));
});

test("V177: invite links use the public server origin, not Capacitor localhost", () => {
  assert.equal(
    inviteProfileUrl({ id: 7, name: "Ivan", username: "@ivan" }, "https://greenchat.example/"),
    "https://greenchat.example/#/user/ivan",
  );
  assert.equal(
    inviteProfileUrl({ id: 7, name: "Ivan", username: "" }, ""),
    "https://greenchat.globalsystem.cc/#/",
  );
});

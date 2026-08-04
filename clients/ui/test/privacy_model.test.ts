import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRIVACY_ITEMS,
  privacyOptions,
  privacyDefault,
  normalizePrivacy,
} from "../src/screens/privacy_model.ts";

test("PRIVACY_ITEMS: covers exactly the 12 M0 keys", () => {
  const keys = PRIVACY_ITEMS.map((i) => i.key);
  assert.deepEqual([...keys].sort(), [
    "birthday",
    "calls",
    "find_by_email",
    "find_by_name",
    "find_by_phone",
    "forward_privacy",
    "group_invite",
    "last_seen",
    "profile_photo",
    "read_receipts",
    "typing_indicator",
    "who_can_message",
  ]);
  assert.equal(new Set(keys).size, keys.length, "no duplicate keys");
});

test("privacyOptions: value domain per kind", () => {
  assert.deepEqual(privacyOptions("scope"), ["everyone", "contacts", "nobody"]);
  assert.deepEqual(privacyOptions("reach"), ["everyone", "contacts"]);
  assert.deepEqual(privacyOptions("toggle"), ["on", "off"]);
});

test("privacyDefault: mirrors the server defaults", () => {
  assert.equal(privacyDefault("last_seen"), "everyone");
  assert.equal(privacyDefault("find_by_phone"), "contacts");
  assert.equal(privacyDefault("read_receipts"), "on");
  assert.equal(privacyDefault("forward_privacy"), "off");
});

test("normalizePrivacy: fills missing keys with defaults and drops unknown keys", () => {
  const out = normalizePrivacy({ last_seen: "nobody", bogus: "x" } as Record<string, string>);
  assert.equal(out.last_seen, "nobody", "explicit value kept");
  assert.equal(out.read_receipts, "on", "missing key filled with default");
  assert.equal("bogus" in out, false, "unknown key dropped");
  assert.equal(Object.keys(out).length, PRIVACY_ITEMS.length);
});

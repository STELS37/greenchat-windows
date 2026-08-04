// T-529 — UI-side cache policy contract mirrors core string values.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_RETENTION_OPTIONS,
  CHAT_CACHE_OPTIONS,
  normalizeCacheRetention,
  normalizeChatCacheMode,
} from "../src/screens/cache_policy_model.ts";

test("T-529 global retention exposes exactly forever/30d/7d/24h and defaults safely", () => {
  assert.deepEqual(CACHE_RETENTION_OPTIONS, ["forever", "30d", "7d", "24h"]);
  for (const mode of CACHE_RETENTION_OPTIONS) assert.equal(normalizeCacheRetention(mode), mode);
  assert.equal(normalizeCacheRetention("cloud_only"), "forever");
  assert.equal(normalizeCacheRetention(null), "forever");
});

test("T-529 chat override adds inherit + cloud_only and rejects unknown values", () => {
  assert.deepEqual(CHAT_CACHE_OPTIONS, ["inherit", "forever", "30d", "7d", "24h", "cloud_only"]);
  for (const mode of CHAT_CACHE_OPTIONS) assert.equal(normalizeChatCacheMode(mode), mode);
  assert.equal(normalizeChatCacheMode("broken"), "inherit");
  assert.equal(normalizeChatCacheMode(undefined), "inherit");
});

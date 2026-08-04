import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "../src/i18n.ts";
import { ru } from "../src/locales/ru.ts";
import { en } from "../src/locales/en.ts";
import { apiErrorCode, isNetworkError, apiErrorData, describeError } from "../src/screens/api.ts";

// Stand-ins that reproduce ONLY the stable contract the helpers read (.name/.code/.data) — no core import.
const apiErr = (code: string, data?: unknown) => ({ name: "ApiError", code, data });
const netErr = () => ({ name: "NetworkError", timedOut: true });

test("apiErrorCode: reads the code of an ApiError-shaped value, null otherwise", () => {
  assert.equal(apiErrorCode(apiErr("USERNAME_TAKEN")), "USERNAME_TAKEN");
  assert.equal(apiErrorCode(netErr()), null);
  assert.equal(apiErrorCode(new Error("boom")), null);
  assert.equal(apiErrorCode(null), null);
  assert.equal(apiErrorCode("nope"), null);
});

test("isNetworkError: only true for a NetworkError-shaped value", () => {
  assert.equal(isNetworkError(netErr()), true);
  assert.equal(isNetworkError(apiErr("RATE_LIMITED")), false);
  assert.equal(isNetworkError(undefined), false);
});

test("apiErrorData: returns merged extras or an empty object", () => {
  assert.deepEqual(apiErrorData(apiErr("RATE_LIMITED", { retry_after: 30 })), { retry_after: 30 });
  assert.deepEqual(apiErrorData(apiErr("X")), {});
  assert.deepEqual(apiErrorData(netErr()), {});
});

test("describeError: network → offline text, server code → its Appendix-D text", () => {
  const i = createI18n({ locale: "ru", dicts: { ru, en } });
  assert.equal(describeError(netErr(), i), i.t("errors.network"));
  assert.equal(describeError(apiErr("UNAUTHORIZED"), i), i.error("UNAUTHORIZED"));
  assert.equal(describeError(new Error("x"), i), i.t("errors.unknown"));
});

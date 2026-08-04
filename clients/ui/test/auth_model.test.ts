import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRegister,
  validateLogin,
  assessPassword,
  fieldForServerError,
  PASSWORD_MIN,
  PASSWORD_STRENGTH_MAX,
  USERNAME_MIN,
  USERNAME_MAX,
} from "../src/screens/auth_model.ts";

test("validateRegister: accepts a well-formed input", () => {
  const r = validateRegister({ username: "annabel", password: "hunter2!", name: "Ann" });
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, {});
});

test("validateRegister: flags empty username/name and short/empty password", () => {
  const r = validateRegister({ username: "  ", password: "short", name: "" });
  assert.equal(r.valid, false);
  assert.equal(r.errors.username, "required");
  assert.equal(r.errors.name, "required");
  assert.equal(r.errors.password, "password_short");
  assert.equal("hunter2!".length >= PASSWORD_MIN, true);
});

test("validateRegister: empty password is required, not password_short", () => {
  const r = validateRegister({ username: "annabel", password: "", name: "Ann" });
  assert.equal(r.errors.password, "required");
});

test("validateRegister: email checked only when present", () => {
  assert.equal(validateRegister({ username: "alice", password: "abcdefgh", name: "A" }).valid, true);
  assert.equal(
    validateRegister({ username: "alice", password: "abcdefgh", name: "A", email: "nope" }).errors.email,
    "email_invalid",
  );
  assert.equal(
    validateRegister({ username: "alice", password: "abcdefgh", name: "A", email: "a@b.co" }).valid,
    true,
  );
});

// Campaign 12: the shape rule now runs client-side so a doomed handle is caught before the round
// trip. It must stay a MIRROR of server/src/core/username.ts USERNAME_RE.
test("validateRegister: username shape mirrors the server policy", () => {
  const bad = ["ann", "9lives", "_lead", "ann-abel", "ann.abel", "ann abel", "a".repeat(USERNAME_MAX + 1)];
  for (const username of bad) {
    const r = validateRegister({ username, password: "hunter2!", name: "Ann" });
    assert.equal(r.valid, false, `expected ${JSON.stringify(username)} to be rejected`);
    assert.equal(r.errors.username, "username_invalid", `wrong code for ${JSON.stringify(username)}`);
  }
  const good = ["a".repeat(USERNAME_MIN), "a".repeat(USERNAME_MAX), "STELS37", "ann_abel", "Ann99"];
  for (const username of good) {
    const r = validateRegister({ username, password: "hunter2!", name: "Ann" });
    assert.equal(r.valid, true, `expected ${JSON.stringify(username)} to pass`);
  }
});

// Sign-in must NOT apply the shape rule: accounts registered before the policy landed may hold
// handles it would reject, and locking them out of their own account would be a far worse bug.
test("validateLogin: both fields required, no shape rule", () => {
  assert.equal(validateLogin({ username: "a", password: "b" }).valid, true);
  assert.equal(validateLogin({ username: "old-style.name", password: "b" }).valid, true);
  const r = validateLogin({ username: "", password: "" });
  assert.equal(r.errors.username, "required");
  assert.equal(r.errors.password, "required");
});

test("fieldForServerError: maps server codes onto the input that caused them", () => {
  assert.equal(fieldForServerError("USERNAME_TAKEN"), "username");
  assert.equal(fieldForServerError("USERNAME_RESERVED"), "username");
  assert.equal(fieldForServerError("EMAIL_TAKEN"), "email");
  assert.equal(fieldForServerError("EMAIL_QUARANTINED"), "email");
  // Anything not about one specific box stays in the form-wide banner.
  assert.equal(fieldForServerError("RATE_LIMITED"), null);
  assert.equal(fieldForServerError(null), null);
  assert.equal(fieldForServerError(undefined), null);
});

test("assessPassword: advisory score, never a gate", () => {
  assert.deepEqual(assessPassword(""), { score: 0, reason: null });
  assert.deepEqual(assessPassword("short"), { score: 0, reason: "too_short" });
  assert.deepEqual(assessPassword("password"), { score: 1, reason: "common" });
  assert.deepEqual(assessPassword("stels37stels37", "STELS37"), { score: 1, reason: "contains_username" });
  // A short handle must not poison every password that happens to contain those letters.
  assert.equal(assessPassword("Abcdefgh1!", "an").reason, null);

  const weak = assessPassword("abcdefgh");
  const fair = assessPassword("Abcdefgh1");
  const good = assessPassword("Qwerty12345!");
  const strong = assessPassword("Tr0ub4dor&3xtra-Long");
  assert.equal(weak.score, 1);
  assert.equal(fair.score, 2);
  assert.equal(good.score, 3);
  assert.equal(strong.score, PASSWORD_STRENGTH_MAX);
  // Monotonic: adding length/classes never lowers the score (the meter must not flicker downward
  // while the user types).
  assert.ok(weak.score <= fair.score && fair.score <= good.score && good.score <= strong.score);
  for (const s of [weak, fair, good, strong]) {
    assert.ok(s.score >= 0 && s.score <= PASSWORD_STRENGTH_MAX);
  }
});

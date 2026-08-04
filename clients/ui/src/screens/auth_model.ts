// clients/ui/src/screens/auth_model.ts — pure client-side validation for the auth screens (T-405).
// A light pre-flight only: the server (auth.ts) is the authority (username policy, uniqueness, scrypt).
// We reject the obvious locally so a user gets instant feedback without a round-trip, and mirror the one
// hard numeric rule the server states explicitly: password ≥ 8 chars. DOM-free → unit-tested directly.

export type AuthField = "username" | "password" | "name" | "email";
export type AuthFieldError = "required" | "password_short" | "email_invalid" | "username_invalid";
export interface AuthValidation {
  valid: boolean;
  errors: Partial<Record<AuthField, AuthFieldError>>;
}

// Loose email shape — the server normalises/validates strictly; this only blocks a clearly broken address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN = 8;

// Mirror of server/src/core/username.ts USERNAME_RE (T-118): one ASCII letter, then 3–31 of
// [a-z0-9_], i.e. 4–32 characters in total. The server stays the authority — it additionally
// NFKC-normalises, refuses mixed-script/confusable letters and holds the reserved-word list — but
// registration used to bounce off it with a generic "Please check the entered data" AFTER a round
// trip. Checking the shape here lets the field say what is wrong while the user is still typing.
export const USERNAME_RE = /^[a-z][a-z0-9_]{3,31}$/i;
export const USERNAME_MIN = 4;
export const USERNAME_MAX = 32;

export interface RegisterInput {
  username: string;
  password: string;
  name: string;
  email?: string;
}

export function validateRegister(input: RegisterInput): AuthValidation {
  const errors: Partial<Record<AuthField, AuthFieldError>> = {};
  const username = input.username.trim();
  if (username === "") errors.username = "required";
  // Shape check on sign-up only. Sign-in must NOT apply it: accounts created before T-118 may hold
  // handles the current policy would reject, and they still have to be able to log in.
  else if (!USERNAME_RE.test(username)) errors.username = "username_invalid";
  if (input.name.trim() === "") errors.name = "required";
  if (input.password.length === 0) errors.password = "required";
  else if (input.password.length < PASSWORD_MIN) errors.password = "password_short";
  const email = (input.email ?? "").trim();
  if (email !== "" && !EMAIL_RE.test(email)) errors.email = "email_invalid";
  return { valid: Object.keys(errors).length === 0, errors };
}

export interface LoginInput {
  username: string;
  password: string;
}

export function validateLogin(input: LoginInput): AuthValidation {
  const errors: Partial<Record<AuthField, AuthFieldError>> = {};
  if (input.username.trim() === "") errors.username = "required";
  if (input.password === "") errors.password = "required";
  return { valid: Object.keys(errors).length === 0, errors };
}

// ── Server errors that belong on a field, not in the form-wide banner ────────────────────────────
// "That username is already taken" printed at the bottom of the form left the offending input
// looking valid (the owner's screenshot: a red line under the button while the username box that
// caused it was untouched). These Appendix D codes name exactly one input, so the screen can put
// the message there, focus it and mark it aria-invalid. Anything else (UNAUTHORIZED — which
// deliberately does not say WHICH of the two was wrong, RATE_LIMITED, LEGAL_*, …) stays form-wide.
export function fieldForServerError(code: string | null | undefined): AuthField | null {
  switch (code) {
    case "USERNAME_TAKEN":
    case "USERNAME_RESERVED":
      return "username";
    case "EMAIL_TAKEN":
    case "EMAIL_QUARANTINED":
      return "email";
    default:
      return null;
  }
}

// ── Password strength ───────────────────────────────────────────────────────────────────────────
// A deliberately transparent rubric (no entropy hand-waving, no wordlist download): length buckets
// plus how many character classes are present, with two hard caps for the failure modes that make
// a long password worthless anyway. It is advisory — the server's only hard rule is ≥ 8 chars —
// so it never blocks submission; it just tells the user where they stand.
export type PasswordStrength = 0 | 1 | 2 | 3 | 4;
export const PASSWORD_STRENGTH_MAX = 4;

// The handful of passwords that top every published breach list, in the forms that still pass a
// "≥ 8 characters" rule. Short by design: this is a UI hint, not a credential-stuffing defence.
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "12345678",
  "123456789",
  "1234567890",
  "qwerty123",
  "qwertyui",
  "iloveyou",
  "admin123",
  "letmein1",
  "welcome1",
  "abc12345",
  "11111111",
  "00000000",
]);

export interface PasswordAssessment {
  score: PasswordStrength;
  // Why a score is capped, when it is — so the UI can say something concrete instead of "weak".
  reason: "too_short" | "common" | "contains_username" | null;
}

export function assessPassword(password: string, username = ""): PasswordAssessment {
  if (password.length === 0) return { score: 0, reason: null };
  if (password.length < PASSWORD_MIN) return { score: 0, reason: "too_short" };
  const folded = password.toLowerCase();
  if (COMMON_PASSWORDS.has(folded)) return { score: 1, reason: "common" };
  const handle = username.trim().toLowerCase();
  if (handle.length >= 3 && folded.includes(handle)) return { score: 1, reason: "contains_username" };

  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;

  let points = 1; // clearing the server minimum is worth one point on its own
  if (password.length >= 12) points += 1;
  if (password.length >= 16) points += 1;
  if (classes >= 2) points += 1;
  if (classes >= 3) points += 1;
  if (classes >= 4) points += 1;

  const score: PasswordStrength = points >= 6 ? 4 : points >= 4 ? 3 : points >= 3 ? 2 : 1;
  return { score, reason: null };
}

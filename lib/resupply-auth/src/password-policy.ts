// Password policy — single source of truth for "is this password
// allowed?". Conservatively simple: minimum length, no upper bound,
// no composition rules. Composition rules ("must have a digit,
// must have a symbol") have been shown to push users toward
// predictable patterns; length is the dominant strength factor.
//
// We deliberately skip a haveibeenpwned k-anonymity check here.
// That call is a network round-trip to a third party — see ADR
// 014 ("no third-party identity vendor"). If we want it later,
// it'd land as an opt-in `breachCheck` adapter on AuthDeps.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

export interface PasswordPolicyError {
  code: "too_short" | "too_long" | "empty";
  message: string;
}

export function validatePassword(
  raw: unknown,
): { ok: true; value: string } | { ok: false; error: PasswordPolicyError } {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      ok: false,
      error: { code: "empty", message: "Password is required." },
    };
  }
  if (raw.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: {
        code: "too_short",
        message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
      },
    };
  }
  if (raw.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: "too_long",
        message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
      },
    };
  }
  return { ok: true, value: raw };
}

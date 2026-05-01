// Environment surface for the in-house auth library.
//
// Stage 1 contract:
//   * AUTH_PROVIDER defaults to "clerk" so this module is a no-op
//     at runtime until Stage 3+. Code paths that branch on the
//     provider must default to the Clerk path.
//   * AUTH_PASSWORD_PEPPER is REQUIRED whenever AUTH_PROVIDER is
//     "dual" or "in_house". For "clerk", we don't even read it —
//     the lib is dormant. This is what lets Stage 1 land in
//     production safely without anyone scrambling for a secret.

import { z } from "zod";

export type AuthProvider = "clerk" | "dual" | "in_house";

export const AUTH_PROVIDER_VALUES = [
  "clerk",
  "dual",
  "in_house",
] as const satisfies readonly AuthProvider[];

export interface AuthEnv {
  /** Active auth provider. Defaults to "clerk" until cutover. */
  provider: AuthProvider;
  /**
   * 32+ random bytes (base64). HMAC-SHA256(password, pepper) is
   * what gets fed to argon2id. Required only when the in-house
   * password path is live.
   */
  passwordPepper: Buffer | null;
  /** Sliding session lifetime. Default 14 days. */
  sessionTtlDays: number;
  /** Default email-token lifetime. Reset / verify TTLs override. */
  emailTokenTtlHours: number;
}

const providerSchema = z.enum(AUTH_PROVIDER_VALUES).default("clerk");

const positiveInt = z.coerce
  .number()
  .int("must be an integer")
  .positive("must be > 0");

/**
 * Decode a base64 / base64url pepper. Pepper is REQUIRED when the
 * in-house password path is active. Length must be >= 32 bytes.
 */
function parsePepper(raw: string | undefined, provider: AuthProvider): Buffer | null {
  if (provider === "clerk") {
    return null;
  }
  if (!raw || raw.trim() === "") {
    throw new Error(
      `AUTH_PASSWORD_PEPPER is required when AUTH_PROVIDER="${provider}"`,
    );
  }
  // Accept base64 or base64url (which Buffer parses with the same call
  // when standard base64 chars are present). Strip whitespace first.
  const cleaned = raw.replace(/\s+/g, "");
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length < 32) {
    throw new Error(
      `AUTH_PASSWORD_PEPPER must decode to at least 32 bytes (got ${buf.length})`,
    );
  }
  return buf;
}

/**
 * Read the auth env. Pure: takes a NodeJS.ProcessEnv-shaped object so
 * tests can pass a synthetic env without polluting `process.env`.
 *
 * Throws on invalid input (`AUTH_PROVIDER` not in the union, missing
 * pepper when required, malformed numeric TTL). Validation lives here
 * — not at first-use — so misconfiguration crashes at boot rather
 * than at the first sign-in attempt.
 */
export function readAuthEnv(
  source: Partial<NodeJS.ProcessEnv> = process.env,
): AuthEnv {
  const provider = providerSchema.parse(source.AUTH_PROVIDER ?? "clerk");
  const sessionTtlDays = positiveInt.parse(
    source.AUTH_SESSION_TTL_DAYS ?? "14",
  );
  const emailTokenTtlHours = positiveInt.parse(
    source.AUTH_EMAIL_TOKEN_TTL_HOURS ?? "24",
  );
  const passwordPepper = parsePepper(source.AUTH_PASSWORD_PEPPER, provider);
  return { provider, passwordPepper, sessionTtlDays, emailTokenTtlHours };
}

/** True when local sessions should be issued / accepted. */
export function isInHouseAuthActive(env: AuthEnv): boolean {
  return env.provider !== "clerk";
}

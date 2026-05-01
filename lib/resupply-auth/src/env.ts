// Environment surface for the in-house auth library.
//
// Stage 5a — AUTH_PROVIDER kill switch retired. The flag lives on
// in `.env.example` as a no-op (set it to anything; it's ignored)
// to keep deploys with the legacy var set from crashing at boot,
// but the library always behaves as if `AUTH_PROVIDER=in_house`.
// Customer + staff cutovers (Stages 3–4c) shipped earlier; the
// flag was the rollback lever, and the rollback window has
// closed. AUTH_PASSWORD_PEPPER is now unconditionally required.

import { z } from "zod";

/**
 * Historical type — preserved on the public surface so existing
 * callers' destructuring keeps working through the Stage 5a /
 * Stage 5d transition. The only valid runtime value is "in_house";
 * we map any other input to that.
 */
export type AuthProvider = "in_house";

export const AUTH_PROVIDER_VALUES = ["in_house"] as const satisfies readonly AuthProvider[];

export interface AuthEnv {
  /**
   * Always "in_house" after Stage 5a. Kept on the type for
   * back-compat with the few callers (e.g. `app.ts`'s log line)
   * that introspect the field.
   */
  provider: AuthProvider;
  /**
   * 32+ random bytes (base64). HMAC-SHA256(password, pepper) is
   * what gets fed to argon2id. UNCONDITIONALLY required.
   */
  passwordPepper: Buffer;
  /** Sliding session lifetime. Default 14 days. */
  sessionTtlDays: number;
  /** Default email-token lifetime. Reset / verify TTLs override. */
  emailTokenTtlHours: number;
}

const positiveInt = z.coerce
  .number()
  .int("must be an integer")
  .positive("must be > 0");

/** Decode a base64 / base64url pepper. Length must be >= 32 bytes. */
function parsePepper(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new Error("AUTH_PASSWORD_PEPPER is required");
  }
  // Accept base64 or base64url. Strip whitespace first.
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
 * Read the auth env. Pure: takes a NodeJS.ProcessEnv-shaped
 * object so tests can pass a synthetic env without polluting
 * `process.env`. Throws on missing pepper or malformed TTL.
 */
export function readAuthEnv(
  source: Partial<NodeJS.ProcessEnv> = process.env,
): AuthEnv {
  const sessionTtlDays = positiveInt.parse(
    source.AUTH_SESSION_TTL_DAYS ?? "14",
  );
  const emailTokenTtlHours = positiveInt.parse(
    source.AUTH_EMAIL_TOKEN_TTL_HOURS ?? "24",
  );
  const passwordPepper = parsePepper(source.AUTH_PASSWORD_PEPPER);
  return {
    provider: "in_house",
    passwordPepper,
    sessionTtlDays,
    emailTokenTtlHours,
  };
}

/**
 * Historical helper. Always true after Stage 5a — kept on the
 * surface so existing call sites compile. New code should NOT
 * branch on this; the in-house path is the only path.
 *
 * @deprecated Always true; remove when Stage 5d retires the
 *   AUTH_PROVIDER flag entirely.
 */
export function isInHouseAuthActive(_env: AuthEnv): boolean {
  return true;
}

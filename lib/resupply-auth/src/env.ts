// Environment surface for the in-house auth library.

import { z } from "zod";

export interface AuthEnv {
  /**
   * 32+ random bytes (base64). HMAC-SHA256(password, pepper) is
   * what gets fed to argon2id.
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
  return { passwordPepper, sessionTtlDays, emailTokenTtlHours };
}

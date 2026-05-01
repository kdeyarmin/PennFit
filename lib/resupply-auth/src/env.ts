// Environment surface for the in-house auth library.

import { z } from "zod";

export interface AuthEnv {
  /** Sliding session lifetime. Default 14 days. */
  sessionTtlDays: number;
  /** Default email-token lifetime. Reset / verify TTLs override. */
  emailTokenTtlHours: number;
}

const positiveInt = z.coerce
  .number()
  .int("must be an integer")
  .positive("must be > 0");

/**
 * Read the auth env. Pure: takes a NodeJS.ProcessEnv-shaped
 * object so tests can pass a synthetic env without polluting
 * `process.env`. Throws on malformed TTL.
 *
 * The previous version of this function also required
 * `AUTH_PASSWORD_PEPPER` to be set to a base64 value of 32+ bytes;
 * the pepper was removed in the Task #38 follow-up, so the env no
 * longer carries it. See `password.ts` for the migration note.
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
  return { sessionTtlDays, emailTokenTtlHours };
}

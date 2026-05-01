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
 * `process.env`. Throws on malformed TTLs.
 *
 * Historical note: this used to require AUTH_PASSWORD_PEPPER
 * (a 32+ byte base64 server-side secret) and decode it into a
 * Buffer. The pepper was removed in the Task #38 follow-up at
 * the project owner's direction, so the env reader no longer
 * touches it. If the variable is still set in your environment
 * it is simply ignored — no boot-time validation, no runtime
 * use. See `password.ts` for the migration note.
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

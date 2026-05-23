/**
 * Startup environment validation for the resupply API server.
 *
 * Per-variable lazy throws elsewhere in the codebase (DB pool,
 * link-HMAC key, etc.) are correct but surface one-at-a-time during
 * request handling, which is painful to chase on a fresh deploy.
 * This helper runs once at boot, collects EVERY missing required
 * variable, and throws a single error listing all of them — so an
 * operator sees "you're missing A, B, and C" instead of
 * "you're missing A; restart; you're missing B; restart; …".
 *
 * Variables that gracefully degrade (Twilio voice/SMS, SendGrid,
 * OpenAI, Stripe, object storage, etc.) are intentionally NOT
 * listed here. The resupply API is designed to boot in a
 * partially-configured state so dev/preview environments don't need
 * every third-party credential. Those vars are documented as
 * optional / feature-gated in the top-level README.
 *
 * `RESUPPLY_LINK_HMAC_KEY` and `RESUPPLY_AUDIT_HMAC_KEY` are the
 * two resupply-specific secrets validated here. The link key signs
 * patient reminder URLs (migration 0025 stripped the pgcrypto
 * column-level encryption secrets); the audit key signs every
 * row written to `resupply.audit_log` (migration 0116 — required
 * for HIPAA §164.312(b) tamper-evidence). Both are checked at boot
 * so the first signing or verifying request doesn't fail
 * mid-flight on a misconfigured deploy.
 */

import { validateSupabaseEnv } from "@workspace/resupply-db";
import { hasLinkHmacKey, LINK_HMAC_KEY_ENV } from "@workspace/resupply-secrets";

// `DATABASE_URL` is still required during the Drizzle → Supabase
// migration: most query sites haven't been ported yet and continue
// to use the shared pg pool. Once every site is on the Supabase JS
// client, drop DATABASE_URL from this list and from .env.example.
const REQUIRED_PLAIN_ENV_VARS = ["PORT", "DATABASE_URL"] as const;

/**
 * Validates that required environment variables are present and throws a single error listing any that are missing.
 *
 * Collects missing names from a fixed required list, the link HMAC key check, and Supabase-specific validations; if any are absent, throws an Error containing a comma-separated list of the missing variables.
 *
 * @throws Error - when one or more required environment variables are missing; the error message lists the missing variable names.
 */
export function assertRequiredEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_PLAIN_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
    }
  }
  if (!hasLinkHmacKey()) missing.push(LINK_HMAC_KEY_ENV);
  // RESUPPLY_AUDIT_HMAC_KEY used to be required at boot; the HIPAA
  // §164.312(b) tamper-evident audit chain has been retired so the
  // key is no longer read by any code path. Leaving the var in the
  // environment is harmless.
  missing.push(...validateSupabaseEnv());

  if (missing.length === 0) return;

  throw new Error(
    `resupply-api: missing required environment variable(s): ${missing.join(", ")}. See README.md for the full list.`,
  );
}

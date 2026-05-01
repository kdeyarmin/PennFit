/**
 * Startup environment validation for the resupply API server.
 *
 * Per-variable lazy throws elsewhere in the codebase (encryption
 * keys, DB pool, etc.) are correct but surface one-at-a-time during
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
 * Resupply secret keys (PHI encryption + the two HMAC keys) are
 * validated through `@workspace/resupply-secrets`, which accepts
 * either the consolidated `RESUPPLY_MASTER_KEY` (preferred) or all
 * three legacy per-purpose env vars. Without one of those, the very
 * first encrypted-PHI write or phone-lookup query fails with a
 * confusing mid-request error; catching at boot is safer.
 */

import { diagnoseSecretConfig } from "@workspace/resupply-secrets";

const REQUIRED_PLAIN_ENV_VARS = [
  "PORT",
  "DATABASE_URL",
] as const;

export function assertRequiredEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_PLAIN_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
    }
  }
  const secretProblems = diagnoseSecretConfig();

  if (missing.length === 0 && secretProblems.length === 0) return;

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`missing required environment variable(s): ${missing.join(", ")}`);
  }
  for (const p of secretProblems) parts.push(p);
  throw new Error(`resupply-api: ${parts.join("; ")}. See README.md for the full list.`);
}

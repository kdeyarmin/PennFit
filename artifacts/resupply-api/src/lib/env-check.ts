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
 */

const REQUIRED_ENV_VARS = [
  "PORT",
  "DATABASE_URL",
  "CLERK_SECRET_KEY",
  // PHI encryption + lookup HMAC keys. Without these, the very
  // first encrypted-PHI write or phone-lookup query fails with a
  // confusing mid-request error. Catching at boot is safer.
  "RESUPPLY_DATA_KEY",
  "RESUPPLY_LINK_HMAC_KEY",
  "RESUPPLY_PHONE_HMAC_KEY",
] as const;

export function assertRequiredEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `resupply-api: missing required environment variable(s): ${missing.join(", ")}. ` +
        `See README.md for the full list.`,
    );
  }
}

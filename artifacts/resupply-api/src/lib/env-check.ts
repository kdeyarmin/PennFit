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
 * `RESUPPLY_LINK_HMAC_KEY` is the only resupply-specific secret left
 * after migration 0025 stripped pgcrypto column-level encryption.
 * Validate it here so the very first link-issuing or link-verifying
 * request doesn't fail mid-flight on a misconfigured deploy.
 */

import { hasLinkHmacKey, LINK_HMAC_KEY_ENV } from "@workspace/resupply-secrets";

const REQUIRED_PLAIN_ENV_VARS = ["PORT", "DATABASE_URL"] as const;

export function assertRequiredEnv(): void {
  const missing: string[] = [];
  for (const name of REQUIRED_PLAIN_ENV_VARS) {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
      missing.push(name);
    }
  }
  if (!hasLinkHmacKey()) missing.push(LINK_HMAC_KEY_ENV);

  if (missing.length === 0) return;

  throw new Error(
    `resupply-api: missing required environment variable(s): ${missing.join(", ")}. See README.md for the full list.`,
  );
}

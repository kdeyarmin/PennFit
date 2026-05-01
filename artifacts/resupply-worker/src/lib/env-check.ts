/**
 * Startup environment validation for the resupply background worker.
 *
 * Per-variable lazy throws (e.g. `DATABASE_URL` in `getDbPool()`,
 * link-HMAC reads inside individual jobs) are correct but only
 * surface when a job actually runs. This helper runs once at boot,
 * collects EVERY missing required variable, and throws a single
 * error listing all of them so an operator can fix the deploy in
 * one pass.
 *
 * Variables that gracefully degrade (Twilio, SendGrid, OpenAI, etc.)
 * are intentionally NOT listed. Reminder jobs are designed to log
 * and exit-0 on a partially-configured messaging surface so they
 * don't fill the pg-boss retry queue with permanent failures (see
 * `jobs/reminders.ts`). Those vars are documented as optional in
 * the top-level README.
 *
 * `RESUPPLY_LINK_HMAC_KEY` is the only resupply-specific secret left
 * after migration 0025 stripped pgcrypto column-level encryption.
 * Worker reminder jobs sign every outbound link, so a missing HMAC
 * key would surface mid-job; catch it at boot instead.
 */

import { hasLinkHmacKey, LINK_HMAC_KEY_ENV } from "@workspace/resupply-secrets";

const REQUIRED_PLAIN_ENV_VARS = ["DATABASE_URL"] as const;

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
    `resupply-worker: missing required environment variable(s): ${missing.join(", ")}. See README.md for the full list.`,
  );
}

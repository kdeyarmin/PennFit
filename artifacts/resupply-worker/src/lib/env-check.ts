/**
 * Startup environment validation for the resupply background worker.
 *
 * Per-variable lazy throws (e.g. `DATABASE_URL` in `getDbPool()`,
 * encryption-key checks inside individual jobs) are correct but only
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
 */

const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  // The worker reads + writes encrypted PHI as part of every
  // outbound reminder job. Without these keys the first job to
  // touch PHI throws with a confusing mid-execution error.
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
      `resupply-worker: missing required environment variable(s): ${missing.join(", ")}. ` +
        `See README.md for the full list.`,
    );
  }
}

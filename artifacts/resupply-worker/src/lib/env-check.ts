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
 *
 * Resupply secret keys (PHI encryption + the two HMAC keys) are
 * validated through `@workspace/resupply-secrets`, which accepts
 * either the consolidated `RESUPPLY_MASTER_KEY` (preferred) or all
 * three legacy per-purpose env vars. The worker reads + writes
 * encrypted PHI as part of every outbound reminder job; without
 * a usable key the first job to touch PHI throws with a confusing
 * mid-execution error.
 */

import { diagnoseSecretConfig } from "@workspace/resupply-secrets";

const REQUIRED_PLAIN_ENV_VARS = ["DATABASE_URL"] as const;

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
  throw new Error(`resupply-worker: ${parts.join("; ")}. See README.md for the full list.`);
}

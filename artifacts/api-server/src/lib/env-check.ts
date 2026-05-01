/**
 * Startup environment validation for the PennPaps fitter API server.
 *
 * The codebase already throws helpful per-variable errors at the point
 * of first use (e.g. `getDbPool()` for `DATABASE_URL`, the explicit
 * `PORT` check in `index.ts`). Those throws are correct but surface
 * one-at-a-time during request handling, which makes
 * misconfigurations painful to chase down on a fresh deploy: fix one
 * var, restart, hit the next missing var, restart, and so on.
 *
 * `assertRequiredEnv` runs once at boot, collects EVERY missing
 * required variable, and throws a single, actionable error listing
 * all of them at once. Variables that gracefully degrade (SendGrid,
 * Twilio, OpenAI, etc.) are intentionally NOT listed here — they're
 * documented as optional in the top-level README.
 */

const REQUIRED_ENV_VARS = [
  "PORT",
  "CLERK_SECRET_KEY",
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
      `api-server: missing required environment variable(s): ${missing.join(", ")}. ` +
        `See README.md for the full list.`,
    );
  }
}

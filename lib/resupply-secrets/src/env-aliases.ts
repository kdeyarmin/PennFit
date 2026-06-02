// @workspace/resupply-secrets — consolidated environment aliases.
//
// Lets an operator set ONE value instead of several near-duplicate
// variables, while keeping every existing variable name working
// unchanged. A specific variable, when explicitly set, ALWAYS wins —
// this only backfills the ones left blank, so it is fully
// backward-compatible and idempotent (safe to call more than once).
//
// Called once at boot (the resupply-api does it at the top of `app.ts`,
// before CORS resolution) and again by the `preflight:prod` validator,
// so both the running process and the pre-deploy check see the same
// effective environment. It mutates the passed env object in place so
// the ~20 call sites that read the specific names need no changes.
//
// Three consolidations:
//   1. PUBLIC_BASE_URL  → the five `*_PUBLIC_BASE_URL` vars, plus the
//      CORS allow-list. On Railway, `RAILWAY_PUBLIC_DOMAIN` is used as
//      the source when `PUBLIC_BASE_URL` itself is unset, so a
//      single-service Railway deploy can set NEITHER.
//   2. OPS_EMAIL        → the five operational recipient addresses.
//   3. TWILIO_PHONE_NUMBER → TWILIO_VOICE_PHONE_NUMBER (one number on a
//      typical single-number account; the separate var is retired).

type EnvLike = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** The customer/agent-facing base-URL vars that all resolve to one host. */
export const PUBLIC_BASE_URL_TARGETS = [
  "SHOP_PUBLIC_BASE_URL",
  "REMINDER_PUBLIC_BASE_URL",
  "RESUPPLY_VOICE_PUBLIC_BASE_URL",
  "RESUPPLY_DASHBOARD_PUBLIC_BASE_URL",
  "PENN_ADMIN_PUBLIC_BASE_URL",
] as const;

/** Operational recipient inboxes that can share one ops address. */
export const OPS_EMAIL_TARGETS = [
  "PENN_FULFILLMENT_EMAIL",
  "SHOP_CSR_INBOX_EMAIL",
  "RESUPPLY_ADMIN_ALERTS_EMAIL",
  "INSURANCE_LEAD_NOTIFICATION_EMAIL",
  "RESUPPLY_SUPPLIER_RETURN_EMAIL",
] as const;

function trimmed(v: string | undefined): string {
  return (v ?? "").trim();
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Backfill the specific environment variables from the consolidated
 * ones. Mutates `env` in place. A variable that already has a non-empty
 * value is never overwritten.
 */
export function applyEnvAliases(env: EnvLike = process.env): void {
  // 1. Base URL. Prefer an explicit PUBLIC_BASE_URL; otherwise synthesize
  //    from Railway's injected host. Never override a specific var.
  const explicitBase = trimmed(env.PUBLIC_BASE_URL);
  const railwayHost = trimmed(env.RAILWAY_PUBLIC_DOMAIN);
  const canonicalBase = stripTrailingSlash(
    explicitBase || (railwayHost ? `https://${railwayHost}` : ""),
  );
  if (canonicalBase) {
    for (const name of PUBLIC_BASE_URL_TARGETS) {
      if (trimmed(env[name]) === "") env[name] = canonicalBase;
    }
    // Feed the CORS allow-list too, so PUBLIC_BASE_URL alone satisfies the
    // production boot check. Only when neither the explicit list nor the
    // Railway host (which the API's CORS resolver already honors on its
    // own) is present.
    if (trimmed(env.RESUPPLY_ALLOWED_ORIGINS) === "" && railwayHost === "") {
      try {
        env.RESUPPLY_ALLOWED_ORIGINS = new URL(canonicalBase).origin;
      } catch {
        // Malformed PUBLIC_BASE_URL — leave CORS to its own validation,
        // which fails closed in production with a clear message.
      }
    }
  }

  // 2. Operational recipient emails → one ops inbox.
  const opsEmail = trimmed(env.OPS_EMAIL);
  if (opsEmail) {
    for (const name of OPS_EMAIL_TARGETS) {
      if (trimmed(env[name]) === "") env[name] = opsEmail;
    }
  }

  // 3. Twilio voice caller-id is the same number as SMS on a one-number
  //    account; alias the retired var so any remaining reader still works.
  if (
    trimmed(env.TWILIO_VOICE_PHONE_NUMBER) === "" &&
    trimmed(env.TWILIO_PHONE_NUMBER) !== ""
  ) {
    env.TWILIO_VOICE_PHONE_NUMBER = trimmed(env.TWILIO_PHONE_NUMBER);
  }
}

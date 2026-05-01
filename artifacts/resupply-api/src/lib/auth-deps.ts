// Wiring layer between the resupply-api Express app and
// `@workspace/resupply-auth`. Builds the AuthDeps object that the
// in-house auth router needs:
//
//   - env: from `readAuthEnv(process.env)`.
//   - repo: pgAuthRepository over the shared pool.
//   - audit: a thin adapter over `@workspace/resupply-audit.logAudit`
//     (which writes to resupply.audit_log). Auth events go through
//     the same chokepoint as everything else for one-grep
//     incident response.
//   - email: SendGrid via `createSendgridClient()`. Failures are
//     swallowed inside the auth handler — but we LOG them here.
//   - publicBaseUrl: comes from RESUPPLY_VOICE_PUBLIC_BASE_URL or
//     SHOP_PUBLIC_BASE_URL depending on which UI is consuming the
//     dashboard auth pages.
//
// The module is lazy: nothing here runs until the API server
// asks for `getAuthDeps()`. After Stage 5a the function always
// returns a value (the kill switch is gone); a misconfigured
// AUTH_PASSWORD_PEPPER throws at first call so the misconfig
// surfaces at boot instead of on the first sign-in attempt.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import { logAudit } from "@workspace/resupply-audit";
import { getDbPool } from "@workspace/resupply-db";
import {
  pgAuthRepository,
  readAuthEnv,
  type AuthDeps,
  type CustomerIdResolver,
  type EmailSender,
} from "@workspace/resupply-auth";

import { logger } from "./logger";

let cachedDeps: AuthDeps | undefined;

/**
 * Build (and memoize) the AuthDeps. Always returns a value after
 * Stage 5a — the kill switch is gone. Exceptions during
 * construction (missing AUTH_PASSWORD_PEPPER, missing DB pool,
 * etc.) propagate so a misconfigured deploy fails LOUD at first
 * call rather than at the first sign-in attempt.
 */
export function getAuthDeps(): AuthDeps {
  if (cachedDeps !== undefined) return cachedDeps;
  const env = readAuthEnv(process.env);
  const repo = pgAuthRepository(getDbPool());

  const audit: AuthDeps["audit"] = (event) => {
    // logAudit is async + write-through; auth handlers don't
    // await us. Forward the failure to the logger and swallow.
    void logAudit({
      action: event.action,
      adminEmail: event.adminEmail ?? null,
      adminUserId: event.adminUserId ?? null,
      metadata: event.metadata ?? {},
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
    }).catch((err) => {
      logger.warn(
        {
          event: "auth_audit_write_failed",
          action: event.action,
          err: err instanceof Error ? err.message : "unknown",
        },
        "auth audit write failed",
      );
    });
  };

  const email = makeSendgridSender();

  const publicBaseUrl = (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.REMINDER_PUBLIC_BASE_URL ??
    "http://localhost:5173"
  ).replace(/\/$/, "");

  cachedDeps = {
    env,
    repo,
    audit,
    email,
    publicBaseUrl,
    secureCookies: process.env.NODE_ENV === "production",
    allowSignUp: false, // staff-facing API: no public sign-up
    customerIdResolver: makeCustomerIdResolver(),
  };
  return cachedDeps;
}

/**
 * Bridges an `auth.users.id` to the value the rest of the API
 * uses as the customer key (the legacy
 * `shop_customers.clerk_user_id` column). See Stage 4c plan doc.
 *
 * Behaviour:
 *   * If `shop_customers.auth_user_id = $authUserId` exists →
 *     return that row's `clerk_user_id` (preserved across the
 *     backfill so every downstream FK keeps working unchanged).
 *   * Else mint a new shop_customers row keyed by `auth.users.id`
 *     itself. The PK column is `text`, so a UUID slots in fine.
 *     The legacy column-name lie ("clerk_user_id" containing a
 *     non-Clerk UUID) is documented in the plan doc; Stage 5
 *     renames the column to `customer_id`.
 *   * Email is taken from `auth.users.email_lower`. Display name
 *     defaults to the auth row, then to the existing customer
 *     row if any. Stripe customer creation happens lazily on
 *     first checkout (see `lib/stripe/customer.ts`).
 */
function makeCustomerIdResolver(): CustomerIdResolver {
  return async (input) => {
    const pool = getDbPool();
    const existing = await pool.query<{
      clerk_user_id: string;
      display_name: string | null;
      email_lower: string | null;
    }>(
      `SELECT clerk_user_id, display_name, email_lower
         FROM resupply.shop_customers
        WHERE auth_user_id = $1
        LIMIT 1`,
      [input.authUserId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      return {
        customerKey: row.clerk_user_id,
        // Prefer auth.users.email — that's the canonical inbox
        // (rotating it goes through the in-house verify flow).
        email: input.emailLower,
        displayName: input.displayName ?? row.display_name,
      };
    }

    // First sign-in for an in-house customer with no
    // shop_customers row yet (typical for brand-new in-house
    // sign-ups). Mint the row keyed by auth.users.id; subsequent
    // requests find it via the auth_user_id index.
    await pool.query(
      `INSERT INTO resupply.shop_customers
         (clerk_user_id, auth_user_id, email_lower, display_name)
       VALUES ($1, $1, $2, $3)
       ON CONFLICT (clerk_user_id) DO UPDATE
         SET auth_user_id = EXCLUDED.auth_user_id,
             email_lower = COALESCE(EXCLUDED.email_lower, resupply.shop_customers.email_lower),
             updated_at = NOW()`,
      [input.authUserId, input.emailLower, input.displayName],
    );
    return {
      customerKey: input.authUserId,
      email: input.emailLower,
      displayName: input.displayName,
    };
  };
}

function makeSendgridSender(): EmailSender {
  // The `from` address is bound to the SendGrid client itself —
  // we configure it via SENDGRID_FROM_EMAIL / SENDGRID_FROM_NAME
  // and reuse the same factory pattern the order-confirmation
  // and cart-abandonment helpers use.
  return async (input) => {
    let client;
    try {
      client = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        logger.warn(
          { event: "auth_email_send_skipped", reason: "config_error" },
          err.message,
        );
        return;
      }
      throw err;
    }
    try {
      await client.sendEmail({
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
    } catch (err) {
      if (err instanceof EmailApiError) {
        logger.warn(
          {
            event: "auth_email_send_failed",
            status: err.status,
            err: err.message,
          },
          "SendGrid rejected auth email",
        );
        return;
      }
      throw err;
    }
  };
}

/** Reset for tests. */
export function __resetAuthDepsCache(): void {
  cachedDeps = undefined;
}

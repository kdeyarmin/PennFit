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
// asks for `getAuthDepsOrNull()`. When AUTH_PROVIDER=clerk (the
// Stage 1/2a default), the function returns null and the API
// does not mount the in-house auth router. That's the kill
// switch ADR 014 describes — it stays in the codebase as a
// runtime-flag-only difference, not an env-var-controlled
// dead-code conditional.

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
  type EmailSender,
} from "@workspace/resupply-auth";

import { logger } from "./logger";

let cachedDeps: AuthDeps | null | undefined;

/**
 * Build (and memoize) the AuthDeps. Returns null when the in-house
 * path is dormant (`AUTH_PROVIDER=clerk`). Returns AuthDeps
 * otherwise. Exceptions during construction (e.g. missing pepper
 * for `in_house` mode) propagate — the API server should fail to
 * boot rather than silently disable auth.
 */
export function getAuthDepsOrNull(): AuthDeps | null {
  if (cachedDeps !== undefined) return cachedDeps;
  const env = readAuthEnv(process.env);
  if (env.provider === "clerk") {
    cachedDeps = null;
    return null;
  }

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
  };
  return cachedDeps;
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

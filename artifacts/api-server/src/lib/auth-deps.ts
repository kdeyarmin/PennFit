// Wiring layer between the api-server (PennPaps) Express app and
// `@workspace/resupply-auth`. Builds the AuthDeps the in-house
// auth router needs.
//
// Differences from the resupply-api wiring:
//   * Uses `lib/db`'s shared `pool` (PennPaps' DB pool) — auth
//     tables live in the `auth` schema regardless of which
//     product connects.
//   * No `resupply.audit_log` here; the PennPaps app doesn't
//     have an analogous table yet, so auth events are written
//     via pino. When PennPaps grows its own audit log we can
//     swap this out without touching the lib.
//   * `allowSignUp: true` — the cash-pay shop accepts customer
//     sign-ups.
//   * `signUpRole: "customer"` is implicit (the lib's default).

import { pool } from "@workspace/db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  pgAuthRepository,
  readAuthEnv,
  type AuthDeps,
  type EmailSender,
} from "@workspace/resupply-auth";

import { logger } from "./logger";

let cachedDeps: AuthDeps | null | undefined;

export function getAuthDepsOrNull(): AuthDeps | null {
  if (cachedDeps !== undefined) return cachedDeps;
  const env = readAuthEnv(process.env);
  if (env.provider === "clerk") {
    cachedDeps = null;
    return null;
  }

  const repo = pgAuthRepository(pool);

  const audit: AuthDeps["audit"] = (event) => {
    logger.info(
      {
        event: event.action,
        adminEmail: event.adminEmail ?? undefined,
        adminUserId: event.adminUserId ?? undefined,
        ip: event.ip ?? undefined,
        ...event.metadata,
      },
      "auth event",
    );
  };

  const email = makeSendgridSender();

  const publicBaseUrl = (
    process.env.SHOP_PUBLIC_BASE_URL ?? "http://localhost:5173"
  ).replace(/\/$/, "");

  cachedDeps = {
    env,
    repo,
    audit,
    email,
    publicBaseUrl,
    secureCookies: process.env.NODE_ENV === "production",
    allowSignUp: true,
  };
  return cachedDeps;
}

function makeSendgridSender(): EmailSender {
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

export function __resetAuthDepsCache(): void {
  cachedDeps = undefined;
}

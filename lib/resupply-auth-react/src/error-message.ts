// Shared error-message helper for the in-house auth surface.
//
// Six customer + admin pages (sign-in, sign-up, verify-email,
// forgot-password, reset-password, change-password) all need to
// distinguish three error shapes coming out of the auth hooks:
//
//   1. AuthError with status >= 500 — the credentials store is
//      unreachable. The user is staring at a "stuck" form and can't
//      tell whether their input is wrong or the backend is down.
//      Render copy that points them at status.pennpaps.com so they
//      know to retry rather than reach for support.
//   2. AuthError with status < 500 — the server already produced
//      a user-facing message (`userMessage`). Render it as-is.
//   3. Anything else (network error, thrown non-Error, etc.) —
//      fall back to the page-specific generic copy.
//
// Before this helper existed, every page had its own copy of a
// SERVER_UNAVAILABLE_MESSAGE constant and authErrorMessage helper.
// When the wording needs to change (new status URL, new tone, new
// translation), there were 6+ places to edit and it was easy to
// miss one. This module is now the single source of truth.

import { AuthError } from "./client";

export interface AuthErrorMessageOptions {
  /**
   * Verb phrase that completes "...we couldn't ${action}." Examples:
   * "sign you in", "create your account", "verify your email",
   * "send a reset link", "reset your password".
   */
  action: string;
  /**
   * Noun phrase that completes "This is a server problem, not your
   * ${subject}." Examples: "password", "email", "link",
   * "reset link", "email or password".
   */
  subject: string;
  /**
   * Page-specific generic copy for non-AuthError failures (network
   * errors, thrown non-Error values, etc.). Rendered when the
   * thrown value isn't an `AuthError` instance at all.
   */
  fallback: string;
}

/**
 * Build the 5xx-branch "credentials store unreachable" message. Exported
 * for tests and for the rare caller that wants the message text without
 * having an error in hand. Most callers should use `authErrorMessage`.
 */
export function serverUnavailableMessage(
  opts: Pick<AuthErrorMessageOptions, "action" | "subject">,
): string {
  return (
    `We can't reach the credentials store right now, so we couldn't ${opts.action}.` +
    ` This is a server problem, not your ${opts.subject}.` +
    ` Please try again in a minute — if it keeps failing, check status.pennpaps.com.`
  );
}

/**
 * Map an unknown thrown value from an auth mutation onto a user-
 * facing string. See the module header for the three branches.
 */
export function authErrorMessage(
  err: unknown,
  opts: AuthErrorMessageOptions,
): string {
  if (err instanceof AuthError) {
    if (err.status >= 500) return serverUnavailableMessage(opts);
    return err.userMessage;
  }
  return opts.fallback;
}

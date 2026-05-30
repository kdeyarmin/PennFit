// Pure helpers for the forgot-password page, extracted to a .ts file
// so they can be unit-tested in the node vitest environment without
// pulling React + JSX through the import graph. The page (.tsx) just
// re-exports + calls them.

import {
  AuthError,
  serverUnavailableMessage,
} from "@workspace/resupply-auth-react";

/**
 * Decide what the forgot-password form should do for a given thrown
 * value from `useForgotPassword().mutate(...)`. Pure function so the
 * no-enumeration contract can be unit-tested directly against real
 * `AuthError` instances — the page's actual branch, not a parallel
 * reimplementation that could silently drift.
 *
 * Contract:
 *   * 5xx AuthError → render the shared server-trouble notice in the
 *     form error region (the user needs to know the email wasn't
 *     queued and an outage page exists).
 *   * Anything else (4xx AuthError, network failures, thrown non-Error
 *     values) → fold to the generic success view. This is what keeps
 *     email enumeration out: an attacker cannot distinguish "no such
 *     account" from "reset link sent".
 */
export function decideForgotPasswordErrorOutcome(
  err: unknown,
): { kind: "show-error"; message: string } | { kind: "fold-to-success" } {
  if (err instanceof AuthError && err.status >= 500) {
    return {
      kind: "show-error",
      message: serverUnavailableMessage({
        action: "send a reset link",
        subject: "email",
      }),
    };
  }
  return { kind: "fold-to-success" };
}

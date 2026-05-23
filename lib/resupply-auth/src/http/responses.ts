// Centralized response shapes for /auth/*.
//
// One generic error envelope so the SPA can render "something went
// wrong" without parsing twenty different shapes. The `code` is
// what code branches on; `message` is a sentence rendered to the
// user as-is. Neither field discloses account existence — that's
// a separate, deliberate concern of each handler.

import type { Response } from "express";

export type AuthErrorCode =
  | "invalid_input"
  | "invalid_credentials"
  | "session_required"
  | "csrf_failed"
  | "forbidden"
  | "rate_limited"
  | "account_locked"
  | "email_unverified"
  // Team-invite "set their password for them" path stamps
  // set_by_admin_at alongside must_change=true. The sign-in
  // handler refuses must_change credentials whose owner never
  // signed in within ADMIN_PASSWORD_TTL_MS and returns this code
  // so the SPA can render "ask your administrator to re-invite
  // you" instead of the generic invalid-credentials message.
  | "invite_expired"
  // MFA (Phase B) — sign-in MFA gate + /sign-in/verify-mfa
  // outcomes. Both `mfa_probe_failed` and `mfa_misconfigured`
  // arise from server-side wiring problems; the SPA renders them
  // as "try again / contact support" without exposing internals.
  | "mfa_probe_failed"
  | "mfa_misconfigured"
  | "mfa_challenge_invalid"
  | "mfa_challenge_expired"
  | "mfa_code_invalid"
  | "mfa_not_enrolled"
  // Phase C — recovery codes. Distinct from `mfa_code_invalid` so
  // the SPA can render "this recovery code didn't match" specifically
  // (and so audit metadata is easy to slice).
  | "mfa_recovery_code_invalid"
  | "internal";

export function authError(
  res: Response,
  status: number,
  code: AuthErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  res.status(status).json({ error: code, message, ...extra });
}

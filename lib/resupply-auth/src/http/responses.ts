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
  | "rate_limited"
  | "account_locked"
  | "email_unverified"
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

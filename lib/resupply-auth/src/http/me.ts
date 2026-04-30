// GET /auth/me — current user identity, derived from the session
// cookie. Returns 401 (not 403) when there is no session at all —
// the dashboard distinguishes "logged out" from "forbidden".
//
// Mounted UNDER `requireSession`, so by the time the handler runs
// `req.authUser` and `req.authSessionId` are guaranteed to be set.

import type { Request, Response } from "express";

export function handleMe(req: Request, res: Response): void {
  const user = req.authUser;
  if (!user) {
    // Should not happen under requireSession, but belt-and-braces.
    res.status(401).json({ error: "session_required" });
    return;
  }
  res.status(200).json({
    id: user.id,
    email: user.emailLower,
    role: user.role,
    displayName: user.displayName,
    emailVerified: user.emailVerifiedAt !== null,
  });
}

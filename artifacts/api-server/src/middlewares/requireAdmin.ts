import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";

/**
 * requireAdmin — gate for the admin API.
 *
 * Two checks, in order:
 *   1. The request has a valid Clerk session (user is signed in).
 *   2. The signed-in user's primary email is in the PENN_ADMIN_EMAILS allowlist.
 *
 * The allowlist is a comma-separated env var, e.g.
 *   PENN_ADMIN_EMAILS="dr.smith@pennhomemedical.com,billing@pennhomemedical.com"
 *
 * Behavior when PENN_ADMIN_EMAILS is unset:
 *   - In `NODE_ENV=development` we allow any signed-in user. This makes the
 *     local dev loop bearable (you can test admin without managing env vars).
 *   - In production we DENY all requests with a 503 "admin not configured"
 *     response. This is intentional — better to have no admin than an
 *     accidentally world-open admin if a deploy ships without the env var.
 *
 * On success we attach `req.adminEmail` and `req.adminClerkId` so route
 * handlers can write audit-log rows without re-fetching the user.
 */

declare global {
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminClerkId?: string;
    }
  }
}

function parseAllowlist(): string[] | null {
  const raw = process.env.PENN_ADMIN_EMAILS;
  if (!raw) return null;
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = getAuth(req);
  const userId = auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }

  // Look up the user to get their primary verified email. We could also
  // stash email in session claims via Clerk's "Customize session" feature,
  // but that requires a dashboard change — fetching here keeps setup simple
  // (the call is cached aggressively by @clerk/express).
  //
  // We REQUIRE the primary email to be verified — otherwise an attacker
  // who can sign up with someone else's address (without proving control)
  // could match the allowlist. Clerk marks an email "verified" only after
  // the user clicks the verification link or enters the code.
  let email: string | undefined;
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    if (primary?.verification?.status !== "verified") {
      res.status(403).json({
        error:
          "Your primary email address is not verified. Please verify it from your account settings before accessing the admin.",
      });
      return;
    }
    email = primary.emailAddress?.toLowerCase();
  } catch (err) {
    res.status(401).json({ error: "Could not verify your identity. Please sign in again." });
    return;
  }

  if (!email) {
    res.status(403).json({ error: "Your account has no verified email address." });
    return;
  }

  const allowlist = parseAllowlist();

  if (allowlist === null) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({
        error:
          "Admin access is not configured on this server. Set PENN_ADMIN_EMAILS to a comma-separated list of admin emails.",
      });
      return;
    }
    // dev fallback — any signed-in user is an admin
  } else if (!allowlist.includes(email)) {
    res.status(403).json({ error: "This account is not authorized for admin access." });
    return;
  }

  req.adminEmail = email;
  req.adminClerkId = userId;
  next();
}

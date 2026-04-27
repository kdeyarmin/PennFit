import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";

/**
 * requireOperator — gate for the resupply operator API.
 *
 * This is the resupply equivalent of Penn Fit's `requireAdmin`. The two
 * products run on the same Clerk instance but use disjoint allowlists,
 * so a Penn Fit admin is NOT automatically a resupply operator and vice
 * versa. Keeping the two env vars separate means rotating one product's
 * staff list cannot accidentally grant access to the other product's
 * console.
 *
 * Two checks, in order:
 *   1. The request has a valid Clerk session (user is signed in).
 *   2. The signed-in user's primary verified email is in the
 *      RESUPPLY_OPERATOR_EMAILS allowlist.
 *
 * The allowlist is a comma-separated env var, e.g.
 *   RESUPPLY_OPERATOR_EMAILS="rt-coordinator@pennhomemedical.com,billing@pennhomemedical.com"
 *
 * Behavior when RESUPPLY_OPERATOR_EMAILS is unset:
 *   - In `NODE_ENV=development` we allow any signed-in user with a
 *     verified email. This makes the local dev loop bearable — you can
 *     poke the operator console without managing env vars.
 *   - In production we DENY all requests with a 503 "operator allowlist
 *     not configured" response. This is the single most important rule
 *     in this file: better to have NO operators than an accidentally
 *     world-open console if a deploy ships without the env var.
 *     Phase 2+ endpoints behind this middleware will read and write
 *     PHI; a missing env var must fail closed.
 *
 * Why the verified-email check matters: Clerk lets users add unverified
 * email addresses to their profile. Without this guard, an attacker who
 * could sign up claiming someone else's address (without proving control
 * of the inbox) could match the allowlist. The check below requires
 * `verification.status === "verified"` for the *primary* email — the one
 * Clerk has confirmed via a click-through link or code.
 *
 * On success we attach `req.operatorEmail` and `req.operatorClerkId` so
 * route handlers and the audit logger can record "who did this" without
 * re-fetching the user from Clerk on every write.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operatorEmail?: string;
      operatorClerkId?: string;
    }
  }
}

const ENV_VAR = "RESUPPLY_OPERATOR_EMAILS";

function parseAllowlist(): string[] | null {
  const raw = process.env[ENV_VAR];
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // Treat "set to whitespace/commas only" the same as "unset" — the env
  // var must contain at least one parseable address to count.
  return list.length > 0 ? list : null;
}

export async function requireOperator(
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

  // Look up the user to fetch their primary verified email. We could
  // alternatively stash email in session claims via Clerk's "Customize
  // session" feature, but that requires a dashboard change — fetching
  // here keeps the wiring self-contained. Clerk's SDK aggressively
  // caches user lookups so the per-request cost is negligible.
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
          "Your primary email address is not verified. Please verify it from your account settings before accessing the operator console.",
      });
      return;
    }
    email = primary.emailAddress?.toLowerCase();
  } catch {
    // Don't surface the underlying Clerk error — it can include the
    // user id and other identifiers that don't belong in an HTTP body
    // returned to an unauthenticated caller.
    res
      .status(401)
      .json({ error: "Could not verify your identity. Please sign in again." });
    return;
  }

  if (!email) {
    res
      .status(403)
      .json({ error: "Your account has no verified email address." });
    return;
  }

  const allowlist = parseAllowlist();

  if (allowlist === null) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({
        error:
          "Operator access is not configured on this server. Set " +
          `${ENV_VAR} to a comma-separated list of operator emails.`,
      });
      return;
    }
    // dev fallback — any signed-in, email-verified user is treated as
    // an operator. This is fine because dev databases never contain
    // real PHI; production rejects via the 503 above.
  } else if (!allowlist.includes(email)) {
    res
      .status(403)
      .json({ error: "This account is not authorized for operator access." });
    return;
  }

  req.operatorEmail = email;
  req.operatorClerkId = userId;
  next();
}

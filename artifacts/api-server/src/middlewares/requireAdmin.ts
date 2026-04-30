import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";

/**
 * requireAdmin — gate for the admin API.
 *
 * Three checks, in order:
 *   1. The request has a valid Clerk session (user is signed in).
 *   2. The signed-in user's primary email is verified.
 *   3. That email is in the `PENN_ADMIN_EMAILS` OR `PENN_AGENT_EMAILS`
 *      allowlist.
 *
 * The allowlists are comma-separated env vars, e.g.
 *   PENN_ADMIN_EMAILS="dr.smith@pennhomemedical.com,billing@pennhomemedical.com"
 *   PENN_AGENT_EMAILS="csr1@pennhomemedical.com,csr2@pennhomemedical.com"
 *
 * Roles:
 *   - `admin` — full privileges. Membership in `PENN_ADMIN_EMAILS`
 *     wins over `PENN_AGENT_EMAILS` if both contain the same email.
 *   - `agent` — junior-admin role used by customer-service staff.
 *     Identical to `admin` everywhere EXCEPT routes that explicitly
 *     opt in to admin-only via `requireAdminOnly`. The cpap-fitter
 *     admin currently has no admin-only routes (no destructive
 *     deletes), so in practice agents see the same surface as
 *     admins; the role distinction is wired so future destructive
 *     operations can gate cleanly.
 *
 * Behavior when neither allowlist is set:
 *   - In `NODE_ENV=development` we allow any signed-in user as
 *     `admin`. This makes the local dev loop bearable — no env vars
 *     to manage.
 *   - In production we DENY all requests with a 503 "admin not
 *     configured" response. Better to have no admin than an
 *     accidentally world-open admin if a deploy ships without the
 *     env var. An agent-only deployment is intentionally not
 *     supported — every prod deploy MUST have at least one admin.
 *
 * On success we attach `req.adminEmail`, `req.adminClerkId`, and
 * `req.adminRole` so route handlers can write audit-log rows
 * without re-fetching the user.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      adminEmail?: string;
      adminClerkId?: string;
      adminRole?: "admin" | "agent";
    }
  }
}

function parseEmailList(envVar: string): string[] | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function parseAdminAllowlist(): string[] | null {
  return parseEmailList("PENN_ADMIN_EMAILS");
}

function parseAgentAllowlist(): string[] | null {
  return parseEmailList("PENN_AGENT_EMAILS");
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
  } catch (_err) {
    res.status(401).json({ error: "Could not verify your identity. Please sign in again." });
    return;
  }

  if (!email) {
    res.status(403).json({ error: "Your account has no verified email address." });
    return;
  }

  const adminAllowlist = parseAdminAllowlist();
  const agentAllowlist = parseAgentAllowlist();

  let role: "admin" | "agent";
  if (adminAllowlist === null) {
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({
        error:
          "Admin access is not configured on this server. Set PENN_ADMIN_EMAILS to a comma-separated list of admin emails.",
      });
      return;
    }
    // dev fallback — any signed-in user is an admin
    role = "admin";
  } else if (adminAllowlist.includes(email)) {
    role = "admin";
  } else if (agentAllowlist !== null && agentAllowlist.includes(email)) {
    role = "agent";
  } else {
    res.status(403).json({ error: "This account is not authorized for admin access." });
    return;
  }

  req.adminEmail = email;
  req.adminClerkId = userId;
  req.adminRole = role;
  next();
}

/**
 * requireAdminOnly — stricter gate that admits only `role === "admin"`.
 *
 * Wraps `requireAdmin` so all the spoofing defenses and Clerk error
 * handling stay in one place. Use on routes whose effects are not
 * safely reversible by a customer-service agent. The cpap-fitter
 * admin has no such routes today; this is wired in advance so future
 * destructive operations can opt in cleanly.
 */
export async function requireAdminOnly(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let advanced = false;
  await requireAdmin(req, res, () => {
    advanced = true;
  });
  if (!advanced) return;
  if (req.adminRole !== "admin") {
    res.status(403).json({
      error:
        "This action requires admin privileges. Customer-service agents cannot perform destructive operations.",
    });
    return;
  }
  next();
}

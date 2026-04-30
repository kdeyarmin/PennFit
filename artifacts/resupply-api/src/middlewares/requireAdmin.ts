import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient } from "@clerk/express";
import { logger } from "../lib/logger";

/**
 * requireAdmin — gate for the resupply admin API.
 *
 * This is the resupply equivalent of PennPaps's `requireAdmin`. The two
 * products run on the same Clerk instance but use disjoint allowlists,
 * so a PennPaps admin is NOT automatically a resupply admin and vice
 * versa. Keeping the two env vars separate means rotating one product's
 * staff list cannot accidentally grant access to the other product's
 * console.
 *
 * Three checks, in order:
 *   1. The request has a valid Clerk session (user is signed in).
 *   2. (Allowlist mode only.) The signed-in user's primary email is
 *      verified.
 *   3. (Allowlist mode only.) That email is in the
 *      `RESUPPLY_ADMIN_EMAILS` OR `RESUPPLY_AGENT_EMAILS` allowlist.
 *
 * The allowlists are comma-separated env vars, e.g.
 *   RESUPPLY_ADMIN_EMAILS="info@pennpaps.com,billing@pennpaps.com"
 *   RESUPPLY_AGENT_EMAILS="csr1@pennpaps.com,csr2@pennpaps.com"
 *
 * Roles:
 *   - `admin` — full privileges. Membership in `RESUPPLY_ADMIN_EMAILS`
 *     always wins over `RESUPPLY_AGENT_EMAILS` if both contain the
 *     same email (a defensive choice — promoting an agent to admin
 *     should never silently downgrade them).
 *   - `agent` — junior-admin role used by customer-service staff.
 *     Identical to `admin` everywhere EXCEPT routes that explicitly
 *     opt in to admin-only via `requireAdminOnly` (currently:
 *     destructive deletes such as `DELETE /rules/:id`). Agents
 *     receive 403 from those routes.
 *   - In dev fallback (no allowlist configured, NODE_ENV=development)
 *     callers are admitted as `admin`. Dev DBs never carry real PHI.
 *
 * Behavior when neither allowlist is set:
 *   - In `NODE_ENV=development` we allow any signed-in user — verified
 *     email or not — and assign role `admin`. This makes the local
 *     dev loop bearable: you can poke the admin console without
 *     managing env vars, and the end-to-end testing harness (which
 *     creates Clerk users via the Backend API and does NOT mark their
 *     primary email as verified) can exercise the admin console
 *     happy path. Skipping the verification check is safe in this
 *     mode because there is NO allowlist to spoof past.
 *   - In production we DENY all requests with a 503 "admin allowlist
 *     not configured" response. This is the single most important
 *     rule in this file: better to have NO admins than an
 *     accidentally world-open console if a deploy ships without the
 *     env var. Endpoints behind this middleware will read and write
 *     PHI; a missing env var must fail closed. Note that an
 *     agent-only deployment is intentionally not supported — every
 *     production deploy MUST have at least one admin to cover
 *     destructive operations.
 *
 * Why the verified-email check matters in allowlist mode: Clerk lets
 * users add unverified email addresses to their profile. Without this
 * guard, an attacker who could sign up claiming someone else's address
 * (without proving control of the inbox) could match the allowlist.
 * The check below requires `verification.status === "verified"` for
 * the *primary* email — the one Clerk has confirmed via a click-
 * through link or code.
 *
 * On success we attach `req.adminEmail`, `req.adminClerkId`, and
 * `req.adminRole` so route handlers and the audit logger can record
 * "who did this and at what privilege level" without re-fetching the
 * user from Clerk on every write. In the dev fallback branch we
 * still attach all three fields so audit logs and the /me endpoint
 * have something to display.
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

const ADMIN_ENV_VAR = "RESUPPLY_ADMIN_EMAILS";
const AGENT_ENV_VAR = "RESUPPLY_AGENT_EMAILS";
// Pre-rename name for the admin allowlist. Read-only fallback so
// existing production deployments keep working until ops flips the
// var name. NEVER rename to RESUPPLY_ADMIN_EMAILS — that would
// silently turn the fallback into a no-op.
const LEGACY_ADMIN_ENV_VAR = "RESUPPLY_OPERATOR_EMAILS";

let legacyEnvWarned = false;

function parseEmailList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  // Treat "set to whitespace/commas only" the same as "unset" — the env
  // var must contain at least one parseable address to count.
  return list.length > 0 ? list : null;
}

function parseAdminAllowlist(): string[] | null {
  // Prefer the new var; fall back to the legacy name so existing
  // deployments don't 503 the moment this code lands. Warn once per
  // process when only the legacy var is set so admins see the
  // signal in production logs and can rotate config at their own pace.
  let raw = process.env[ADMIN_ENV_VAR];
  if (!raw) {
    const legacy = process.env[LEGACY_ADMIN_ENV_VAR];
    if (legacy) {
      if (!legacyEnvWarned) {
        legacyEnvWarned = true;
        logger.warn(
          {
            event: "resupply_admin_legacy_env_var_in_use",
            legacy: LEGACY_ADMIN_ENV_VAR,
            current: ADMIN_ENV_VAR,
          },
          `${LEGACY_ADMIN_ENV_VAR} is deprecated; rename it to ${ADMIN_ENV_VAR}.`,
        );
      }
      raw = legacy;
    }
  }
  return parseEmailList(raw);
}

function parseAgentAllowlist(): string[] | null {
  return parseEmailList(process.env[AGENT_ENV_VAR]);
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

  // Decide the auth mode up front so we know whether email verification
  // is load-bearing for this request. In production an unset admin
  // allowlist is a hard 503 — handle that before touching Clerk so a
  // misconfig returns instantly without consuming a Clerk API call per
  // request. The agent allowlist is optional: a deploy with admins but
  // no agents is valid (no CSR seats). A deploy with agents but no
  // admins is NOT valid — every production deploy MUST have at least
  // one admin to cover destructive operations, so we fail closed on
  // an admin-empty deploy regardless of the agent allowlist.
  const adminAllowlist = parseAdminAllowlist();
  const agentAllowlist = parseAgentAllowlist();
  const isProduction = process.env.NODE_ENV === "production";
  if (adminAllowlist === null && isProduction) {
    res.status(503).json({
      error:
        "Admin access is not configured on this server. Set " +
        `${ADMIN_ENV_VAR} to a comma-separated list of admin emails.`,
    });
    return;
  }

  // Look up the user to fetch their primary email. We could
  // alternatively stash email in session claims via Clerk's "Customize
  // session" feature, but that requires a dashboard change — fetching
  // here keeps the wiring self-contained. Clerk's SDK aggressively
  // caches user lookups so the per-request cost is negligible.
  //
  // We pull `primary` (not just the email string) so the allowlist
  // branch can read `verification.status` without re-fetching. Storing
  // verification status in a separate variable here would trip the
  // no-useless-assignment lint when the dev-fallback branch returns
  // before reading it.
  let email: string | undefined;
  let primaryEmailVerified = false;
  try {
    const user = await clerkClient.users.getUser(userId);
    const primaryId = user.primaryEmailAddressId;
    const primary =
      user.emailAddresses.find((e) => e.id === primaryId) ??
      user.emailAddresses[0];
    if (primary) {
      email = primary.emailAddress?.toLowerCase();
      primaryEmailVerified = primary.verification?.status === "verified";
    }
  } catch (err) {
    // Distinguish "Clerk says you have no session" (already handled by
    // the !userId guard above) from "Clerk Backend API errored mid-
    // request" (this branch). The user's session is fine; it's our
    // upstream call to Clerk that failed — a 5xx, throttle, or
    // network blip. Returning 401 here would tell a perfectly-valid
    // admin to "sign in again", which is wrong AND confusing —
    // they're already signed in and signing in again won't fix
    // anything when Clerk itself is unhealthy.
    //
    // We use 502 Bad Gateway: an upstream service we depend on is
    // unhealthy. We deliberately do NOT use 503 here because the
    // dashboard reserves 503 for the "admin allowlist not
    // configured" case (a deploy-side problem with a different
    // remediation). The dashboard maps any non-503 5xx to a
    // "transient — please retry" screen, which is exactly what an
    // admin should see during a Clerk Backend API blip.
    //
    // The log line emits the error CLASS name and Clerk's HTTP
    // status (when available) — never the raw message. Clerk's
    // error strings can echo the userId we just queried with, and
    // we treat every log line as world-readable.
    const errName = err instanceof Error ? err.name : "unknown";
    const clerkStatus = (err as { status?: number } | null | undefined)
      ?.status;
    logger.warn(
      {
        event: "resupply_admin_clerk_lookup_failed",
        errName,
        clerkStatus,
      },
      "requireAdmin: Clerk Backend API lookup failed",
    );
    res.status(502).json({
      error:
        "Could not verify your identity right now. Please try again in a moment.",
    });
    return;
  }

  if (adminAllowlist === null) {
    // Dev fallback (production was rejected above): trust any signed-
    // in session, regardless of email verification. We still record
    // the email for the audit trail / /me display when one exists.
    // Intentionally ignore `primaryEmailVerified` here — see the
    // file header.
    //
    // Dev fallback always assigns role `admin` so the dev loop has
    // full privileges. The agent role only exists in environments
    // where ops has explicitly configured an agent allowlist.
    //
    // Log every dev-fallback request at WARN. Defense-in-depth: if a
    // real deployment ever ships with NODE_ENV unset (or set to
    // anything other than the literal string "production") AND
    // RESUPPLY_ADMIN_EMAILS unset — two missing env vars at once,
    // which is plausible for a junior admin's first deploy — this
    // line is the grep-able signal that the gate has degraded to
    // "any signed-in Clerk user". A loud WARN per request makes the
    // misconfiguration impossible to miss in production logs.
    logger.warn(
      {
        event: "resupply_admin_dev_fallback_active",
        clerkId: userId,
        emailVerified: primaryEmailVerified,
        nodeEnv: process.env.NODE_ENV ?? "(unset)",
      },
      `requireAdmin: ${ADMIN_ENV_VAR} is unset; allowing any signed-in user (dev fallback). This MUST NOT happen in production.`,
    );
    req.adminEmail = email ?? `clerk:${userId}`;
    req.adminClerkId = userId;
    req.adminRole = "admin";
    next();
    return;
  }

  // Allowlist mode (production always; dev when explicitly configured).
  // Email verification is mandatory here — see the file header for the
  // spoofing-defense rationale.
  if (!email) {
    res
      .status(403)
      .json({ error: "Your account has no verified email address." });
    return;
  }
  if (!primaryEmailVerified) {
    res.status(403).json({
      error:
        "Your primary email address is not verified. Please verify it from your account settings before accessing the admin console.",
    });
    return;
  }

  // Admin membership wins over agent membership when both lists
  // contain the same email — promoting an agent to admin should
  // never silently downgrade their privileges.
  let role: "admin" | "agent";
  if (adminAllowlist.includes(email)) {
    role = "admin";
  } else if (agentAllowlist !== null && agentAllowlist.includes(email)) {
    role = "agent";
  } else {
    res
      .status(403)
      .json({ error: "This account is not authorized for admin access." });
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
 * Layered on top of `requireAdmin`: first the standard auth checks
 * run (sign-in + verified email + allowlist membership), then we
 * additionally reject `agent` callers with 403. Use on routes whose
 * effects are not safely reversible by a customer-service agent
 * (currently: `DELETE /rules/:id`).
 *
 * Wraps `requireAdmin` rather than re-implementing it so all the
 * spoofing defenses, dev fallback, env var fallbacks, and Clerk
 * error handling stay in one place. The `inner advanced` flag
 * disambiguates "requireAdmin already responded with a 4xx/5xx"
 * (we must not call next() — the inner middleware owns the
 * response) from "requireAdmin succeeded and called next()" (we
 * then check the role).
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

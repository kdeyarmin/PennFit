// Platform super-admin: act-as-tenant impersonation (G4).
//
// POST /resupply-api/platform/tenants/:id/impersonate — a platform admin
//   starts operating AS tenant `:id` (full read/write tenant-admin access)
//   for support. Issues a SEPARATE short-lived pf_session whose row carries
//   `impersonated_org_id` (migration 0356); `requireAdmin` then binds every
//   request on that cookie to the target org and grants tenant-admin
//   access there, recording the platform admin as `impersonatorUserId`.
// POST /resupply-api/platform/impersonation/stop — revoke the current
//   impersonation session and clear the cookie.
//
// Security posture:
//   * The impersonation session is DISTINCT from the platform console
//     session (separate cookie / tab) and is owned by the platform
//     admin's auth user, so revoking that admin kills it too.
//   * Short TTL (30 min) + explicitly revocable.
//   * Mintable ONLY here, behind `requirePlatformAdmin`.
//   * Every start/stop is audited; downstream mutations carry
//     `impersonatorUserId` so the real human stays attributable.
//   * Known limitation (v1): if a platform admin is removed from
//     `platform_admins` while holding a live impersonation cookie, it
//     keeps working until it expires or is revoked (short TTL bounds it).

import { randomBytes } from "node:crypto";

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  SESSION_COOKIE,
  appendSetCookie,
  buildCsrfCookie,
  buildSessionCookie,
  hashToken,
  isExpired,
  issueToken,
  readCookie,
} from "@workspace/resupply-auth";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

const IMPERSONATION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const tenantIdParam = z.object({ id: z.string().uuid() });

function secureCookies(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Build the cleared-cookie pair (expire pf_session + pf_csrf). */
function clearedAuthCookies(): string[] {
  const opts = { secure: secureCookies(), maxAgeSeconds: 0 };
  return [buildSessionCookie("", opts), buildCsrfCookie("", opts)];
}

router.post(
  "/platform/tenants/:id/impersonate",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = tenantIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_tenant_id" });
      return;
    }
    const targetOrgId = parsed.data.id;
    const platformAdminUserId = req.platformAdminUserId;
    if (!platformAdminUserId) {
      // requirePlatformAdmin guarantees this, but fail closed.
      res.status(401).json({ error: "Sign in required" });
      return;
    }

    // Verify the target tenant exists (global directory). Any tenant —
    // including the seed org — is impersonatable per the product decision.
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data: org, error: orgErr } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, slug")
      .eq("id", targetOrgId)
      .limit(1)
      .maybeSingle();
    if (orgErr) {
      logger.error(
        { event: "platform_impersonate_org_read_failed", err: orgErr },
        "platform: impersonate org read failed",
      );
      res.status(500).json({ error: "tenant_read_failed" });
      return;
    }
    if (!org) {
      res.status(404).json({ error: "tenant_not_found" });
      return;
    }

    // Mint the impersonation session (owned by the platform admin, tagged
    // with the target org). A SEPARATE token from the console session.
    const token = issueToken();
    const csrfRaw = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS);
    const deps = getAuthDeps();
    let sessionId: string;
    try {
      const session = await deps.repo.insertSession({
        tokenHash: token.hash,
        userId: platformAdminUserId,
        expiresAt,
        ip: req.ip ?? null,
        userAgentHash: null,
        impersonatedOrgId: targetOrgId,
        impersonatorUserId: platformAdminUserId,
      });
      sessionId = session.id;
    } catch (err) {
      logger.error(
        { event: "platform_impersonate_session_failed", err },
        "platform: impersonation session insert failed",
      );
      res.status(500).json({ error: "impersonation_failed" });
      return;
    }

    const maxAge = Math.floor(IMPERSONATION_TTL_MS / 1000);
    appendSetCookie(res, [
      buildSessionCookie(token.raw, {
        secure: secureCookies(),
        maxAgeSeconds: maxAge,
      }),
      buildCsrfCookie(csrfRaw, {
        secure: secureCookies(),
        maxAgeSeconds: maxAge,
      }),
    ]);

    await logAudit({
      action: "platform.impersonation.started",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: platformAdminUserId,
      targetTable: "organizations",
      targetId: targetOrgId,
      metadata: {
        slug: (org as { slug: string }).slug,
        sessionId,
        expiresAt: expiresAt.toISOString(),
      },
      ip: req.ip ?? null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "platform: impersonation-start audit write failed");
    });

    res
      .status(200)
      .json({ ok: true, impersonatingOrgId: targetOrgId, expiresAt });
  },
);

router.post(
  "/platform/impersonation/stop",
  adminWriteRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    // Self-service: resolve the CURRENT session from the cookie and, when
    // it's an impersonation session, revoke it + clear the cookie. No
    // platform gate (anyone holding the impersonation cookie may end it),
    // and CSRF isn't required because ending your own impersonation is a
    // safe, idempotent action.
    const raw = readCookie(req, SESSION_COOKIE);
    const tokenHash = raw ? hashToken(raw) : null;
    if (!tokenHash) {
      // Nothing to stop — clear cookies defensively and 200.
      appendSetCookie(res, clearedAuthCookies());
      res.status(200).json({ ok: true, stopped: false });
      return;
    }
    const deps = getAuthDeps();
    try {
      const session = await deps.repo.findSessionByTokenHash(tokenHash);
      if (
        session &&
        session.impersonatedOrgId &&
        !isExpired(
          { expiresAt: session.expiresAt, revokedAt: session.revokedAt },
          new Date(),
        )
      ) {
        await deps.repo.revokeSession(session.id, new Date());
        await logAudit({
          action: "platform.impersonation.stopped",
          adminEmail: null,
          adminUserId: session.impersonatorUserId ?? null,
          targetTable: "organizations",
          targetId: session.impersonatedOrgId,
          metadata: { sessionId: session.id },
          ip: req.ip ?? null,
          userAgent: null,
        }).catch(() => undefined);
      }
    } catch (err) {
      logger.warn(
        { err },
        "platform: impersonation stop lookup/revoke failed (clearing cookie anyway)",
      );
    }
    appendSetCookie(res, clearedAuthCookies());
    res.status(200).json({ ok: true, stopped: true });
  },
);

export default router;

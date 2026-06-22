// /resupply-api/platform/admins — the platform operator roster (G4).
//
//   GET    /platform/admins                 — who has platform-god access
//   POST   /platform/admins  { email }      — grant it to an EXISTING user
//   DELETE /platform/admins/:authUserId      — revoke it
//
// Membership is the `resupply.platform_admins` table (migration 0355): an
// `auth.users` id present there is a platform super-admin. This route is
// the in-app replacement for editing that table by hand.
//
// Guards on the mutations — platform-god is the highest privilege there
// is, so the failure modes are deliberately conservative:
//   * Grant only ELEVATES an existing auth user; it never creates an
//     account. An unknown email 404s rather than silently no-op.
//   * You can't revoke YOURSELF (prevents accidental self-lockout).
//   * You can't revoke the LAST operator (prevents locking everyone out).
//
// Emails here are operator identities (the people who run the platform),
// not patient PHI. Read/written through the global `.raw()` escape hatch
// because `platform_admins` has no org_id (it's above all tenants).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePlatformAdmin } from "../../middlewares/requirePlatformAdmin";

const router: IRouter = Router();

interface PlatformAdminRow {
  auth_user_id: string;
  granted_by_email: string | null;
  created_at: string;
}

async function rawClient() {
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return null;
  return getOrgScopedClient(seedOrgId).raw();
}

router.get(
  "/platform/admins",
  adminReadRateLimiter,
  requirePlatformAdmin,
  async (_req, res): Promise<void> => {
    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const { data, error } = await raw
      .schema("resupply")
      .from("platform_admins")
      .select("auth_user_id, granted_by_email, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      logger.error(
        { event: "platform_operators_list_failed", err: error },
        "platform: operator list query failed",
      );
      res.status(500).json({ error: "operator_list_failed" });
      return;
    }

    // Resolve each operator's identity through the auth repo. The roster is
    // a handful of rows, so the per-row lookup is cheap; a lookup miss
    // degrades that row's email to null rather than failing the list.
    const repo = getAuthDeps().repo;
    const operators = await Promise.all(
      ((data ?? []) as PlatformAdminRow[]).map(async (r) => {
        let email: string | null = null;
        let displayName: string | null = null;
        let status: string | null = null;
        try {
          const u = await repo.findUserById(r.auth_user_id);
          if (u) {
            email = u.emailLower;
            displayName = u.displayName;
            status = u.status;
          }
        } catch {
          // Leave identity null — a directory blip shouldn't 500 the roster.
        }
        return {
          authUserId: r.auth_user_id,
          email,
          displayName,
          status,
          grantedByEmail: r.granted_by_email,
          createdAt: r.created_at,
        };
      }),
    );
    res.json({ operators });
  },
);

const grantBody = z.object({
  email: z.string().trim().toLowerCase().email(),
});

router.post(
  "/platform/admins",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = grantBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_email" });
      return;
    }
    const email = parsed.data.email;

    // Elevate-existing-only: never create an account from here.
    const user = await getAuthDeps().repo.findUserByEmail(email);
    if (!user) {
      res.status(404).json({ error: "no_such_user" });
      return;
    }

    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }
    const adminsTable = raw.schema("resupply").from("platform_admins");

    // Honest idempotency: if the user is already an operator, return the
    // PERSISTED row (original grant timestamp + granter) and don't write a
    // fresh "granted" audit for an elevation that didn't happen.
    const existing = await adminsTable
      .select("granted_by_email, created_at")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (existing.error) {
      logger.error(
        { event: "platform_operator_grant_failed", err: existing.error },
        "platform: operator existence check failed",
      );
      res.status(500).json({ error: "operator_grant_failed" });
      return;
    }
    if (existing.data) {
      res.status(200).json({
        operator: {
          authUserId: user.id,
          email: user.emailLower,
          displayName: user.displayName,
          status: user.status,
          grantedByEmail:
            (existing.data as { granted_by_email: string | null })
              .granted_by_email ?? null,
          createdAt: (existing.data as { created_at: string }).created_at,
        },
      });
      return;
    }

    const inserted = await raw
      .schema("resupply")
      .from("platform_admins")
      .insert({
        auth_user_id: user.id,
        granted_by_email: req.platformAdminEmail ?? "platform-admin",
      })
      .select("granted_by_email, created_at")
      .single();
    if (inserted.error || !inserted.data) {
      logger.error(
        { event: "platform_operator_grant_failed", err: inserted.error },
        "platform: operator grant failed",
      );
      res.status(500).json({ error: "operator_grant_failed" });
      return;
    }

    await logAudit({
      action: "platform.operator.granted",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "platform_admins",
      targetId: user.id,
      metadata: { email },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "platform: operator grant audit write failed");
    });

    res.status(201).json({
      operator: {
        authUserId: user.id,
        email: user.emailLower,
        displayName: user.displayName,
        status: user.status,
        grantedByEmail:
          (inserted.data as { granted_by_email: string | null })
            .granted_by_email ?? null,
        createdAt: (inserted.data as { created_at: string }).created_at,
      },
    });
  },
);

const authUserIdParam = z.object({ authUserId: z.string().min(1) });

router.delete(
  "/platform/admins/:authUserId",
  adminWriteRateLimiter,
  requirePlatformAdmin,
  async (req, res): Promise<void> => {
    const parsed = authUserIdParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const authUserId = parsed.data.authUserId;
    if (authUserId === req.platformAdminUserId) {
      res.status(400).json({ error: "cannot_remove_self" });
      return;
    }

    const raw = await rawClient();
    if (!raw) {
      res.status(503).json({ error: "tenant_directory_unavailable" });
      return;
    }

    // Never strand the platform with zero operators.
    const { count, error: countErr } = await raw
      .schema("resupply")
      .from("platform_admins")
      .select("auth_user_id", { count: "exact", head: true });
    if (countErr) {
      logger.error(
        { event: "platform_operator_count_failed", err: countErr },
        "platform: operator count failed",
      );
      res.status(500).json({ error: "operator_revoke_failed" });
      return;
    }
    if ((count ?? 0) <= 1) {
      res.status(400).json({ error: "cannot_remove_last_operator" });
      return;
    }

    const { data: existing, error: readErr } = await raw
      .schema("resupply")
      .from("platform_admins")
      .select("auth_user_id")
      .eq("auth_user_id", authUserId)
      .limit(1)
      .maybeSingle();
    if (readErr) {
      logger.error(
        { event: "platform_operator_read_failed", err: readErr },
        "platform: operator read failed",
      );
      res.status(500).json({ error: "operator_revoke_failed" });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "operator_not_found" });
      return;
    }

    const { error } = await raw
      .schema("resupply")
      .from("platform_admins")
      .delete()
      .eq("auth_user_id", authUserId);
    if (error) {
      logger.error(
        { event: "platform_operator_revoke_failed", err: error },
        "platform: operator revoke failed",
      );
      res.status(500).json({ error: "operator_revoke_failed" });
      return;
    }

    await logAudit({
      action: "platform.operator.revoked",
      adminEmail: req.platformAdminEmail ?? "platform-admin",
      adminUserId: req.platformAdminUserId ?? null,
      targetTable: "platform_admins",
      targetId: authUserId,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "platform: operator revoke audit write failed");
    });

    res.json({ ok: true, removed: authUserId });
  },
);

export default router;

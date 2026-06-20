// /admin/organization/email-settings — a tenant's (DME company's) own
// outbound email From identity.
//
//   GET   /admin/organization/email-settings
//         Returns the tenant's From email / name (if set), the platform
//         default that applies otherwise, and a LIVE SendGrid domain-auth
//         status for the configured address (so a tenant isn't silently
//         dropped into spam).
//
//   PATCH /admin/organization/email-settings
//         Body: { fromEmail?: string|null, fromName?: string|null } (only
//         provided fields change; null clears back to the platform default).
//
// Patient-facing mail funnels through the shared createSendgridClient(); a
// tenant's from_email / from_name (migration 0360) override the platform
// default (noreply@cmbreathe.com) per CLAUDE.md's per-tenant-sender rule.
// Only an explicit, non-blank from_email switches a tenant off the default
// — a from_name alone is ignored by resolveTenantSender(), so the UI tells
// the operator to set an address.
//
// PHI / log posture: a From address is business data, not PHI. The audit
// envelope carries the action + address only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  DEFAULT_SENDGRID_FROM_EMAIL,
  DEFAULT_SENDGRID_FROM_NAME,
} from "@workspace/resupply-email";

import { logger } from "../../lib/logger.js";
import { invalidateTenantSenderCache } from "../../lib/email/tenant-sender.js";
import { checkSendgridDomainAuth } from "../../lib/email/sendgrid-domain-auth.js";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

const router: IRouter = Router();

const patchBody = z
  .object({
    fromEmail: z
      .string()
      .trim()
      .email("must be a valid email address")
      .max(254)
      .nullable()
      .optional(),
    fromName: z.string().trim().max(200).nullable().optional(),
  })
  .strict()
  .refine((b) => b.fromEmail !== undefined || b.fromName !== undefined, {
    message: "Provide at least one field to change.",
  });

interface OrgEmailRow {
  from_email: string | null;
  from_name: string | null;
}

async function loadOrgEmail(orgId: string): Promise<OrgEmailRow | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .from("organizations")
    .select("from_email, from_name")
    .eq("id", orgId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OrgEmailRow | null) ?? null;
}

async function viewOf(row: OrgEmailRow | null) {
  const fromEmail = row?.from_email ?? null;
  const domainAuth = fromEmail
    ? await checkSendgridDomainAuth(fromEmail)
    : {
        status: "unknown" as const,
        detail:
          "Using the platform default sender. Set your own From address to brand outbound email.",
      };
  return {
    fromEmail,
    fromName: row?.from_name ?? null,
    platformDefaultEmail: DEFAULT_SENDGRID_FROM_EMAIL,
    platformDefaultName: DEFAULT_SENDGRID_FROM_NAME,
    domainAuth,
  };
}

// ---------------------------------------------------------------------------
// GET — current sender + live domain-auth status
// ---------------------------------------------------------------------------
router.get(
  "/admin/organization/email-settings",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    res.json(await viewOf(await loadOrgEmail(orgId)));
  },
);

// ---------------------------------------------------------------------------
// PATCH — set / clear the tenant's From identity
// ---------------------------------------------------------------------------
router.patch(
  "/admin/organization/email-settings",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "email_settings.patch", preset: "sensitive" }),
  async (req, res) => {
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const { fromEmail, fromName } = parsed.data;
    const update: Record<string, string | null> = {};
    if (fromEmail !== undefined) update.from_email = fromEmail;
    if (fromName !== undefined) update.from_name = fromName;

    const { error: updErr } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .update(update)
      .eq("id", orgId);
    if (updErr) throw updErr;

    invalidateTenantSenderCache();

    await logAudit({
      action: "organization.email_sender_updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: {
        from_email: fromEmail ?? null,
        from_name: fromName ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn(
        { err: auditErr },
        "organization.email_sender_updated audit write failed",
      );
    });

    res.json(await viewOf(await loadOrgEmail(orgId)));
  },
);

export default router;

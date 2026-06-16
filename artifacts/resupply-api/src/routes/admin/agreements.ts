// /admin/agreements — tenant onboarding agreements (BAA + platform terms).
//
//   GET  /admin/agreements        — the required agreements + whether this
//        org has signed each at its current version (drives the accept UI).
//   POST /admin/agreements/accept — record a signed acceptance.
//
// The console is gated on these: /me exposes `pendingAgreements`, and the
// SPA blocks until it's empty. Viewing is open to any admin; ACCEPTING is
// owner-tier (system.config.manage) because the signatory binds the org.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  REQUIRED_AGREEMENTS,
  currentAgreement,
  type AgreementType,
} from "../../lib/agreements";
import {
  getAgreementStatus,
  getPendingAgreementTypes,
  invalidatePendingAgreementsCache,
} from "../../lib/agreements/status";
import { logger } from "../../lib/logger";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

router.get(
  "/admin/agreements",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    res.json({ agreements: await getAgreementStatus(orgId) });
  },
);

const acceptBody = z
  .object({
    type: z.enum(["baa", "platform_terms"]),
    version: z.string().trim().min(1).max(40),
    signatoryName: z.string().trim().min(1).max(200),
  })
  .strict();

router.post(
  "/admin/agreements/accept",
  adminWriteRateLimiter,
  requirePermission("system.config.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = acceptBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { type, version, signatoryName } = parsed.data;

    // Only the CURRENT version of a required agreement is acceptable —
    // reject a stale/forged version so a tenant can't satisfy the gate by
    // signing superseded text.
    const current = currentAgreement(type as AgreementType);
    if (!current || current.version !== version) {
      res.status(409).json({ error: "stale_agreement_version" });
      return;
    }

    const db = getOrgScopedClient(orgId);
    const { error } = await db.from("organization_agreements").insert({
      agreement_type: type,
      version,
      accepted_by_user_id: req.adminUserId ?? null,
      accepted_by_email: req.adminEmail ?? null,
      signatory_name: signatoryName,
      accepted_ip: req.ip ?? null,
    });
    // 23505 = already accepted this (org, type, version): idempotent success.
    if (error && (error as { code?: string }).code !== "23505") {
      logger.error(
        { event: "agreement_accept_failed", err: error, orgId, type },
        "agreements: accept insert failed",
      );
      res.status(500).json({ error: "accept_failed" });
      return;
    }

    await logAudit({
      action: "tenant.agreement.accepted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      // The org is the audited subject (a tenant-level acceptance), so
      // targetTable/targetId both identify the organization — rather than
      // naming the agreements table while pointing targetId at an org id.
      targetTable: "organizations",
      targetId: orgId,
      metadata: { type, version, signatoryName },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "agreements: accept audit write failed");
    });

    // Clear the server-side gate cache so the just-signed agreement
    // unblocks this tenant's admin API on the very next request (rather
    // than after the ~10s TTL).
    invalidatePendingAgreementsCache(orgId);

    const pending = await getPendingAgreementTypes(orgId);
    res.json({ ok: true, pending, allSigned: pending.length === 0 });
  },
);

export { REQUIRED_AGREEMENTS };
export default router;

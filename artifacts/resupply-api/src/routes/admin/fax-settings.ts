// /admin/organization/fax-settings — a tenant's (DME company's) own fax
// number.
//
//   GET   /admin/organization/fax-settings
//         Returns the tenant's provisioned fax number (if any), how it was
//         set, and whether the platform can auto-provision one.
//
//   POST  /admin/organization/fax-settings/provision
//         Body: { areaCode? }
//         Orders a fax-capable DID from Telnyx, attaches it to the fax
//         Application, and stamps it onto organizations.fax_from_number.
//         409 if the tenant already has one (avoids double-buying).
//
//   PATCH /admin/organization/fax-settings
//         Body: { faxNumber: string | null }
//         Manually set (a ported / pre-existing DID) or clear the tenant's
//         fax number. Clears the Telnyx order id (manual numbers aren't
//         from an order). 409 on a uniqueness collision with another tenant.
//
// Fax is provisioned through Telnyx — Twilio retired Programmable Fax. The
// tenant's number then flows through the existing tenant-aware fax SEND
// path (physician outreach / appeal letters) and the inbound-fax routing
// (resolveOrgIdByFaxNumber), both keyed on organizations.fax_from_number
// (migration 0368).
//
// PHI / log posture: a tenant's own fax DID is business data, not PHI. The
// audit envelope carries the action + order id only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createTelnyxNumberClient,
  TelnyxApiError,
  TelnyxConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger.js";
import { invalidateTenantTelecomCache } from "../../lib/messaging/tenant-telecom.js";
import { adminRateLimit } from "../../middlewares/admin-rate-limit.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

const router: IRouter = Router();

const E164 = /^\+[1-9]\d{6,14}$/;

const provisionBody = z
  .object({
    // US area code (national destination code) to keep the fax number
    // local to the tenant. Optional — Telnyx picks one when omitted.
    areaCode: z
      .string()
      .trim()
      .regex(/^\d{3}$/, "areaCode must be a 3-digit US area code")
      .optional(),
  })
  .strict();

const patchBody = z
  .object({
    // null clears the tenant's fax number (e.g. when releasing a DID).
    faxNumber: z.string().trim().regex(E164, "must be E.164").nullable(),
  })
  .strict();

/**
 * True when the platform can auto-order a number (Telnyx key + the fax
 * Application id are set). Distinct from `isFaxConfigured()` (which also
 * requires the SEND-side webhook key + public base URL) — a tenant can be
 * GIVEN a number even before the full send pipeline is wired.
 */
function canProvisionFax(): boolean {
  return Boolean(
    process.env.TELNYX_API_KEY?.trim() &&
    process.env.TELNYX_FAX_CONNECTION_ID?.trim(),
  );
}

interface OrgFaxRow {
  fax_from_number: string | null;
  fax_telnyx_order_id: string | null;
  fax_provisioned_at: string | null;
  slug: string | null;
}

async function loadOrgFax(orgId: string): Promise<OrgFaxRow | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .from("organizations")
    .select("fax_from_number, fax_telnyx_order_id, fax_provisioned_at, slug")
    .eq("id", orgId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OrgFaxRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// GET — current fax number + provisioning capability
// ---------------------------------------------------------------------------
router.get(
  "/admin/organization/fax-settings",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const row = await loadOrgFax(orgId);
    res.json({
      faxNumber: row?.fax_from_number ?? null,
      telnyxOrderId: row?.fax_telnyx_order_id ?? null,
      provisionedAt: row?.fax_provisioned_at ?? null,
      canProvision: canProvisionFax(),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /provision — order a fax-capable DID for this tenant
// ---------------------------------------------------------------------------

// Ordering a number is a live, billable Telnyx call that assigns a real
// DID. Keep the limit tight so a stuck button can't buy a stack of numbers.
const provisionLimiter = adminRateLimit({
  name: "fax_provision",
  preset: "sensitive",
});

router.post(
  "/admin/organization/fax-settings/provision",
  requirePermission("admin.tools.manage"),
  provisionLimiter,
  async (req, res) => {
    const parsed = provisionBody.safeParse(req.body ?? {});
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!canProvisionFax()) {
      res.status(503).json({ error: "fax_provisioning_not_configured" });
      return;
    }

    const existing = await loadOrgFax(orgId);
    if (existing?.fax_from_number) {
      // Already has one — refuse to buy a second. Operator clears it first
      // (PATCH faxNumber:null) if they really want to re-provision.
      res.status(409).json({
        error: "fax_already_provisioned",
        faxNumber: existing.fax_from_number,
      });
      return;
    }

    let result: { phoneNumber: string; orderId: string; status: string };
    try {
      const client = createTelnyxNumberClient();
      result = await client.provisionFaxNumber({
        areaCode: parsed.data.areaCode,
        // Tag the Telnyx order so a number can be traced back to its tenant.
        customerReference: existing?.slug
          ? `org:${existing.slug}`
          : `org:${orgId}`,
      });
    } catch (err) {
      if (err instanceof TelnyxConfigError) {
        res.status(503).json({ error: "fax_provisioning_not_configured" });
        return;
      }
      const msg =
        err instanceof TelnyxApiError
          ? err.message
          : "Telnyx number provisioning failed";
      logger.warn(
        { event: "fax_provision_failed", orgId },
        "fax-settings: Telnyx provisioning failed",
      );
      res.status(502).json({ error: "fax_provision_failed", detail: msg });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .update({
        fax_from_number: result.phoneNumber,
        fax_telnyx_order_id: result.orderId,
        fax_provisioned_at: nowIso,
      })
      .eq("id", orgId);
    if (updErr) {
      // The number is bought but we couldn't persist it — log the DID +
      // order id so an operator can reconcile by hand rather than orphaning
      // a paid-for number silently.
      logger.error(
        {
          event: "fax_provision_persist_failed",
          orgId,
          telnyxOrderId: result.orderId,
          err: updErr,
        },
        "fax-settings: number ordered but DB write failed — manual reconcile",
      );
      res.status(500).json({
        error: "fax_provision_persist_failed",
        telnyxOrderId: result.orderId,
      });
      return;
    }

    invalidateTenantTelecomCache();

    await logAudit({
      action: "organization.fax_provisioned",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: {
        telnyx_order_id: result.orderId,
        order_status: result.status,
        // The DID is business data, not PHI — safe to record.
        fax_number: result.phoneNumber,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn(
        { err: auditErr },
        "organization.fax_provisioned audit write failed",
      );
    });

    res.status(201).json({
      faxNumber: result.phoneNumber,
      telnyxOrderId: result.orderId,
      provisionedAt: nowIso,
      status: result.status,
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH — manually set / clear the tenant's fax number
// ---------------------------------------------------------------------------
router.patch(
  "/admin/organization/fax-settings",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "fax_settings.patch", preset: "sensitive" }),
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const faxNumber = parsed.data.faxNumber;
    const nowIso = new Date().toISOString();
    const { error: updErr } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .update({
        fax_from_number: faxNumber,
        // A manually-entered number isn't from a Telnyx order; clearing the
        // number clears the order id too.
        fax_telnyx_order_id: null,
        fax_provisioned_at: faxNumber ? nowIso : null,
      })
      .eq("id", orgId);
    if (updErr) {
      // Unique partial index collision → another tenant owns this number.
      if ((updErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "fax_number_in_use" });
        return;
      }
      throw updErr;
    }

    invalidateTenantTelecomCache();

    await logAudit({
      action: faxNumber
        ? "organization.fax_number_set"
        : "organization.fax_number_cleared",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: { fax_number: faxNumber },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn(
        { err: auditErr },
        "organization.fax_number change audit write failed",
      );
    });

    res.json({ faxNumber, provisionedAt: faxNumber ? nowIso : null });
  },
);

export default router;

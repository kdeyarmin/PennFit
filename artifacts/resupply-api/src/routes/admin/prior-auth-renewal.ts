// /admin/prior-authorizations/:id/draft-renewal — one-click renewal
// draft for an expiring/expired PA (Biller #35, Phase 5).
//
//   POST /admin/prior-authorizations/:id/draft-renewal
//
// The prior-auth-expiry-sweep job already does the "nudge" half — it
// writes a `prior_auth_expiring` / `prior_auth_expired` CSR alert as a
// PA approaches/passes its approved_through. This is the "draft the
// renewal" half: clone the source PA into a fresh `draft` (same patient
// / coverage / HCPCS / payer; decision + auth fields cleared) so the
// biller starts the renewal from the existing record instead of
// re-keying it.
//
// Gated patients.update (the same gate the PA create/patch carries).
// Idempotent-ish: refuses if an OPEN renewal (draft/submitted/appealed)
// already exists for the same patient+hcpcs, so repeated clicks don't
// spawn duplicate drafts. Audited; no PHI in the log (ids + hcpcs only).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.string().trim().uuid();

// PAs that count as a still-open renewal for the dedupe guard.
const OPEN_RENEWAL_STATUSES = ["draft", "submitted", "appealed"];
// Source PAs eligible to be renewed — only ones at/near end of life.
const RENEWABLE_SOURCE_STATUSES = new Set(["approved", "expired", "denied"]);

router.post(
  "/admin/prior-authorizations/:id/draft-renewal",
  requirePermission("patients.update"),
  adminRateLimit({ name: "prior_auth.draft_renewal", preset: "mutation" }),
  async (req, res) => {
    const idCheck = idParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const sourceId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: sourceData, error: srcErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select(
        "id, patient_id, insurance_coverage_id, hcpcs_code, payer_name, status, approved_through",
      )
      .eq("id", sourceId)
      .maybeSingle();
    if (srcErr) {
      res.status(500).json({ error: "query_failed", message: srcErr.message });
      return;
    }
    const source = sourceData as Record<string, unknown> | null;
    if (!source) {
      res.status(404).json({ error: "prior_auth_not_found" });
      return;
    }
    const sourceStatus = String(source.status);
    if (!RENEWABLE_SOURCE_STATUSES.has(sourceStatus)) {
      res.status(409).json({
        error: "not_renewable",
        message: `cannot draft a renewal from a PA in status '${sourceStatus}'`,
        status: sourceStatus,
      });
      return;
    }

    const patientId = String(source.patient_id);
    const hcpcsCode = String(source.hcpcs_code);

    // Dedupe: if an open renewal already exists for this patient+hcpcs,
    // return it rather than spawning another draft.
    const { data: existingOpen, error: dupErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select("id, status")
      .eq("patient_id", patientId)
      .eq("hcpcs_code", hcpcsCode)
      .in("status", OPEN_RENEWAL_STATUSES)
      .neq("id", sourceId)
      .limit(1);
    if (dupErr) {
      res.status(500).json({ error: "query_failed", message: dupErr.message });
      return;
    }
    if (Array.isArray(existingOpen) && existingOpen.length > 0) {
      const existing = existingOpen[0] as Record<string, unknown>;
      res.status(409).json({
        error: "open_renewal_exists",
        message: "an open renewal for this patient + HCPCS already exists",
        existingId: existing.id,
        existingStatus: existing.status,
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const { data: created, error: insErr } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .insert({
        patient_id: patientId,
        insurance_coverage_id:
          typeof source.insurance_coverage_id === "string"
            ? source.insurance_coverage_id
            : null,
        hcpcs_code: hcpcsCode,
        payer_name: String(source.payer_name),
        status: "draft",
        requested_at: nowIso,
        notes: `Renewal drafted from PA ${sourceId} (expired ${
          source.approved_through ?? "n/a"
        }).`,
      })
      .select("id")
      .single();
    if (insErr) {
      res.status(500).json({ error: "insert_failed", message: insErr.message });
      return;
    }
    const newId = (created as Record<string, unknown>).id as string;

    await logAudit({
      action: "prior_authorization.renewal_drafted",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prior_authorizations",
      targetId: newId,
      metadata: {
        source_prior_auth_id: sourceId,
        patient_id: patientId,
        hcpcs_code: hcpcsCode,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prior_authorization.renewal_drafted audit failed");
    });

    res.status(201).json({ id: newId, sourcePriorAuthId: sourceId });
  },
);

export default router;

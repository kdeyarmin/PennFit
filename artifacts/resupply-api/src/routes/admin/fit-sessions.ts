// /admin/fit-sessions — the clinical fitting record and RT review queue.
//
//   GET  /admin/fit-sessions               — list, filtered by review status
//   GET  /admin/fit-sessions/:id           — one session as a full report
//   GET  /admin/fit-sessions/:id/report.pdf — the downloadable fit report
//   POST /admin/fit-sessions/:id/approve   — clinician sign-off
//   POST /admin/fit-sessions/:id/override  — dispense something else, with a reason
//   POST /admin/fit-sessions/:id/request-rescan — send the patient back for a better scan
//
// PATH CHOICE — read before "tidying" this under /admin/clinical/.
// These routes deliberately live at the top level rather than under
// /admin/clinical/, because /admin/clinical/* is NOT on the mask_fitter
// product-scope allowlist (it fronts order-joined worklists a fitter-only
// tenant has no data for). Nesting the review queue there would 403
// exactly the customers who bought the fitter as a standalone product.
//
// PHI / log posture: sessions carry facial measurements, health
// questionnaire answers, and safety-screen answers about the patient AND
// their household. The PDF bytes are PHI: streamed to the authenticated
// caller with `no-store`, never written to disk, never logged. Structured
// log lines carry ids and outcome codes only.
//
// Staff mutations additionally write `public.admin_audit_log` — the live,
// org-scoped staff-action log (migration 0477), which is a different thing
// from the retired `resupply.audit_log` machinery CLAUDE.md forbids.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { buildFitReport } from "../../lib/fitting/build-report";
import { renderFitReportPdf } from "../../lib/fitting/fit-report-pdf";
import { sendRescanRequest } from "../../lib/fitting/rescan-notify";
import { isFeatureEnabled } from "../../lib/feature-flags";

const router: IRouter = Router();

const listQuery = z
  .object({
    reviewStatus: z
      .enum([
        "not_required",
        "pending_review",
        "approved",
        "overridden",
        "rescan_requested",
        "rejected",
      ])
      .optional(),
    outcome: z
      .enum([
        "high_confidence",
        "moderate_confidence",
        "low_confidence",
        "contraindicated",
        "outside_validated_range",
      ])
      .optional(),
    patientId: z.string().trim().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const overrideBody = z
  .object({
    maskModelId: z.string().trim().uuid(),
    variantId: z.string().trim().uuid().nullable().optional(),
    reason: z
      .string()
      .trim()
      .min(10, "Explain in a sentence why a different mask was chosen.")
      .max(2000),
  })
  .strict();

const approveBody = z
  .object({ note: z.string().trim().max(2000).optional() })
  .strict();

const rescanBody = z
  .object({
    reason: z.string().trim().min(3).max(2000),
  })
  .strict();

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

router.get(
  "/admin/fit-sessions",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "fit_sessions.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { reviewStatus, outcome, patientId, limit, offset } = parsed.data;
    const supabase = getOrgScopedClient(orgId);

    let query = supabase
      .from("fit_sessions")
      .select(
        "id, created_at, patient_id, fitter_invite_id, status, outcome, recommendation_confidence, measurement_confidence_band, scan_quality_grade, review_status, reviewed_by_email, reviewed_at, primary_recommendation, population, service_line, degraded",
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (reviewStatus) query = query.eq("review_status", reviewStatus);
    if (outcome) query = query.eq("outcome", outcome);
    if (patientId) query = query.eq("patient_id", patientId);

    const { data, error } = (await query) as {
      data: Record<string, unknown>[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const rows = data ?? [];

    // A rescan request produces a NEW session for the same invite, and
    // nothing ever moves the old one out of `rescan_requested` — so those
    // rows read as eternally open work. Resolve, in one batched lookup,
    // which of them have in fact been superseded by a newer fitting, so
    // the queue can say "rescan completed — see the new session" instead
    // of dead-ending. Best-effort: a lookup failure leaves the field null.
    const supersededBy = new Map<string, string>();
    const rescanRows = rows.filter(
      (r) => r.review_status === "rescan_requested" && r.fitter_invite_id,
    );
    if (rescanRows.length > 0) {
      const inviteIds = [
        ...new Set(rescanRows.map((r) => String(r.fitter_invite_id))),
      ];
      const { data: siblings } = (await supabase
        .from("fit_sessions")
        .select("id, fitter_invite_id, created_at")
        .in("fitter_invite_id", inviteIds)
        .order("created_at", { ascending: false })) as {
        data: Record<string, unknown>[] | null;
      };
      for (const row of rescanRows) {
        const newer = (siblings ?? []).find(
          (s) =>
            String(s.fitter_invite_id) === String(row.fitter_invite_id) &&
            String(s.id) !== String(row.id) &&
            String(s.created_at) > String(row.created_at),
        );
        if (newer) supersededBy.set(String(row.id), String(newer.id));
      }
    }

    res.json({
      sessions: rows.map((row) => ({
        id: String(row.id),
        createdAt: String(row.created_at),
        patientId: (row.patient_id as string | null) ?? null,
        status: row.status,
        outcome: row.outcome,
        recommendationConfidence: row.recommendation_confidence,
        measurementConfidenceBand: row.measurement_confidence_band,
        scanQualityGrade: row.scan_quality_grade,
        reviewStatus: row.review_status,
        reviewedByEmail: row.reviewed_by_email,
        reviewedAt: row.reviewed_at,
        population: row.population,
        serviceLine: row.service_line,
        degraded: row.degraded,
        recommendedMask:
          (row.primary_recommendation as { name?: string } | null)?.name ??
          null,
        // The newer session that answered this row's rescan request, when
        // one exists. Null for everything that is not a superseded rescan.
        supersededBySessionId: supersededBy.get(String(row.id)) ?? null,
      })),
      limit,
      offset,
    });
  },
);

router.get(
  "/admin/fit-sessions/:id",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "fit_sessions.detail", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const report = await buildFitReport(orgId, id.data);
    if (!report) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(report);
  },
);

router.get(
  "/admin/fit-sessions/:id/report.pdf",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "fit_sessions.report", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("fitter.clinical_report", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }

    const report = await buildFitReport(orgId, id.data);
    if (!report) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    try {
      const pdf = await renderFitReportPdf(report);
      // PHI: never cached by an intermediary, never stored.
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Length", String(pdf.byteLength));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="fit-report-${id.data}.pdf"`,
      );
      res.end(pdf);

      // This route is triggered by a human taking a copy, so the event is a
      // DOWNLOAD. `report.generated` would imply the PDF was produced ahead
      // of time, and would make the counter below count the wrong thing on
      // a report that is rendered fresh on every request.
      await recordEvent(orgId, id.data, "report.downloaded", req, {
        outcome: report.session.outcome,
      });
      await getOrgScopedClient(orgId)
        .from("fit_sessions")
        .update({
          report_generated_at: new Date().toISOString(),
          report_count:
            report.auditTrail.filter((e) => e.eventType === "report.downloaded")
              .length + 1,
        })
        .eq("id", id.data);
    } catch (err) {
      logger.error(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          fitSessionId: id.data,
        },
        "fit report render failed",
      );
      if (!res.headersSent) {
        res.status(500).json({ error: "render_failed" });
      }
    }
  },
);

router.post(
  "/admin/fit-sessions/:id/approve",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "fit_sessions.approve", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = approveBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    // You cannot approve a recommendation that does not exist. Every
    // low-confidence, contraindicated, and outside-range session is stored
    // with a NULL primary recommendation precisely BECAUSE the engine
    // declined to name a mask — rubber-stamping one would produce an
    // "approved" clinical report with no mask or size on it, which is the
    // opposite of what the exception states exist for. Those sessions go
    // through override (a clinician picks a mask, with a reason) or rescan.
    const supabase = getOrgScopedClient(orgId);
    const { data: existing } = (await supabase
      .from("fit_sessions")
      .select("primary_recommendation, outcome, review_status")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!existing.primary_recommendation) {
      res.status(409).json({
        error: "no_recommendation_to_approve",
        outcome: existing.outcome,
        message:
          "This fitting produced no automated recommendation, so there is nothing to approve. Override it with a mask you have chosen, or request a new scan.",
      });
      return;
    }
    // An overridden session already carries a clinician's decision AND the
    // override mask/reason columns. Flipping it to "approved" would leave
    // those populated under a status that contradicts them — a record that
    // reads "approved" while still naming a different dispensed mask.
    if (existing.review_status === "overridden") {
      res.status(409).json({
        error: "already_overridden",
        message:
          "This fitting was overridden with a different mask. To change that decision, record a new override with a reason.",
      });
      return;
    }

    const { error } = await supabase
      .from("fit_sessions")
      .update({
        review_status: "approved",
        status: "approved",
        reviewed_by_email: req.adminEmail ?? null,
        reviewed_by_user_id: req.adminUserId ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }

    await recordEvent(orgId, id.data, "clinician.approved", req, {
      hasNote: Boolean(body.data.note),
    });
    res.json({ ok: true });
  },
);

router.post(
  "/admin/fit-sessions/:id/override",
  requireAdmin,
  // The dedicated permission for exactly this action. It already existed
  // for the CSR-curated per-patient override and is granted to the CSR and
  // clinician tiers.
  requirePermission("fit_session.override"),
  adminRateLimit({ name: "fit_sessions.override", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = overrideBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.success
          ? []
          : body.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
      });
      return;
    }

    // Validate BOTH references against what this tenant can actually see.
    // The catalog FKs are global (platform rows have a NULL org_id), so an
    // unvalidated UUID lets a caller pin another tenant's private model —
    // or pair a real mask with an unrelated size — onto a clinical
    // disposition, producing a corrupt record whose override name will not
    // even resolve in the report.
    const supabase = getOrgScopedClient(orgId);
    const { data: model } = (await supabase
      .raw()
      .schema("resupply")
      .from("mask_models")
      .select("id")
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .eq("id", body.data.maskModelId)
      .limit(1)
      .maybeSingle()) as { data: Record<string, unknown> | null };
    if (!model) {
      res.status(400).json({
        error: "unknown_mask_model",
        message: "That mask is not in this organization's catalog.",
      });
      return;
    }
    if (body.data.variantId) {
      const { data: variant } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_size_variants")
        .select("id")
        .eq("id", body.data.variantId)
        // The size must belong to the mask being dispensed.
        .eq("mask_model_id", body.data.maskModelId)
        .limit(1)
        .maybeSingle()) as { data: Record<string, unknown> | null };
      if (!variant) {
        res.status(400).json({
          error: "variant_model_mismatch",
          message: "That size does not belong to the selected mask.",
        });
        return;
      }
    }

    // The reason is mandatory at the schema level AND at the database
    // level (a CHECK on fit_sessions). A recommendation silently replaced
    // is exactly what the report exists to prevent.
    const { error } = await supabase
      .from("fit_sessions")
      .update({
        review_status: "overridden",
        status: "overridden",
        override_mask_model_id: body.data.maskModelId,
        override_variant_id: body.data.variantId ?? null,
        override_reason: body.data.reason,
        reviewed_by_email: req.adminEmail ?? null,
        reviewed_by_user_id: req.adminUserId ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }

    await recordEvent(orgId, id.data, "clinician.overridden", req, {
      maskModelId: body.data.maskModelId,
      reasonLength: body.data.reason.length,
    });
    res.json({ ok: true });
  },
);

router.post(
  "/admin/fit-sessions/:id/request-rescan",
  requireAdmin,
  requirePermission("clinical.intervention.write"),
  adminRateLimit({ name: "fit_sessions.rescan", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = rescanBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const { error } = await getOrgScopedClient(orgId)
      .from("fit_sessions")
      .update({
        review_status: "rescan_requested",
        status: "rescan_required",
        // The clinician's why (0501). Free text sits on the session row
        // beside override_reason — the events table stays codes/counts.
        rescan_reason: body.data.reason,
        reviewed_by_email: req.adminEmail ?? null,
        reviewed_by_user_id: req.adminUserId ?? null,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }

    // Actually ask the patient. Flagging the session alone reads to staff
    // as "the patient has been asked" while nothing has left the
    // building, and the fitting then dies in a queue nobody outside this
    // console can see. Delivery is best-effort but its OUTCOME is
    // reported: a clinician needs to know the difference between "asked"
    // and "we have no way to reach them".
    const delivery = await sendRescanRequest(orgId, id.data);

    await recordEvent(orgId, id.data, "rescan.requested", req, {
      reasonLength: body.data.reason.length,
      notified: delivery.delivered,
      notifyReason: delivery.reason,
    });
    res.json({
      ok: true,
      patientNotified: delivery.delivered,
      notifyReason: delivery.reason,
      // Handed back so staff can read the link out or paste it into a
      // channel of their own when automated delivery had nowhere to go.
      inviteLink: delivery.delivered ? null : delivery.link,
    });
  },
);

/**
 * Append to the session's provenance trail.
 *
 * Best-effort: a failed event write must not fail the clinical action it
 * describes. `detail` carries ids, codes, and counts — never free text
 * the clinician typed, which could contain PHI.
 */
async function recordEvent(
  orgId: string,
  fitSessionId: string,
  eventType: string,
  req: { adminEmail?: string | null; adminUserId?: string | null },
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await getOrgScopedClient(orgId)
      .from("fit_session_events")
      .insert({
        fit_session_id: fitSessionId,
        event_type: eventType,
        actor_kind: "staff",
        actor_email: req.adminEmail ?? null,
        // The stable identity too — an email is mutable and re-assignable,
        // which is a weak basis for a clinical sign-off trail.
        actor_user_id: req.adminUserId ?? null,
        detail,
      });
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err : new Error(String(err)),
        fitSessionId,
        eventType,
      },
      "fit session event write failed",
    );
  }
}

export default router;

// /admin/office-ally-submissions — tracking + simple-recovery surface
// for 837P claim files we've uploaded to Office Ally.
//
//   GET   /admin/office-ally-submissions               — list newest-first
//   GET   /admin/office-ally-submissions/:id           — detail incl. linked claims
//   GET   /admin/office-ally-submissions/:id/raw-837p  — download the EDI we
//                                                        sent (regenerated)
//   POST  /admin/office-ally-submissions/:id/resubmit  — re-attempt a
//                                                        transport_failed batch
//   PATCH /admin/office-ally-submissions/:id           — ack-file ingest + status edit
//
// The original UPLOAD happens at
// /admin/billing/batch-submit-office-ally (and the per-claim variant
// on the patients router). This route is the read + ack triage +
// resubmit surface.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import {
  buildEdiPayloadForSubmission,
  executeOfficeAllyBatchSubmit,
} from "../../lib/billing/office-ally-batch";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

type SubmissionRowFull = Database["resupply"]["Tables"]["office_ally_submissions"]["Row"];
type SubmissionStatus = SubmissionRowFull["status"];

const STATUS_VALUES = [
  "queued",
  "uploaded",
  "accepted_999",
  "rejected_999",
  "accepted_277ca",
  "rejected_277ca",
  "transport_failed",
] as const satisfies readonly SubmissionStatus[];

const patchBody = z
  .object({
    status: z.enum(STATUS_VALUES).optional(),
    ack999FileName: z.string().trim().max(120).nullable().optional(),
    ack999ReceivedAt: z.string().datetime().nullable().optional(),
    ack277caFileName: z.string().trim().max(120).nullable().optional(),
    ack277caReceivedAt: z.string().datetime().nullable().optional(),
    rejectionReason: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

interface SubmissionRow {
  id: string;
  file_name: string;
  isa_control_number: string;
  gs_control_number: string;
  status: string;
  file_size_bytes: number;
  claim_count: number;
  office_ally_session_id: string | null;
  ack_999_file_name: string | null;
  ack_999_received_at: string | null;
  ack_277ca_file_name: string | null;
  ack_277ca_received_at: string | null;
  rejection_reason: string | null;
  submitted_by_email: string;
  submitted_at: string;
  updated_at: string;
  attempted_claim_ids: string[] | null;
  parent_submission_id: string | null;
}

function rowToApi(r: SubmissionRow) {
  return {
    id: r.id,
    fileName: r.file_name,
    isaControlNumber: r.isa_control_number,
    gsControlNumber: r.gs_control_number,
    status: r.status,
    fileSizeBytes: r.file_size_bytes,
    claimCount: r.claim_count,
    officeAllySessionId: r.office_ally_session_id,
    ack999FileName: r.ack_999_file_name,
    ack999ReceivedAt: r.ack_999_received_at,
    ack277caFileName: r.ack_277ca_file_name,
    ack277caReceivedAt: r.ack_277ca_received_at,
    rejectionReason: r.rejection_reason,
    submittedByEmail: r.submitted_by_email,
    submittedAt: r.submitted_at,
    updatedAt: r.updated_at,
    attemptedClaimIds: r.attempted_claim_ids ?? [],
    parentSubmissionId: r.parent_submission_id,
  };
}

const FULL_SELECT =
  "id, file_name, isa_control_number, gs_control_number, status, file_size_bytes, claim_count, office_ally_session_id, ack_999_file_name, ack_999_received_at, ack_277ca_file_name, ack_277ca_received_at, rejection_reason, submitted_by_email, submitted_at, updated_at, attempted_claim_ids, parent_submission_id";

// ── LIST ────────────────────────────────────────────────────────────
router.get(
  "/admin/office-ally-submissions",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(FULL_SELECT)
      .order("submitted_at", { ascending: false })
      .limit(200);
    const statusFilter =
      typeof req.query.status === "string" ? req.query.status : undefined;
    if (statusFilter && isSubmissionStatus(statusFilter)) {
      query = query.eq("status", statusFilter);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ submissions: (data ?? []).map(rowToApi) });
  },
);

// ── DETAIL incl linked claims ──────────────────────────────────────
router.get(
  "/admin/office-ally-submissions/:id",
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: submission, error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select(FULL_SELECT)
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!submission) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { data: claims } = await supabase
      .schema("resupply")
      .from("insurance_claims")
      .select(
        "id, patient_id, payer_name, claim_number, date_of_service, status, total_billed_cents",
      )
      .eq("office_ally_submission_id", submission.id)
      .order("date_of_service", { ascending: false });
    res.json({
      submission: rowToApi(submission),
      claims: (claims ?? []).map((c) => ({
        id: c.id,
        patientId: c.patient_id,
        payerName: c.payer_name,
        claimNumber: c.claim_number,
        dateOfService: c.date_of_service,
        status: c.status,
        totalBilledCents: c.total_billed_cents,
      })),
    });
  },
);

// ── RAW 837P DOWNLOAD ──────────────────────────────────────────────
// Regenerates the exact 837P payload from the submission's linked
// claims and original ISA/GS control numbers. Used by the admin UI's
// "View raw 837P" download for audit + Office-Ally support tickets.
//
// PHI gate: the payload contains the full patient/claim payload that
// was sent. requireAdminOnly + the response carries no-store +
// Content-Disposition: attachment so it never lands in a browser
// cache or proxy intermediary.
router.get(
  "/admin/office-ally-submissions/:id/raw-837p",
  requireAdminOnly,
  adminRateLimit({
    name: "office_ally_submissions.raw_837p",
    preset: "sensitive",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const built = await buildEdiPayloadForSubmission(parsed.data.id);
    if (!built) {
      res.status(404).json({ error: "submission_unrecoverable" });
      return;
    }
    await logAudit({
      action: "office_ally_submission.download_raw_837p",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: parsed.data.id,
      metadata: {
        usage_indicator: built.usageIndicator,
        size_bytes: Buffer.byteLength(built.payload, "utf8"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "office_ally_submission.download_raw_837p audit write failed",
      );
    });
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="PF-837P-${parsed.data.id.slice(0, 8)}.txt"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(built.payload);
  },
);

// ── RESUBMIT ────────────────────────────────────────────────────────
// One-click recovery for `transport_failed` submissions. Forwards to
// the shared batch-submit core, recording parent_submission_id so the
// dashboard can show the resubmit chain. Only valid on a row whose
// upload failed at transport — once OA has accepted the file, the
// claims have already advanced and a true resubmit is a different
// (corrected-claim) flow.
router.post(
  "/admin/office-ally-submissions/:id/resubmit",
  requirePermission("admin.tools.manage"),
  adminRateLimit({
    name: "office_ally_submissions.resubmit",
    preset: "bulk",
  }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: original } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .select("id, status, attempted_claim_ids")
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!original) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (original.status !== "transport_failed") {
      res.status(409).json({
        error: "not_resubmittable",
        message:
          "only transport_failed submissions can be resubmitted (claims for accepted batches advance past draft, so a corrected-claim flow is needed instead)",
        currentStatus: original.status,
      });
      return;
    }
    const claimIds = original.attempted_claim_ids ?? [];
    if (claimIds.length === 0) {
      res.status(409).json({
        error: "no_attempted_claims",
        message:
          "this submission predates migration 0150 and has no recorded claim list; submit a fresh batch instead",
      });
      return;
    }
    const result = await executeOfficeAllyBatchSubmit({
      claimIds,
      parentSubmissionId: original.id,
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    if (!result.ok) {
      const status =
        result.kind === "no_claims_matched"
          ? 404
          : 409;
      res.status(status).json({ error: result.kind, ...result.detail });
      return;
    }
    res.status(result.uploadOk ? 201 : 502).json({
      ok: result.uploadOk,
      submissionId: result.submissionId,
      parentSubmissionId: original.id,
      claimCount: result.claimCount,
      isaControlNumber: result.isaControlNumber,
      gsControlNumber: result.gsControlNumber,
      transport: result.transport,
      uploadError: result.uploadError,
    });
  },
);

// ── PATCH — ack-file ingest + manual status edit ───────────────────
router.patch(
  "/admin/office-ally-submissions/:id",
  // Editing a submission row is operator-level: it changes downstream
  // claim status interpretation, and the ack rows are the auditable
  // truth source for billing reconciliation.
  requireAdminOnly,
  adminRateLimit({
    name: "office_ally_submissions.ack",
    preset: "sensitive",
  }),
  async (req, res) => {
    const idParsed = idParam.safeParse(req.params);
    if (!idParsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
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
    const b = parsed.data;
    const update: Database["resupply"]["Tables"]["office_ally_submissions"]["Update"] = {
      updated_at: new Date().toISOString(),
    };
    if (b.status !== undefined) update.status = b.status;
    if (b.ack999FileName !== undefined) update.ack_999_file_name = b.ack999FileName;
    if (b.ack999ReceivedAt !== undefined) update.ack_999_received_at = b.ack999ReceivedAt;
    if (b.ack277caFileName !== undefined) update.ack_277ca_file_name = b.ack277caFileName;
    if (b.ack277caReceivedAt !== undefined) update.ack_277ca_received_at = b.ack277caReceivedAt;
    if (b.rejectionReason !== undefined) update.rejection_reason = b.rejectionReason;

    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("office_ally_submissions")
      .update(update)
      .eq("id", idParsed.data.id);
    if (error) throw error;

    await logAudit({
      action: "office_ally_submission.update",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "office_ally_submissions",
      targetId: idParsed.data.id,
      metadata: {
        fields_changed: Object.keys(update).filter((k) => k !== "updated_at"),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "office_ally_submission.update audit write failed");
    });

    res.json({ ok: true });
  },
);

function isSubmissionStatus(v: string): v is SubmissionStatus {
  return (STATUS_VALUES as readonly string[]).includes(v);
}

export default router;

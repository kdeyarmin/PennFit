// /admin/office-ally-submissions — read-only tracking surface for
// 837P claim files we've uploaded to Office Ally.
//
//   GET   /admin/office-ally-submissions           — list newest-first
//   GET   /admin/office-ally-submissions/:id       — detail incl. linked claims
//   PATCH /admin/office-ally-submissions/:id       — ack-file ingest + status edit
//
// The actual UPLOAD happens at
// /admin/patients/:patientId/insurance-claims/:claimId/submit-office-ally
// (mounted from the patients router). This route is the read + ack
// triage surface.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireAdmin,
  requireAdminOnly,
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
  };
}

const FULL_SELECT =
  "id, file_name, isa_control_number, gs_control_number, status, file_size_bytes, claim_count, office_ally_session_id, ack_999_file_name, ack_999_received_at, ack_277ca_file_name, ack_277ca_received_at, rejection_reason, submitted_by_email, submitted_at, updated_at";

// ── LIST ────────────────────────────────────────────────────────────
router.get(
  "/admin/office-ally-submissions",
  requireAdmin,
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
  requireAdmin,
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

// ── PATCH — ack-file ingest + manual status edit ───────────────────
router.patch(
  "/admin/office-ally-submissions/:id",
  // Editing a submission row is operator-level: it changes downstream
  // claim status interpretation, and the ack rows are the auditable
  // truth source for billing reconciliation.
  requireAdminOnly,
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

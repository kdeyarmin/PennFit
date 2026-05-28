// /admin/physician-fax-outreach — record + dispatch physician-fax
// Rx-renewal requests (Phase G.6 — Phase B.2 follow-up).
//
//   POST /admin/physician-fax-outreach
//        Body: { patientId, prescriptionId?, physicianName,
//                physicianFaxE164, coverLetterText }
//        Inserts a physician_fax_outreach row and dispatches via
//        Twilio Programmable Fax when TWILIO_ACCOUNT_SID,
//        TWILIO_AUTH_TOKEN, and TWILIO_FAX_FROM_NUMBER are set.
//        Returns the outreach row id + final status.
//
//   POST /admin/physician-fax-outreach/:id/retry
//        Re-fires a pending or failed outreach row. Guards against
//        double-billing: 409 if the row is already sent/delivered.
//
//   GET  /admin/physician-fax-outreach?patientId=...
//        Lists recent outreach rows for a patient.
//
// Vendor: Twilio Programmable Fax (same credentials as SMS + voice).
//   Required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//                 TWILIO_FAX_FROM_NUMBER
//   Optional env: RESUPPLY_VOICE_PUBLIC_BASE_URL (needed for the
//                 mediaUrl and statusCallback — if unset the row is
//                 created but not dispatched immediately).
//
// PHI / log posture:
//   * Audit envelope: outreach_id, patient_id, has_prescription,
//     cover_letter_length. Never the fax number, never the cover
//     letter body, never the physician name.
//   * The mediaUrl token carries only the outreach ID + expiry; the
//     cover letter text is fetched by Twilio from /fax/document/:token.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createTwilioFaxClient,
  TwilioApiError,
} from "@workspace/resupply-telecom";

import { signFaxDocumentToken } from "../../lib/fax-document-token.js";
import { logger } from "../../lib/logger.js";
import { rateLimit } from "../../middlewares/rate-limit.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

const router: IRouter = Router();

const E164 = /^\+[1-9]\d{6,14}$/;

const createBody = z
  .object({
    patientId: z.string().uuid(),
    prescriptionId: z.string().uuid().nullable().optional(),
    physicianName: z.string().trim().min(1).max(120),
    physicianFaxE164: z.string().trim().regex(E164, "Fax must be E.164"),
    coverLetterText: z
      .string()
      .max(8000)
      .refine((value) => value.trim().length > 0, {
        message: "String must contain at least 1 character(s)",
      })
      .refine((value) => value.trim().length >= 20, {
        message: "String must contain at least 20 character(s)",
      }),
  })
  .strict();

const listQuery = z
  .object({
    patientId: z.string().uuid(),
  })
  .strict();

/**
 * Returns the public base URL used for Twilio fax callbacks and the
 * cover-letter mediaUrl. Falls back to RAILWAY_PUBLIC_DOMAIN when the
 * explicit env var is unset. Returns null when neither is set.
 */
export function getFaxPublicBaseUrl(): string | null {
  const raw =
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim() ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : null);
  return raw ? raw.replace(/\/+$/u, "") : null;
}

/**
 * Returns true when all four conditions for a live fax dispatch are met:
 *   - TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (shared with SMS/voice)
 *   - TWILIO_FAX_FROM_NUMBER (fax-enabled Twilio number)
 *   - RESUPPLY_VOICE_PUBLIC_BASE_URL or RAILWAY_PUBLIC_DOMAIN (needed to
 *     build the signed mediaUrl that Twilio fetches, and the
 *     statusCallback URL for delivery events)
 *
 * All four are required for a successful send; showing "configured"
 * when the base URL is missing would mislead the ops dashboard into
 * thinking dispatch works when it silently would not.
 */
export function isFaxConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_FAX_FROM_NUMBER?.trim() &&
      getFaxPublicBaseUrl(),
  );
}

interface DispatchResult {
  status: "sent" | "failed" | "pending";
  provider: string;
  vendorRef?: string;
  dispatchError?: string;
}

/**
 * Attempt to dispatch a fax outreach row via Twilio. Updates the DB
 * row in-place and returns the outcome. Shared between the POST
 * (create + dispatch) and the POST /:id/retry (re-dispatch) handlers.
 */
async function dispatchFax(outreachId: string, to: string): Promise<DispatchResult> {
  if (!isFaxConfigured()) {
    return { status: "pending", provider: "not_configured" };
  }

  // isFaxConfigured() already verified getFaxPublicBaseUrl() is non-null.
  const baseUrl = getFaxPublicBaseUrl()!;
  const supabase = getSupabaseServiceRoleClient();

  const faxClient = createTwilioFaxClient();
  const token = signFaxDocumentToken(outreachId);
  const mediaUrl = `${baseUrl}/resupply-api/fax/document/${token}`;
  const statusCallbackUrl = `${baseUrl}/resupply-api/fax/status-callback`;
  const fromNumber = process.env.TWILIO_FAX_FROM_NUMBER!.trim();

  // Scope try/catch to the Twilio API call only. A DB failure after a
  // successful send must NOT fall into the catch path — that would mark
  // the row as "failed" and allow the retry endpoint to re-fire an already-
  // accepted fax, causing duplicate physician outreach and double billing.
  let result: { sid: string; status: string };
  try {
    result = await faxClient.sendFax({
      to,
      from: fromNumber,
      mediaUrl,
      statusCallbackUrl,
    });
  } catch (err) {
    const msg =
      err instanceof TwilioApiError
        ? `Twilio fax error: ${err.message}`
        : `Fax dispatch error: ${String(err)}`;

    const nowIso = new Date().toISOString();
    const { error: failErr } = await supabase
      .schema("resupply")
      .from("physician_fax_outreach")
      .update({
        status: "failed",
        failed_at: nowIso,
        failure_reason: msg,
        updated_at: nowIso,
      })
      .eq("id", outreachId);
    if (failErr) {
      logger.warn(
        { event: "fax_failure_stamp_db_err", outreachId, err: failErr },
        "physician_fax_outreach: failed to stamp failure",
      );
    }

    logger.warn(
      { event: "fax_dispatch_failed", outreachId },
      "physician_fax_outreach: Twilio dispatch failed",
    );

    return { status: "failed", provider: "twilio", dispatchError: msg };
  }

  // Twilio accepted the fax. Stamp the row outside the sendFax try/catch so
  // a DB hiccup doesn't trigger a retry. The Twilio status-callback will
  // also update the row when delivery completes, giving a second correction path.
  const sentIso = new Date().toISOString();
  const { error: stampErr } = await supabase
    .schema("resupply")
    .from("physician_fax_outreach")
    .update({
      status: "sent",
      vendor_ref: result.sid,
      vendor_name: "twilio",
      sent_at: sentIso,
      failed_at: null,
      failure_reason: null,
      updated_at: sentIso,
    })
    .eq("id", outreachId);
  if (stampErr) {
    // Log the vendorRef so ops can manually reconcile if needed.
    logger.warn(
      {
        event: "fax_db_stamp_failed",
        outreachId,
        vendorRef: result.sid,
        err: stampErr,
      },
      "physician_fax_outreach: fax accepted by Twilio but DB stamp failed",
    );
  }

  return { status: "sent", provider: "twilio", vendorRef: result.sid };
}

// ---------------------------------------------------------------------------
// POST /admin/physician-fax-outreach — create + dispatch
// ---------------------------------------------------------------------------

// Create + record Rx-renewal physician faxes (Twilio dispatch when
// configured, else pending). Writes per-patient outreach state, so
// `patients.update` matches the rest of the patient-tier write
// matrix.
router.post("/admin/physician-fax-outreach", requirePermission("patients.update"), async (req, res) => {
  const parsed = createBody.safeParse(req.body);
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
  const data = parsed.data;
  const supabase = getSupabaseServiceRoleClient();

  const { data: patient, error: patientErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("id", data.patientId)
    .limit(1)
    .maybeSingle();
  if (patientErr) throw patientErr;
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (data.prescriptionId) {
    const { data: rx, error: rxErr } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .select("id, patient_id")
      .eq("id", data.prescriptionId)
      .limit(1)
      .maybeSingle();
    if (rxErr) throw rxErr;
    if (!rx || rx.patient_id !== data.patientId) {
      res.status(400).json({ error: "prescription_patient_mismatch" });
      return;
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("physician_fax_outreach")
    .insert({
      patient_id: data.patientId,
      prescription_id: data.prescriptionId ?? null,
      physician_name: data.physicianName,
      physician_fax_e164: data.physicianFaxE164,
      cover_letter_text: data.coverLetterText,
      created_by_email: req.adminEmail ?? "",
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertErr) throw insertErr;
  if (!inserted) throw new Error("physician_fax_outreach insert returned no rows");
  const id = inserted.id;

  const dispatch = await dispatchFax(id, data.physicianFaxE164);

  await logAudit({
    action: "physician_fax_outreach.created",
    adminEmail: req.adminEmail ?? null,
    adminUserId: req.adminUserId ?? null,
    targetTable: "physician_fax_outreach",
    targetId: id,
    metadata: {
      patient_id: data.patientId,
      has_prescription:
        data.prescriptionId !== undefined && data.prescriptionId !== null,
      cover_letter_length: data.coverLetterText.length,
      provider: dispatch.provider,
      status: dispatch.status,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((auditErr: unknown) => {
    logger.warn({ err: auditErr }, "physician_fax_outreach.created audit write failed");
  });

  const response: Record<string, unknown> = {
    id,
    status: dispatch.status,
    provider: dispatch.provider,
  };
  if (dispatch.dispatchError) response.dispatchError = dispatch.dispatchError;
  res.status(201).json(response);
});

// ---------------------------------------------------------------------------
// POST /admin/physician-fax-outreach/:id/retry — re-fire a failed/pending row
// ---------------------------------------------------------------------------

// Tight limit: each retry triggers a live Twilio API call that incurs cost.
// 5 retries / 15 min per IP is generous for legitimate manual re-dispatch
// but blocks runaway automation or misclicks.
const retryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  name: "physician_fax_retry",
});

router.post(
  "/admin/physician-fax-outreach/:id/retry",
  // Retry — same write scope as the initial create.
  requirePermission("patients.update"),
  retryLimiter,
  async (req, res) => {
    const rawId = req.params.id;
    const outreachId = Array.isArray(rawId) ? (rawId[0] ?? "") : (rawId ?? "");
    if (!outreachId) {
      res.status(400).json({ error: "missing_id" });
      return;
    }

    if (!isFaxConfigured()) {
      res.status(503).json({ error: "fax_not_configured" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("physician_fax_outreach")
      .select("id, status, physician_fax_e164, patient_id, updated_at")
      .eq("id", outreachId)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;

    if (!row) {
      res.status(404).json({ error: "outreach_not_found" });
      return;
    }

    // Guard against double-billing: only allow retry for rows that
    // were never successfully dispatched.
    if (row.status === "sent" || row.status === "delivered") {
      res.status(409).json({
        error: "already_dispatched",
        status: row.status,
      });
      return;
    }

    // Optimistic-concurrency claim: two concurrent retry requests both
    // pass the status check above. Only one UPDATE matches (Postgres
    // serialises row writes); the loser sees zero rows and returns 409
    // before either touches Twilio — preventing duplicate physician
    // faxes. PostgREST round-trips timestamptz losslessly so the
    // updated_at equality is exact.
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("physician_fax_outreach")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", outreachId)
      .eq("updated_at", row.updated_at)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) {
      res.status(409).json({ error: "concurrent_retry" });
      return;
    }

    const dispatch = await dispatchFax(row.id, row.physician_fax_e164);

    await logAudit({
      action: "physician_fax_outreach.retried",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "physician_fax_outreach",
      targetId: outreachId,
      metadata: {
        patient_id: row.patient_id,
        provider: dispatch.provider,
        status: dispatch.status,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn({ err: auditErr }, "physician_fax_outreach.retried audit write failed");
    });

    const response: Record<string, unknown> = {
      id: outreachId,
      status: dispatch.status,
      provider: dispatch.provider,
    };
    if (dispatch.dispatchError) response.dispatchError = dispatch.dispatchError;
    res.status(200).json(response);
  },
);

// ---------------------------------------------------------------------------
// GET /admin/physician-fax-outreach — list rows for a patient
// ---------------------------------------------------------------------------

// Per-CSR read of the queue. `patients.read` matches the rest of
// the patient-tier read matrix (every current role holds it).
router.get("/admin/physician-fax-outreach", requirePermission("patients.read"), async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("physician_fax_outreach")
    .select(
      "id, patient_id, prescription_id, physician_name, physician_fax_e164, status, vendor_ref, vendor_name, sent_at, delivered_at, failed_at, failure_reason, created_by_email, created_at",
    )
    .eq("patient_id", parsed.data.patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  res.json({
    outreach: (rows ?? []).map((r) => ({
      id: r.id,
      patientId: r.patient_id,
      prescriptionId: r.prescription_id,
      physicianName: r.physician_name,
      physicianFaxE164: r.physician_fax_e164,
      status: r.status,
      vendorRef: r.vendor_ref,
      vendorName: r.vendor_name,
      // PostgREST returns timestamptz as ISO string already.
      sentAt: r.sent_at,
      deliveredAt: r.delivered_at,
      failedAt: r.failed_at,
      failureReason: r.failure_reason,
      createdByEmail: r.created_by_email,
      createdAt: r.created_at,
    })),
    providerConfigured: isFaxConfigured(),
  });
});

export default router;

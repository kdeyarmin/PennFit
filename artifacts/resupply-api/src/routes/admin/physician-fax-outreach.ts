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
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patients,
  physicianFaxOutreach,
  prescriptions,
} from "@workspace/resupply-db";
import {
  createTwilioFaxClient,
  TwilioApiError,
} from "@workspace/resupply-telecom";

import { signFaxDocumentToken } from "../../lib/fax-document-token.js";
import { logger } from "../../lib/logger.js";
import { rateLimit } from "../../middlewares/rate-limit.js";
import { requireAdmin } from "../../middlewares/requireAdmin.js";

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
 * cover-letter mediaUrl. Falls back to the Replit dev domain in dev.
 * Returns null when neither env var is set.
 */
export function getFaxPublicBaseUrl(): string | null {
  const raw =
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim() ??
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : null);
  return raw ? raw.replace(/\/+$/u, "") : null;
}

/**
 * Returns true when all four conditions for a live fax dispatch are met:
 *   - TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (shared with SMS/voice)
 *   - TWILIO_FAX_FROM_NUMBER (fax-enabled Twilio number)
 *   - RESUPPLY_VOICE_PUBLIC_BASE_URL or REPLIT_DEV_DOMAIN (needed to
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
  const db = drizzle(getDbPool());

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

    await db
      .update(physicianFaxOutreach)
      .set({
        status: "failed",
        failedAt: new Date(),
        failureReason: msg,
        updatedAt: new Date(),
      })
      .where(eq(physicianFaxOutreach.id, outreachId));

    logger.warn(
      { event: "fax_dispatch_failed", outreachId },
      "physician_fax_outreach: Twilio dispatch failed",
    );

    return { status: "failed", provider: "twilio", dispatchError: msg };
  }

  // Twilio accepted the fax. Stamp the row outside the sendFax try/catch so
  // a DB hiccup doesn't trigger a retry. The Twilio status-callback will
  // also update the row when delivery completes, giving a second correction path.
  try {
    await db
      .update(physicianFaxOutreach)
      .set({
        status: "sent",
        vendorRef: result.sid,
        vendorName: "twilio",
        sentAt: new Date(),
        failedAt: null,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(physicianFaxOutreach.id, outreachId));
  } catch (dbErr) {
    // Log the vendorRef so ops can manually reconcile if needed.
    logger.warn(
      { event: "fax_db_stamp_failed", outreachId, vendorRef: result.sid, err: dbErr },
      "physician_fax_outreach: fax accepted by Twilio but DB stamp failed",
    );
  }

  return { status: "sent", provider: "twilio", vendorRef: result.sid };
}

// ---------------------------------------------------------------------------
// POST /admin/physician-fax-outreach — create + dispatch
// ---------------------------------------------------------------------------

router.post("/admin/physician-fax-outreach", requireAdmin, async (req, res) => {
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
  const db = drizzle(getDbPool());

  const [patient] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.id, data.patientId))
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (data.prescriptionId) {
    const [rx] = await db
      .select({ id: prescriptions.id, patientId: prescriptions.patientId })
      .from(prescriptions)
      .where(eq(prescriptions.id, data.prescriptionId))
      .limit(1);
    if (!rx || rx.patientId !== data.patientId) {
      res.status(400).json({ error: "prescription_patient_mismatch" });
      return;
    }
  }

  const inserted = await db
    .insert(physicianFaxOutreach)
    .values({
      patientId: data.patientId,
      prescriptionId: data.prescriptionId ?? null,
      physicianName: data.physicianName,
      physicianFaxE164: data.physicianFaxE164,
      coverLetterText: data.coverLetterText,
      createdByEmail: req.adminEmail ?? "",
    })
    .returning({ id: physicianFaxOutreach.id });
  const id = inserted[0]!.id;

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
  requireAdmin,
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

    const db = drizzle(getDbPool());
    const [row] = await db
      .select({
        id: physicianFaxOutreach.id,
        status: physicianFaxOutreach.status,
        physicianFaxE164: physicianFaxOutreach.physicianFaxE164,
        patientId: physicianFaxOutreach.patientId,
        updatedAt: physicianFaxOutreach.updatedAt,
      })
      .from(physicianFaxOutreach)
      .where(eq(physicianFaxOutreach.id, outreachId))
      .limit(1);

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
    // serialises row writes); the loser gets 0 rows and returns 409
    // before either touches Twilio — preventing duplicate physician faxes.
    const claimed = await db
      .update(physicianFaxOutreach)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(physicianFaxOutreach.id, outreachId),
          eq(physicianFaxOutreach.updatedAt, row.updatedAt),
        ),
      )
      .returning({ id: physicianFaxOutreach.id });
    if (claimed.length === 0) {
      res.status(409).json({ error: "concurrent_retry" });
      return;
    }

    const dispatch = await dispatchFax(row.id, row.physicianFaxE164);

    await logAudit({
      action: "physician_fax_outreach.retried",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "physician_fax_outreach",
      targetId: outreachId,
      metadata: {
        patient_id: row.patientId,
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

router.get("/admin/physician-fax-outreach", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: physicianFaxOutreach.id,
      patientId: physicianFaxOutreach.patientId,
      prescriptionId: physicianFaxOutreach.prescriptionId,
      physicianName: physicianFaxOutreach.physicianName,
      physicianFaxE164: physicianFaxOutreach.physicianFaxE164,
      status: physicianFaxOutreach.status,
      vendorRef: physicianFaxOutreach.vendorRef,
      vendorName: physicianFaxOutreach.vendorName,
      sentAt: physicianFaxOutreach.sentAt,
      deliveredAt: physicianFaxOutreach.deliveredAt,
      failedAt: physicianFaxOutreach.failedAt,
      failureReason: physicianFaxOutreach.failureReason,
      createdByEmail: physicianFaxOutreach.createdByEmail,
      createdAt: physicianFaxOutreach.createdAt,
    })
    .from(physicianFaxOutreach)
    .where(and(eq(physicianFaxOutreach.patientId, parsed.data.patientId)))
    .orderBy(desc(physicianFaxOutreach.createdAt))
    .limit(50);
  res.json({
    outreach: rows.map((r) => ({
      id: r.id,
      patientId: r.patientId,
      prescriptionId: r.prescriptionId,
      physicianName: r.physicianName,
      physicianFaxE164: r.physicianFaxE164,
      status: r.status,
      vendorRef: r.vendorRef,
      vendorName: r.vendorName,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : null,
      failedAt: r.failedAt ? r.failedAt.toISOString() : null,
      failureReason: r.failureReason,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
    providerConfigured: isFaxConfigured(),
  });
});

export default router;

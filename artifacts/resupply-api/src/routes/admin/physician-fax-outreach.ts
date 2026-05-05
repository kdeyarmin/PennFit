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
import { createTwilioFaxClient, TwilioApiError } from "@workspace/resupply-telecom";

import { signFaxDocumentToken } from "../../lib/fax-document-token.js";
import { logger } from "../../lib/logger.js";
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
 * Returns true when Twilio fax is configured. Requires the same
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN used by SMS and voice, plus
 * a TWILIO_FAX_FROM_NUMBER identifying the fax-enabled Twilio number.
 */
export function isFaxConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_FAX_FROM_NUMBER?.trim(),
  );
}

/**
 * Returns the public base URL used for Twilio callbacks and the fax
 * mediaUrl. Falls back to the Replit dev domain in dev. Returns null
 * when neither is set — the caller degrades gracefully.
 */
function getFaxPublicBaseUrl(): string | null {
  const raw =
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim() ??
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : null);
  return raw ? raw.replace(/\/+$/u, "") : null;
}

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
      createdByEmail: req.adminEmail,
    })
    .returning({ id: physicianFaxOutreach.id });
  const id = inserted[0]!.id;

  let status: "pending" | "sent" | "failed" = "pending";
  let provider = "not_configured";
  let dispatchError: string | null = null;

  if (isFaxConfigured()) {
    const baseUrl = getFaxPublicBaseUrl();
    if (!baseUrl) {
      // Twilio credentials set but no public base URL — can't build
      // mediaUrl or statusCallback. Row stays pending.
      provider = "twilio_no_base_url";
    } else {
      try {
        const faxClient = createTwilioFaxClient();
        const token = signFaxDocumentToken(id);
        const mediaUrl = `${baseUrl}/fax/document/${token}`;
        const statusCallbackUrl = `${baseUrl}/fax/status-callback`;
        const fromNumber = process.env.TWILIO_FAX_FROM_NUMBER!.trim();

        const result = await faxClient.sendFax({
          to: data.physicianFaxE164,
          from: fromNumber,
          mediaUrl,
          statusCallbackUrl,
        });

        await db
          .update(physicianFaxOutreach)
          .set({
            status: "sent",
            vendorRef: result.sid,
            vendorName: "twilio",
            sentAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(physicianFaxOutreach.id, id));

        status = "sent";
        provider = "twilio";
      } catch (err) {
        const msg =
          err instanceof TwilioApiError
            ? `Twilio fax error: ${err.message}`
            : `Fax dispatch error: ${String(err)}`;
        dispatchError = msg;

        await db
          .update(physicianFaxOutreach)
          .set({
            status: "failed",
            failedAt: new Date(),
            failureReason: msg,
            updatedAt: new Date(),
          })
          .where(eq(physicianFaxOutreach.id, id));

        status = "failed";
        provider = "twilio";
        logger.warn(
          { event: "fax_dispatch_failed", outreachId: id },
          "physician_fax_outreach: Twilio dispatch failed",
        );
      }
    }
  }

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
      provider,
      status,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((auditErr: unknown) => {
    logger.warn({ err: auditErr }, "physician_fax_outreach.created audit write failed");
  });

  const response: Record<string, unknown> = { id, status, provider };
  if (dispatchError) response.dispatchError = dispatchError;
  res.status(201).json(response);
});

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

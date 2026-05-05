// /admin/physician-fax-outreach — record + query physician-fax
// Rx-renewal requests (Phase G.6 — Phase B.2 follow-up).
//
//   POST /admin/physician-fax-outreach
//        Body: { patientId, prescriptionId?, physicianName,
//                physicianFaxE164, coverLetterText }
//        Records the outreach intent and dispatches via the
//        configured fax vendor when one is wired. Returns the
//        outreach row id.
//
//   GET  /admin/physician-fax-outreach?patientId=...
//        Lists recent outreach rows for a patient. Used by the
//        patient-detail "fax history" tab.
//
// Why a separate endpoint from /admin/prescriptions/send-renewal-due:
// the email/SMS dispatcher is a bulk cron job; physician-fax is a
// CSR-initiated single action ("the patient asked us to handle this
// directly"). Different lifecycle, different actor (always 'admin'),
// different audit verb.
//
// Vendor abstraction:
// The actual fax dispatch is gated behind isFaxConfigured() — when
// no vendor env triple is wired (FAX_VENDOR / _API_KEY / _FROM), the
// row is created with status='pending' and `vendor_ref` left null.
// CSRs can see it in /admin/patients/<id>/fax-outreach as "queued
// — provider not configured" and a deployer wires the provider when
// ready. Mirrors the SendGrid/Twilio not-configured pattern.
//
// PHI / log posture:
//   * Audit envelope: outreach_id, patient_id, has_prescription,
//     cover_letter_length. Never the fax number, never the cover
//     letter body, never the physician name.

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

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const E164 = /^\+[1-9]\d{6,14}$/;

const createBody = z
  .object({
    patientId: z.string().uuid(),
    prescriptionId: z.string().uuid().nullable().optional(),
    physicianName: z.string().trim().min(1).max(120),
    physicianFaxE164: z.string().trim().regex(E164, "Fax must be E.164"),
    coverLetterText: z.string().trim().min(20).max(8000),
  })
  .strict();

const listQuery = z
  .object({
    patientId: z.string().uuid(),
  })
  .strict();

/**
 * Returns true when a fax vendor is wired. Mirrors the
 * isPushConfigured / isSmsConfigured pattern in the rest of the
 * codebase. The `FAX_VENDOR` env names a provider key (documo,
 * phaxio, srfax) that the dispatcher implementation switches on;
 * `FAX_API_KEY` and `FAX_FROM_NUMBER` are vendor-agnostic.
 *
 * Today no vendor implementation ships — this scaffold persists
 * the outreach intent so the data path is complete; a follow-up PR
 * adds the actual provider integration.
 */
export function isFaxConfigured(): boolean {
  return Boolean(
    process.env.FAX_VENDOR?.trim() &&
    process.env.FAX_API_KEY?.trim() &&
    process.env.FAX_FROM_NUMBER?.trim(),
  );
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

  // Defensive existence check on the patient — a 404 here is far
  // friendlier than a constraint-violation 500 from the FK.
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
      createdByEmail: req.adminEmail ?? null,
    })
    .returning({ id: physicianFaxOutreach.id });
  const id = inserted[0]!.id;

  // Provider wiring deferred — when isFaxConfigured() is true the
  // dispatcher would synchronously hit the vendor here, stamp
  // sent_at + vendor_ref + vendor_name, and return status='sent'.
  // Until then the row stays at 'pending' and a CSR can re-fire
  // by changing status manually (or, post-vendor, hitting a
  // /retry endpoint that won't double-bill).
  const status: "pending" | "sent" = "pending";
  const provider = isFaxConfigured()
    ? "configured_but_no_dispatcher_yet"
    : "not_configured";

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
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "physician_fax_outreach.created audit write failed");
  });

  res.status(201).json({ id, status, provider });
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

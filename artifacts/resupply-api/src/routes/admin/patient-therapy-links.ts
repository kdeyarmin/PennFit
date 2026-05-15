// /admin/patients/:id/therapy-links — durable per-patient mapping
// to a therapy-cloud account (ResMed AirView, Philips Care). The
// nightly sync worker reads from this table; admins manage the
// linkage here so a sync doesn't need a human re-typing the
// partner id every run. Companion to patient-therapy-sync.ts.
//
//   GET    /admin/patients/:id/therapy-links
//   POST   /admin/patients/:id/therapy-links
//   PATCH  /admin/patients/:id/therapy-links/:linkId
//   DELETE /admin/patients/:id/therapy-links/:linkId   (status=revoked)
//
// PHI / log posture: partner_patient_id and device_serial are
// PHI-adjacent (they map back to a real partner-side patient).
// Audit envelopes record link id + patient id + source only — not
// the partner id or device serial. Logger never sees them either.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Database,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

type TherapyLinkRow =
  Database["resupply"]["Tables"]["patient_therapy_links"]["Row"];
type TherapyLinkUpdate =
  Database["resupply"]["Tables"]["patient_therapy_links"]["Update"];

const router: IRouter = Router();

// Per-admin rate limit on therapy-link writes (B-07). Each create
// or revoke decides which patient pairs to which therapy-cloud
// account; the nightly sync worker reads from this table, so a
// scripted abuse here would mis-route every subsequent sync. 30/hour
// is plenty for legitimate CSR workflows (typically 0–5 per day per
// admin) and bounds blast radius from a compromised account. Keyed
// by adminUserId (populated by requireAdmin which runs first).
const adminTherapyLinkMutationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: "admin_patient_therapy_link_mutation",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const patientIdParam = z.string().uuid();
const linkIdParam = z.string().uuid();

const createBody = z
  .object({
    source: z.enum(["resmed_airview", "philips_care"]),
    partnerPatientId: z.string().trim().min(1).max(200),
    deviceSerial: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const updateBody = z
  .object({
    status: z.enum(["active", "paused", "revoked"]).optional(),
    deviceSerial: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => v.status !== undefined || v.deviceSerial !== undefined,
    "at least one of status, deviceSerial is required",
  );

interface LinkResponse {
  id: string;
  patientId: string;
  source: string;
  partnerPatientId: string;
  deviceSerial: string | null;
  status: string;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PgConstraintError {
  code?: string;
  constraint?: string;
  message?: string;
  details?: string;
}

function parsePgConstraintError(err: unknown): PgConstraintError {
  if (!err || typeof err !== "object") {
    return {};
  }
  const candidate = err as PgConstraintError;
  return {
    code: candidate.code,
    constraint: candidate.constraint,
    message: candidate.message,
    details: candidate.details,
  };
}

function matchesConstraint(err: PgConstraintError, name: string): boolean {
  // PostgREST exposes the constraint name in the explicit `constraint`
  // field on supabase-js v2.105+, but older releases may only stuff it
  // into the message / details strings — match either to be safe.
  if (err.constraint === name) return true;
  if (err.message?.includes(name)) return true;
  if (err.details?.includes(name)) return true;
  return false;
}

function toResponse(row: TherapyLinkRow): LinkResponse {
  return {
    id: row.id,
    patientId: row.patient_id,
    source: row.source,
    partnerPatientId: row.partner_patient_id,
    deviceSerial: row.device_serial,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncError: row.last_sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get(
  "/admin/patients/:id/therapy-links",
  // Read-only — list of partner-account mappings. `patients.read`.
  requirePermission("patients.read"),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("patient_therapy_links")
      .select(
        "id, patient_id, source, partner_patient_id, device_serial, status, last_synced_at, last_sync_status, last_sync_error, created_at, updated_at",
      )
      .eq("patient_id", patientId)
      // Active first, then by source for stable display.
      .order("status", { ascending: true })
      .order("source", { ascending: true });
    if (error) throw error;

    res.json({ links: (rows ?? []).map(toResponse) });
  },
);

router.post(
  "/admin/patients/:id/therapy-links",
  // Creates a new partner mapping — mis-routing every subsequent
  // sync. `patients.update` scope; tightens fulfillment +
  // compliance_officer.
  requirePermission("patients.update"),
  adminTherapyLinkMutationLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = createBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const { source, partnerPatientId, deviceSerial } = bodyParsed.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: existsRow, error: existsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existsRow) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_links")
      .insert({
        patient_id: patientId,
        source,
        partner_patient_id: partnerPatientId,
        device_serial: deviceSerial ?? null,
        status: "active",
      })
      .select(
        "id, patient_id, source, partner_patient_id, device_serial, status, last_synced_at, last_sync_status, last_sync_error, created_at, updated_at",
      )
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      // Partial unique on (patient_id, source) WHERE status='active'
      // and the (source, partner_patient_id) global unique both
      // surface as 23505. Distinguish by constraint name so the SPA
      // can show a useful message; default to a generic 409.
      const pgErr = parsePgConstraintError(insertErr);
      if (pgErr.code === "23505") {
        if (matchesConstraint(pgErr, "patient_therapy_links_active_unique")) {
          res.status(409).json({
            error: "active_link_exists",
            message: `Patient already has an active ${source} link. Pause or revoke it first.`,
          });
          return;
        }
        if (matchesConstraint(pgErr, "patient_therapy_links_partner_unique")) {
          res.status(409).json({
            error: "partner_id_in_use",
            message: `Another patient is already linked to this ${source} account.`,
          });
          return;
        }
        res.status(409).json({ error: "conflict" });
        return;
      }
      logger.warn(
        { db_error: pgErr, patient_id: patientId, source },
        "patient_therapy_links insert failed",
      );
      res.status(500).json({ error: "internal_error" });
      return;
    }
    if (!inserted) {
      throw new Error("insert returned no rows");
    }

    await logAudit({
      action: "patient.therapy_link.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_links",
      targetId: inserted.id,
      // Envelope: ids only. Partner id / device serial are PHI-adjacent
      // and deliberately excluded.
      metadata: {
        patient_id: patientId,
        link_id: inserted.id,
        source: inserted.source,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.therapy_link.created audit write failed");
    });

    res.status(201).json({ link: toResponse(inserted) });
  },
);

router.patch(
  "/admin/patients/:id/therapy-links/:linkId",
  requirePermission("patients.update"),
  adminTherapyLinkMutationLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    const linkCheck = linkIdParam.safeParse(req.params.linkId);
    if (!idCheck.success || !linkCheck.success) {
      res.status(404).json({ error: "link_not_found" });
      return;
    }
    const patientId = idCheck.data;
    const linkId = linkCheck.data;

    const bodyParsed = updateBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: bodyParsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();

    const patch: TherapyLinkUpdate = {};
    if (bodyParsed.data.status !== undefined) {
      patch.status = bodyParsed.data.status;
    }
    if (bodyParsed.data.deviceSerial !== undefined) {
      patch.device_serial = bodyParsed.data.deviceSerial;
    }

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_links")
      .update(patch)
      .eq("id", linkId)
      .eq("patient_id", patientId)
      .select(
        "id, patient_id, source, partner_patient_id, device_serial, status, last_synced_at, last_sync_status, last_sync_error, created_at, updated_at",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) {
      const pgErr = parsePgConstraintError(updateErr);
      if (
        pgErr.code === "23505" &&
        matchesConstraint(pgErr, "patient_therapy_links_active_unique")
      ) {
        // Trying to flip a paused/revoked row back to active when an
        // active row already exists.
        res.status(409).json({
          error: "active_link_exists",
          message: "Patient already has an active link for this source.",
        });
        return;
      }
      logger.warn(
        { db_error: pgErr, patient_id: patientId, link_id: linkId },
        "patient_therapy_links update failed",
      );
      res.status(500).json({ error: "internal_error" });
      return;
    }

    if (!updated) {
      res.status(404).json({ error: "link_not_found" });
      return;
    }

    await logAudit({
      action: "patient.therapy_link.updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_links",
      targetId: updated.id,
      metadata: {
        patient_id: patientId,
        link_id: updated.id,
        source: updated.source,
        // Surface only which fields were changed (not new partner id
        // values) to keep the audit trail useful but PHI-clean.
        changed_fields: Object.keys(patch),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.therapy_link.updated audit write failed");
    });

    res.json({ link: toResponse(updated) });
  },
);

router.delete(
  "/admin/patients/:id/therapy-links/:linkId",
  requirePermission("patients.update"),
  adminTherapyLinkMutationLimiter,
  async (req, res) => {
    // DELETE is a soft-revoke (status='revoked') so the audit
    // trail of "patient was linked to AirView between X and Y"
    // survives. Hard delete only happens on cascade from
    // patients ON DELETE CASCADE.
    const idCheck = patientIdParam.safeParse(req.params.id);
    const linkCheck = linkIdParam.safeParse(req.params.linkId);
    if (!idCheck.success || !linkCheck.success) {
      res.status(404).json({ error: "link_not_found" });
      return;
    }
    const patientId = idCheck.data;
    const linkId = linkCheck.data;

    const supabase = getSupabaseServiceRoleClient();

    const { data: updated, error: updateErr } = await supabase
      .schema("resupply")
      .from("patient_therapy_links")
      .update({ status: "revoked" })
      .eq("id", linkId)
      .eq("patient_id", patientId)
      .select(
        "id, patient_id, source, partner_patient_id, device_serial, status, last_synced_at, last_sync_status, last_sync_error, created_at, updated_at",
      )
      .limit(1)
      .maybeSingle();
    if (updateErr) throw updateErr;

    if (!updated) {
      res.status(404).json({ error: "link_not_found" });
      return;
    }

    await logAudit({
      action: "patient.therapy_link.revoked",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_links",
      targetId: updated.id,
      metadata: {
        patient_id: patientId,
        link_id: updated.id,
        source: updated.source,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.therapy_link.revoked audit write failed");
    });

    res.json({ link: toResponse(updated) });
  },
);

export default router;

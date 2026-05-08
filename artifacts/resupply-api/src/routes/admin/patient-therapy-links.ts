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

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patients,
  patientTherapyLinks,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

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
}

function parsePgConstraintError(err: unknown): PgConstraintError {
  if (!err || typeof err !== "object") {
    return {};
  }
  const candidate = err as PgConstraintError;
  return {
    code: candidate.code,
    constraint: candidate.constraint,
  };
}

function toResponse(row: {
  id: string;
  patientId: string;
  source: string;
  partnerPatientId: string;
  deviceSerial: string | null;
  status: string;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): LinkResponse {
  return {
    id: row.id,
    patientId: row.patientId,
    source: row.source,
    partnerPatientId: row.partnerPatientId,
    deviceSerial: row.deviceSerial,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get(
  "/admin/patients/:id/therapy-links",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const db = drizzle(getDbPool());
    const rows = await db
      .select()
      .from(patientTherapyLinks)
      .where(eq(patientTherapyLinks.patientId, patientId))
      // Active first, then by source for stable display.
      .orderBy(asc(patientTherapyLinks.status), asc(patientTherapyLinks.source));

    res.json({ links: rows.map(toResponse) });
  },
);

router.post(
  "/admin/patients/:id/therapy-links",
  requireAdmin,
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

    const db = drizzle(getDbPool());

    const exists = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.id, patientId))
      .limit(1);
    if (exists.length === 0) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    let inserted: typeof patientTherapyLinks.$inferSelect;
    try {
      const rows = await db
        .insert(patientTherapyLinks)
        .values({
          patientId,
          source,
          partnerPatientId,
          deviceSerial: deviceSerial ?? null,
          status: "active",
        })
        .returning();
      const row = rows[0];
      if (!row) {
        // Should be impossible — INSERT … RETURNING * always returns
        // the row on success.
        throw new Error("insert returned no rows");
      }
      inserted = row;
    } catch (err) {
      // Partial unique on (patient_id, source) WHERE status='active'
      // and the (source, partner_patient_id) global unique both
      // surface as 23505. Distinguish by constraint name so the SPA
      // can show a useful message; default to a generic 409.
      const pgErr = parsePgConstraintError(err);
      if (pgErr?.code === "23505") {
        if (pgErr.constraint === "patient_therapy_links_active_unique") {
          res.status(409).json({
            error: "active_link_exists",
            message: `Patient already has an active ${source} link. Pause or revoke it first.`,
          });
          return;
        }
        if (pgErr.constraint === "patient_therapy_links_partner_unique") {
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
  requireAdmin,
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

    const db = drizzle(getDbPool());

    const patch: Partial<typeof patientTherapyLinks.$inferInsert> = {};
    if (bodyParsed.data.status !== undefined) {
      patch.status = bodyParsed.data.status;
    }
    if (bodyParsed.data.deviceSerial !== undefined) {
      patch.deviceSerial = bodyParsed.data.deviceSerial;
    }

    let updated: typeof patientTherapyLinks.$inferSelect | undefined;
    try {
      const rows = await db
        .update(patientTherapyLinks)
        .set(patch)
        .where(
          and(
            eq(patientTherapyLinks.id, linkId),
            eq(patientTherapyLinks.patientId, patientId),
          ),
        )
        .returning();
      updated = rows[0];
    } catch (err) {
      const pgErr = parsePgConstraintError(err);
      if (
        pgErr?.code === "23505" &&
        pgErr.constraint === "patient_therapy_links_active_unique"
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
  requireAdmin,
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

    const db = drizzle(getDbPool());

    const rows = await db
      .update(patientTherapyLinks)
      .set({ status: "revoked" })
      .where(
        and(
          eq(patientTherapyLinks.id, linkId),
          eq(patientTherapyLinks.patientId, patientId),
        ),
      )
      .returning();
    const updated = rows[0];

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

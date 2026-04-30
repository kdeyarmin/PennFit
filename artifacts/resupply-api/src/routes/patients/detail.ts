// GET /patients/:id — full patient detail for the admin console.
//
// Returns the patient header (decrypted name; phone/email surfaced
// only as boolean reachability flags) plus, in one round-trip per
// related table:
//   * all prescriptions
//   * all episodes (denormalising the prescription's itemSku for
//     display so the patient detail tab doesn't need a second
//     table reference)
//   * the 10 most recent conversations (no message bodies — those
//     come from /conversations/:id)
//   * the 10 most recent fulfillments
//
// Writes one `patient.view` audit row with the patient id as
// target. This is a PHI read, so it is auditable per ADR; we do
// not include the decrypted name in metadata (the metadata
// sanitiser would drop it anyway, but it costs nothing to be
// explicit at the call site).

import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  conversations,
  decrypt,
  episodes,
  fulfillments,
  getDbPool,
  patientLatestMessage,
  patients,
  prescriptions,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get("/patients/:id", requireAdmin, async (req, res) => {
  const parsed = idParam.safeParse(req.params);
  if (!parsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { id } = parsed.data;

  const db = drizzle(getDbPool());

  // Detail header LEFT JOINs the latest-message projection so the
  // patient header strip can show "last contacted" without a
  // separate /messages query. Same encryption-on-the-wire treatment
  // as patients/list — decrypt() is the only path through which the
  // bytea preview leaves Postgres.
  const patientRows = await db
    .select({
      id: patients.id,
      pacwareId: patients.pacwareId,
      firstName: decrypt(patients.legalFirstName),
      lastName: decrypt(patients.legalLastName),
      status: patients.status,
      hasPhone: sql<boolean>`(${patients.phoneE164} IS NOT NULL)`,
      hasEmail: sql<boolean>`(${patients.email} IS NOT NULL)`,
      // Admin-editable settings the new dashboard panel reads/writes
      // via PATCH /patients/:id. All three are nullable: NULL means
      // "no override / fall back to global rules / fall back to legacy
      // SMS-then-email selection".
      insurancePayer: patients.insurancePayer,
      cadenceOverrideDays: patients.cadenceOverrideDays,
      channelPreference: patients.channelPreference,
      createdAt: patients.createdAt,
      updatedAt: patients.updatedAt,
      lastMessageAt: patientLatestMessage.lastMessageAt,
      lastMessageDirection: patientLatestMessage.lastMessageDirection,
      lastMessagePreview: decrypt(patientLatestMessage.lastMessagePreview),
    })
    .from(patients)
    .leftJoin(
      patientLatestMessage,
      eq(patientLatestMessage.patientId, patients.id),
    )
    .where(eq(patients.id, id))
    .limit(1);

  const patient = patientRows[0];
  if (!patient) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const prescriptionRows = await db
    .select({
      id: prescriptions.id,
      itemSku: prescriptions.itemSku,
      cadenceDays: prescriptions.cadenceDays,
      validFrom: prescriptions.validFrom,
      validUntil: prescriptions.validUntil,
      status: prescriptions.status,
      createdAt: prescriptions.createdAt,
      // Attachment metadata. We only forward the bounded technical
      // fields the dashboard needs to render the "Document attached"
      // chip + download link — the actual object key is intentionally
      // NOT exposed here. Downloads go through the dedicated GET
      // endpoint which is admin-gated and audit-logged on every hit.
      attachmentFilename: prescriptions.attachmentFilename,
      attachmentContentType: prescriptions.attachmentContentType,
      attachmentSizeBytes: prescriptions.attachmentSizeBytes,
      attachmentUploadedAt: prescriptions.attachmentUploadedAt,
    })
    .from(prescriptions)
    .where(eq(prescriptions.patientId, id))
    .orderBy(desc(prescriptions.createdAt));

  const episodeRows = await db
    .select({
      id: episodes.id,
      prescriptionId: episodes.prescriptionId,
      itemSku: prescriptions.itemSku,
      status: episodes.status,
      dueAt: episodes.dueAt,
      expiresAt: episodes.expiresAt,
      createdAt: episodes.createdAt,
    })
    .from(episodes)
    .leftJoin(prescriptions, eq(prescriptions.id, episodes.prescriptionId))
    .where(eq(episodes.patientId, id))
    .orderBy(desc(episodes.createdAt));

  const conversationRows = await db
    .select({
      id: conversations.id,
      episodeId: conversations.episodeId,
      channel: conversations.channel,
      status: conversations.status,
      lastMessageAt: conversations.lastMessageAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.patientId, id))
    .orderBy(desc(conversations.createdAt))
    .limit(10);

  const fulfillmentRows = await db
    .select({
      id: fulfillments.id,
      episodeId: fulfillments.episodeId,
      itemSku: fulfillments.itemSku,
      quantity: fulfillments.quantity,
      status: fulfillments.status,
      pacwareOrderRef: fulfillments.pacwareOrderRef,
      submittedAt: fulfillments.submittedAt,
      shippedAt: fulfillments.shippedAt,
      deliveredAt: fulfillments.deliveredAt,
      createdAt: fulfillments.createdAt,
    })
    .from(fulfillments)
    .where(eq(fulfillments.patientId, id))
    .orderBy(desc(fulfillments.createdAt))
    .limit(10);

  const toIso = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return String(v);
  };
  const toIsoRequired = (v: unknown): string => {
    const out = toIso(v);
    return out ?? new Date(0).toISOString();
  };

  try {
    await logAudit({
      action: "patient.view",
      adminEmail: req.adminEmail ?? null,
      adminClerkId: req.adminClerkId ?? null,
      targetTable: "patients",
      targetId: id,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { source: "console" },
    });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? { name: err.name, message: err.message } : err },
      "patients.detail: audit write failed",
    );
  }

  res.status(200).json({
    id: patient.id,
    pacwareId: patient.pacwareId,
    firstName: patient.firstName ?? "",
    lastName: patient.lastName ?? "",
    status: patient.status,
    hasPhone: Boolean(patient.hasPhone),
    hasEmail: Boolean(patient.hasEmail),
    insurancePayer: patient.insurancePayer,
    cadenceOverrideDays: patient.cadenceOverrideDays,
    channelPreference: patient.channelPreference,
    createdAt: toIsoRequired(patient.createdAt),
    updatedAt: toIsoRequired(patient.updatedAt),
    lastMessageAt: toIso(patient.lastMessageAt),
    lastMessageDirection: patient.lastMessageDirection ?? null,
    lastMessagePreview: patient.lastMessagePreview ?? null,
    prescriptions: prescriptionRows.map((p) => ({
      id: p.id,
      itemSku: p.itemSku,
      cadenceDays: p.cadenceDays,
      // drizzle's `date()` column returns the value as a
      // `YYYY-MM-DD` string by default (no `mode: "date"`), so we
      // forward it as-is. Defensive String() in case a future
      // mode change yields a Date.
      validFrom:
        typeof p.validFrom === "string"
          ? p.validFrom
          : String(p.validFrom),
      validUntil:
        p.validUntil == null
          ? null
          : typeof p.validUntil === "string"
            ? p.validUntil
            : String(p.validUntil),
      status: p.status,
      createdAt: toIsoRequired(p.createdAt),
      // Forward the bounded attachment metadata. The dashboard uses
      // `attachmentFilename` truthiness to switch between "Attach"
      // and "Download/Remove" UI states; the other three fields are
      // for display only. Object key is intentionally NOT forwarded.
      attachmentFilename: p.attachmentFilename,
      attachmentContentType: p.attachmentContentType,
      attachmentSizeBytes: p.attachmentSizeBytes,
      attachmentUploadedAt: toIso(p.attachmentUploadedAt),
    })),
    episodes: episodeRows.map((e) => ({
      id: e.id,
      prescriptionId: e.prescriptionId,
      itemSku: e.itemSku ?? "",
      status: e.status,
      dueAt: toIsoRequired(e.dueAt),
      expiresAt: toIso(e.expiresAt),
      createdAt: toIsoRequired(e.createdAt),
    })),
    conversations: conversationRows.map((c) => ({
      id: c.id,
      episodeId: c.episodeId,
      channel: c.channel,
      status: c.status,
      lastMessageAt: toIso(c.lastMessageAt),
      createdAt: toIsoRequired(c.createdAt),
    })),
    fulfillments: fulfillmentRows.map((f) => ({
      id: f.id,
      episodeId: f.episodeId,
      itemSku: f.itemSku,
      quantity: f.quantity,
      status: f.status,
      pacwareOrderRef: f.pacwareOrderRef,
      submittedAt: toIso(f.submittedAt),
      shippedAt: toIso(f.shippedAt),
      deliveredAt: toIso(f.deliveredAt),
      createdAt: toIsoRequired(f.createdAt),
    })),
  });
});

export default router;

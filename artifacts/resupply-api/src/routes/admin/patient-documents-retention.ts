// /admin/patient-documents/retention/* — compliance surface for the
// HIPAA retention sweep.
//
//   GET    /admin/patient-documents/retention?bucket=...
//   POST   /admin/patient-documents/:id/legal-hold
//          body: { hold: boolean, reason: string }
//   POST   /admin/patient-documents/:id/destroy
//          body: { confirm: string }   // must equal "DESTROY"
//
// All three gate behind `audit.export` (admin / supervisor /
// compliance_officer per the rbac catalog). The destroy path
// requires admin-only — bytes-erasure is a one-way action, the
// supervisor role can review but not pull the trigger.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { bucketRetention } from "../../lib/patient-documents/retention";
import {
  requireAdminOnly,
  requirePermission,
} from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  bucket: z
    .enum(["due_now", "due_soon", "marked", "legal_hold", "destroyed"])
    .optional(),
});

const holdBody = z
  .object({
    hold: z.boolean(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const destroyBody = z
  .object({
    confirm: z.literal("DESTROY"),
  })
  .strict();

// ────────────────────────────────────────────────────────────────
// GET — list patient documents that need compliance attention.
// Default surfaces "due_now" + "marked" (the actionable queue);
// optional ?bucket=... narrows to a single bucket.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/patient-documents/retention",
  requirePermission("audit.export"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const wantBucket = parsed.data.bucket;
    const supabase = getSupabaseServiceRoleClient();

    // Pull a bounded page. The retention queue is supposed to be
    // small (rows accumulate slowly; a deploy-day's worth fits in
    // a few hundred). Hard cap to keep the response bounded even
    // pathologically.
    let query = supabase
      .schema("resupply")
      .from("patient_documents")
      .select(
        "id, patient_id, document_type, filename, content_type, size_bytes, retention_until_at, legal_hold, retention_marked_at, destroyed_at, destroyed_by_admin_id, created_at",
      )
      .order("retention_until_at", { ascending: true, nullsFirst: false })
      .limit(500);

    // Cheap server-side narrow: when caller asks for a specific
    // bucket we can push the dominant predicate to PostgREST.
    if (wantBucket === "destroyed") {
      query = query.not("destroyed_at", "is", null);
    } else if (wantBucket === "legal_hold") {
      query = query.eq("legal_hold", true).is("destroyed_at", null);
    } else if (wantBucket === "marked") {
      query = query
        .not("retention_marked_at", "is", null)
        .is("destroyed_at", null);
    } else if (wantBucket === "due_now" || wantBucket === "due_soon") {
      // For "due" buckets we let the client-side bucketize tag the
      // rows; server filter keeps unrelated rows out.
      query = query
        .is("destroyed_at", null)
        .eq("legal_hold", false)
        .is("retention_marked_at", null)
        .not("retention_until_at", "is", null);
    } else {
      // Default surface: actionable queue = due_now ∪ marked.
      query = query.is("destroyed_at", null).eq("legal_hold", false);
    }

    const { data, error } = await query;
    if (error) throw error;

    const asOfDate = new Date();
    const rows = (data ?? []).map((r) => ({
      id: r.id,
      patientId: r.patient_id,
      documentType: r.document_type,
      filename: r.filename,
      contentType: r.content_type,
      sizeBytes: r.size_bytes,
      createdAt: r.created_at,
      retentionUntilAt: r.retention_until_at,
      legalHold: r.legal_hold,
      retentionMarkedAt: r.retention_marked_at,
      destroyedAt: r.destroyed_at,
      bucket: bucketRetention({
        retentionUntilAt: r.retention_until_at,
        retentionMarkedAt: r.retention_marked_at,
        destroyedAt: r.destroyed_at,
        legalHold: r.legal_hold,
        asOfDate,
      }),
    }));

    // For the default surface (no explicit bucket), drop rows
    // that aren't actually actionable — e.g. legacy rows with
    // retention_until_at still null bucketize as "active" and
    // shouldn't clutter the queue.
    const filtered =
      wantBucket == null
        ? rows.filter(
            (r) => r.bucket === "due_now" || r.bucket === "due_soon",
          )
        : wantBucket === "due_now"
          ? rows.filter((r) => r.bucket === "due_now")
          : wantBucket === "due_soon"
            ? rows.filter((r) => r.bucket === "due_soon")
            : rows;

    res.json({ count: filtered.length, documents: filtered });
  },
);

// ────────────────────────────────────────────────────────────────
// POST .../legal-hold — toggle the legal_hold flag.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/patient-documents/:id/legal-hold",
  requirePermission("audit.export"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = holdBody.safeParse(req.body);
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
    const supabase = getSupabaseServiceRoleClient();
    const { data: prior, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select("id, legal_hold, destroyed_at, patient_id")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!prior) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (prior.destroyed_at != null) {
      res.status(409).json({
        error: "destroyed",
        message: "Cannot change legal hold on an already-destroyed document.",
      });
      return;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .update({ legal_hold: parsed.data.hold })
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: parsed.data.hold
        ? "patient_documents.legal_hold.applied"
        : "patient_documents.legal_hold.released",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: params.data.id,
      metadata: {
        patient_id: prior.patient_id,
        reason: parsed.data.reason,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_documents.legal_hold audit failed");
    });

    res.json({ ok: true, legalHold: parsed.data.hold });
  },
);

// ────────────────────────────────────────────────────────────────
// POST .../destroy — erase the underlying object + clear object_key.
// Admin-only (one-way action). The row stays for audit; only the
// PHI bytes are gone.
//
// We deliberately do NOT delete the object from GCS in this route —
// object lifecycle is a separate concern with its own infra. The
// row's `object_key` is cleared and `destroyed_at` is stamped; a
// follow-up object-storage sweep will hard-delete the orphaned
// blob on its own schedule.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/patient-documents/:id/destroy",
  requireAdminOnly,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = destroyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "Body must include {\"confirm\":\"DESTROY\"} — a deliberate confirmation guard.",
      });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: prior, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .select(
        "id, patient_id, document_type, legal_hold, destroyed_at, object_key, retention_marked_at, retention_until_at",
      )
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!prior) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (prior.destroyed_at != null) {
      res.status(409).json({
        error: "already_destroyed",
        message: "This document has already been destroyed.",
      });
      return;
    }
    if (prior.legal_hold) {
      res.status(409).json({
        error: "legal_hold",
        message:
          "This document is on legal hold and cannot be destroyed. Release the hold first.",
      });
      return;
    }
    // Require that the retention sweep has already flagged the row
    // — otherwise an admin could destroy a freshly-uploaded
    // document by hand. Defense in depth.
    if (prior.retention_marked_at == null) {
      res.status(409).json({
        error: "not_marked",
        message:
          "Retention sweep hasn't flagged this row yet; destruction requires a marked row.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("patient_documents")
      .update({
        destroyed_at: nowIso,
        destroyed_by_admin_id: req.adminUserId ?? null,
        // Bytes-pointer cleared so any subsequent download attempt
        // 404s. The blob itself is cleaned up by a separate
        // object-storage sweep (deferred).
        object_key: "",
      })
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "patient_documents.destroyed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_documents",
      targetId: params.data.id,
      metadata: {
        patient_id: prior.patient_id,
        document_type: prior.document_type,
        retention_until_at: prior.retention_until_at,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient_documents.destroyed audit failed");
    });

    res.json({ ok: true, destroyedAt: nowIso });
  },
);

export default router;

// /admin/patients/:id/onboarding — first-90-day adherence-coaching
// program enrollment + read endpoints (Phase B.1 / feature #17).
// Plus /admin/onboarding/send-due — multi-channel dispatcher that
// fires the next due check-in (email + SMS + automated voice) for
// every active journey whose next step is overdue.
//
//   GET    /admin/patients/:id/onboarding                — read
//   POST   /admin/patients/:id/onboarding/enroll          — enroll
//   PATCH  /admin/patients/:id/onboarding/status         — pause/resume
//   POST   /admin/onboarding/send-due                     — dispatcher
//
// Dispatcher pattern: synchronous response summarizing what was
// scanned + sent. CSRs hit "Run now" from /admin/operations OR the
// in-process pg-boss cron fires it daily.
//
// PHI / log posture: patient name + email on the row are required by
// the vendors for the actual send, but the audit envelope records
// only patient_id + day_label + channel + outcome — never message
// body, never phone/email plaintext.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { dispatchDueCheckins } from "../../lib/checkin-dispatcher";
import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rateLimit } from "../../middlewares/rate-limit";

// Per-admin write rate limits (B-07). All three limiters key by
// adminUserId so a compromised account's blast radius is capped
// without affecting other staff.
const adminEnrollLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  name: "admin_onboarding_enroll",
  keyFn: (req) => req.adminUserId ?? "unknown",
});
const adminSendDueLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  name: "admin_onboarding_send_due",
  keyFn: (req) => req.adminUserId ?? "unknown",
});

const router: IRouter = Router();

const patientIdParam = z.string().uuid();

const enrollBody = z
  .object({
    /** ISO 8601 date when the patient started therapy. Defaults to
     *  now if omitted (most enrollments happen at machine setup). */
    startedAt: z.string().datetime().optional(),
  })
  .strict();

const statusBody = z
  .object({
    status: z.enum(["active", "paused"]),
  })
  .strict();

router.get("/admin/patients/:id/onboarding", requireAdmin, async (req, res) => {
  const idCheck = patientIdParam.safeParse(req.params.id);
  if (!idCheck.success) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  const patientId = idCheck.data;

  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("patient_onboarding_journeys")
    .select(
      "id, started_at, day1_sent_at, day3_sent_at, day7_sent_at, day30_sent_at, day60_sent_at, day90_sent_at, status, enrolled_by_email, created_at",
    )
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!row) {
    res.json({ journey: null });
    return;
  }
  res.json({
    journey: {
      id: row.id,
      // PostgREST returns timestamptz as ISO string already.
      startedAt: row.started_at,
      day1SentAt: row.day1_sent_at,
      day3SentAt: row.day3_sent_at,
      day7SentAt: row.day7_sent_at,
      day30SentAt: row.day30_sent_at,
      day60SentAt: row.day60_sent_at,
      day90SentAt: row.day90_sent_at,
      status: row.status,
      enrolledByEmail: row.enrolled_by_email,
      createdAt: row.created_at,
    },
  });
});

router.post(
  "/admin/patients/:id/onboarding/enroll",
  requireAdmin,
  adminEnrollLimiter,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = enrollBody.safeParse(req.body ?? {});
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
    const startedAtIso = bodyParsed.data.startedAt
      ? bodyParsed.data.startedAt
      : new Date().toISOString();

    const supabase = getSupabaseServiceRoleClient();

    // Patient existence + open-journey precheck run in parallel.
    const [existsRes, openRes] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("id")
        .eq("id", patientId)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("patient_onboarding_journeys")
        .select("id")
        .eq("patient_id", patientId)
        .eq("status", "active")
        .limit(1)
        .maybeSingle(),
    ]);
    if (existsRes.error) throw existsRes.error;
    if (openRes.error) throw openRes.error;
    if (!existsRes.data) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // Defense: refuse a second active row. The partial unique index
    // would also catch this but a clean 409 reads better than a raw
    // constraint violation.
    if (openRes.data) {
      res.status(409).json({
        error: "already_enrolled",
        journeyId: openRes.data.id,
      });
      return;
    }

    const { data: row, error: insertErr } = await supabase
      .schema("resupply")
      .from("patient_onboarding_journeys")
      .insert({
        patient_id: patientId,
        started_at: startedAtIso,
        enrolled_by_email: req.adminEmail ?? "<unknown>",
        enrolled_by_user_id: req.adminUserId ?? null,
      })
      .select("id, started_at")
      .limit(1)
      .maybeSingle();
    if (insertErr) {
      // Concurrent request beat us to it — the partial unique index on
      // (patient_id) WHERE status='active' fired. Return the same 409
      // the pre-check above would have returned.
      if ((insertErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "already_enrolled" });
        return;
      }
      throw insertErr;
    }
    if (!row) {
      throw new Error("INSERT returned no rows");
    }

    await logAudit({
      action: "patient.onboarding.enroll",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_onboarding_journeys",
      targetId: row.id,
      metadata: {
        patient_id: patientId,
        started_at: row.started_at,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.onboarding.enroll audit write failed");
    });

    res.status(201).json({
      id: row.id,
      startedAt: row.started_at,
    });
  },
);

router.patch(
  "/admin/patients/:id/onboarding/status",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const bodyParsed = statusBody.safeParse(req.body);
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
    const { data: row, error: lookupErr } = await supabase
      .schema("resupply")
      .from("patient_onboarding_journeys")
      .select("id, status")
      .eq("patient_id", patientId)
      .limit(1)
      .maybeSingle();
    if (lookupErr) throw lookupErr;
    if (!row) {
      res.status(404).json({ error: "journey_not_found" });
      return;
    }
    if (row.status === "completed") {
      res.status(409).json({ error: "already_completed" });
      return;
    }

    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("patient_onboarding_journeys")
      .update({
        status: bodyParsed.data.status,
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (updateErr) throw updateErr;

    await logAudit({
      action:
        bodyParsed.data.status === "paused"
          ? "patient.onboarding.pause"
          : "patient.onboarding.resume",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_onboarding_journeys",
      targetId: row.id,
      metadata: { patient_id: patientId },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.onboarding.status audit write failed");
    });

    res.json({ id: row.id, status: bodyParsed.data.status });
  },
);

router.post(
  "/admin/onboarding/send-due",
  requireAdmin,
  adminSendDueLimiter,
  async (req, res) => {
    const summary = await dispatchDueCheckins({
      actor: {
        kind: "admin",
        email: req.adminEmail ?? null,
        userId: req.adminUserId ?? null,
      },
    });
    res.json(summary);
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/patients/:id/onboarding/attempts — per-checkpoint
// dispatch log. Drives the "tried email at 09:02 (vendor_error),
// then SMS at 09:03 (sent)" trail an admin sees on the patient-
// detail Onboarding tab.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/patients/:id/onboarding/attempts",
  requireAdmin,
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: journey, error: jErr } = await supabase
      .schema("resupply")
      .from("patient_onboarding_journeys")
      .select("id")
      .eq("patient_id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (jErr) throw jErr;
    if (!journey) {
      res.json({ attempts: [] });
      return;
    }
    const { data: rows, error: aErr } = await supabase
      .schema("resupply")
      .from("patient_checkin_attempts")
      .select(
        "id, day_label, channel, outcome, vendor_ref, error_code, attempted_at",
      )
      .eq("journey_id", journey.id)
      .order("attempted_at", { ascending: false })
      .limit(200);
    if (aErr) throw aErr;
    res.json({
      attempts: (rows ?? []).map((r) => ({
        id: r.id,
        dayLabel: r.day_label,
        channel: r.channel,
        outcome: r.outcome,
        vendorRef: r.vendor_ref,
        errorCode: r.error_code,
        attemptedAt: r.attempted_at,
      })),
    });
  },
);

export default router;

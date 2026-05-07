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

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientOnboardingJourneys,
  patients,
} from "@workspace/resupply-db";

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

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: patientOnboardingJourneys.id,
      startedAt: patientOnboardingJourneys.startedAt,
      day1SentAt: patientOnboardingJourneys.day1SentAt,
      day3SentAt: patientOnboardingJourneys.day3SentAt,
      day7SentAt: patientOnboardingJourneys.day7SentAt,
      day30SentAt: patientOnboardingJourneys.day30SentAt,
      day60SentAt: patientOnboardingJourneys.day60SentAt,
      day90SentAt: patientOnboardingJourneys.day90SentAt,
      status: patientOnboardingJourneys.status,
      enrolledByEmail: patientOnboardingJourneys.enrolledByEmail,
      createdAt: patientOnboardingJourneys.createdAt,
    })
    .from(patientOnboardingJourneys)
    .where(eq(patientOnboardingJourneys.patientId, patientId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    res.json({ journey: null });
    return;
  }
  res.json({
    journey: {
      id: row.id,
      startedAt: row.startedAt.toISOString(),
      day1SentAt: row.day1SentAt?.toISOString() ?? null,
      day3SentAt: row.day3SentAt?.toISOString() ?? null,
      day7SentAt: row.day7SentAt?.toISOString() ?? null,
      day30SentAt: row.day30SentAt?.toISOString() ?? null,
      day60SentAt: row.day60SentAt?.toISOString() ?? null,
      day90SentAt: row.day90SentAt?.toISOString() ?? null,
      status: row.status,
      enrolledByEmail: row.enrolledByEmail,
      createdAt: row.createdAt.toISOString(),
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
    const startedAt = bodyParsed.data.startedAt
      ? new Date(bodyParsed.data.startedAt)
      : new Date();

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

    // Defense: refuse a second active row. The partial unique index
    // would also catch this but a clean 409 reads better than a
    // raw constraint violation surfacing from drizzle.
    const open = await db
      .select({ id: patientOnboardingJourneys.id })
      .from(patientOnboardingJourneys)
      .where(
        and(
          eq(patientOnboardingJourneys.patientId, patientId),
          eq(patientOnboardingJourneys.status, "active"),
        ),
      )
      .limit(1);
    if (open[0]) {
      res.status(409).json({
        error: "already_enrolled",
        journeyId: open[0].id,
      });
      return;
    }

    let inserted: { id: string; startedAt: Date }[];
    try {
      inserted = await db
        .insert(patientOnboardingJourneys)
        .values({
          patientId,
          startedAt,
          enrolledByEmail: req.adminEmail ?? "<unknown>",
          enrolledByUserId: req.adminUserId ?? null,
        })
        .returning({
          id: patientOnboardingJourneys.id,
          startedAt: patientOnboardingJourneys.startedAt,
        });
    } catch (err) {
      // Concurrent request beat us to it — the partial unique index on
      // (patient_id) WHERE status='active' fired. Return the same 409
      // the pre-check above would have returned rather than bubbling
      // the raw constraint violation as a 500.
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "23505") {
        res.status(409).json({ error: "already_enrolled" });
        return;
      }
      throw err;
    }
    const row = inserted[0];
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
        started_at: row.startedAt.toISOString(),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.onboarding.enroll audit write failed");
    });

    res.status(201).json({
      id: row.id,
      startedAt: row.startedAt.toISOString(),
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

    const db = drizzle(getDbPool());
    const rows = await db
      .select({
        id: patientOnboardingJourneys.id,
        status: patientOnboardingJourneys.status,
      })
      .from(patientOnboardingJourneys)
      .where(eq(patientOnboardingJourneys.patientId, patientId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "journey_not_found" });
      return;
    }
    if (row.status === "completed") {
      res.status(409).json({ error: "already_completed" });
      return;
    }

    const now = new Date();
    await db
      .update(patientOnboardingJourneys)
      .set({ status: bodyParsed.data.status, updatedAt: now })
      .where(eq(patientOnboardingJourneys.id, row.id));

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
      pool: getDbPool(),
      actor: {
        kind: "admin",
        email: req.adminEmail ?? null,
        userId: req.adminUserId ?? null,
      },
    });
    res.json(summary);
  },
);

export default router;

// /admin/patients/:id/onboarding — first-90-day adherence-coaching
// program enrollment + read endpoints (Phase B.1 / feature #17).
// Plus /admin/onboarding/send-due — dispatcher that fires the next
// due check-in via SendGrid for every active journey whose next
// step is overdue.
//
//   GET    /admin/patients/:id/onboarding                — read
//   POST   /admin/patients/:id/onboarding/enroll          — enroll
//   PATCH  /admin/patients/:id/onboarding/status         — pause/resume
//   POST   /admin/onboarding/send-due                     — dispatcher
//
// Dispatcher pattern matches abandoned-carts: synchronous response
// summarizing what was scanned + sent, no background queue. CSRs
// hit "Run now" from /admin/operations OR the deployer wires a
// pg-boss cron that POSTs to this endpoint.
//
// PHI / log posture: patient name + email on the row are required
// by SendGrid for the actual send, but the audit envelope records
// only patient_id + day_label — never message body.

import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  ONBOARDING_DAYS,
  patientOnboardingJourneys,
  patients,
  type OnboardingDayLabel,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";

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
      day7SentAt: patientOnboardingJourneys.day7SentAt,
      day30SentAt: patientOnboardingJourneys.day30SentAt,
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
      day7SentAt: row.day7SentAt?.toISOString() ?? null,
      day30SentAt: row.day30SentAt?.toISOString() ?? null,
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

    const inserted = await db
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

router.post("/admin/onboarding/send-due", requireAdmin, adminSendDueLimiter, async (req, res) => {
  const db = drizzle(getDbPool());
  const now = new Date();
  const cap = 50;

  // Fetch active journeys joined with patient email + first name.
  // The dispatcher only needs rows where SOME check-in is due —
  // we filter in JS rather than a clever WHERE because the joined
  // row count is bounded by ACTIVE journeys (small) and the
  // per-day-due math reads more clearly in TypeScript.
  const rows = await db
    .select({
      journeyId: patientOnboardingJourneys.id,
      patientId: patientOnboardingJourneys.patientId,
      startedAt: patientOnboardingJourneys.startedAt,
      day1SentAt: patientOnboardingJourneys.day1SentAt,
      day7SentAt: patientOnboardingJourneys.day7SentAt,
      day30SentAt: patientOnboardingJourneys.day30SentAt,
      day90SentAt: patientOnboardingJourneys.day90SentAt,
      firstName: patients.legalFirstName,
      email: patients.email,
    })
    .from(patientOnboardingJourneys)
    .innerJoin(patients, eq(patients.id, patientOnboardingJourneys.patientId))
    .where(eq(patientOnboardingJourneys.status, "active"))
    .limit(500);

  // SendGrid client up-front: any config error becomes a clean 503
  // before we touch the per-row loop.
  let sg: ReturnType<typeof createSendgridClient>;
  try {
    sg = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      res.status(503).json({
        error: "email_not_configured",
        message: "SendGrid is not configured on this server.",
      });
      return;
    }
    throw err;
  }

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skippedNoEmail = 0;
  const completed: string[] = [];

  for (const row of rows) {
    if (attempted >= cap) break;
    const next = nextDueCheckin(
      row.startedAt,
      {
        day1: row.day1SentAt,
        day7: row.day7SentAt,
        day30: row.day30SentAt,
        day90: row.day90SentAt,
      },
      now,
    );
    if (!next) continue;
    attempted++;
    if (!row.email) {
      skippedNoEmail++;
      continue;
    }
    const greeting = row.firstName
      ? `Hi ${row.firstName.split(/\s+/)[0]}`
      : "Hi";
    try {
      await sg.sendEmail({
        to: row.email,
        subject: subjectForDay(next),
        text: textBodyForDay(next, greeting),
        html: htmlBodyForDay(next, greeting),
        customArgs: {
          kind: "onboarding_checkin",
          day: next,
        },
      });
      // Stamp on success. Race with another concurrent dispatcher
      // is acceptable — at worst the customer gets two copies of
      // the same check-in, and the second stamp is a no-op.
      const stampField = stampFieldForDay(next);
      await db
        .update(patientOnboardingJourneys)
        .set({
          [stampField]: now,
          updatedAt: now,
          // Day-90 transitions the journey to completed.
          ...(next === "day90" ? { status: "completed" } : {}),
        })
        .where(
          and(
            eq(patientOnboardingJourneys.id, row.journeyId),
            isNull(
              patientOnboardingJourneys[
                stampField as keyof typeof patientOnboardingJourneys
              ] as never,
            ),
          ),
        );
      if (next === "day90") completed.push(row.journeyId);

      await logAudit({
        action: "patient.onboarding.checkin_sent",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patient_onboarding_journeys",
        targetId: row.journeyId,
        metadata: {
          patient_id: row.patientId,
          day_label: next,
          channel: "email",
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "patient.onboarding.checkin_sent audit write failed",
        );
      });

      if (next === "day90") {
        await logAudit({
          action: "patient.onboarding.complete",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "patient_onboarding_journeys",
          targetId: row.journeyId,
          metadata: { patient_id: row.patientId },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        }).catch((err) => {
          logger.warn(
            { err },
            "patient.onboarding.complete audit write failed",
          );
        });
      }
      sent++;
    } catch (err) {
      failed++;
      logger.warn(
        { err, journey_id: row.journeyId, day_label: next },
        "onboarding check-in send failed",
      );
    }
  }

  res.json({
    attempted,
    sent,
    failed,
    skippedNoEmail,
    completedJourneys: completed.length,
    remaining: rows.length > attempted ? rows.length - attempted : 0,
  });
});

function nextDueCheckin(
  startedAt: Date,
  sent: Record<OnboardingDayLabel, Date | null>,
  now: Date,
): OnboardingDayLabel | null {
  const startedMs = startedAt.getTime();
  for (const { label, offsetDays } of ONBOARDING_DAYS) {
    if (sent[label]) continue;
    const dueAt = startedMs + offsetDays * 24 * 60 * 60 * 1000;
    if (now.getTime() >= dueAt) return label;
    // Future entries are not yet due; nothing later in the cadence
    // can be due before this one, so bail.
    return null;
  }
  return null;
}

function stampFieldForDay(label: OnboardingDayLabel): string {
  switch (label) {
    case "day1":
      return "day1SentAt";
    case "day7":
      return "day7SentAt";
    case "day30":
      return "day30SentAt";
    case "day90":
      return "day90SentAt";
  }
}

function subjectForDay(label: OnboardingDayLabel): string {
  switch (label) {
    case "day1":
      return "Welcome to therapy — quick day-1 tips";
    case "day7":
      return "How's your first week going?";
    case "day30":
      return "30 days in — here's what helps most";
    case "day90":
      return "90-day check-in from PennPaps";
  }
}

function textBodyForDay(label: OnboardingDayLabel, greeting: string): string {
  // Plain-text bodies are intentionally short — older patients read
  // the first paragraph and act. The HTML version below carries the
  // tip detail.
  switch (label) {
    case "day1":
      return `${greeting},\n\nYou started therapy yesterday. The single biggest predictor of long-term success is wearing your mask every night this week, even if it feels strange at first.\n\nCommon day-1 issues:\n* Mask leaks at the corners → tighten the lower headgear strap first.\n* Air feels too strong → look for a "ramp" button on the machine; it ramps up over 20 minutes.\n* Dry mouth → if your machine has a humidifier, set it to 3 and adjust from there.\n\nReply to this email if anything is uncomfortable. We answer within a business day.\n\n— PennPaps customer service\n`;
    case "day7":
      return `${greeting},\n\nA week in. Most patients hit at least one comfort issue by day 7 — common ones are mask seal at the corner of the mouth, ramp pressure feeling too low, and waking up with a dry mouth.\n\nQuick triage:\n1. Refit the mask while the machine is running (so you can hear leaks).\n2. Bump humidifier one notch.\n3. If the ramp is too short, lengthen it from the menu.\n\nIf you'd rather talk to a human, reply to this email.\n\n— PennPaps customer service\n`;
    case "day30":
      return `${greeting},\n\n30 days in. By now you've felt the better-rest payoff — and you might be due for a fresh cushion. Cushion seal degrades over the first month and replacing it makes the next month dramatically easier.\n\nIf you have insurance through us, your replacement is already eligible. Reply YES and we'll ship a fresh one.\n\n— PennPaps customer service\n`;
    case "day90":
      return `${greeting},\n\nYou've made it to 90 days — the threshold most patients miss. Insurance now considers you adherent and most plans renew supply eligibility automatically.\n\nWe'll keep an eye on your supply schedule and ship replacements before they're due. If you've been struggling, reply to this email and we'll set up a call with one of our therapists.\n\n— PennPaps customer service\n`;
  }
}

function htmlBodyForDay(label: OnboardingDayLabel, greeting: string): string {
  // Identical structure across all four days; only the heading +
  // body paragraphs differ. We escape `greeting` minimally because
  // it comes from a CSV-imported patient record (potentially
  // attacker-controlled in a hostile-import scenario).
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const heading = subjectForDay(label);
  const paragraphs = textBodyForDay(label, safeGreeting)
    .split("\n\n")
    .map(
      (p) =>
        `<p style="margin:0 0 12px;font-size:14px;line-height:1.55;color:#0a1f44;">${p
          .replace(/[<>&]/g, "")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; background: #f8fafc; padding: 24px;">
  <table cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;border:1px solid #e2e8f0;">
    <tr><td style="padding:24px;">
      <h2 style="margin:0 0 16px;color:#0a1f44;font-size:18px;">${heading}</h2>
      ${paragraphs}
    </td></tr>
  </table>
</body></html>`;
}

export default router;

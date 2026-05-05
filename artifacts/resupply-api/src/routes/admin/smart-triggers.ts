// /admin/smart-triggers — data-driven reorder-trigger evaluator +
// dispatcher (Phase E.2 / feature #19). Reads patient_therapy_nights,
// runs the rule library, inserts proposals into
// patient_smart_trigger_events, then sends an email per detected
// event. Mirrors the other dispatcher patterns (Phase B.1 onboarding,
// Phase B.2 Rx renewal): synchronous, capped, summary response.
//
//   POST /admin/smart-triggers/evaluate
//        — scan therapy data, insert any new pending events.
//          Idempotent: the partial-unique active index prevents
//          re-firing while an existing event is pending or sent.
//   POST /admin/smart-triggers/send-due
//        — email pending events; stamp sent_at on success.
//   POST /admin/smart-triggers/:id/dismiss
//        — CSR manually clears a false-positive or
//          customer-requested mute.
//
// Email content is intentionally short — the data-driven version
// converts at 3-5x the rate of calendar-only nudges per the brief,
// and the conversion comes from the SPECIFICITY of the message,
// not its length.
//
// PHI / log posture: nightly therapy data is PHI. The audit
// envelope records patient_id + kind + window dates only — never
// the leak rate / AHI / usage values that drove detection.

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getDbPool,
  patientSmartTriggerEvents,
  patientTherapyNights,
  patients,
} from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { evaluateAll, type TriggerKind } from "../../lib/smart-triggers";
import { logger } from "../../lib/logger";
import { sendPushToCustomerByEmail } from "../../lib/web-push";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const triggerIdParam = z.string().uuid();
const dismissBody = z
  .object({
    reason: z.string().trim().max(500).optional().nullable(),
  })
  .strict();

/** Per-evaluator-run cap to keep response time bounded. */
const PER_RUN_PATIENT_CAP = 200;
/** Per-dispatcher-run cap on emails. */
const PER_RUN_SEND_CAP = 50;

router.post(
  "/admin/smart-triggers/evaluate",
  requireAdmin,
  async (req, res) => {
    const db = drizzle(getDbPool());

    // Fetch the recent therapy-night roster — patients with at
    // least one night in the last 60 days are candidates. The full
    // night history within that window comes per-patient below.
    const candidates = await db
      .selectDistinct({ patientId: patientTherapyNights.patientId })
      .from(patientTherapyNights)
      .where(
        sql`${patientTherapyNights.nightDate}::timestamptz >= now() - interval '60 days'`,
      )
      .limit(PER_RUN_PATIENT_CAP);

    let scanned = 0;
    let proposed = 0;
    let inserted = 0;
    let skippedExisting = 0;

    for (const c of candidates) {
      scanned++;
      const nights = await db
        .select({
          date: patientTherapyNights.nightDate,
          usageMinutes: patientTherapyNights.usageMinutes,
          ahi: patientTherapyNights.ahi,
          leakRateLMin: patientTherapyNights.leakRateLMin,
          pressureP95Cmh2o: patientTherapyNights.pressureP95Cmh2o,
        })
        .from(patientTherapyNights)
        .where(eq(patientTherapyNights.patientId, c.patientId))
        .orderBy(asc(patientTherapyNights.nightDate))
        .limit(60);

      const proposals = evaluateAll(
        nights.map((n) => ({
          date: n.date,
          usageMinutes: n.usageMinutes,
          ahi: n.ahi !== null ? Number(n.ahi) : null,
          leakRateLMin: n.leakRateLMin !== null ? Number(n.leakRateLMin) : null,
          pressureP95Cmh2o:
            n.pressureP95Cmh2o !== null ? Number(n.pressureP95Cmh2o) : null,
        })),
      );

      for (const p of proposals) {
        proposed++;
        // Insert; the partial-unique index on (patient, kind) WHERE
        // dismissed_at IS NULL ensures we don't double-fire while a
        // prior event is still pending. ON CONFLICT DO NOTHING is
        // the cleanest way to skip silently.
        const result = await db
          .insert(patientSmartTriggerEvents)
          .values({
            patientId: c.patientId,
            kind: p.kind,
            windowStartDate: p.windowStartDate,
            windowEndDate: p.windowEndDate,
          })
          .onConflictDoNothing()
          .returning({ id: patientSmartTriggerEvents.id });

        if (result.length > 0) {
          inserted++;
          await logAudit({
            action: "patient.smart_trigger.detected",
            adminEmail: req.adminEmail ?? null,
            adminUserId: req.adminUserId ?? null,
            targetTable: "patient_smart_trigger_events",
            targetId: result[0]!.id,
            metadata: {
              patient_id: c.patientId,
              kind: p.kind,
              window_start: p.windowStartDate,
              window_end: p.windowEndDate,
            },
            ip: req.ip ?? null,
            userAgent: req.get("user-agent") ?? null,
          }).catch((err) => {
            logger.warn(
              { err },
              "patient.smart_trigger.detected audit write failed",
            );
          });
        } else {
          skippedExisting++;
        }
      }
    }

    res.json({ scanned, proposed, inserted, skippedExisting });
  },
);

const sendDueChannelQuery = z.enum(["email", "sms"]).default("email");

router.post(
  "/admin/smart-triggers/send-due",
  requireAdmin,
  async (req, res) => {
    const channelParse = sendDueChannelQuery.safeParse(
      req.query.channel ?? "email",
    );
    if (!channelParse.success) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    const channel = channelParse.data;

    const db = drizzle(getDbPool());

    const rows = await db
      .select({
        eventId: patientSmartTriggerEvents.id,
        patientId: patientSmartTriggerEvents.patientId,
        kind: patientSmartTriggerEvents.kind,
        windowStartDate: patientSmartTriggerEvents.windowStartDate,
        windowEndDate: patientSmartTriggerEvents.windowEndDate,
        firstName: patients.legalFirstName,
        email: patients.email,
        phoneE164: patients.phoneE164,
      })
      .from(patientSmartTriggerEvents)
      .innerJoin(patients, eq(patients.id, patientSmartTriggerEvents.patientId))
      .where(
        and(
          isNull(patientSmartTriggerEvents.sentAt),
          isNull(patientSmartTriggerEvents.dismissedAt),
        ),
      )
      .orderBy(asc(patientSmartTriggerEvents.detectedAt))
      .limit(PER_RUN_SEND_CAP * 2);

    // Per-channel client construction. Mirrors the pattern in
    // /admin/prescriptions/send-renewal-due (Phase G.3): an SMS-channel
    // run never touches SendGrid and vice-versa, so a missing-on-one-
    // side env doesn't 503 the other.
    let sg: ReturnType<typeof createSendgridClient> | null = null;
    let sms: ReturnType<typeof createTwilioSmsClient> | null = null;
    if (channel === "email") {
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
    } else {
      try {
        sms = createTwilioSmsClient();
      } catch (err) {
        if (err instanceof TwilioConfigError) {
          res.status(503).json({
            error: "sms_not_configured",
            message: "Twilio Messaging is not configured on this server.",
          });
          return;
        }
        throw err;
      }
    }

    let attempted = 0;
    let sent = 0;
    let failed = 0;
    let skippedNoContact = 0;
    const now = new Date();

    for (const row of rows) {
      if (attempted >= PER_RUN_SEND_CAP) break;
      attempted++;
      const contact = channel === "email" ? row.email : row.phoneE164;
      if (!contact) {
        skippedNoContact++;
        continue;
      }
      const firstName = row.firstName
        ? (row.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
        : "";
      const greeting = firstName ? `Hi ${firstName}` : "Hi";
      try {
        if (channel === "email") {
          await sg!.sendEmail({
            to: contact,
            subject: subjectForKind(row.kind as TriggerKind),
            text: textBody(greeting, row.kind as TriggerKind),
            html: htmlBody(greeting, row.kind as TriggerKind),
            customArgs: {
              kind: "smart_trigger",
              trigger_kind: row.kind,
              event_id: row.eventId,
            },
          });
        } else {
          await sms!.sendSms({
            to: contact,
            body: smsBody(firstName, row.kind as TriggerKind),
          });
        }

        await db
          .update(patientSmartTriggerEvents)
          .set({ sentAt: now, updatedAt: now })
          .where(
            and(
              eq(patientSmartTriggerEvents.id, row.eventId),
              isNull(patientSmartTriggerEvents.sentAt),
            ),
          );

        await logAudit({
          action: "patient.smart_trigger.sent",
          adminEmail: req.adminEmail ?? null,
          adminUserId: req.adminUserId ?? null,
          targetTable: "patient_smart_trigger_events",
          targetId: row.eventId,
          metadata: {
            patient_id: row.patientId,
            kind: row.kind,
            channel,
          },
          ip: req.ip ?? null,
          userAgent: req.get("user-agent") ?? null,
        }).catch((err) => {
          logger.warn({ err }, "patient.smart_trigger.sent audit write failed");
        });

        // Phase G.8 — additionally fan out to any push subscriptions
        // belonging to a shop_customer whose email_lower matches the
        // patient's email. Best-effort: a push misconfig or no
        // matching customer can never roll back the email/SMS that
        // already went out. Same PHI posture as the SPA's insights
        // surface — title and body name no PHI, just the trigger
        // copy. URL deep-links to /account/insights so the customer
        // sees the same headline and CTA they'd see in the SPA.
        if (row.email) {
          void sendPushToCustomerByEmail(row.email, {
            title: subjectForKind(row.kind as TriggerKind),
            body: pushBody(row.kind as TriggerKind),
            url: "/account/insights",
            tag: `smart_trigger:${row.eventId}`,
          }).catch((err) => {
            logger.warn(
              {
                event_id: row.eventId,
                err: err instanceof Error ? err.message : String(err),
              },
              "smart-trigger push fan-out threw (non-fatal)",
            );
          });
        }

        sent++;
      } catch (err) {
        failed++;
        logger.warn(
          { err, event_id: row.eventId, channel },
          "smart-trigger send failed",
        );
      }
    }

    res.json({
      attempted,
      sent,
      failed,
      // Backwards-compatible: the original endpoint returned this key
      // for the email channel.
      ...(channel === "email"
        ? { skippedNoEmail: skippedNoContact }
        : { skippedNoPhone: skippedNoContact }),
      skippedNoContact,
      remaining: rows.length > attempted ? rows.length - attempted : 0,
      channel,
    });
  },
);

router.post(
  "/admin/smart-triggers/:id/dismiss",
  requireAdmin,
  async (req, res) => {
    const idParsed = triggerIdParam.safeParse(req.params.id);
    if (!idParsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const id = idParsed.data;

    const bodyParsed = dismissBody.safeParse(req.body ?? {});
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
        id: patientSmartTriggerEvents.id,
        patientId: patientSmartTriggerEvents.patientId,
        kind: patientSmartTriggerEvents.kind,
        dismissedAt: patientSmartTriggerEvents.dismissedAt,
      })
      .from(patientSmartTriggerEvents)
      .where(eq(patientSmartTriggerEvents.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: "trigger_not_found" });
      return;
    }
    if (row.dismissedAt !== null) {
      res.status(409).json({ error: "already_dismissed" });
      return;
    }

    const now = new Date();
    await db
      .update(patientSmartTriggerEvents)
      .set({
        dismissedAt: now,
        dismissedByEmail: req.adminEmail ?? null,
        dismissedReason: bodyParsed.data.reason ?? null,
        updatedAt: now,
      })
      .where(eq(patientSmartTriggerEvents.id, id));

    await logAudit({
      action: "patient.smart_trigger.dismissed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_smart_trigger_events",
      targetId: id,
      metadata: {
        patient_id: row.patientId,
        kind: row.kind,
        // length-only — operator's free-form reason isn't logged
        // verbatim so audit-log search can't surface PHI-adjacent
        // commentary.
        reason_length: bodyParsed.data.reason?.length ?? 0,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "patient.smart_trigger.dismissed audit write failed",
      );
    });

    res.json({ id, dismissedAt: now.toISOString() });
  },
);

function subjectForKind(kind: TriggerKind): string {
  switch (kind) {
    case "leak_rising":
      return "Your CPAP mask seal may need attention";
    case "usage_dropping":
      return "We noticed a few harder nights — anything we can help with?";
    case "cushion_wear":
      return "Your mask cushion may be wearing out";
    case "humidifier_drop":
      return "Time to refresh your tubing?";
  }
}

function textBody(greeting: string, kind: TriggerKind): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  switch (kind) {
    case "leak_rising":
      return `${safeGreeting},\n\nYour mask leak rate has trended up over the last two weeks. The most common cause is a worn cushion seal — replacing it usually solves it overnight. If your insurance is on file, a replacement is already eligible.\n\nReply YES and we'll ship a fresh one. Or sign in at https://pennpaps.com/account to review options.\n\n— Penn Home Medical Supply\n`;
    case "usage_dropping":
      return `${safeGreeting},\n\nWe noticed your therapy hours have dropped over the last couple of weeks. That's the most common point where patients quietly stop using CPAP — and it's also the one where small changes (mask refit, ramp tweak, humidifier nudge) make the biggest difference.\n\nReply to this email and we'll set up a quick call. No charge, no pressure.\n\n— Penn Home Medical Supply\n`;
    case "cushion_wear":
      return `${safeGreeting},\n\nYour AHI and leak rate have both ticked up over the last two weeks — usually a sign your mask cushion is at the end of its life. A replacement cushion takes about 5 minutes to swap and typically clears both readings.\n\nReply YES to ship a fresh cushion (no charge if you're on insurance through us).\n\n— Penn Home Medical Supply\n`;
    case "humidifier_drop":
      return `${safeGreeting},\n\nWith warmer weather your tubing may be due for a refresh — older tubing collects condensation and reduces airflow, which can make therapy feel less comfortable in the summer.\n\nReply YES and we'll ship a fresh hose.\n\n— Penn Home Medical Supply\n`;
  }
}

function htmlBody(greeting: string, kind: TriggerKind): string {
  const safeGreeting = greeting.replace(/[<>&]/g, "");
  const heading = subjectForKind(kind);
  const paragraphs = textBody(safeGreeting, kind)
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

/**
 * Render the SMS body for a smart-trigger nudge. Kept under 160
 * ASCII chars so the message ships as one Twilio segment in the
 * typical case (firstName + status + CTA). STOP keyword is included
 * so Twilio's opt-out compliance surface stays intact.
 *
 * Why short: SMS conversion drops sharply at multi-segment length;
 * the patient is one tap from "reply YES" so the body just needs to
 * carry the trigger reason and the CTA, not the long explanation
 * the email body uses.
 */
/**
 * Push-notification body. Short — push notifications get
 * truncated aggressively on iOS/Android lock screens (≈ 110
 * chars). Different from the SMS variant (no STOP keyword;
 * already gated by the customer's browser permission) and
 * different from the email body (which can sustain a paragraph
 * of context). Keep copy generic to avoid exposing PHI in
 * lock-screen banners.
 */
function pushBody(kind: TriggerKind): string {
  switch (kind) {
    case "leak_rising":
      return "We noticed a change in your therapy. Tap to review your update.";
    case "usage_dropping":
      return "Your care team has a helpful therapy update for you.";
    case "cushion_wear":
      return "You may be due for a supply refresh. Tap to review your options.";
    case "humidifier_drop":
      return "You may be due for a supply refresh. Tap to review your options.";
  }
}

function smsBody(firstName: string, kind: TriggerKind): string {
  const head = firstName ? `Hi ${firstName}` : "Hi";
  switch (kind) {
    case "leak_rising":
      return `${head}, your CPAP leak rate has trended up — usually means a worn cushion. Reply YES to ship a replacement, or STOP to opt out. — Penn Home`;
    case "usage_dropping":
      return `${head}, we noticed your therapy hours dropped lately. Small adjustments help. Reply YES for a quick check-in call, or STOP to opt out. — Penn Home`;
    case "cushion_wear":
      return `${head}, your AHI + leak rate are both up — usually a worn cushion. Reply YES to ship a fresh one, or STOP to opt out. — Penn Home`;
    case "humidifier_drop":
      return `${head}, your tubing may be due for a refresh. Reply YES to ship a fresh hose, or STOP to opt out. — Penn Home`;
  }
}

export default router;

// /admin/prescriptions/send-renewal-due — prescription concierge
// dispatcher (Phase B.2 / feature #7, SMS variant Phase G.3, daily
// pg-boss cron Phase G.15).
//
//   POST /admin/prescriptions/send-renewal-due[?channel=email|sms]
//
// Scans active prescriptions whose `valid_until` falls inside the
// renewal window (default: next 30 days), filters out rows we've
// already nudged, and contacts the patient asking them to coordinate
// renewal with their prescribing physician.
//
// Two channels share the same `renewal_requested_at` stamp so a
// patient never gets nudged twice across email + SMS for the same
// renewal cycle.
//
// PHI / log posture: patient name + email/phone are required by the
// vendor for the actual send. The audit envelope records
// prescription_id + patient_id + days_until_expiry + channel only —
// never the prescriber's notes blob, never the SKU label, never the
// SMS body or phone number.
//
// The dispatcher body (DB scan + per-row send + audit + push fan-out)
// lives in lib/rx-renewal/dispatcher.ts so the daily pg-boss cron
// (Phase G.15) and this route share the same code path.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { runRxRenewalSendDue } from "../../lib/rx-renewal/dispatcher";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const channelQuery = z.enum(["email", "sms"]).default("email");

router.post(
  "/admin/prescriptions/send-renewal-due",
  requireAdmin,
  async (req, res) => {
    const channelParse = channelQuery.safeParse(req.query.channel);
    if (!channelParse.success) {
      res.status(400).json({ error: "invalid_channel" });
      return;
    }
    const channel = channelParse.data;

    const outcome = await runRxRenewalSendDue(channel, {
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    if (outcome.status === "not_configured") {
      res.status(503).json({
        error:
          channel === "email" ? "email_not_configured" : "sms_not_configured",
        message:
          channel === "email"
            ? "SendGrid is not configured on this server."
            : "Twilio Messaging is not configured on this server.",
      });
      return;
    }

    const { attempted, sent, failed, skippedNoContact, remaining, windowDays } =
      outcome;
    res.json({
      attempted,
      sent,
      failed,
      // Backwards-compatible: the original endpoint returned this key.
      // We keep it on the email channel, alias to the new key on SMS,
      // and expose the channel-neutral key on both.
      ...(channel === "email"
        ? { skippedNoEmail: skippedNoContact }
        : { skippedNoPhone: skippedNoContact }),
      skippedNoContact,
      remaining,
      windowDays,
      channel,
    });
  },
);


export default router;

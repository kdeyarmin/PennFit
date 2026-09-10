import { Router, type IRouter } from "express";
import { z } from "zod";
import { hasLinkHmacKey } from "@workspace/resupply-secrets";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  adminRateLimit,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { checkCsrOutreach } from "../../lib/resupply/csr-outreach";
import {
  readSmsConfigOrNull,
  readEmailConfigOrNull,
} from "../../lib/messaging/messaging-config";
import {
  applyTenantEmailSender,
  isPatientEmailClickBaseReady,
} from "../../lib/email/apply-tenant-email-sender";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import { getBoss } from "../../worker/index";
import {
  isWithinQuietHours,
  SEND_SMS_JOB,
  SEND_EMAIL_JOB,
} from "../../worker/jobs/reminders";
import { SEND_VOICE_JOB } from "../../worker/jobs/reminder-voice";

const router: IRouter = Router();
const body = z
  .object({
    episodeIds: z.array(z.string().uuid()).min(1).max(50),
    channel: z.enum(["sms", "email", "voice"]),
  })
  .strict();
router.post(
  "/admin/resupply-outreach",
  adminWriteRateLimiter,
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "resupply_outreach", preset: "mutation" }),
  async (req, res) => {
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    if (!req.orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const orgId = req.orgId;
    const { channel, episodeIds } = parsed.data;
    const boss = getBoss();
    if (!boss) {
      res.status(503).json({
        error: "queue_unavailable",
        message: "Outreach is temporarily unavailable. Try again shortly.",
      });
      return;
    }
    const voice = channel === "voice" ? readVoiceConfigOrNull() : null;
    const email = channel === "email" ? readEmailConfigOrNull() : null;
    const configured =
      channel === "voice"
        ? Boolean(voice?.twilioPhoneNumber)
        : hasLinkHmacKey() &&
          Boolean(channel === "sms" ? readSmsConfigOrNull() : email);
    if (!configured) {
      res.status(503).json({
        error: "channel_not_configured",
        message: `The ${channel} service is not configured.`,
      });
      return;
    }
    if (email) {
      const cfg = await applyTenantEmailSender(orgId, {
        ...email,
        practiceName: "",
      });
      if (!isPatientEmailClickBaseReady(cfg.publicBaseUrl)) {
        res.status(422).json({ error: "tenant_domain_required" });
        return;
      }
    }
    const queue =
      channel === "sms"
        ? SEND_SMS_JOB
        : channel === "email"
          ? SEND_EMAIL_JOB
          : SEND_VOICE_JOB;
    const results: {
      episodeId: string;
      status: "queued" | "skipped" | "error";
      message: string;
    }[] = [];
    const patients = new Set<string>();
    for (const episodeId of new Set(episodeIds)) {
      try {
        const check = await checkCsrOutreach(orgId, episodeId, channel);
        let reason = check.reason;
        if (
          !reason &&
          channel !== "email" &&
          isWithinQuietHours(new Date(), check.timezone!)
        )
          reason =
            "Outside the patient's contact hours. Try again during their local daytime.";
        if (!reason && patients.has(check.patientId!))
          reason = "Patient already included in this batch.";
        if (reason) {
          results.push({ episodeId, status: "skipped", message: reason });
          continue;
        }
        patients.add(check.patientId!);
        const job = await boss.send(
          queue,
          {
            orgId,
            patientId: check.patientId,
            episodeId,
            variant: "initial",
            csrRequested: true,
          },
          {
            singletonKey: `csr-resupply:${orgId}:${check.patientId}`,
            singletonSeconds: 48 * 3600,
          },
        );
        results.push({
          episodeId,
          status: job ? "queued" : "skipped",
          message: job
            ? "Queued for outreach. Delivery and replies appear in Conversations."
            : "Patient already has outreach queued for this channel.",
        });
      } catch {
        // Earlier successes stay visible even if a later lookup/enqueue fails.
        results.push({
          episodeId,
          status: "error",
          message:
            "Could not verify or queue this patient. Review before retrying.",
        });
      }
    }
    res.json({ results });
  },
);
export default router;

// /admin/message-previews — "what does the patient actually receive?"
//
//   GET  /admin/message-previews            — the whole catalog, rendered
//                                             for THIS tenant's brand
//   POST /admin/message-previews/:id/send   — deliver one of them, for real,
//                                             to an address/number the
//                                             operator types
//
// Why this exists: the outbound copy is spread across ~66 send paths, so
// nobody could see the patient's-eye view of the product without triggering
// real events against a real patient. This renders every scenario from the
// shared catalog with a fictional sample patient, and lets staff send one
// to themselves to check how it lands in a real Messages app or inbox.
//
// Send safety
// -----------
//   * The body is NOT caller-supplied. The operator picks a catalog id;
//     the copy comes from the catalog. This endpoint cannot be used to
//     send arbitrary text to anyone.
//   * The sample patient is obviously fictional ("Jordan Alvarez"), so a
//     mis-typed recipient receives something clearly not about them, and
//     every SMS carries the STOP footer the production copy already has.
//   * One recipient per call, write-rate-limited, behind
//     `requirePermission("admin.tools.manage")` — the same gate the
//     message-template library uses.
//   * The tenant's OWN sender identity is used (G6), so a test also
//     verifies the From address/number the patient would actually see.
//
// This is the same posture as /platform/connection-tests, which likewise
// performs a real vendor round-trip to an operator-supplied recipient.
//
// PHI: none. The catalog renders fictional sample data by construction.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  DEFAULT_SENDGRID_FROM_EMAIL,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { getCompanyInfo } from "../../lib/company-info";
import { logger } from "../../lib/logger";
import {
  buildMessagePreviews,
  findMessagePreview,
  type PreviewBrand,
} from "../../lib/message-previews/catalog";
import {
  createTenantSendgridClient,
  resolveTenantSender,
} from "../../lib/email/tenant-sender";
import {
  resolveTenantSmsClientOptions,
  resolveTenantSmsFrom,
} from "../../lib/messaging/tenant-telecom";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/** Resolve the brand values every preview renders against. */
async function previewBrand(orgId: string | undefined): Promise<PreviewBrand> {
  const [branding, company, baseUrl] = await Promise.all([
    resolveBrandingByOrgId(orgId),
    getCompanyInfo(orgId),
    resolveTenantBaseUrl(orgId),
  ]);
  return {
    brandName: branding.storefrontName,
    // The reminder worker brands its messages with getCompanyInfo().name,
    // which a tenant can configure independently of the storefront name.
    companyName: company.name,
    legalName: company.legalName,
    supportPhoneDisplay: company.supportPhoneDisplay,
    supportEmail: company.supportEmail,
    baseUrl: baseUrl ?? "https://cmbreathe.com",
  };
}

/**
 * Can this tenant actually send a test right now, and from what identity?
 *
 * The page asks staff to type their own phone/email, so telling them up
 * front that a channel is unconfigured beats letting them type an address
 * and get a failure back. "Configured" is probed by CONSTRUCTING the
 * vendor client, because that is exactly where both clients throw their
 * config error — an env-var check here would drift from the real rule.
 * Nothing is sent by the probe.
 */
async function sendingReadiness(orgId: string | undefined): Promise<{
  email: { configured: boolean; from: string | null };
  sms: { configured: boolean; from: string | null };
}> {
  const email = await (async () => {
    try {
      await createTenantSendgridClient(orgId);
      const sender = await resolveTenantSender(orgId);
      return {
        configured: true,
        from:
          sender.fromEmail ??
          process.env.SENDGRID_FROM_EMAIL?.trim() ??
          DEFAULT_SENDGRID_FROM_EMAIL,
      };
    } catch (err) {
      if (err instanceof EmailConfigError) {
        return { configured: false, from: null };
      }
      throw err;
    }
  })();

  const sms = await (async () => {
    try {
      const opts = await resolveTenantSmsClientOptions(orgId);
      createTwilioSmsClient(opts);
      const tenant = await resolveTenantSmsFrom(orgId);
      return {
        configured: true,
        // A Messaging Service has no single display number; say so rather
        // than showing a platform number the patient would not see.
        from:
          tenant.from ??
          (tenant.messagingServiceSid
            ? "Messaging Service"
            : (process.env.TWILIO_PHONE_NUMBER?.trim() ?? null)),
      };
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        return { configured: false, from: null };
      }
      throw err;
    }
  })();

  return { email, sms };
}

// ── GET /admin/message-previews ─────────────────────────────────────

router.get(
  "/admin/message-previews",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res): Promise<void> => {
    try {
      const brand = await previewBrand(req.orgId);
      const sending = await sendingReadiness(req.orgId);
      res.json({
        sending,
        brand: {
          name: brand.brandName,
          companyName: brand.companyName,
          legalName: brand.legalName,
          supportPhoneDisplay: brand.supportPhoneDisplay,
          baseUrl: brand.baseUrl,
        },
        previews: buildMessagePreviews(brand),
      });
    } catch (err) {
      logger.error(
        { event: "message_previews_render_failed", err },
        "message-previews: render failed",
      );
      res.status(500).json({ error: "preview_render_failed" });
    }
  },
);

// ── POST /admin/message-previews/:id/send ───────────────────────────

const sendBody = z
  .object({
    channel: z.enum(["email", "sms"]),
    /** Where to deliver the test. Exactly one, matching `channel`. */
    to: z.string().trim().min(1).max(254),
  })
  .strict();

/** Loose E.164 shape — the vendor does the real validation. */
const E164 = /^\+[1-9]\d{7,14}$/;

router.post(
  "/admin/message-previews/:id/send",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res): Promise<void> => {
    const parsed = sendBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const { channel, to } = parsed.data;

    const brand = await previewBrand(req.orgId);
    const preview = findMessagePreview(brand, String(req.params.id));
    if (!preview) {
      res.status(404).json({ error: "unknown_preview" });
      return;
    }

    if (channel === "email") {
      const email = preview.email;
      if (!email) {
        res.status(400).json({ error: "no_email_variant" });
        return;
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
        res.status(400).json({ error: "invalid_email" });
        return;
      }
      try {
        const client = await createTenantSendgridClient(req.orgId);
        await client.sendEmail({
          to,
          subject: email.subject,
          html: email.html,
          text: email.text,
        });
      } catch (err) {
        if (err instanceof EmailConfigError) {
          // Not an error in the request — email simply isn't wired up here.
          res.json({
            ok: false,
            channel,
            code: "not_configured",
            message:
              "Email sending is not configured for this deployment. Set the SendGrid credentials under Global integrations.",
          });
          return;
        }
        logger.warn(
          { event: "message_preview_email_send_failed", err, id: preview.id },
          "message-previews: test email send failed",
        );
        res.json({
          ok: false,
          channel,
          code: "upstream_error",
          message: "The email provider rejected the send.",
        });
        return;
      }
      logger.info(
        { event: "message_preview_sent", id: preview.id, channel },
        "message-previews: test email sent",
      );
      res.json({ ok: true, channel, id: preview.id });
      return;
    }

    // ── SMS ───────────────────────────────────────────────────────
    const sms = preview.sms;
    if (!sms) {
      res.status(400).json({ error: "no_sms_variant" });
      return;
    }
    if (!E164.test(to)) {
      res.status(400).json({ error: "invalid_phone" });
      return;
    }
    // Assigned by the try below; every catch path returns, so it is
    // definitely assigned by the time it is read.
    let confirmation: {
      terminal: boolean;
      delivered: boolean;
      status: string;
      errorCode: number | string | null;
      errorMessage: string | null;
    };
    try {
      const client = createTwilioSmsClient(
        await resolveTenantSmsClientOptions(req.orgId),
      );
      const { messageSid } = await client.sendSms({ to, body: sms.body });
      // Twilio ACCEPTING a message is not the same as a handset receiving
      // it — a landline, an unreachable number, or a carrier block all
      // accept then fail. Since the whole point here is "did it actually
      // arrive on my phone", poll briefly for the terminal state instead
      // of reporting success on acceptance.
      confirmation = await client.confirmDelivery(messageSid);
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        res.json({
          ok: false,
          channel,
          code: "not_configured",
          message:
            "SMS sending is not configured for this deployment. Set the Twilio credentials under Global integrations.",
        });
        return;
      }
      logger.warn(
        { event: "message_preview_sms_send_failed", err, id: preview.id },
        "message-previews: test SMS send failed",
      );
      res.json({
        ok: false,
        channel,
        code: "upstream_error",
        message: "The SMS provider rejected the send.",
      });
      return;
    }
    // A carrier rejection is a real failure the operator must see, even
    // though the API call itself succeeded.
    if (confirmation.terminal && !confirmation.delivered) {
      logger.warn(
        {
          event: "message_preview_sms_undelivered",
          id: preview.id,
          status: confirmation.status,
          errorCode: confirmation.errorCode,
        },
        "message-previews: test SMS was accepted but not delivered",
      );
      res.json({
        ok: false,
        channel,
        code: "undelivered",
        message:
          confirmation.errorMessage ??
          `The carrier reported "${confirmation.status}". Check the number can receive texts (a landline or VoIP line often can't).`,
      });
      return;
    }
    logger.info(
      { event: "message_preview_sent", id: preview.id, channel },
      "message-previews: test SMS sent",
    );
    res.json({
      ok: true,
      channel,
      id: preview.id,
      segments: sms.segments,
      // `false` here means Twilio accepted it but no terminal state came
      // back inside the poll window — it is probably still in flight.
      delivered: confirmation.delivered,
      deliveryStatus: confirmation.status,
    });
  },
);

export default router;

// /admin/patients/:id/payment-link — staff-initiated patient payment link.
//
// A CSR / biller sends a patient a hosted Stripe Checkout link to collect
// a payment (a copay, a cash-pay balance, an amount not tracked as an
// insurance claim). The link is delivered by email or SMS and is ALSO
// returned in the response so staff can copy/share it directly (read it
// aloud in-office, paste into another channel) — mirroring the AI
// mask-fitter invite flow in fitter-invites.ts.
//
// On the patient side this reuses the existing patient_payments +
// Stripe-webhook machinery: createAdhocPaymentCheckoutSession reserves a
// patient_payments row (source='csr', no claim allocations) and the
// payment_intent.succeeded webhook flips it to 'succeeded'. Nothing is
// auto-charged — the patient must open the link and pay.
//
// Endpoint (requirePermission):
//   POST /admin/patients/:id/payment-link        patients.update
//     (the same gate as payment-plans.ts — a CSR/biller holds it)
//
// PHI / log posture (matches fitter-invites.ts):
//   * Audit + logs carry counts/flags only — channel, delivered,
//     amount_cents, payment_id, patient_id. NEVER the recipient's
//     email/phone (PHI) or the Stripe URL.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { createAdhocPaymentCheckoutSession } from "../../lib/billing/patient-payment";
import { logger } from "../../lib/logger";
import { readPracticeName } from "../../lib/messaging/messaging-config";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// 30 sends/hour per admin caps a compromised-account spam scenario while
// leaving plenty of headroom for legitimate collections outreach. Keyed
// by adminUserId. Same shape as the fitter-invite / portal-invite
// limiters.
const sendLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.adminUserId ?? "unknown",
  message: {
    error: "too_many_requests",
    limiter: "admin_payment_link",
    message:
      "You're sending payment links too quickly. Please wait a few minutes and try again.",
  },
});

/** Public storefront origin the patient-facing redirect is built against.
 *  Mirrors the helper in fitter-invites.ts so links are consistent
 *  across staff-originated sends. */
function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
}

function tryCreateSendgrid(): ReturnType<typeof createSendgridClient> | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

function tryCreateTwilioSms(): ReturnType<typeof createTwilioSmsClient> | null {
  try {
    return createTwilioSmsClient();
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderPaymentEmailHtml(
  greeting: string,
  practiceName: string,
  amount: string,
  memo: string | null,
  link: string,
): string {
  const memoLine = memo
    ? `<p style="margin:0 0 12px">For: ${escapeHtml(memo)}</p>`
    : "";
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.5">
  <p>Hi ${escapeHtml(greeting)},</p>
  <p>Your care team at <strong>${escapeHtml(practiceName)}</strong> has set up a
  secure online payment of <strong>${escapeHtml(amount)}</strong>. You can pay by
  card using the button below — it only takes a moment.</p>
  ${memoLine}
  <p style="margin:24px 0">
    <a href="${escapeHtml(link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Pay ${escapeHtml(amount)} securely</a>
  </p>
  <p style="font-size:13px;color:#6b7280">Payments are processed securely by
  Stripe. ${escapeHtml(practiceName)} never sees your full card number.</p>
  <p style="font-size:13px;color:#6b7280">If the button doesn't work, copy and
  paste this link:<br>${escapeHtml(link)}</p>
  <p>— The ${escapeHtml(practiceName)} team</p>
  </body></html>`;
}

function renderPaymentEmailText(
  greeting: string,
  practiceName: string,
  amount: string,
  memo: string | null,
  link: string,
): string {
  return [
    `Hi ${greeting},`,
    "",
    `Your care team at ${practiceName} has set up a secure online payment of`,
    `${amount}. You can pay by card using the link below.`,
    ...(memo ? ["", `For: ${memo}`] : []),
    "",
    `Pay securely: ${link}`,
    "",
    `Payments are processed securely by Stripe. ${practiceName} never sees your`,
    "full card number.",
    "",
    `— The ${practiceName} team`,
  ].join("\n");
}

/** Send the payment link over the chosen channel. Returns whether
 *  delivery succeeded; never throws on a vendor / config failure so the
 *  caller can still hand the staff member a copy-able link. */
async function deliverPaymentLink(opts: {
  channel: "email" | "sms";
  email: string | null;
  phone: string | null;
  firstName: string | null;
  practiceName: string;
  amountCents: number;
  memo: string | null;
  link: string;
}): Promise<{ delivered: boolean; reason?: string }> {
  const greeting = opts.firstName?.trim() ? opts.firstName.trim() : "there";
  const amount = formatUsd(opts.amountCents);
  try {
    if (opts.channel === "email") {
      if (!opts.email) return { delivered: false, reason: "no_email" };
      const sendgrid = tryCreateSendgrid();
      if (!sendgrid) return { delivered: false, reason: "no_email_config" };
      await sendgrid.sendEmail({
        to: opts.email,
        // No PHI in the subject line — provider subjects aren't encrypted.
        subject: `Your secure payment link from ${opts.practiceName.replace(/[\r\n]/g, "")}`,
        html: renderPaymentEmailHtml(
          greeting,
          opts.practiceName,
          amount,
          opts.memo,
          opts.link,
        ),
        text: renderPaymentEmailText(
          greeting,
          opts.practiceName,
          amount,
          opts.memo,
          opts.link,
        ),
      });
      return { delivered: true };
    }
    // SMS — kept plain ASCII; this is a one-off send, not bulk, so the
    // GSM-7 segment-count concern that drives the templated reminders is
    // not worth a clamp here.
    if (!opts.phone) return { delivered: false, reason: "no_phone" };
    const twilio = tryCreateTwilioSms();
    if (!twilio) return { delivered: false, reason: "no_sms_config" };
    await twilio.sendSms({
      to: opts.phone,
      body: `Hi ${greeting}, this is ${opts.practiceName}. You can securely pay ${amount} here: ${opts.link}`,
    });
    return { delivered: true };
  } catch (err) {
    logger.warn(
      { err, channel: opts.channel },
      "patient-payment-link: send failed",
    );
    return {
      delivered: false,
      reason: err instanceof Error ? err.message.slice(0, 120) : "send_error",
    };
  }
}

const E164_RE = /^\+\d{10,15}$/;

const sendBody = z
  .object({
    channel: z.enum(["email", "sms"]),
    // Stripe's USD minimum is 50¢; cap at $20,000 as a sanity guard
    // against a fat-fingered amount.
    amountCents: z.number().int().min(50).max(2_000_000),
    // Optional memo shown on the Stripe page + receipt and in the
    // email/SMS body ("For: …"). No PHI — it renders to the patient.
    memo: z.string().trim().max(200).optional(),
    // Optional contact overrides when the chart has none on file (or the
    // staff member wants to reach a different address).
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phoneE164: z
      .string()
      .trim()
      .regex(E164_RE, "Must be E.164 format, e.g. +12155551234")
      .optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/payment-link",
  // Sending a balance-due link to a patient — same gate as the
  // payment-plan tracker (a CSR/biller sets these up).
  requirePermission("patients.update"),
  sendLimiter,
  adminRateLimit({ name: "patient_payment_link.create", preset: "sensitive" }),
  async (req, res) => {
    const idCheck = z.string().uuid().safeParse(req.params.id);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const parsed = sendBody.safeParse(req.body ?? {});
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
    const body = parsed.data;
    const supabase = getSupabaseServiceRoleClient();

    const { data: patient, error: patientErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, status, email, phone_e164, legal_first_name")
      .eq("id", idCheck.data)
      .limit(1)
      .maybeSingle();
    if (patientErr) throw patientErr;
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    // SMS to a non-active patient could violate a STOP opt-out (TCPA) —
    // refuse, mirroring the outbound-reminder invariant in send-sms.ts.
    // Email has no STOP concept, so a paused/closed patient can still be
    // emailed a balance-due link.
    if (body.channel === "sms" && patient.status !== "active") {
      res.status(409).json({
        error: "patient_not_active",
        message: `Patient status is "${patient.status}". SMS is disabled for non-active patients (STOP opt-out).`,
      });
      return;
    }

    const recipientEmail = body.email ?? patient.email?.toLowerCase() ?? null;
    const recipientPhone = body.phoneE164 ?? patient.phone_e164 ?? null;
    if (body.channel === "email" && !recipientEmail) {
      res.status(422).json({
        error: "email_required",
        message:
          "No email available to send the payment link. Provide one or choose SMS.",
      });
      return;
    }
    if (body.channel === "sms" && !recipientPhone) {
      res.status(422).json({
        error: "phone_required",
        message:
          "No phone number available to send the payment link. Provide one or choose email.",
      });
      return;
    }

    // Create the hosted Stripe Checkout Session. This reserves the
    // patient_payments row; the link is shareable immediately and the
    // webhook reconciles on success.
    const base = publicBaseUrl();
    const session = await createAdhocPaymentCheckoutSession({
      patientId: patient.id,
      amountCents: body.amountCents,
      description: body.memo ?? null,
      successUrl: `${base}/account/billing?paid=1`,
      cancelUrl: `${base}/account/billing?cancelled=1`,
      initiatorEmail: req.adminEmail ?? "unknown",
    });
    if ("error" in session) {
      const status =
        session.error === "stripe_not_configured"
          ? 503
          : session.error === "invalid_amount"
            ? 400
            : 502;
      res
        .status(status)
        .json({ error: session.error, message: session.message });
      return;
    }

    const delivery = await deliverPaymentLink({
      channel: body.channel,
      email: recipientEmail,
      phone: recipientPhone,
      firstName: patient.legal_first_name ?? null,
      practiceName: readPracticeName(),
      amountCents: session.amountCents,
      memo: body.memo ?? null,
      link: session.url,
    });

    await logAudit({
      action: "patient.payment_link.sent",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_payments",
      targetId: session.paymentId,
      metadata: {
        channel: body.channel,
        patient_id: patient.id,
        payment_id: session.paymentId,
        amount_cents: session.amountCents,
        delivered: delivery.delivered,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "patient.payment_link.sent audit write failed");
    });

    res.status(201).json({
      paymentId: session.paymentId,
      channel: body.channel,
      delivered: delivery.delivered,
      deliveryError: delivery.delivered ? null : (delivery.reason ?? null),
      amountCents: session.amountCents,
      // Always returned so staff can copy/share the link directly (read
      // it aloud, paste into another channel) — and so the link is still
      // usable when automatic delivery isn't configured in this env.
      paymentUrl: session.url,
    });
  },
);

export default router;

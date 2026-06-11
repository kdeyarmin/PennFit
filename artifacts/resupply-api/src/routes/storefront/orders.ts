/**
 * Orders endpoint — accepts patient PHI, persists to the orders table,
 * and forwards a copy to Penn Home Medical Supply via SendGrid.
 *
 * IMPORTANT — Privacy posture changed (April 2026):
 * Earlier versions of this endpoint were strictly "validate → email →
 * discard". We now persist orders to the orders table so Penn staff can
 * see and act on them in the admin dashboard. This is disclosed in the
 * `/consent` and `/privacy` pages, and patients re-consent at order time
 * via the `consentToContact` checkbox (which now also covers storage).
 *
 * Persistence rules:
 *   - Validation runs first; bad orders never touch the DB.
 *   - We INSERT the order with email_status="pending" before sending,
 *     then UPDATE to "sent" / "failed" / "skipped" after the send.
 *   - If the DB write fails, we still attempt the email (Penn would
 *     rather receive an order with no DB record than lose it entirely).
 *   - We do NOT log the request body (logger serializer redacts URL only).
 *
 * ANTI-SPAM: A hidden honeypot field (`website`) is rendered in the form
 * but kept invisible+aria-hidden+tabindex=-1. Humans never type into it;
 * naive bots fill in every visible input. If it's non-empty, we return a
 * fake success without touching the DB or sending the email.
 */

import { Router } from "express";
import { SubmitOrderBody } from "../../lib/api-zod/index.js";
import {
  getSupabaseServiceRoleClient,
  type FacialMeasurementsInfo,
  type Json,
} from "@workspace/resupply-db";
import {
  sendOrderToPenn,
  generateOrderReference,
} from "../../lib/storefront/orderEmail.js";
import { sendFitterOrderConfirmationEmail } from "../../lib/order-emails/send-fitter-order-confirmation-email.js";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";
import { logger } from "../../lib/logger.js";
import { requireCsrfWhenSession } from "../../middlewares/csrf.js";
import { attachSignedIn } from "../../middlewares/requireSignedIn.js";
import { ensureShopCustomerRow } from "../../lib/stripe/customer.js";

const router = Router();

/**
 * Strip a supabase-js / PostgREST error to safe identifiers only.
 *
 * supabase-js wraps PostgREST errors in objects of shape
 * `{ message, details, hint, code }`. On constraint violations
 * (unique, NOT NULL, foreign key) the `details` and `hint` fields
 * echo back the offending row's column values — for orders that
 * means DOB, insurance member ID, address, and email all land in
 * structured logs. CLAUDE.md hard rule: "No order request bodies in
 * the application logger." Pino does NOT redact these by default.
 */
function redactDbErr(err: unknown): {
  name: string;
  code?: string;
  message?: string;
} {
  if (err instanceof Error) {
    const code =
      (err as Error & { code?: unknown }).code !== undefined
        ? String((err as Error & { code?: unknown }).code)
        : undefined;
    return { name: err.name, code, message: err.message };
  }
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    return {
      name: "non_error",
      code: e.code !== undefined ? String(e.code) : undefined,
      message: e.message !== undefined ? String(e.message) : undefined,
    };
  }
  return { name: "non_error", message: String(err) };
}

router.post(
  "/orders",
  attachSignedIn,
  requireCsrfWhenSession,
  async (req, res) => {
    // Honeypot check — must run BEFORE schema parse, because Zod (with default
    // strip mode) would silently drop the unknown field and we'd lose the
    // signal. We deliberately return a fake-looking success so the bot
    // believes its submission worked and stops retrying.
    const honeypot = (req.body as Record<string, unknown> | null | undefined)
      ?.website;
    if (typeof honeypot === "string" && honeypot.trim().length > 0) {
      res.json({
        success: true,
        orderReference: `PENN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        deliveredAt: new Date().toISOString(),
        message: "Your order has been received.",
      });
      return;
    }

    const parseResult = SubmitOrderBody.safeParse(req.body);

    if (!parseResult.success) {
      res.status(400).json({
        error: "Invalid order",
        details: parseResult.error.issues.map(
          (i) => `${i.path.join(".")}: ${i.message}`,
        ),
      });
      return;
    }

    const order = parseResult.data;

    // Hard requirement: never forward an order without explicit patient consent
    // to be contacted. The OpenAPI-generated zod only checks `boolean`; we
    // enforce `true` here so the route is the single source of truth.
    if (order.consentToContact !== true) {
      res.status(400).json({
        error: "Invalid order",
        details: [
          "consentToContact: You must consent to be contacted to submit an order",
        ],
      });
      return;
    }

    // Persist BEFORE attempting delivery. If delivery fails, the row stays
    // with email_status="failed" and an admin can investigate. We generate
    // the reference here (instead of letting orderEmail do it) so the DB
    // row, the SendGrid email, and the patient-facing response all share
    // the same value.
    const orderReference = generateOrderReference();

    const supabase = getSupabaseServiceRoleClient();

    let dbId: string | null = null;
    try {
      const { data: inserted, error: insertErr } = await supabase
        .schema("public")
        .from("orders")
        .insert({
          order_reference: orderReference,
          patient_first_name: order.patient.firstName,
          patient_last_name: order.patient.lastName,
          patient_email: order.patient.email,
          patient_phone: order.patient.phone,
          patient_date_of_birth: order.patient.dateOfBirth,
          mask_id: order.chosenMask.maskId,
          mask_name: order.chosenMask.name,
          mask_manufacturer: order.chosenMask.manufacturer,
          mask_model_number: order.chosenMask.modelNumber,
          shipping_city: order.shippingAddress.city,
          shipping_state: order.shippingAddress.state,
          shipping_zip: order.shippingAddress.zip,
          // SubmitOrderBody is a typed Zod object; PostgREST `Json` rejects
          // it without a cast at the boundary.
          payload: order as unknown as Json,
        })
        .select("id")
        .limit(1)
        .maybeSingle();
      if (insertErr) throw insertErr;
      dbId = inserted?.id ?? null;
    } catch (err) {
      // We deliberately don't fail the whole request on a DB write error.
      // The patient's primary expectation is that Penn receives the order;
      // losing the audit row is bad but recoverable, losing the email is not.
      //
      // Strip the supabase-js error to name+code+message only. Its raw
      // shape includes `.details`/`.hint` which echo the rejected row's
      // column values on constraint violation — for orders these carry
      // DOB, insurance member ID, and email (PHI). CLAUDE.md hard rule:
      // "No order request bodies in the application logger."
      logger.error(
        { err: redactDbErr(err) },
        "Failed to persist order before send (continuing with email)",
      );
    }

    // If the order arrived with on-device measurements AND the caller
    // is signed in, mirror the latest measurements onto their
    // shop_customers row so /account and the admin Customer 360 can
    // surface them without parsing every past order's payload. Email
    // match is intentionally NOT used as a fallback — it would let an
    // anonymous order overwrite a registered customer's saved sizing.
    // Best-effort: never blocks delivery.
    const rawMeasurements = (order as { measurements?: unknown })
      .measurements as
      | (Omit<FacialMeasurementsInfo, "capturedAt" | "calibrationMethod"> & {
          capturedAt?: string;
          calibrationMethod?: string;
        })
      | undefined;
    if (req.userCustomerId && rawMeasurements) {
      try {
        // The OpenAPI schema for SubmitOrderBody allows a wider
        // `calibrationMethod` enum than `FacialMeasurementsInfo` (the DB
        // column type) does. Normalize to the DB-enforced enum so that
        // a future legitimate value can never poison persisted data.
        // Anything other than the iris-calibrated path falls back to
        // "manual_card", which is the only other variant the fitter
        // actually emits today.
        const calibrationMethod: FacialMeasurementsInfo["calibrationMethod"] =
          rawMeasurements.calibrationMethod === "iris" ? "iris" : "manual_card";
        const value: FacialMeasurementsInfo = {
          noseWidth: rawMeasurements.noseWidth,
          noseHeight: rawMeasurements.noseHeight,
          noseToChin: rawMeasurements.noseToChin,
          mouthWidth: rawMeasurements.mouthWidth,
          faceWidthAtCheekbones: rawMeasurements.faceWidthAtCheekbones,
          calibrationMethod,
          capturedAt: rawMeasurements.capturedAt ?? new Date().toISOString(),
        };
        // A signed-in customer who has never opened /shop/me or hit
        // checkout has no shop_customers row yet — without this an
        // .update() would silently no-op and the measurements would
        // never reach /account or admin Customer 360. Use the same
        // upsert helper the rest of the shop surface uses so we
        // share the email/displayName invariants.
        await ensureShopCustomerRow({
          customerId: req.userCustomerId,
          email: order.patient.email ?? null,
          displayName:
            [order.patient.firstName, order.patient.lastName]
              .filter(Boolean)
              .join(" ") || null,
        });
        const { error: updateErr } = await supabase
          .schema("resupply")
          .from("shop_customers")
          .update({
            facial_measurements_json: value as unknown as Json,
            updated_at: new Date().toISOString(),
          })
          .eq("customer_id", req.userCustomerId);
        if (updateErr) throw updateErr;
      } catch (err) {
        // Audit-relevant but non-fatal. Log structurally only — no
        // measurement values, no customer id (treat logs as world-readable).
        logger.warn(
          { err },
          "Failed to mirror facial measurements onto shop_customers (continuing)",
        );
      }
    }

    const result = await sendOrderToPenn(order, { orderReference });

    // Update DB row with delivery status (best-effort; do not surface errors
    // to the patient if this update fails)
    if (dbId) {
      try {
        const status: "sent" | "failed" | "skipped" = !result.configured
          ? "skipped"
          : result.delivered
            ? "sent"
            : "failed";
        const { error: updateErr } = await supabase
          .schema("public")
          .from("orders")
          .update({
            email_status: status,
            email_error: result.delivered ? null : (result.error ?? null),
            email_delivered_at:
              result.delivered && result.deliveredAt
                ? result.deliveredAt
                : null,
          })
          .eq("id", dbId);
        if (updateErr) throw updateErr;
      } catch (err) {
        logger.error(
          { err: redactDbErr(err), dbId },
          "Failed to update order email_status",
        );
      }
    }

    if (!result.configured) {
      res.status(503).json({
        error:
          "Order delivery is not configured on this server. Please ask Penn Home Medical Supply to set up email delivery.",
      });
      return;
    }

    if (!result.delivered) {
      res.status(502).json({
        error:
          "We could not deliver your order to Penn Home Medical Supply. Please try again or call us directly.",
        details: result.error ? [result.error] : undefined,
      });
      return;
    }

    // Provider-fetch concierge SMS — fires only when the patient
    // gave us a phone number AND included physician info (we have
    // someone to chase). Transactional under TCPA — the patient
    // initiated the order with us — but we still include the
    // "Reply STOP" tail per industry best practice. Fire-and-forget
    // against the response.
    void (async () => {
      const phone = order.patient.phone;
      const physicianName = order.prescription?.physicianName;
      if (!phone || !physicianName) return;
      try {
        const sms = createTwilioSmsClient();
        // Keep the body under 160 GSM-7 characters so it ships as a
        // single segment. The order reference doubles as a per-message
        // search anchor if the patient texts back asking about it.
        const body = `PennPaps: order ${result.orderReference} received. We'll reach out to Dr. ${physicianName.split(" ").pop()} this week to coordinate your prescription. Reply STOP to opt out.`;
        await sms.sendSms({ to: phone, body });
      } catch (err) {
        if (err instanceof TwilioConfigError) {
          logger.info(
            { event: "fitter-order.concierge-sms.skipped" },
            "fitter order: concierge-sms skipped (twilio not configured)",
          );
          return;
        }
        logger.warn(
          {
            event: "fitter-order.concierge-sms.failed",
            err,
            orderReference: result.orderReference,
          },
          "fitter order: concierge-sms send failed (non-fatal)",
        );
      }
    })();

    // Patient-facing confirmation email. Fires AFTER the fulfillment-
    // side delivery succeeds so we never confirm an order we didn't
    // actually deliver. Fire-and-forget against the response: a
    // SendGrid hiccup on the patient copy must NOT 5xx the order POST
    // (the order itself is already with the fulfillment team).
    void (async () => {
      try {
        const patientEmail = order.patient.email;
        if (!patientEmail) return;
        const confirmResult = await sendFitterOrderConfirmationEmail({
          toEmail: patientEmail,
          firstName: order.patient.firstName ?? null,
          orderReference: result.orderReference,
          maskName: order.chosenMask.name,
          maskManufacturer: order.chosenMask.manufacturer ?? null,
        });
        if (!confirmResult.configured) {
          logger.info(
            { event: "fitter-order.confirmation-email.skipped" },
            "fitter order: confirmation-email skipped (sendgrid not configured)",
          );
        } else if (!confirmResult.delivered) {
          logger.warn(
            {
              event: "fitter-order.confirmation-email.failed",
              err: confirmResult.error,
              orderReference: result.orderReference,
            },
            "fitter order: confirmation-email send failed (non-fatal)",
          );
        }
      } catch (err) {
        logger.warn(
          {
            err,
            orderReference: result.orderReference,
          },
          "fitter order: confirmation-email threw (non-fatal)",
        );
      }
    })();

    res.json({
      success: true,
      orderReference: result.orderReference,
      deliveredAt: result.deliveredAt,
      message:
        "Your order has been sent to Penn Home Medical Supply. A team member will contact you within 1 business day to confirm and arrange shipping.",
    });
  },
);

export default router;

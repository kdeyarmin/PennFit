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
import { db, ordersTable } from "../../lib/storefront/db.js";
import { eq } from "drizzle-orm";
import {
  sendOrderToPenn,
  generateOrderReference,
} from "../../lib/storefront/orderEmail.js";
import { logger } from "../../lib/logger.js";

const router = Router();

router.post("/orders", async (req, res) => {
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

  let dbId: string | null = null;
  try {
    const [inserted] = await db
      .insert(ordersTable)
      .values({
        orderReference,
        patientFirstName: order.patient.firstName,
        patientLastName: order.patient.lastName,
        patientEmail: order.patient.email,
        patientPhone: order.patient.phone,
        patientDateOfBirth: order.patient.dateOfBirth,
        maskId: order.chosenMask.maskId,
        maskName: order.chosenMask.name,
        maskManufacturer: order.chosenMask.manufacturer,
        maskModelNumber: order.chosenMask.modelNumber,
        shippingCity: order.shippingAddress.city,
        shippingState: order.shippingAddress.state,
        shippingZip: order.shippingAddress.zip,
        payload: order as unknown as Record<string, unknown>,
      })
      .returning({ id: ordersTable.id });
    dbId = inserted.id;
  } catch (err) {
    // We deliberately don't fail the whole request on a DB write error.
    // The patient's primary expectation is that Penn receives the order;
    // losing the audit row is bad but recoverable, losing the email is not.
    logger.error(
      { err },
      "Failed to persist order before send (continuing with email)",
    );
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
      await db
        .update(ordersTable)
        .set({
          emailStatus: status,
          emailError: result.delivered ? null : (result.error ?? null),
          emailDeliveredAt:
            result.delivered && result.deliveredAt
              ? new Date(result.deliveredAt)
              : null,
        })
        .where(eq(ordersTable.id, dbId));
    } catch (err) {
      logger.error({ err, dbId }, "Failed to update order email_status");
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

  res.json({
    success: true,
    orderReference: result.orderReference,
    deliveredAt: result.deliveredAt,
    message:
      "Your order has been sent to Penn Home Medical Supply. A team member will contact you within 1 business day to confirm and arrange shipping.",
  });
});

export default router;

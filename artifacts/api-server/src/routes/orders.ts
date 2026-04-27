/**
 * INTENTIONAL ARCHITECTURE NOTE — PHI Handling in Orders
 *
 * Unlike /recommend (which stays stateless and PHI-free), this route
 * inevitably handles patient identifying data: name, DOB, address,
 * insurance, contact info. Our discipline:
 *
 *   - Body is validated by Zod (strict schema) and NEVER logged.
 *   - Order is forwarded to Penn Home Medical Supply via SendGrid and
 *     immediately discarded — no database write, no in-memory cache, no
 *     analytics event, no persistent reference number stored.
 *   - The reference number returned to the patient is generated per-request
 *     and lives only in the email Penn receives.
 *
 * If SENDGRID_API_KEY or PENN_FULFILLMENT_EMAIL is missing, we return HTTP
 * 503 instead of silently swallowing the order.
 *
 * ANTI-SPAM: A hidden honeypot field (`website`) is rendered in the form
 * but kept invisible+aria-hidden+tabindex=-1. Humans never type into it;
 * naive bots fill in every visible input. If it's non-empty, we return a
 * fake success so the bot doesn't iterate, and skip the email.
 */

import { Router } from "express";
import { SubmitOrderBody } from "@workspace/api-zod";
import { sendOrderToPenn } from "../lib/orderEmail.js";

const router = Router();

router.post("/orders", async (req, res) => {
  // Honeypot check — must run BEFORE schema parse, because Zod (with default
  // strip mode) would silently drop the unknown field and we'd lose the
  // signal. We deliberately return a fake-looking success so the bot
  // believes its submission worked and stops retrying.
  const honeypot = (req.body as Record<string, unknown> | null | undefined)?.website;
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
      details: parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
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
      details: ["consentToContact: You must consent to be contacted to submit an order"],
    });
    return;
  }

  const result = await sendOrderToPenn(order);

  if (!result.configured) {
    res.status(503).json({
      error:
        "Order delivery is not configured on this server. Please ask Penn Home Medical Supply to set up email delivery.",
    });
    return;
  }

  if (!result.delivered) {
    res.status(502).json({
      error: "We could not deliver your order to Penn Home Medical Supply. Please try again or call us directly.",
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

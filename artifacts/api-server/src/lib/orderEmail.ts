/**
 * Order email delivery for Penn Home Medical Supply.
 *
 * PRIVACY-CRITICAL:
 *   - This module is the only place in the server that sees PHI (insurance,
 *     contact, address). Treat it accordingly.
 *   - We do NOT log the email body, recipient, or any patient field.
 *   - We do NOT persist the order — it is composed, sent, and discarded.
 *   - The recommendation engine and route remain stateless and PHI-free.
 *
 * Configuration (all REQUIRED — set as Replit Secrets):
 *   - SENDGRID_API_KEY       — SendGrid API key with "Mail Send" permission
 *   - PENN_FULFILLMENT_EMAIL — Where the order is delivered
 *   - PENN_FROM_EMAIL        — Verified sender on the SendGrid account
 *                              (must be verified in SendGrid before delivery
 *                              works — SendGrid will reject mail from
 *                              unverified senders)
 *
 * If any of the above is missing, the function returns { configured: false }
 * and the route returns HTTP 503. We never silently swallow an order.
 */

import { randomBytes } from "node:crypto";

export interface OrderPayload {
  chosenMask: {
    maskId: string;
    name: string;
    modelNumber: string;
    manufacturer: string;
  };
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    email: string;
    phone: string;
  };
  shippingAddress: {
    street1: string;
    street2?: string;
    city: string;
    state: string;
    zip: string;
  };
  insurance: {
    provider: string;
    memberId: string;
    groupNumber?: string;
    planName?: string;
    policyholderName?: string;
    policyholderRelationship?: "self" | "spouse" | "parent" | "child" | "other";
  };
  prescription: {
    hasExistingPrescription: boolean;
    physicianName?: string;
    physicianPhone?: string;
  };
  notes?: string;
  consentToContact: boolean;
}

export interface SendOrderResult {
  configured: boolean;
  delivered: boolean;
  orderReference: string;
  deliveredAt: string;
  error?: string;
}

/**
 * Generate a short, human-readable order reference (e.g. "PHM-7K3-N9X").
 */
export function generateOrderReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  const bytes = randomBytes(6);
  let ref = "";
  for (let i = 0; i < 6; i++) {
    ref += alphabet[bytes[i]! % alphabet.length];
  }
  return `PHM-${ref.slice(0, 3)}-${ref.slice(3, 6)}`;
}

/**
 * Build the plain-text email body sent to Penn Home Medical Supply.
 * This text is NOT logged anywhere — it lives in memory only until handed to
 * the SMTP client.
 */
function composeEmailBody(order: OrderPayload, orderReference: string): string {
  const lines: string[] = [];
  lines.push(`PENN FIT — NEW MASK ORDER`);
  lines.push(`Reference: ${orderReference}`);
  lines.push(`Submitted: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("─── CHOSEN MASK ───");
  lines.push(`${order.chosenMask.manufacturer} ${order.chosenMask.name}`);
  lines.push(`Model number: ${order.chosenMask.modelNumber}`);
  lines.push("");
  lines.push("─── PATIENT ───");
  lines.push(`Name:  ${order.patient.firstName} ${order.patient.lastName}`);
  lines.push(`DOB:   ${order.patient.dateOfBirth}`);
  lines.push(`Phone: ${order.patient.phone}`);
  lines.push(`Email: ${order.patient.email}`);
  lines.push("");
  lines.push("─── SHIPPING ADDRESS ───");
  lines.push(order.shippingAddress.street1);
  if (order.shippingAddress.street2) lines.push(order.shippingAddress.street2);
  lines.push(`${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.zip}`);
  lines.push("");
  lines.push("─── INSURANCE ───");
  lines.push(`Provider:  ${order.insurance.provider}`);
  lines.push(`Member ID: ${order.insurance.memberId}`);
  if (order.insurance.groupNumber) lines.push(`Group #:   ${order.insurance.groupNumber}`);
  if (order.insurance.planName) lines.push(`Plan:      ${order.insurance.planName}`);
  if (order.insurance.policyholderName) {
    lines.push(`Policyholder: ${order.insurance.policyholderName} (${order.insurance.policyholderRelationship ?? "—"})`);
  } else {
    lines.push(`Policyholder: patient`);
  }
  lines.push("");
  lines.push("─── PRESCRIPTION ───");
  lines.push(`Has existing CPAP Rx on file: ${order.prescription.hasExistingPrescription ? "YES" : "NO — Penn must obtain Rx before shipping"}`);
  if (order.prescription.physicianName) lines.push(`Physician: ${order.prescription.physicianName}`);
  if (order.prescription.physicianPhone) lines.push(`Phone:     ${order.prescription.physicianPhone}`);
  lines.push("");
  if (order.notes) {
    lines.push("─── PATIENT NOTES ───");
    lines.push(order.notes);
    lines.push("");
  }
  lines.push("─── CONSENT ───");
  lines.push(`Patient consents to be contacted about this order: ${order.consentToContact ? "YES" : "NO"}`);
  lines.push("");
  lines.push("This order was submitted through Penn Fit. No data is stored on the server.");
  return lines.join("\n");
}

/**
 * Send the order email via SendGrid. Returns a structured result so the route
 * can react appropriately. Never throws on missing config — returns
 * { configured: false } instead so the route can return HTTP 503.
 */
export async function sendOrderToPenn(order: OrderPayload): Promise<SendOrderResult> {
  const orderReference = generateOrderReference();
  const deliveredAt = new Date().toISOString();

  const apiKey = process.env.SENDGRID_API_KEY;
  const toEmail = process.env.PENN_FULFILLMENT_EMAIL;
  const fromEmail = process.env.PENN_FROM_EMAIL;

  if (!apiKey || !toEmail || !fromEmail) {
    return {
      configured: false,
      delivered: false,
      orderReference,
      deliveredAt,
      error: "Order email delivery is not configured.",
    };
  }

  const body = composeEmailBody(order, orderReference);
  const subject = `Penn Fit Order ${orderReference} — ${order.chosenMask.modelNumber} for ${order.patient.lastName}`;

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: toEmail }],
            subject,
          },
        ],
        from: { email: fromEmail, name: "Penn Fit" },
        reply_to: { email: order.patient.email, name: `${order.patient.firstName} ${order.patient.lastName}` },
        content: [{ type: "text/plain", value: body }],
      }),
    });

    if (response.status >= 200 && response.status < 300) {
      return { configured: true, delivered: true, orderReference, deliveredAt };
    }

    const errText = await response.text().catch(() => "");
    return {
      configured: true,
      delivered: false,
      orderReference,
      deliveredAt,
      error: `Email provider returned ${response.status}: ${errText.slice(0, 200)}`,
    };
  } catch (e) {
    return {
      configured: true,
      delivered: false,
      orderReference,
      deliveredAt,
      error: e instanceof Error ? e.message : "Unknown email delivery error",
    };
  }
}

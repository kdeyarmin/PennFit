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
 * Configuration (all REQUIRED — set as Railway Variables):
 *   - SENDGRID_API_KEY       — SendGrid API key with "Mail Send" permission
 *   - PENN_FULFILLMENT_EMAIL — Where the order is delivered
 *   - SENDGRID_FROM_EMAIL    — Verified sender on the SendGrid account
 *                              (must be verified in SendGrid before delivery
 *                              works — operations should set this to
 *                              info@pennpaps.com so every outbound email
 *                              originates from the canonical practice address)
 *   - SENDGRID_FROM_NAME     — Display name shown next to the From address
 *
 * If any of the above is missing, the function returns { configured: false }
 * and the route returns HTTP 503. We never silently swallow an order.
 *
 * All outbound mail funnels through the shared SendGrid integration in
 * @workspace/resupply-email — no raw fetch, no separate PENN_FROM_EMAIL,
 * so the entire platform sends from a single From address.
 */

import { randomInt } from "node:crypto";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";

export interface OrderPayload {
  chosenMask: {
    maskId: string;
    name: string;
    modelNumber: string;
    manufacturer: string;
  };
  measurements?: {
    noseWidth: number;
    noseHeight: number;
    noseToChin: number;
    mouthWidth: number;
    faceWidthAtCheekbones: number;
    calibrationMethod?: string;
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
  let ref = "";
  for (let i = 0; i < 6; i++) {
    // randomInt is uniform across [0, alphabet.length); randomBytes()%len
    // would be biased whenever 256 isn't an exact multiple of len.
    ref += alphabet[randomInt(alphabet.length)];
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
  if (order.measurements) {
    const m = order.measurements;
    const fmt = (v: number) => `${v.toFixed(1)} mm`;
    lines.push("─── FACIAL MEASUREMENTS (on-device, mm) ───");
    lines.push(`Nose width:               ${fmt(m.noseWidth)}`);
    lines.push(`Nose height:              ${fmt(m.noseHeight)}`);
    lines.push(`Nose tip to chin:         ${fmt(m.noseToChin)}`);
    lines.push(`Mouth width:              ${fmt(m.mouthWidth)}`);
    lines.push(`Face width at cheekbones: ${fmt(m.faceWidthAtCheekbones)}`);
    if (m.calibrationMethod) {
      lines.push(`Calibration method:       ${m.calibrationMethod}`);
    }
    lines.push("");
  }
  lines.push("─── PATIENT ───");
  lines.push(`Name:  ${order.patient.firstName} ${order.patient.lastName}`);
  lines.push(`DOB:   ${order.patient.dateOfBirth}`);
  lines.push(`Phone: ${order.patient.phone}`);
  lines.push(`Email: ${order.patient.email}`);
  lines.push("");
  lines.push("─── SHIPPING ADDRESS ───");
  lines.push(order.shippingAddress.street1);
  if (order.shippingAddress.street2) lines.push(order.shippingAddress.street2);
  lines.push(
    `${order.shippingAddress.city}, ${order.shippingAddress.state} ${order.shippingAddress.zip}`,
  );
  lines.push("");
  lines.push("─── INSURANCE ───");
  lines.push(`Provider:  ${order.insurance.provider}`);
  lines.push(`Member ID: ${order.insurance.memberId}`);
  if (order.insurance.groupNumber)
    lines.push(`Group #:   ${order.insurance.groupNumber}`);
  if (order.insurance.planName)
    lines.push(`Plan:      ${order.insurance.planName}`);
  if (order.insurance.policyholderName) {
    lines.push(
      `Policyholder: ${order.insurance.policyholderName} (${order.insurance.policyholderRelationship ?? "—"})`,
    );
  } else {
    lines.push(`Policyholder: patient`);
  }
  lines.push("");
  lines.push("─── PRESCRIPTION ───");
  lines.push(
    `Has existing CPAP Rx on file: ${order.prescription.hasExistingPrescription ? "YES" : "NO — Penn must obtain Rx before shipping"}`,
  );
  if (order.prescription.physicianName)
    lines.push(`Physician: ${order.prescription.physicianName}`);
  if (order.prescription.physicianPhone)
    lines.push(`Phone:     ${order.prescription.physicianPhone}`);
  lines.push("");
  if (order.notes) {
    lines.push("─── PATIENT NOTES ───");
    lines.push(order.notes);
    lines.push("");
  }
  lines.push("─── CONSENT ───");
  lines.push(
    `Patient consents to be contacted about this order: ${order.consentToContact ? "YES" : "NO"}`,
  );
  lines.push("");
  lines.push(
    "This order was submitted through PennPaps. No data is stored on the server.",
  );
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyToHtml(text: string): string {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;white-space:pre-wrap;font-size:14px;line-height:1.5;color:#222">${escapeHtml(text)}</div>`;
}

/**
 * Send the order email via the shared SendGrid integration. Returns a
 * structured result so the route can react appropriately. Never throws on
 * missing config — returns { configured: false } instead so the route can
 * return HTTP 503.
 */
export async function sendOrderToPenn(
  order: OrderPayload,
  options: { orderReference?: string } = {},
): Promise<SendOrderResult> {
  // The route may pass a pre-generated reference so the DB row, email, and
  // patient-facing response all share the same value. Fall back to a
  // freshly-generated one for legacy callers.
  const orderReference = options.orderReference ?? generateOrderReference();
  const deliveredAt = new Date().toISOString();

  const toEmail = process.env.PENN_FULFILLMENT_EMAIL;
  if (!toEmail) {
    return {
      configured: false,
      delivered: false,
      orderReference,
      deliveredAt,
      error: "Order email delivery is not configured.",
    };
  }

  let client;
  try {
    client = createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return {
        configured: false,
        delivered: false,
        orderReference,
        deliveredAt,
        error: "Order email delivery is not configured.",
      };
    }
    return {
      configured: false,
      delivered: false,
      orderReference,
      deliveredAt,
      error: err instanceof Error ? err.message : "Unknown email config error",
    };
  }

  const body = composeEmailBody(order, orderReference);
  const subject = `PennPaps Order ${orderReference} — ${order.chosenMask.modelNumber} for ${order.patient.lastName}`;

  // Set the patient as the reply-to so the fulfillment team can reply
  // directly. SendGrid accepts the standard "Name <email>" string format,
  // BUT we never want to interpolate an unsanitized name field — names can
  // contain CRLF, angle brackets, quotes, or other characters that would
  // break header parsing or enable header injection. The cheapest robust
  // posture is to drop the display name entirely and pass only the
  // email; SendGrid is happy with bare addresses, fulfillment can still
  // reply, and there is no untrusted string anywhere near the headers.
  const replyTo = order.patient.email;

  try {
    await client.sendEmail({
      to: toEmail,
      subject,
      text: body,
      html: bodyToHtml(body),
      replyTo,
    });
    return { configured: true, delivered: true, orderReference, deliveredAt };
  } catch (err) {
    if (err instanceof EmailApiError) {
      const status = err.status ?? "unknown";
      return {
        configured: true,
        delivered: false,
        orderReference,
        deliveredAt,
        error: `Email provider returned ${status}: ${err.message.slice(0, 200)}`,
      };
    }
    return {
      configured: true,
      delivered: false,
      orderReference,
      deliveredAt,
      error:
        err instanceof Error ? err.message : "Unknown email delivery error",
    };
  }
}

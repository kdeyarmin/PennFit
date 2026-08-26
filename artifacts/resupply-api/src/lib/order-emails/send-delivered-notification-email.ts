// sendDeliveredNotificationEmail — single-shot SendGrid notice that a
// paid shop order has been DELIVERED.
//
// Fired when an order's delivered_at is stamped: either by an admin
// clicking "mark delivered" (POST /admin/shop/orders/:orderId/delivered)
// or by the carrier tracking webhook (applyCarrierTrackingEvent). Returns
// a tagged-union outcome so the caller can branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// (`delivered` in the RESULT means "the email was delivered to SendGrid",
// matching the sibling shipping/pickup helpers — not the parcel status.)
//
// Idempotency lives at the call site (sendDeliveredNotificationIfNew in
// routes/admin/shop-orders.ts), which performs an atomic claim on
// shop_orders.delivered_email_sent_at before invoking this helper, so it
// is only ever called once per order in normal operation.
//
// Privacy:
//   - The recipient email is never logged.
//   - Carrier name + tracking number + shipping address are PUBLIC
//     operational data — safe to render in body.
//   - No PHI; this is the cash-pay shop, not the resupply outreach
//     surface.
//
// Template mirrors the shipping notice: brand banner ("It's here"), a
// short confirmation, an optional tracking box, the shipping address,
// a "View order" CTA, and a "didn't get it?" support footer.

import {
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  infoPanel,
  renderBrandedEmail,
  secondaryLink,
  textParagraph,
} from "@workspace/resupply-email";

import type { SavedShippingAddress } from "@workspace/resupply-db";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";
import { getCarrierTrackingUrl } from "./send-shipping-notification-email.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface SendDeliveredNotificationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string;
  /** Free-form carrier label (e.g. "UPS"). Optional — may be null when a
   *  webhook delivered the order before tracking was recorded. */
  carrier?: string | null;
  /** Carrier-specific tracking number. Optional, as above. */
  trackingNumber?: string | null;
  /**
   * Address snapshot from shop_orders.shipping_address_json. Optional —
   * shipping-disabled SKUs land here as null and the email still makes
   * sense without an address block.
   */
  shippingAddress?: SavedShippingAddress | null;
  /** Optional override for the public base URL. */
  baseUrlOverride?: string;
  /**
   * Tenant the order belongs to. When set and the tenant has its own From
   * identity (migration 0360) the email is sent under it (G6) and the copy
   * carries the tenant's storefront brand; otherwise the platform default
   * From/brand is used.
   */
  orgId?: string;
}

export interface SendDeliveredNotificationEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function renderAddressTextLines(addr: SavedShippingAddress): string[] {
  const lines: string[] = [];
  lines.push(addr.line1);
  if (addr.line2) lines.push(addr.line2);
  lines.push(`${addr.city}, ${addr.state} ${addr.postalCode}`);
  lines.push(addr.country);
  return lines;
}

function renderAddressHtml(addr: SavedShippingAddress): string {
  return renderAddressTextLines(addr)
    .map((l) => escapeHtml(l))
    .join("<br/>");
}

export async function sendDeliveredNotificationEmail(
  input: SendDeliveredNotificationEmailInput,
): Promise<SendDeliveredNotificationEmailResult> {
  const { toEmail, stripeSessionId, carrier, trackingNumber, shippingAddress } =
    input;

  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open (configured: false) — the caller logs and skips. A
      // missing SendGrid key must NOT 500 the delivery transition.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply"; a second tenant's email carries ITS
  // brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const subject = `Your ${brandName} order was delivered`;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const orderUrl = `${base}/contact`;
  const trackingUrl =
    carrier && trackingNumber
      ? getCarrierTrackingUrl(carrier, trackingNumber)
      : null;

  // ---------- text body ----------
  const textLines: string[] = [
    `Your ${brandName} order has been delivered. We hope everything arrived in great shape.`,
    "",
  ];
  if (carrier && trackingNumber) {
    textLines.push(`Carrier:  ${carrier}`);
    textLines.push(`Tracking: ${trackingNumber}`);
    if (trackingUrl) textLines.push(`Track:    ${trackingUrl}`);
    textLines.push("");
  }
  if (shippingAddress) {
    textLines.push("Delivered to:");
    for (const l of renderAddressTextLines(shippingAddress)) {
      textLines.push(`  ${l}`);
    }
    textLines.push("");
  }
  textLines.push(`Questions about your order? ${orderUrl}`);
  textLines.push("");
  textLines.push(
    "Didn't receive it, or did something arrive damaged? Reply to this " +
      "message and we'll make it right.",
  );
  const text = textLines.join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system;
  // this builder supplies only copy + data. The delivery panels use the
  // "success" tone rather than a bespoke green button so the CTA stays
  // identical to every other platform email.
  const trackingPanel =
    carrier && trackingNumber
      ? infoPanel({
          title: "Delivered by",
          tone: "success",
          html:
            `<div style="font-weight:700;color:#0b1426;">${escapeHtml(carrier)}</div>` +
            `<div style="font-family:Menlo,Consolas,monospace;font-size:14px;margin-top:2px;">${escapeHtml(
              trackingNumber,
            )}</div>`,
        })
      : "";

  const addressPanel = shippingAddress
    ? infoPanel({
        title: "Delivered to",
        html: renderAddressHtml(shippingAddress),
      })
    : "";

  const html = renderBrandedEmail({
    brandName,
    heading: "It's here",
    preheader: `Your ${brandName} order has been delivered.`,
    contentHtml: [
      textParagraph(
        `Your ${brandName} order has been delivered — we hope everything arrived in great shape.`,
      ),
      trackingPanel,
      addressPanel,
    ]
      .filter(Boolean)
      .join("\n"),
    button: trackingUrl
      ? { label: "View delivery details", url: trackingUrl }
      : { label: "Contact us", url: orderUrl },
    postButtonHtml: trackingUrl
      ? secondaryLink("Or contact us about this order", orderUrl)
      : "",
    footerLines: [
      "Didn't receive it, or did something arrive damaged? Reply to this message and we'll make it right.",
    ],
    copyrightName: brandName,
  });

  try {
    const { messageId } = await client.sendEmail({
      to: toEmail,
      subject,
      html,
      text,
      customArgs: {
        kind: "shop_delivered_notification_v1",
        stripe_session_id: stripeSessionId,
      },
    });
    return { configured: true, delivered: true, messageId };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: `SendGrid ${err.status ?? "?"}: ${err.message}`,
      };
    }
    return {
      configured: true,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

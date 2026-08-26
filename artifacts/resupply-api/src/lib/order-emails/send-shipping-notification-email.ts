// sendShippingNotificationEmail — single-shot SendGrid notice that
// a paid Penn Home Medical Supply shop order has shipped.
//
// Fired from the admin POST /admin/shop/orders/:orderId/tracking
// endpoint after the carrier + tracking number are stamped on the
// order row. Returns a tagged-union outcome so the route can branch
// without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site, not here. The admin route
// checks shop_orders.shipping_email_sent_at against a "did this
// tracking actually change?" condition before invoking this helper
// and stamps it on success — so this function may be safely retried
// by the caller's own logic when needed (e.g. an admin manually
// re-pressing the button after a SendGrid outage), but is NEVER
// called twice in normal operation.
//
// Privacy:
//   - The recipient email is never logged.
//   - The tracking number, carrier name and shipping address are
//     PUBLIC operational data — safe to render in body.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface.
//
// Template:
//   - Subject:   "Your Penn Home Medical Supply order has shipped"
//   - HTML body: rendered through the shared branded email layout
//                (`renderBrandedEmail`) so it matches every other
//                platform email. Copy: short note, tracking panel
//                (carrier + number, with a public carrier-tracking
//                link when the carrier is known), shipping-address
//                panel, "Track package"/"View order" CTA, support footer.

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

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface SendShippingNotificationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string;
  /** Free-form carrier label entered by admin (e.g. "UPS", "USPS"). */
  carrier: string;
  /** Carrier-specific tracking number entered by admin. */
  trackingNumber: string;
  /**
   * Address snapshot from shop_orders.shipping_address_json. Optional —
   * shipping-disabled SKUs land here as null and the email still
   * makes sense without an address block.
   */
  shippingAddress?: SavedShippingAddress | null;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, then RESUPPLY_VOICE_PUBLIC_BASE_URL,
   * then https://cmbreathe.com.
   */
  baseUrlOverride?: string;
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendShippingNotificationEmailResult {
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

/**
 * Map a free-form carrier label to a public tracking URL. Returns
 * null for carriers we don't have a template for; the email then
 * renders the bare number with no link (still informative).
 *
 * The match is intentionally loose (lowercase, accepts common
 * synonyms) so admin typos like "ups " or "U.P.S." still produce a
 * usable link.
 */
export function getCarrierTrackingUrl(
  carrier: string,
  trackingNumber: string,
): string | null {
  const c = carrier
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const num = encodeURIComponent(trackingNumber.trim());
  if (!num) return null;
  switch (c) {
    case "ups":
      return `https://www.ups.com/track?tracknum=${num}`;
    case "usps":
      return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${num}`;
    case "fedex":
    case "federalexpress":
      return `https://www.fedex.com/fedextrack/?trknbr=${num}`;
    case "dhl":
    case "dhlexpress":
      return `https://www.dhl.com/en/express/tracking.html?AWB=${num}`;
    default:
      return null;
  }
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

export async function sendShippingNotificationEmail(
  input: SendShippingNotificationEmailInput,
): Promise<SendShippingNotificationEmailResult> {
  const { toEmail, stripeSessionId, carrier, trackingNumber, shippingAddress } =
    input;

  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the admin route
      // logs and skips. We never throw on misconfig; a missing
      // SendGrid key must NOT 500 the admin tracking endpoint.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const subject = `Your ${brandName} order has shipped`;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const orderUrl = `${base}/contact`;
  const trackingUrl = getCarrierTrackingUrl(carrier, trackingNumber);

  // ---------- text body ----------
  const textLines: string[] = [
    `Good news — your ${brandName} order has shipped and is on its way.`,
    "",
    `Carrier:  ${carrier}`,
    `Tracking: ${trackingNumber}`,
  ];
  if (trackingUrl) {
    textLines.push(`Track:    ${trackingUrl}`);
  }
  textLines.push("");
  if (shippingAddress) {
    textLines.push("Shipping to:");
    for (const l of renderAddressTextLines(shippingAddress)) {
      textLines.push(`  ${l}`);
    }
    textLines.push("");
  }
  textLines.push(`Questions about your order? ${orderUrl}`);
  textLines.push("");
  textLines.push(
    "If anything looks off (wrong address, wrong items), reply to this " +
      "message right away and we'll sort it out.",
  );
  const text = textLines.join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system;
  // this builder supplies only copy + data. The wordmark is the TENANT's
  // storefront brand (see CLAUDE.md brand architecture).
  const addressPanel = shippingAddress
    ? infoPanel({
        title: "Shipping to",
        html: renderAddressHtml(shippingAddress),
      })
    : "";

  const trackingPanel = infoPanel({
    title: "Tracking",
    tone: "info",
    html:
      `<div style="font-weight:700;color:#0b1426;">${escapeHtml(carrier)}</div>` +
      `<div style="font-family:Menlo,Consolas,monospace;font-size:14px;margin-top:2px;">${escapeHtml(
        trackingNumber,
      )}</div>`,
  });

  const html = renderBrandedEmail({
    brandName,
    heading: "On its way",
    preheader: `Your order has shipped via ${carrier} — tracking ${trackingNumber}.`,
    contentHtml: [
      textParagraph(`Good news — your ${brandName} order has shipped.`),
      trackingPanel,
      addressPanel,
    ]
      .filter(Boolean)
      .join("\n"),
    button: trackingUrl
      ? { label: "Track package", url: trackingUrl }
      : { label: "Contact us", url: orderUrl },
    // Secondary action belongs BELOW the CTA, so it renders in the
    // post-button slot rather than in contentHtml (which sits above it).
    postButtonHtml: trackingUrl
      ? secondaryLink("Or contact us about this order", orderUrl)
      : "",
    footerLines: [
      "If anything looks off — wrong address, wrong items — reply to this message right away and we'll sort it out.",
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
        kind: "shop_shipping_notification_v1",
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

// sendReadyForPickupEmail — single-shot SendGrid notice that a paid
// Penn Home Medical Supply in-store-pickup order is ready to collect.
//
// The pickup analogue of sendShippingNotificationEmail. Fired from the
// admin POST /admin/shop/orders/:orderId/ready-for-pickup endpoint after
// ready_for_pickup_at is stamped. Returns the same tagged result shape
// so the route can branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site (the route claims
// ready_for_pickup_email_sent_at atomically), exactly like the shipping
// notification.
//
// Privacy:
//   - The recipient email is never logged.
//   - The location name/address/phone are PUBLIC business contact info.
//   - No PHI — this is the cash-pay shop.

import {
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  infoPanel,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface PickupLocationForEmail {
  name: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  phoneE164: string | null;
}

export interface SendReadyForPickupEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the order page. */
  stripeSessionId: string;
  /** The location the customer collects from. */
  location: PickupLocationForEmail;
  /** Optional override for the public base URL. */
  baseUrlOverride?: string;
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6) and
   * the copy carries the tenant's storefront brand; otherwise the platform
   * default From/brand is used. Omit / undefined leaves it unchanged.
   */
  orgId?: string;
}

export interface SendReadyForPickupEmailResult {
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

function locationTextLines(loc: PickupLocationForEmail): string[] {
  const lines: string[] = [loc.name];
  if (loc.addressLine1) lines.push(loc.addressLine1);
  if (loc.addressLine2) lines.push(loc.addressLine2);
  const cityLine = [loc.city, loc.state].filter(Boolean).join(", ");
  const cityState = [cityLine, loc.postalCode].filter(Boolean).join(" ").trim();
  if (cityState) lines.push(cityState);
  if (loc.phoneE164) lines.push(`Phone: ${loc.phoneE164}`);
  return lines;
}

function locationHtml(loc: PickupLocationForEmail): string {
  return locationTextLines(loc)
    .map((l) => escapeHtml(l))
    .join("<br/>");
}

export async function sendReadyForPickupEmail(
  input: SendReadyForPickupEmailInput,
): Promise<SendReadyForPickupEmailResult> {
  const { toEmail, stripeSessionId, location } = input;

  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open — the admin route logs and skips. A missing SendGrid
      // key must NOT 500 the ready-for-pickup endpoint.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const subject = `Your ${brandName} order is ready for pickup`;
  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const orderUrl = `${base}/contact`;

  // ---------- text body ----------
  const textLines: string[] = [
    `Good news — your ${brandName} order is ready to pick up.`,
    "",
    "Pick up at:",
    ...locationTextLines(location).map((l) => `  ${l}`),
    "",
    "Please bring a photo ID matching the order. " +
      "If someone else is collecting on your behalf, let us know in advance.",
    "",
    `Questions about your order? ${orderUrl}`,
  ];
  const text = textLines.join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system;
  // this builder supplies only copy + data.
  const html = renderBrandedEmail({
    brandName,
    heading: "Ready for pickup",
    preheader: `Your ${brandName} order is ready to collect.`,
    contentHtml: [
      textParagraph(`Good news — your ${brandName} order is ready to pick up.`),
      infoPanel({ title: "Pick up at", html: locationHtml(location) }),
    ].join("\n"),
    button: { label: "Contact us", url: orderUrl },
    footerLines: [
      "Please bring a photo ID matching the order. If someone else is collecting on your behalf, let us know in advance.",
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
        kind: "shop_ready_for_pickup_v1",
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

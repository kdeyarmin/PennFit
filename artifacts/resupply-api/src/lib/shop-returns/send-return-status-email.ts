// sendReturnStatusEmail — one helper for the two customer-facing
// transitions in the RMA workflow that the patient otherwise has to
// discover by checking /account:
//
//   * approved  — staff cleared the request; tell the patient how
//                 to send it back (carrier + tracking link), or
//                 that "no return shipment is required" when the
//                 label fields are absent (rare — staff-issued
//                 refund without intake).
//   * received  — the warehouse logged the returned item as received;
//                 reassure the patient we have it and the refund/exchange
//                 is being processed (otherwise the package "disappears"
//                 between drop-off and refund).
//   * refunded  — the Stripe refund has been issued; tell the
//                 patient how much, in what currency, and to expect
//                 5-10 business days for it to land on the card.
//
// Privacy: subject lines are PHI-free ("Your Penn Home Medical Supply return is
// approved", "Your Penn Home Medical Supply refund is on the way"). The body
// references the order's last 4 of the Stripe session ID for
// disambiguation; we deliberately do NOT include patient name,
// address, or any prescription detail. The recipient email is
// never logged.
//
// Failure mode: returns a tagged-union result so the caller can
// branch without try/catch. NEVER throws — a SendGrid 5xx must not
// block the lifecycle transition that already succeeded in the DB.

import {
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  infoPanel,
  paragraph,
  renderBrandedEmail,
  secondaryLink,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
  type StorefrontBranding,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export type ReturnStatusKind = "approved" | "received" | "refunded";

export interface SendReturnStatusEmailInput {
  kind: ReturnStatusKind;
  toEmail: string;
  /** Stripe session id (`cs_...`). Last 8 chars render in the body for disambiguation. */
  stripeSessionId: string;
  /** Resupply shop_returns row id — round-trips on customArgs for bounce correlation. */
  returnId: string;
  /** Required when kind === "refunded". USD cents. Ignored when kind === "approved". */
  refundCents?: number | null;
  /** Required when kind === "refunded". Stripe currency code (lowercase). Defaults to "usd". */
  currency?: string | null;
  /** Optional when kind === "approved" — carrier name shown next to the tracking link. */
  returnCarrier?: string | null;
  /** Optional when kind === "approved" — tracking number for the return label. */
  returnTrackingNumber?: string | null;
  /** Optional when kind === "approved" — direct link to the prepaid return label PDF. */
  returnLabelUrl?: string | null;
  /** Optional override for the public base URL. */
  baseUrlOverride?: string;
  /**
   * Tenant the return belongs to. When set and the tenant has its own
   * From identity (migration 0360), the email is sent under it (G6); the
   * body/subject also carry the tenant's brand. Omit / undefined leaves the
   * platform default From and the seed tenant's brand ("Penn Home Medical Supply") in place.
   */
  orgId?: string;
}

export interface SendReturnStatusEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
  messageId?: string;
}

function formatMoney(cents: number, currency: string): string {
  const code = currency.toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function publicBaseUrl(override?: string): string {
  const raw =
    override ??
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

function lastChars(id: string, n: number): string {
  return id.length <= n ? id : id.slice(-n);
}

function buildApprovedBody(
  input: SendReturnStatusEmailInput,
  myReturnsUrl: string,
  brand: StorefrontBranding,
): { subject: string; html: string; text: string } {
  const orderTail = lastChars(input.stripeSessionId, 8);
  const subject = `Your ${brand.storefrontName} return is approved`;

  // Carrier + tracking + label panel are conditional — staff sometimes
  // approves a return without issuing a label (e.g. exchange where the
  // customer keeps the original item). Render whichever fields are
  // present so the email reads cleanly in either shape.
  const carrier = input.returnCarrier?.trim();
  const tracking = input.returnTrackingNumber?.trim();
  const labelUrl = input.returnLabelUrl?.trim();

  const textParts: string[] = [
    "Good news — your return is approved.",
    "",
    `Order: ...${orderTail}`,
    "",
  ];
  if (labelUrl) {
    textParts.push(`Print your prepaid return label: ${labelUrl}`);
  }
  if (carrier || tracking) {
    textParts.push(
      `Carrier: ${carrier ?? "—"}${tracking ? ` (tracking ${tracking})` : ""}`,
    );
  }
  if (!labelUrl && !carrier && !tracking) {
    textParts.push(
      "No return shipment is required — our team will be in touch about next steps.",
    );
  }
  textParts.push("");
  textParts.push(`See all your returns: ${myReturnsUrl}`);
  const text = textParts.join("\n");

  // Chrome comes from the shared CareMetric Breathe email design system.
  const shipmentPanel =
    carrier || tracking
      ? infoPanel({
          title: "Return shipment",
          html:
            `Carrier: <strong>${escapeHtml(carrier ?? "—")}</strong>` +
            (tracking
              ? ` &middot; Tracking: <strong>${escapeHtml(tracking)}</strong>`
              : ""),
        })
      : "";
  const noShipmentNote =
    !labelUrl && !carrier && !tracking
      ? textParagraph(
          "No return shipment is required — our team will be in touch about next steps.",
        )
      : "";

  const html = renderBrandedEmail({
    brandName: brand.storefrontName,
    heading: "Your return is approved",
    preheader: `We've approved your return on order ...${orderTail}.`,
    contentHtml: [
      paragraph(
        `Good news — we&#39;ve approved your return on order <strong>&hellip;${escapeHtml(
          orderTail,
        )}</strong>.`,
      ),
      shipmentPanel,
      noShipmentNote,
    ]
      .filter(Boolean)
      .join("\n"),
    postButtonHtml: secondaryLink("View all your returns", myReturnsUrl),
    ...(labelUrl
      ? { button: { label: "Print your return label", url: labelUrl } }
      : {}),
    footerLines: [
      `You're receiving this because you opened a return request at ${brand.storefrontName}. Reply to this email and our team will help.`,
    ],
    copyrightName: brand.storefrontName,
  });

  return { subject, html, text };
}

function buildRefundedBody(
  input: SendReturnStatusEmailInput,
  myReturnsUrl: string,
  brand: StorefrontBranding,
): { subject: string; html: string; text: string } {
  const cents = input.refundCents ?? 0;
  const currency = (input.currency ?? "usd").toLowerCase();
  const amount = formatMoney(cents, currency);
  const orderTail = lastChars(input.stripeSessionId, 8);
  const subject = `Your ${brand.storefrontName} refund is on the way`;

  const text = [
    `We've issued your refund of ${amount}.`,
    "",
    `Order: ...${orderTail}`,
    "",
    `Refunds typically take 5-10 business days to land back on the card you paid with. The amount will appear on your statement under ${brand.storefrontName}.`,
    "",
    `See all your returns: ${myReturnsUrl}`,
  ].join("\n");

  const html = renderBrandedEmail({
    brandName: brand.storefrontName,
    heading: "Refund issued",
    preheader: `We've issued your refund of ${amount}.`,
    contentHtml: [
      paragraph(
        `We&#39;ve issued your refund of <strong>${escapeHtml(
          amount,
        )}</strong> on order <strong>&hellip;${escapeHtml(orderTail)}</strong>.`,
      ),
      paragraph(
        `Refunds typically take <strong>5-10 business days</strong> to land back on the card you paid with. The amount will appear on your statement under <strong>${escapeHtml(
          brand.storefrontName,
        )}</strong>.`,
      ),
    ].join("\n"),
    postButtonHtml: secondaryLink("View all your returns", myReturnsUrl),
    footerLines: ["Questions? Reply to this email and our team will help."],
    copyrightName: brand.storefrontName,
  });

  return { subject, html, text };
}

function buildReceivedBody(
  input: SendReturnStatusEmailInput,
  myReturnsUrl: string,
  brand: StorefrontBranding,
): { subject: string; html: string; text: string } {
  const orderTail = lastChars(input.stripeSessionId, 8);
  const subject = `We've received your ${brand.storefrontName} return`;

  const text = [
    "We've received your returned item — thank you.",
    "",
    `Order: ...${orderTail}`,
    "",
    "Our team is processing it now. You'll get a separate confirmation as soon as your refund or exchange is on its way.",
    "",
    `See all your returns: ${myReturnsUrl}`,
  ].join("\n");

  const html = renderBrandedEmail({
    brandName: brand.storefrontName,
    heading: "Return received",
    preheader: "We've received your returned item — thank you.",
    contentHtml: [
      paragraph(
        `We&#39;ve received your returned item on order <strong>&hellip;${escapeHtml(
          orderTail,
        )}</strong> — thank you.`,
      ),
      textParagraph(
        "Our team is processing it now. You'll get a separate confirmation as soon as your refund or exchange is on its way.",
      ),
    ].join("\n"),
    postButtonHtml: secondaryLink("View all your returns", myReturnsUrl),
    footerLines: ["Questions? Reply to this email and our team will help."],
    copyrightName: brand.storefrontName,
  });

  return { subject, html, text };
}

export async function sendReturnStatusEmail(
  input: SendReturnStatusEmailInput,
): Promise<SendReturnStatusEmailResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6); falls
    // back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    return {
      configured: false,
      delivered: false,
      error: err instanceof Error ? err.message : "email_client_init_failed",
    };
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply", so single-tenant copy is unchanged.
  const brand = await resolveBrandingByOrgId(input.orgId);

  const myReturnsUrl = `${publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  )}/account/returns`;
  const body =
    input.kind === "approved"
      ? buildApprovedBody(input, myReturnsUrl, brand)
      : input.kind === "received"
        ? buildReceivedBody(input, myReturnsUrl, brand)
        : buildRefundedBody(input, myReturnsUrl, brand);

  try {
    const { messageId } = await client.sendEmail({
      to: input.toEmail,
      subject: body.subject,
      html: body.html,
      text: body.text,
      customArgs: {
        kind:
          input.kind === "approved"
            ? "return_approved_v1"
            : input.kind === "received"
              ? "return_received_v1"
              : "return_refunded_v1",
        return_id: input.returnId,
      },
    });
    return { configured: true, delivered: true, messageId };
  } catch (err) {
    if (err instanceof EmailApiError) {
      return {
        configured: true,
        delivered: false,
        error: `sendgrid_api_error_${err.status ?? "unknown"}`,
      };
    }
    return {
      configured: true,
      delivered: false,
      error: "sendgrid_unexpected_error",
    };
  }
}

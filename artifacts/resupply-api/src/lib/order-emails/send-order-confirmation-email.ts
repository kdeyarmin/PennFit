// sendOrderConfirmationEmail — single-shot SendGrid confirmation
// for a paid Penn Home Medical Supply shop order.
//
// Fired from the Stripe webhook on checkout.session.completed (and
// async_payment_succeeded). Returns a tagged-union outcome so the
// webhook can branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site, not here. The webhook checks
// shop_orders.confirmation_email_sent_at IS NULL before invoking
// this helper and stamps it on success — so this function may be
// safely retried by the caller's own logic when needed (e.g. a
// manual replay after a SendGrid outage), but is NEVER called twice
// in normal operation.
//
// Privacy:
//   - The recipient email is never logged.
//   - Line items are PUBLIC catalog data (Stripe price/product names
//     and quantities) — safe to render in body and subject.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface.
//   - The shipping address summary is included (city/state/postal)
//     because customers expect to see "we'll ship to ..." on a
//     confirmation. Street is included as well — it was just
//     submitted by the customer and is no more sensitive in email
//     than on the success page they just visited.
//
// Template:
//   - Subject:   "Your <tenant brand> order is confirmed"
//   - HTML body: rendered through the shared branded email layout
//                (`renderBrandedEmail`) so it carries the same chrome as
//                every other platform email — tenant wordmark header,
//                white content card, bulletproof CTA, quiet footer. This
//                builder supplies only the copy: thank-you line, item
//                table (qty × unit price), total, shipping-address panel,
//                "View order" CTA to the success page, support footer.

import {
  BREATHE_COLORS,
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  infoPanel,
  lineItemsTable,
  renderBrandedEmail,
  summaryRows,
  textParagraph,
} from "@workspace/resupply-email";

import type { SavedShippingAddress } from "@workspace/resupply-db";

import { withMetrics } from "../observability";
import { withRetry } from "../with-retry.js";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface OrderConfirmationLineItem {
  name: string;
  quantity: number;
  unitAmountCents: number;
  currency: string;
}

export interface SendOrderConfirmationEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  /** Stripe Checkout Session id — used to deep-link the success page. */
  stripeSessionId: string;
  /**
   * Mirrored line items from shop_order_items (or the Stripe Session
   * if the mirror hasn't landed yet). May be empty — the body still
   * renders cleanly with a "see your order online" fallback.
   */
  items: readonly OrderConfirmationLineItem[];
  /** Order grand total. Stripe gives this on the Session. */
  amountTotalCents: number;
  /** Stripe currency code (lowercase from Stripe; we upper-case for Intl). */
  currency: string;
  /**
   * Shipping address snapshot the webhook just stored. Optional —
   * shipping-disabled SKUs land here as null and the email still
   * makes sense without an address block.
   */
  shippingAddress?: SavedShippingAddress | null;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, then RESUPPLY_VOICE_PUBLIC_BASE_URL,
   * then https://cmbreathe.com so links emitted from preview/staging
   * deploys still resolve to production.
   */
  baseUrlOverride?: string;
  /**
   * Tenant the order belongs to. When set and the tenant has its own
   * From identity (migration 0360), the confirmation is sent under it
   * (G6); otherwise the platform default From is used. Omit / undefined
   * leaves the platform default unchanged.
   */
  orgId?: string;
}

export interface SendOrderConfirmationEmailResult {
  /** True iff SendGrid env vars are present. */
  configured: boolean;
  /** True iff the API call succeeded (2xx + message id present). */
  delivered: boolean;
  /** Human-readable error when delivered=false (configured=true). */
  error?: string;
  /** SendGrid X-Message-Id when delivered. */
  messageId?: string;
}

function formatMoney(cents: number, currency: string): string {
  // Stripe always sends lowercase currency codes; Intl wants upper.
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

function renderAddressTextLines(addr: SavedShippingAddress): string[] {
  // Address shape comes from shop-customers.ts SavedShippingAddress.
  // Fields: line1, line2?, city, state, postalCode, country.
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

export async function sendOrderConfirmationEmail(
  input: SendOrderConfirmationEmailInput,
): Promise<SendOrderConfirmationEmailResult> {
  const {
    toEmail,
    stripeSessionId,
    items,
    amountTotalCents,
    currency,
    shippingAddress,
  } = input;

  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the webhook
      // logs and skips. We never throw on misconfig out of this
      // helper; a missing SendGrid key must NOT cause Stripe to
      // retry the entire webhook.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's order email carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;
  const subject = `Your ${brandName} order is confirmed`;

  // Build patient links from the tenant's own storefront origin (its verified
  // custom domain) when the caller didn't pass an explicit override; the seed
  // tenant falls through to the platform env/default, so single-tenant is
  // unchanged. Resolved once per send.
  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const orderUrl = `${base}/contact`;
  // Cash-pay /shop is retired — send patients to insurance coverage
  // rather than a LegacyShopRedirect hop off /shop.
  const coverageUrl = `${base}/insurance`;

  // ---------- text body ----------
  const textLines: string[] = [
    `Thanks for your order at ${brandName}. Your payment was received and we're getting it ready to ship.`,
    "",
  ];
  if (items.length > 0) {
    textLines.push("Order summary:");
    for (const it of items) {
      textLines.push(
        `  - ${it.quantity} x ${it.name} (${formatMoney(it.unitAmountCents, it.currency)} each)`,
      );
    }
    textLines.push("");
  }
  textLines.push(`Total: ${formatMoney(amountTotalCents, currency)}`);
  textLines.push("");
  if (shippingAddress) {
    textLines.push("Shipping to:");
    for (const l of renderAddressTextLines(shippingAddress)) {
      textLines.push(`  ${l}`);
    }
    textLines.push("");
  }
  textLines.push(`Questions about your order? ${orderUrl}`);
  textLines.push(`Insurance coverage: ${coverageUrl}`);
  textLines.push("");
  textLines.push(
    "We'll send another email with tracking info once your order ships. " +
      "Reply to this message if you need to make a change — we read every reply.",
  );
  const text = textLines.join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system
  // (`renderBrandedEmail`); this builder supplies only copy + data. The
  // wordmark is the TENANT's storefront brand, so the look is shared
  // while the name stays per-tenant correct (see CLAUDE.md).
  const itemsHtml =
    items.length > 0
      ? lineItemsTable(
          items.map((it) => ({
            name: it.name,
            amount: `${it.quantity} × ${formatMoney(it.unitAmountCents, it.currency)}`,
          })),
        )
      : textParagraph(
          "Questions about your order? Use the Contact us button below.",
        );

  const addressPanel = shippingAddress
    ? infoPanel({
        title: "Shipping to",
        html: renderAddressHtml(shippingAddress),
      })
    : "";

  const html = renderBrandedEmail({
    brandName,
    heading: "Your order is confirmed",
    preheader: `We received your payment of ${formatMoney(amountTotalCents, currency)} and we're getting your order ready to ship.`,
    contentHtml: [
      textParagraph(
        "Thanks for your order. Your payment was received and we're getting it ready to ship.",
      ),
      itemsHtml,
      summaryRows([
        {
          label: "Total",
          value: formatMoney(amountTotalCents, currency),
          emphasis: true,
        },
      ]),
      addressPanel,
    ]
      .filter(Boolean)
      .join("\n"),
    button: { label: "Contact us", url: orderUrl },
    footerHtml: `<a href="${escapeHtml(coverageUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">Insurance coverage</a>`,
    footerLines: [
      "We'll send another email with tracking info once your order ships.",
      "Reply to this message if you need to make a change — we read every reply.",
    ],
    copyrightName: brandName,
  });

  try {
    const { messageId } = await withMetrics(
      {
        name: "sendgrid.send_email",
        attrs: { kind: "shop_order_confirmation_v1" },
      },
      // Retry up to 2 more times on 5xx / network failures so a brief
      // SendGrid hiccup doesn't drop the customer's order confirmation.
      // 4xx (config / recipient errors) and EmailConfigError are NOT
      // retried — they're permanent and replays would just stack
      // identical failures in the audit log.
      () =>
        withRetry(
          () =>
            client.sendEmail({
              to: toEmail,
              subject,
              html,
              text,
              customArgs: {
                kind: "shop_order_confirmation_v1",
                stripe_session_id: stripeSessionId,
              },
            }),
          {
            attempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1_500,
            isRetriable: (err) => {
              if (err instanceof EmailConfigError) {
                return false;
              }
              if (err instanceof EmailApiError) {
                // Retry only on 5xx and missing-status (network /
                // timeout / DNS — the SDK leaves status undefined when
                // the request never made it to a SendGrid response).
                return err.status === undefined || err.status >= 500;
              }
              // Non-EmailApiError ⇒ likely a thrown TypeError /
              // AbortError from undici. Retry up to 2 more times — if it persists the
              // attempts cap will surface it.
              return true;
            },
          },
        ),
    );
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

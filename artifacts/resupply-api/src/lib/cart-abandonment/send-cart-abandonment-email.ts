// sendCartAbandonmentEmail — single-shot SendGrid nudge for a
// signed-in shop visitor who left items in their cart >24h ago.
//
// Runs from the admin dispatcher (POST /admin/shop/abandoned-carts/
// send-due). Returns a tagged-union outcome so the dispatcher can
// branch without try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Privacy:
//   - The recipient email is never logged.
//   - The cart contents (Stripe price/product IDs, names, qty) are
//     PUBLIC catalog data — safe to render in the body.
//   - We deliberately do NOT include any PHI; this is the cash-pay
//     shop, not the resupply outreach surface, so there's none to
//     leak. The subject line mentions item count only.
//
// Template:
//   - Subject:   "You started an order at {brand} — let's finish through insurance"
//   - HTML body: brand banner, item list (qty × name @ unit price),
//                subtotal, primary CTA "Contact us to finish" linking
//                to /contact (cash-pay cart is retired), footer
//                explaining the one-nudge-per-incomplete-order policy.

import {
  BREATHE_COLORS,
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  lineItemsTable,
  renderBrandedEmail,
  summaryRows,
  textParagraph,
} from "@workspace/resupply-email";

import type { ShopAbandonedCartItem } from "@workspace/resupply-db";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export interface SendCartAbandonmentEmailInput {
  toEmail: string;
  items: readonly ShopAbandonedCartItem[];
  subtotalCents: number;
  currency: string;
  /**
   * Optional override for the public base URL. Defaults to
   * SHOP_PUBLIC_BASE_URL env var, falling back to https://cmbreathe.com
   * so links emitted from preview/staging deploys still resolve to
   * production.
   */
  baseUrlOverride?: string;
  /**
   * Tenant the cart belongs to. When set and the tenant has its own
   * From identity (migration 0360), the nudge is sent under it (G6);
   * otherwise the platform default From is used. Omit / undefined leaves
   * the platform default unchanged.
   */
  orgId?: string;
}

export interface SendCartAbandonmentEmailResult {
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
    // Unknown currency code: fall back to plain "$X.XX".
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

export async function sendCartAbandonmentEmail(
  input: SendCartAbandonmentEmailInput,
): Promise<SendCartAbandonmentEmailResult> {
  const { toEmail, items, subtotalCents, currency } = input;

  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open here (return configured: false) — the dispatcher
      // logs and skips. We never throw on misconfig out of this
      // helper; the admin route surfaces the configured flag so the
      // operator sees the warning.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's cart nudge carries ITS brand.
  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const subject = `You started an order at ${brandName} — let's finish through insurance`;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  const cartUrl = `${base}/contact`;
  const browseUrl = `${base}/insurance`;

  // Plain-text body — many corporate filters drop HTML-only mail.
  const textLines: string[] = [
    `You started an order at ${brandName} but didn't finish. Cash-pay checkout is retired — reply or call and we'll confirm coverage and ship through insurance.`,
    "",
  ];
  for (const it of items) {
    textLines.push(
      `  - ${it.quantity} x ${it.name} (${formatMoney(it.unitAmountCents, it.currency)} each)` +
        (it.mode === "subscription" && it.recurringIntervalLabel
          ? ` -- was recurring every ${it.recurringIntervalLabel}; we now ship on your insurance schedule`
          : ""),
    );
  }
  textLines.push("");
  textLines.push(`Subtotal: ${formatMoney(subtotalCents, currency)}`);
  textLines.push("");
  textLines.push(`Contact us to finish through insurance: ${cartUrl}`);
  textLines.push(`How insurance ordering works: ${browseUrl}`);
  textLines.push("");
  textLines.push(
    `You're receiving this because you started an order at ${brandName}. ` +
      "We send one of these per incomplete order at most.",
  );
  const text = textLines.join("\n");

  // HTML body — chrome comes from the shared CareMetric Breathe email
  // design system; this builder supplies only copy + data.
  const html = renderBrandedEmail({
    brandName,
    heading: "You started an order",
    preheader: `Your list at ${brandName} is still saved — reply and we'll finish through insurance.`,
    contentHtml: [
      textParagraph(
        `You started an order at ${brandName} but didn't finish. Cash-pay checkout is retired — reply or call and we'll confirm coverage and ship through insurance.`,
      ),
      lineItemsTable(
        items.map((it) => ({
          name: it.name,
          detail:
            it.mode === "subscription" && it.recurringIntervalLabel
              ? `Was recurring every ${it.recurringIntervalLabel} — we now ship on your insurance schedule`
              : undefined,
          amount: `${it.quantity} × ${formatMoney(it.unitAmountCents, it.currency)}`,
        })),
      ),
      summaryRows([
        {
          label: "Subtotal",
          value: formatMoney(subtotalCents, currency),
          emphasis: true,
        },
      ]),
    ].join("\n"),
    button: { label: "Contact us to finish", url: cartUrl },
    footerHtml: `<a href="${escapeHtml(browseUrl)}" style="color:${BREATHE_COLORS.blue};text-decoration:underline;">How insurance ordering works</a>`,
    footerLines: [
      `You're receiving this because you started an order at ${brandName}. We send one of these per incomplete order at most.`,
    ],
    copyrightName: brandName,
  });

  try {
    const { messageId } = await client.sendEmail({
      to: toEmail,
      subject,
      html,
      text,
      customArgs: { kind: "cart_abandonment_v1" },
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

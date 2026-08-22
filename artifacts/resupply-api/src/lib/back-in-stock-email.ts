// Back-in-stock notification email — single SendGrid message sent to
// a patient when a SKU they signed up to watch returns to stock.
// Fire-and-forget: if SendGrid is unconfigured or returns an error,
// we still stamp `notified_at` (the patient does not get a second
// chance — if delivery failed for a transient reason ops can re-add
// them; we don't want to spam on every subsequent stock save).
//
// Templated since 2026-05-08: the subject + bodyText + bodyHtml run
// through `renderMessage` with templateKey "shop.back_in_stock.email".
// Admins can edit the copy via /admin/templates without a deploy;
// fallback strings below match the previous behaviour byte-for-byte
// when no template row exists. Because back_in_stock_notifications
// holds (product_id, email) without a shop_customers customerId,
// per-customer overrides don't apply on this surface today —
// customerId is null on every send. Cross-referencing by email at
// lookup time is a separate enhancement.

import {
  EmailApiError,
  EmailConfigError,
  escapeHtml,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";
import { renderMessage } from "@workspace/resupply-templates";

import { messageTemplateLookup } from "./message-templates/lookup";
import { createTenantSendgridClient } from "./email/tenant-sender.js";
import { resolveBrandingByOrgId } from "./tenant-branding.js";

export interface BackInStockEmailPayload {
  email: string;
  productId: string;
  productName: string;
  productImageUrl?: string | null;
  productUrl: string;
  priceLabel?: string | null;
  /**
   * Tenant the signup belongs to. When set and the tenant has its own
   * From identity (migration 0360), the alert is sent under it (G6);
   * otherwise the platform default From is used. Omit / undefined leaves
   * the platform default unchanged.
   */
  orgId?: string;
  /**
   * Tenant storefront brand to render in the copy. Defaults to the
   * CareMetric Breathe platform brand inside the renderers (never the seed
   * tenant's "Penn Home Medical Supply"); sendBackInStockEmail threads the resolved tenant
   * brand here (G6) — for the Penn tenant that resolves to "Penn Home Medical Supply".
   */
  brandName?: string;
}

export interface BackInStockEmailResult {
  configured: boolean;
  delivered: boolean;
  error?: string;
}

/**
 * The HTML img fragment when an image URL is present, empty string
 * otherwise. Pre-rendered so the template body can interpolate
 * `{{image_block_html}}` as a single token rather than carry
 * conditional logic.
 */
export function renderImageBlockHtml(productImageUrl: string | null): string {
  if (!productImageUrl) return "";
  return `<div style="text-align:center;padding:0 0 18px;"><img src="${escapeHtml(
    productImageUrl,
  )}" alt="" width="220" style="display:inline-block;border-radius:10px;max-width:220px;height:auto;" /></div>`;
}

/**
 * The HTML price fragment when a label is present, empty string
 * otherwise. Same shape as `renderImageBlockHtml`.
 */
export function renderPriceBlockHtml(priceLabel: string | null): string {
  if (!priceLabel) return "";
  return `<div style="font-size:18px;font-weight:700;color:#0b1426;margin-top:6px;">${escapeHtml(priceLabel)}</div>`;
}

/**
 * Assemble the branded body. Shared with the SEEDED template row
 * (`seed-bodies.ts`), which calls this with `{{...}}` placeholders in
 * place of the real values — that is what keeps the seeded output
 * byte-identical to this fallback path. Every fragment is concatenated
 * directly (no `filter`/`join`) so an absent image/price block collapses
 * to the same bytes on both paths.
 */
export function backInStockBrandedHtml(parts: {
  /** Goes into escaped slots. Fallback passes the raw brand; the seed
   *  passes `{{brand_name_html}}` (whose value is pre-escaped to match). */
  brandName: string;
  /** Escaped slot. Seed passes `{{product_name_html}}`. */
  productName: string;
  /** Button href. `brandedButton` only quote-escapes, so the seed's
   *  `{{product_url_html}}` must carry the same quote-only escape. */
  productUrl: string;
  /** Verbatim HTML fragment (may be empty). */
  imageBlockHtml: string;
  /** Verbatim HTML fragment (may be empty). */
  priceBlockHtml: string;
  copyrightYear?: number | string;
}): string {
  return renderBrandedEmail({
    brandName: parts.brandName,
    brandTagline: "Back in stock",
    heading: `${parts.productName} is available again`,
    preheader: `${parts.productName} is back in stock at ${parts.brandName}.`,
    contentHtml:
      parts.imageBlockHtml +
      textParagraph(
        `Good news — the item you asked us to watch is back in stock at ${parts.brandName}. Stock can run low quickly, so grab one while it's available.`,
      ) +
      parts.priceBlockHtml,
    button: { label: "View product", url: parts.productUrl },
    footerLines: [
      `You're receiving this because you signed up for a back-in-stock alert at ${parts.brandName}. We'll only email you once per signup.`,
    ],
    copyrightName: parts.brandName,
    ...(parts.copyrightYear === undefined
      ? {}
      : { copyrightYear: parts.copyrightYear }),
  });
}

function renderHtml(p: BackInStockEmailPayload): string {
  const brandName = p.brandName ?? "CareMetric Breathe";
  // Chrome comes from the shared CareMetric Breathe email design system.
  return backInStockBrandedHtml({
    brandName,
    productName: p.productName,
    productUrl: p.productUrl,
    imageBlockHtml: renderImageBlockHtml(p.productImageUrl ?? null),
    priceBlockHtml: renderPriceBlockHtml(p.priceLabel ?? null),
  });
}

function renderText(p: BackInStockEmailPayload): string {
  const brandName = p.brandName ?? "CareMetric Breathe";
  const lines = [
    `${p.productName} is back in stock at ${brandName}.`,
    "",
    "Stock can run low quickly, so grab one while it's available:",
    p.productUrl,
  ];
  if (p.priceLabel) lines.splice(1, 0, p.priceLabel);
  lines.push(
    "",
    `You're receiving this because you signed up for a back-in-stock alert at ${brandName}. We only email once per signup.`,
  );
  return lines.join("\n");
}

/**
 * Build the variable dictionary for the templated path. Variables
 * that go into HTML positions are pre-escaped as `*_html` siblings —
 * the template author chooses the right one for each context. Same
 * pattern we'd use for any future HTML template wrap.
 */
function buildVariables(p: BackInStockEmailPayload): Record<string, string> {
  const brandName = p.brandName ?? "CareMetric Breathe";
  return {
    product_name: p.productName,
    product_name_html: escapeHtml(p.productName),
    product_url: p.productUrl,
    // Href slot: `brandedButton` only quote-escapes, so this must too —
    // a full escapeHtml would turn `&` into `&amp;` and break parity.
    product_url_html: p.productUrl.replace(/"/g, "&quot;"),
    price_label: p.priceLabel ?? "",
    // Tenant storefront brand (resolved by sendBackInStockEmail; the
    // neutral platform identity when unset) — same value the fallback
    // renderers interpolate, so the seeded template stays byte-identical.
    brand_name: brandName,
    brand_name_html: escapeHtml(brandName),
    image_block_html: renderImageBlockHtml(p.productImageUrl ?? null),
    price_block_html: renderPriceBlockHtml(p.priceLabel ?? null),
    copyright_year: String(new Date().getFullYear()),
    // Pre-rendered conditional line for the PLAIN-TEXT body: the price on
    // its own line (with trailing newline) when present, empty otherwise —
    // renderText omits the line entirely when there is no price, and the
    // {{var}}-only template engine can't express that conditional.
    price_line_text: p.priceLabel ? `${p.priceLabel}\n` : "",
  };
}

export async function sendBackInStockEmail(
  payload: BackInStockEmailPayload,
): Promise<BackInStockEmailResult> {
  let client;
  try {
    // Send under the tenant's own From identity when configured (G6);
    // falls back to the platform default when it isn't / orgId is unset.
    client = await createTenantSendgridClient(payload.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  // Brand the email with the tenant's own storefront name (G6). For the seed
  // tenant this resolves to "Penn Home Medical Supply" (its stored brand), so single-tenant
  // copy is unchanged; a second tenant's alert carries ITS brand.
  const brand = await resolveBrandingByOrgId(payload.orgId);
  const renderPayload: BackInStockEmailPayload = {
    ...payload,
    brandName: brand.storefrontName,
  };

  // Fallback strings preserve byte-for-byte the prior behaviour when
  // no template row exists or the lookup fails.
  const rendered = await renderMessage(
    {
      templateKey: "shop.back_in_stock.email",
      channel: "email",
      // Per the file header: this surface keys on (product_id, email)
      // without a shop_customers id, so per-customer overrides don't
      // apply today.
      customerId: null,
      orgId: payload.orgId,
      // The brand-resolved payload, so {{brand_name}} in a template row
      // carries the tenant's storefront brand exactly like the fallback.
      variables: buildVariables(renderPayload),
    },
    {
      subject: `Back in stock: ${payload.productName}`,
      bodyHtml: renderHtml(renderPayload),
      bodyText: renderText(renderPayload),
    },
    messageTemplateLookup,
  );

  try {
    await client.sendEmail({
      to: payload.email,
      subject: rendered.subject ?? "",
      html: rendered.bodyHtml ?? rendered.bodyText,
      text: rendered.bodyText,
      customArgs: {
        kind: "back_in_stock_v1",
        product_id: payload.productId,
      },
    });
    return { configured: true, delivered: true };
  } catch (err) {
    const msg =
      err instanceof EmailApiError
        ? `SendGrid ${err.status ?? "?"}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { configured: true, delivered: false, error: msg };
  }
}

// Test seam: re-export the pure renderers so the parity test can
// assert byte-identical fallback output. Keeping them un-exported
// from the module's public surface (only needed in tests) is
// possible but adds friction with the build chain; the test
// imports them via this named export.
export const __forTests = {
  renderHtml,
  renderText,
  buildVariables,
};

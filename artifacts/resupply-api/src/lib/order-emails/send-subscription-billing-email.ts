// sendSubscriptionBillingEmail — transactional notices for a storefront
// Subscribe & Save subscription's billing lifecycle.
//
// Two kinds, both fired from the Stripe webhook handler:
//   - "renewing_soon" — invoice.upcoming, an advance heads-up that the
//     card on file will be charged on the renewal date.
//   - "receipt"       — invoice.paid (billing_reason = subscription_cycle),
//     a payment receipt for an auto-renewal that already succeeded.
//
// (The initial subscription invoice — billing_reason subscription_create —
// is intentionally NOT receipted here: the Subscribe & Save checkout
// already sends an order confirmation, so a receipt would duplicate it.)
//
// Returns a tagged-union outcome so the caller can branch without
// try/catch:
//   { configured: false }                        — SendGrid not wired
//   { configured: true, delivered: true, ... }   — sent
//   { configured: true, delivered: false, error } — SendGrid 4xx/5xx
//
// Idempotency lives at the call site (the webhook's event-id gate in
// stripe_webhook_events dedupes redelivered events), so this helper does
// no claiming of its own.
//
// Privacy: the recipient email is never logged. Amounts, renewal dates,
// and the card last4 are the customer's own billing data — safe to render
// to the customer. No PHI (this is the cash-pay shop billing surface).

import {
  EmailApiError,
  EmailConfigError,
  renderBrandedEmail,
  textParagraph,
} from "@workspace/resupply-email";

import { createTenantSendgridClient } from "../email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../tenant-branding.js";

const DEFAULT_BASE_URL = "https://cmbreathe.com";

export type SubscriptionBillingEmailKind = "renewing_soon" | "receipt";

export interface SendSubscriptionBillingEmailInput {
  /** Recipient email — required. Caller resolves; helper does not look up. */
  toEmail: string;
  kind: SubscriptionBillingEmailKind;
  /** Invoice amount in the smallest currency unit (cents). */
  amountCents: number | null;
  currency: string | null;
  /**
   * Renewal/charge date as an ISO string. Used by "renewing_soon" (when
   * the upcoming charge lands) and "receipt" (when payment was taken).
   * Optional — the copy degrades gracefully when absent.
   */
  chargeDateIso?: string | null;
  /** Optional override for the manage-billing link's base URL. */
  baseUrlOverride?: string;
  /**
   * Tenant the subscription belongs to. When set and the tenant has its
   * own From identity (migration 0360) the email is sent under it (G6)
   * and the copy carries the tenant's storefront brand; otherwise the
   * platform default From/brand is used.
   */
  orgId?: string;
}

export interface SendSubscriptionBillingEmailResult {
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

/** cents → "$12.34" (USD) or "12.34 EUR". null → "your balance". */
export function formatBillingAmount(
  cents: number | null,
  currency: string | null,
): string {
  if (cents == null) return "your balance";
  const major = (cents / 100).toFixed(2);
  const cur = (currency ?? "usd").toUpperCase();
  return cur === "USD" ? `$${major}` : `${major} ${cur}`;
}

/** ISO → "June 30, 2026" (deterministic: en-US, UTC). null → null. */
export function formatBillingDate(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

interface KindCopy {
  subject: string;
  banner: string;
  intro: string;
  /** CTA button label for the manage-billing link. */
  cta: string;
  /** Accent color for the banner border + button. */
  accent: string;
  /** Footer note. */
  footer: string;
}

function copyFor(
  kind: SubscriptionBillingEmailKind,
  brandName: string,
  amount: string,
  date: string | null,
): KindCopy {
  if (kind === "renewing_soon") {
    const when = date ? `on ${date}` : "soon";
    return {
      subject: `Your ${brandName} supply schedule (${when})`,
      banner: "Supply schedule",
      intro:
        `Cash-pay Subscribe & Save is retired at ${brandName}. ` +
        `If you previously had an auto-ship plan that was set to renew ${when} (${amount}), ` +
        `reply or call and we'll move you onto an insurance resupply schedule instead. ` +
        `We will not charge a patient card for supplies.`,
      cta: "Contact us about resupply",
      accent: "#1d4ed8",
      footer:
        "Need help with coverage, quantities, or timing? Use the button above and a team member will help.",
    };
  }
  // receipt — historical cash-pay renewals only; no new patient charges.
  const when = date ? ` on ${date}` : "";
  return {
    subject: `About a past ${brandName} supply payment`,
    banner: "Past payment notice",
    intro:
      `We recorded a ${amount} payment${when} on a retired cash-pay auto-ship plan at ${brandName}. ` +
      `New supplies ship through insurance — reply if you need a statement or want to set up reminders.`,
    cta: "Contact us",
    accent: "#1f8a4c",
    footer:
      "Questions about this notice? Just reply to this message and we'll help.",
  };
}

export async function sendSubscriptionBillingEmail(
  input: SendSubscriptionBillingEmailInput,
): Promise<SendSubscriptionBillingEmailResult> {
  const { toEmail, kind } = input;

  let client;
  try {
    client = await createTenantSendgridClient(input.orgId);
  } catch (err) {
    if (err instanceof EmailConfigError) {
      // Fail-open (configured:false) — the caller logs and skips. A
      // missing SendGrid key must NOT fail the billing webhook.
      return { configured: false, delivered: false, error: err.message };
    }
    throw err;
  }

  const brand = await resolveBrandingByOrgId(input.orgId);
  const brandName = brand.storefrontName;

  const base = publicBaseUrl(
    input.baseUrlOverride ??
      (await resolveTenantBaseUrl(input.orgId)) ??
      undefined,
  );
  // Durable contact link — cash-pay Subscribe & Save / Stripe Customer
  // Portal are retired; patients finish through insurance with staff help.
  const manageUrl = `${base}/contact`;

  const amount = formatBillingAmount(input.amountCents, input.currency);
  const date = formatBillingDate(input.chargeDateIso);
  const c = copyFor(kind, brandName, amount, date);

  // ---------- text body ----------
  const text = [c.intro, "", `${c.cta}: ${manageUrl}`, "", c.footer].join("\n");

  // ---------- html body ----------
  // Chrome comes from the shared CareMetric Breathe email design system;
  // this builder supplies only copy. The per-kind accent still tints the
  // CTA so "renewing soon" and "payment received" stay distinguishable.
  const html = renderBrandedEmail({
    brandName,
    heading: c.banner,
    preheader: c.intro,
    contentHtml: textParagraph(c.intro),
    button: { label: c.cta, url: manageUrl },
    accent: c.accent,
    footerLines: [c.footer],
    copyrightName: brandName,
  });

  try {
    const { messageId } = await client.sendEmail({
      to: toEmail,
      subject: c.subject,
      html,
      text,
      customArgs: {
        kind: `shop_subscription_${kind}_v1`,
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

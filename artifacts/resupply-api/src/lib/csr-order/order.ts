// Shared helpers for CSR-created signature orders.
//
// Used by both the admin routes (create / resend / cancel / list) and the
// public token-gated routes (view / sign) so the two surfaces can never
// drift on: the paperwork snapshot shape, the signing-link format, and the
// invite copy.
//
// Nothing is charged here. The patient signs the required paperwork
// (assignment of benefits, delivery confirmation) and the order is billed
// to their insurance through the claims pipeline — there is no cash-pay
// checkout, so this flow collects a signature, not a payment.
//
// PHI / logging posture: invite emails and SMS contain the link only —
// order line items are patient-facing but are never logged; signature
// images are persisted, never logged.

import { randomInt } from "node:crypto";

import { type Json, type OrgScopedClient } from "@workspace/resupply-db";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { getAuthDeps } from "../auth-deps";
import { createTenantSendgridClient } from "../email/tenant-sender.js";
import { logger } from "../logger";
import { resolveTenantSmsClientOptions } from "../messaging/tenant-telecom";
import { recordOutboundMessageUsage } from "../metering/usage";
import { resolveTenantLinkBaseUrl } from "../tenant-branding";
import { resolveCompanyProfile } from "../patient-packet/company";
import {
  effectiveTemplateContent,
  loadTemplateOverrides,
} from "../patient-packet/content";
import {
  getPacketTemplate,
  isValidPacketDocumentKey,
  type PacketDocumentSection,
} from "../patient-packet/templates";
import { signCsrOrderToken } from "./token";
import {
  escapeHtml,
  paragraph,
  renderBrandedEmail,
} from "@workspace/resupply-email";

type SupabaseClient = OrgScopedClient;

export const DEFAULT_CSR_ORDER_TTL_DAYS = 30;

/** One free-form line item priced by the CSR (cents, USD). */
export interface CsrOrderItem {
  description: string;
  quantity: number;
  unitAmountCents: number;
}

/** Send-time paperwork snapshot (token-form sections — merge tokens
 *  resolve at render time, same model as patient_packet_documents). */
export interface CsrOrderDocumentSnapshot {
  key: string;
  title: string;
  category: string;
  requiresSignature: boolean;
  version: string;
  sections: PacketDocumentSection[];
}

export function computeAmountTotalCents(items: CsrOrderItem[]): number {
  return items.reduce((sum, it) => sum + it.unitAmountCents * it.quantity, 0);
}

/** Human-friendly unique reference, e.g. ORD-7K3M2Q. The unambiguous
 *  alphabet (no 0/O/1/I) keeps it readable over the phone; the UNIQUE
 *  constraint catches the astronomically-unlikely collision. */
export function generateCsrOrderReference(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += alphabet[randomInt(alphabet.length)];
  return `ORD-${suffix}`;
}

/**
 * Snapshot the selected paperwork documents from the patient-packet
 * template catalog (operator overrides folded in, token form). Choice
 * documents (e.g. the ABN's Option 1/2/3) are not supported on the
 * order flow — they're rejected here as invalid keys.
 */
export async function snapshotOrderDocuments(
  supabase: SupabaseClient,
  documentKeys: string[],
): Promise<
  | { ok: true; documents: CsrOrderDocumentSnapshot[] }
  | { ok: false; invalidKeys: string[] }
> {
  const invalidKeys = documentKeys.filter(
    (k) =>
      !isValidPacketDocumentKey(k) || Boolean(getPacketTemplate(k)?.choice),
  );
  if (invalidKeys.length > 0) return { ok: false, invalidKeys };
  if (documentKeys.length === 0) return { ok: true, documents: [] };

  const overrides = await loadTemplateOverrides(supabase);
  const documents: CsrOrderDocumentSnapshot[] = [];
  for (const key of documentKeys) {
    const template = getPacketTemplate(key)!;
    const effective = effectiveTemplateContent(key, overrides);
    documents.push({
      key,
      title: effective?.title ?? template.title,
      category: template.category,
      requiresSignature: template.requiresSignature,
      version: effective?.version ?? template.version,
      sections: effective?.sections ?? [],
    });
  }
  return { ok: true, documents };
}

export function parseOrderItems(raw: Json): CsrOrderItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((it) => {
    const o = it as {
      description?: unknown;
      quantity?: unknown;
      unitAmountCents?: unknown;
    } | null;
    if (
      !o ||
      typeof o.description !== "string" ||
      typeof o.quantity !== "number" ||
      typeof o.unitAmountCents !== "number"
    ) {
      return [];
    }
    return [
      {
        description: o.description,
        quantity: o.quantity,
        unitAmountCents: o.unitAmountCents,
      },
    ];
  });
}

export function parseOrderDocuments(raw: Json): CsrOrderDocumentSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d) => {
    const o = d as {
      key?: unknown;
      title?: unknown;
      category?: unknown;
      requiresSignature?: unknown;
      version?: unknown;
      sections?: unknown;
    } | null;
    if (!o || typeof o.key !== "string" || typeof o.title !== "string") {
      return [];
    }
    return [
      {
        key: o.key,
        title: o.title,
        category: typeof o.category === "string" ? o.category : "consent",
        requiresSignature: o.requiresSignature !== false,
        version: typeof o.version === "string" ? o.version : "v1",
        sections: Array.isArray(o.sections)
          ? (o.sections as PacketDocumentSection[])
          : [],
      },
    ];
  });
}

/**
 * Mint a patient `/order-sign` link. Prefer the tenant's verified custom
 * domain so SMS/email invites land on the tenant host, not the platform
 * Railway / cmbreathe fallback. Returns null when a non-seed tenant has
 * no verified domain (callers must refuse rather than mint a wrong-org
 * platform link). When `orgId` is unset, falls back to the platform
 * public base for legacy/test callers.
 */
export async function buildCsrOrderSigningLink(
  orderRequestId: string,
  linkVersion: number,
  ttlSeconds = DEFAULT_CSR_ORDER_TTL_DAYS * 24 * 60 * 60,
  orgId?: string | null,
): Promise<string | null> {
  const token = signCsrOrderToken(orderRequestId, linkVersion, ttlSeconds);
  const platform = getAuthDeps().publicBaseUrl;
  const base = !orgId?.trim()
    ? platform.replace(/\/$/, "")
    : await resolveTenantLinkBaseUrl(orgId, platform);
  if (!base) return null;
  return `${base}/order-sign?token=${encodeURIComponent(token)}`;
}

/**
 * Deliver the signature invite over email and/or SMS. Best-effort per
 * channel: a missing contact point, an unconfigured vendor, or a send
 * error leaves that channel's flag false without throwing — the CSR
 * can always copy the link from the admin UI instead.
 */
export async function deliverCsrOrderInvite(input: {
  supabase: SupabaseClient;
  customerName: string;
  email: string | null;
  phone: string | null;
  link: string;
  orderReference: string;
  hasDocuments: boolean;
  reminder?: boolean;
  /** For log correlation only. */
  orderRequestId?: string;
}): Promise<{ emailSent: boolean; smsSent: boolean }> {
  if (!input.email && !input.phone) {
    return { emailSent: false, smsSent: false };
  }
  const company = await resolveCompanyProfile(input.supabase);

  let emailSent = false;
  if (input.email) {
    try {
      // Send via createSendgridClient() directly (not getAuthDeps().email,
      // which swallows EmailConfigError/EmailApiError and resolves anyway)
      // so an unconfigured provider or a vendor reject surfaces as a throw.
      // That keeps emailSent — and the usage metering below — gated on a
      // genuinely accepted send, never an over-count during a config gap.
      const client = await createTenantSendgridClient(input.supabase.orgId);
      await client.sendEmail({
        to: input.email,
        subject: input.reminder
          ? `Reminder: complete your ${company.legalName} order ${input.orderReference}`
          : `Your ${company.legalName} order ${input.orderReference} — review & sign`,
        html: renderOrderInviteHtml({
          company: company.legalName,
          customerName: input.customerName,
          link: input.link,
          orderReference: input.orderReference,
          hasDocuments: input.hasDocuments,
        }),
        text: renderOrderInviteText({
          company: company.legalName,
          customerName: input.customerName,
          link: input.link,
          orderReference: input.orderReference,
          hasDocuments: input.hasDocuments,
        }),
      });
      emailSent = true;
      recordOutboundMessageUsage({
        orgId: input.supabase.orgId,
        channel: "email",
        source: "csr_order_invite",
      });
    } catch (err) {
      logger.warn(
        {
          err: err instanceof Error ? err : new Error(String(err)),
          order_request_id: input.orderRequestId,
        },
        "csr order invite email failed",
      );
    }
  }

  let smsSent = false;
  if (input.phone) {
    const accountSid = process.env.TWILIO_ACCOUNT_SID ?? null;
    const authToken = process.env.TWILIO_AUTH_TOKEN ?? null;
    const from = process.env.TWILIO_PHONE_NUMBER ?? null;
    const messagingServiceSid =
      process.env.TWILIO_MESSAGING_SERVICE_SID ?? null;
    // Send under the tenant's own number / Messaging Service when it has one
    // (G7); falls back to the platform env default otherwise. Resolved before
    // the guard so a tenant routable via its DB sender still sends even when
    // the platform env has no default from-number/Messaging Service.
    const tenantSms = await resolveTenantSmsClientOptions(input.supabase.orgId);
    if (
      accountSid &&
      authToken &&
      (from ||
        messagingServiceSid ||
        tenantSms.from ||
        tenantSms.messagingServiceSid)
    ) {
      const body =
        `${company.legalName}: your order ${input.orderReference} is ready. ` +
        `Review${input.hasDocuments ? " & sign" : ""} securely here: ${input.link}` +
        ` Reply STOP to opt out.`;
      try {
        const client = createTwilioSmsClient({
          accountSid,
          authToken,
          from: tenantSms.from ?? from ?? undefined,
          messagingServiceSid:
            tenantSms.messagingServiceSid ?? messagingServiceSid ?? undefined,
        });
        await client.sendSms({ to: input.phone, body: body.slice(0, 480) });
        smsSent = true;
        recordOutboundMessageUsage({
          orgId: input.supabase.orgId,
          channel: "sms",
          source: "csr_order_invite",
        });
      } catch (err) {
        logger.warn(
          {
            err: err instanceof Error ? err : new Error(String(err)),
            order_request_id: input.orderRequestId,
          },
          "csr order invite SMS failed",
        );
      }
    }
  }

  return { emailSent, smsSent };
}

function renderOrderInviteHtml(input: {
  company: string;
  customerName: string;
  link: string;
  orderReference: string;
  hasDocuments: boolean;
}): string {
  const safeName = escapeHtml(input.customerName);
  const steps = input.hasDocuments
    ? "review your order and sign the required paperwork"
    : "review and confirm your order";
  // Chrome comes from the shared CareMetric Breathe email design system.
  // `input.company` goes into slots the layout escapes itself — pass it
  // raw or it double-escapes.
  return renderBrandedEmail({
    brandName: input.company,
    heading: `Order ${input.orderReference}`,
    preheader: `We've prepared order ${input.orderReference} for you.`,
    contentHtml: [
      paragraph(`Hello ${safeName},`),
      paragraph(
        `We&#39;ve prepared order <strong>${escapeHtml(
          input.orderReference,
        )}</strong> for you. Please ${steps}. It only takes a few minutes on any phone, tablet, or computer.`,
      ),
    ].join("\n"),
    button: { label: "Review & complete my order", url: input.link },
    footerLines: [
      `If the button doesn't work, copy and paste this link into your browser: ${input.link}`,
      "This is a secure, personalized link. Please don't forward it. If you didn't expect this message, you can ignore it.",
    ],
    copyrightName: input.company,
  });
}

function renderOrderInviteText(input: {
  company: string;
  customerName: string;
  link: string;
  orderReference: string;
  hasDocuments: boolean;
}): string {
  const steps = input.hasDocuments
    ? "review your order and sign the required paperwork"
    : "review and confirm your order";
  return [
    `${input.company}`,
    "",
    `Hello ${input.customerName},`,
    "",
    `We've prepared order ${input.orderReference} for you. Please ${steps}. It only takes a few minutes on any device.`,
    "",
    `Review & complete: ${input.link}`,
    "",
    "This is a secure, personalized link. Please don't forward it.",
  ].join("\n");
}

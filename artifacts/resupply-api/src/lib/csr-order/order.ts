// Shared helpers for CSR-created "sign & pay" orders.
//
// Used by both the admin routes (create / resend / cancel / list) and
// the public token-gated routes (view / sign / checkout) so the two
// surfaces can never drift on: the paperwork snapshot shape, the
// signing-link format, the invite copy, and how payment state is
// derived from the mirrored shop_orders row.
//
// PHI / logging posture: invite emails and SMS contain the link only —
// order line items are patient-facing but are never logged; signature
// images are persisted, never logged.

import { randomInt } from "node:crypto";

import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import { createTwilioSmsClient } from "@workspace/resupply-telecom";

import { getAuthDeps } from "../auth-deps";
import { logger } from "../logger";
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

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

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

export function buildCsrOrderSigningLink(
  orderRequestId: string,
  linkVersion: number,
  ttlSeconds = DEFAULT_CSR_ORDER_TTL_DAYS * 24 * 60 * 60,
): string {
  const token = signCsrOrderToken(orderRequestId, linkVersion, ttlSeconds);
  const base = getAuthDeps().publicBaseUrl.replace(/\/$/, "");
  return `${base}/order-pay?token=${encodeURIComponent(token)}`;
}

/** Payment state derived from the mirrored shop_orders row (the Stripe
 *  charge webhook owns the status flip — see lib/stripe/webhook-handler). */
export interface CsrOrderPaymentState {
  status: "not_started" | "pending" | "paid" | "refunded";
  paidAt: string | null;
  shopOrderId: string | null;
}

export async function lookupPaymentState(
  supabase: SupabaseClient,
  stripeSessionId: string | null,
): Promise<CsrOrderPaymentState> {
  if (!stripeSessionId) {
    return { status: "not_started", paidAt: null, shopOrderId: null };
  }
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, status, paid_at")
    .eq("stripe_session_id", stripeSessionId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { status: "not_started", paidAt: null, shopOrderId: null };
  if (data.status === "paid") {
    return { status: "paid", paidAt: data.paid_at, shopOrderId: data.id };
  }
  if (data.status === "refunded") {
    return { status: "refunded", paidAt: data.paid_at, shopOrderId: data.id };
  }
  return { status: "pending", paidAt: null, shopOrderId: data.id };
}

/** Batch variant for the admin list view: session id → payment state. */
export async function lookupPaymentStates(
  supabase: SupabaseClient,
  stripeSessionIds: string[],
): Promise<Map<string, CsrOrderPaymentState>> {
  const map = new Map<string, CsrOrderPaymentState>();
  if (stripeSessionIds.length === 0) return map;
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, stripe_session_id, status, paid_at")
    .in("stripe_session_id", stripeSessionIds);
  if (error) throw error;
  for (const row of data ?? []) {
    map.set(row.stripe_session_id, {
      status:
        row.status === "paid"
          ? "paid"
          : row.status === "refunded"
            ? "refunded"
            : "pending",
      paidAt: row.status === "paid" ? row.paid_at : null,
      shopOrderId: row.id,
    });
  }
  return map;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Deliver the sign-&-pay invite over email and/or SMS. Best-effort per
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
  amountTotalCents: number;
  hasDocuments: boolean;
  reminder?: boolean;
  /** For log correlation only. */
  orderRequestId?: string;
}): Promise<{ emailSent: boolean; smsSent: boolean }> {
  if (!input.email && !input.phone) {
    return { emailSent: false, smsSent: false };
  }
  const company = await resolveCompanyProfile(input.supabase);
  const amount = formatUsd(input.amountTotalCents);

  let emailSent = false;
  if (input.email) {
    try {
      await getAuthDeps().email({
        to: input.email,
        subject: input.reminder
          ? `Reminder: complete your ${company.legalName} order ${input.orderReference}`
          : `Your ${company.legalName} order ${input.orderReference} — review, sign & pay`,
        html: renderOrderInviteHtml({
          company: company.legalName,
          customerName: input.customerName,
          link: input.link,
          orderReference: input.orderReference,
          amount,
          hasDocuments: input.hasDocuments,
        }),
        text: renderOrderInviteText({
          company: company.legalName,
          customerName: input.customerName,
          link: input.link,
          orderReference: input.orderReference,
          amount,
          hasDocuments: input.hasDocuments,
        }),
      });
      emailSent = true;
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
    if (accountSid && authToken && (from || messagingServiceSid)) {
      const body =
        `${company.legalName}: your order ${input.orderReference} (${amount}) is ready. ` +
        `Review${input.hasDocuments ? ", sign" : ""} & pay securely here: ${input.link}` +
        ` Reply STOP to opt out.`;
      try {
        const client = createTwilioSmsClient({
          accountSid,
          authToken,
          from: from ?? undefined,
          messagingServiceSid: messagingServiceSid ?? undefined,
        });
        await client.sendSms({ to: input.phone, body: body.slice(0, 480) });
        smsSent = true;
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
  amount: string;
  hasDocuments: boolean;
}): string {
  const safeName = escapeHtml(input.customerName);
  const safeCompany = escapeHtml(input.company);
  const steps = input.hasDocuments
    ? "review your order, sign the required paperwork, and complete your payment"
    : "review your order and complete your payment";
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#ffffff;border-radius:16px;padding:32px;border:1px solid #e2e8f0">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${safeCompany}</h1>
      <p style="font-size:15px;line-height:1.55">Hello ${safeName},</p>
      <p style="font-size:15px;line-height:1.55">We've prepared order <strong>${escapeHtml(input.orderReference)}</strong> for you (total <strong>${escapeHtml(input.amount)}</strong>). Please ${steps}. It only takes a few minutes on any phone, tablet, or computer.</p>
      <p style="text-align:center;margin:28px 0">
        <a href="${input.link}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:14px 28px;border-radius:9999px;font-weight:bold;font-size:15px">Review &amp; complete my order</a>
      </p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">If the button doesn't work, copy and paste this link into your browser:<br><span style="word-break:break-all;color:#334155">${input.link}</span></p>
      <p style="font-size:13px;color:#64748b;line-height:1.5">This is a secure, personalized link. Please don't forward it. If you didn't expect this message, you can ignore it.</p>
    </div>
  </div></body></html>`;
}

function renderOrderInviteText(input: {
  company: string;
  customerName: string;
  link: string;
  orderReference: string;
  amount: string;
  hasDocuments: boolean;
}): string {
  const steps = input.hasDocuments
    ? "review your order, sign the required paperwork, and complete your payment"
    : "review your order and complete your payment";
  return [
    `${input.company}`,
    "",
    `Hello ${input.customerName},`,
    "",
    `We've prepared order ${input.orderReference} for you (total ${input.amount}). Please ${steps}. It only takes a few minutes on any device.`,
    "",
    `Review & complete: ${input.link}`,
    "",
    "This is a secure, personalized link. Please don't forward it.",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

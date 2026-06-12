// Public CSR-order "sign & pay" endpoints (no login — the HMAC token
// is the auth).
//
//   GET  /csr-orders/view?token=...  — fetch the order + paperwork for
//                                      the review/sign/pay UI
//   POST /csr-orders/sign            — submit the e-signature
//   POST /csr-orders/checkout        — mint a Stripe Hosted Checkout
//                                      Session (only after signing)
//
// Mounted inside the storefront router (BEFORE attachSignedIn) so the
// cpap-fitter SPA reaches it at /api/csr-orders/*. The signing body
// can carry a drawn-signature PNG data URL; a dedicated 1 MB JSON
// parser is mounted for /api/csr-orders/sign in app.ts (the global
// parser caps at 100 KB).
//
// Payment model: the Checkout Session is mirrored into
// resupply.shop_orders exactly like /shop/checkout, so the existing
// charge webhook flips it to paid and the normal fulfillment
// lifecycle applies. The signature gate is enforced server-side here —
// /checkout refuses until the order is signed.
//
// PHI / logging posture: the signature image is the signed artifact —
// it is persisted but NEVER logged. Order line items are never logged.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  lookupPaymentState,
  parseOrderDocuments,
  parseOrderItems,
} from "../../lib/csr-order/order";
import { verifyCsrOrderToken } from "../../lib/csr-order/token";
import { logger } from "../../lib/logger";
import { resolveCompanyProfile } from "../../lib/patient-packet/company";
import { renderPacketDocumentSections } from "../../lib/patient-packet/content";
import {
  SHOP_UNAVAILABLE_BODY,
  getStripeClient,
  readStripeConfigOrNull,
} from "../../lib/stripe/config";
import { stripeErrLogFields } from "../../lib/stripe/err-log-fields";

const router: IRouter = Router();

const viewLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const mutateLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const SIGNATURE_MAX_CHARS = 90_000; // keeps the body within the parser cap

type ResolvedOrderRow = {
  id: string;
  order_reference: string;
  status: "sent" | "viewed" | "signed" | "canceled";
  customer_name: string;
  customer_email: string | null;
  items: unknown;
  amount_total_cents: number;
  currency: string;
  note_to_customer: string | null;
  documents: unknown;
  link_version: number;
  expires_at: string | null;
  signed_at: string | null;
  signer_name: string | null;
  stripe_session_id: string | null;
};

const ORDER_COLUMNS =
  "id, order_reference, status, customer_name, customer_email, items, amount_total_cents, currency, note_to_customer, documents, link_version, expires_at, signed_at, signer_name, stripe_session_id";

// Verify a token against a freshly-loaded order row. Returns the order
// when the link is valid + open, or an error code to surface.
async function resolveOpenOrder(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  token: string,
): Promise<
  | { ok: true; order: ResolvedOrderRow }
  | { ok: false; code: "invalid" | "not_found" | "expired" | "canceled" }
> {
  const verified = verifyCsrOrderToken(token);
  if (!verified.valid) return { ok: false, code: "invalid" };

  const { data: order, error } = await supabase
    .schema("resupply")
    .from("csr_order_requests")
    .select(ORDER_COLUMNS)
    .eq("id", verified.orderRequestId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!order) return { ok: false, code: "not_found" };
  // A stale link (re-issued / canceled) carries an old version.
  if (order.link_version !== verified.linkVersion) {
    return { ok: false, code: "invalid" };
  }
  if (order.status === "canceled") return { ok: false, code: "canceled" };
  if (order.expires_at && new Date(order.expires_at).getTime() < Date.now()) {
    return { ok: false, code: "expired" };
  }
  return { ok: true, order: order as ResolvedOrderRow };
}

function errorStatus(code: "invalid" | "not_found" | "expired" | "canceled") {
  return code === "not_found" ? 404 : 410;
}

// ── GET /csr-orders/view ──────────────────────────────────────────
router.get("/csr-orders/view", viewLimiter, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token || token.length > 600) {
    res.status(400).json({ error: "missing_token" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolveOpenOrder(supabase, token);
  if (!resolved.ok) {
    res.status(errorStatus(resolved.code)).json({ error: resolved.code });
    return;
  }
  const order = resolved.order;

  const company = await resolveCompanyProfile(supabase);
  const payment = await lookupPaymentState(supabase, order.stripe_session_id);

  // First view? Stamp it (best-effort; never blocks the read).
  if (order.status === "sent") {
    const { error: viewStampErr } = await supabase
      .schema("resupply")
      .from("csr_order_requests")
      .update({
        status: "viewed",
        first_viewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("status", "sent");
    if (viewStampErr) {
      logger.warn(
        { err: viewStampErr, orderRequestId: order.id },
        "csr-orders.view: first-view stamp failed (non-fatal)",
      );
    }
  }

  const documents = parseOrderDocuments(
    order.documents as Parameters<typeof parseOrderDocuments>[0],
  );

  res.json({
    status: "open",
    orderReference: order.order_reference,
    customerName: order.customer_name,
    items: parseOrderItems(
      order.items as Parameters<typeof parseOrderItems>[0],
    ),
    amountTotalCents: order.amount_total_cents,
    currency: order.currency,
    note: order.note_to_customer,
    company: {
      legalName: company.legalName,
      phone: company.phone,
      email: company.email,
    },
    documents: documents.map((d) => ({
      key: d.key,
      title: d.title,
      category: d.category,
      requiresSignature: d.requiresSignature,
      // Send-time snapshot (merge tokens resolved here against live
      // company data + this order's recipient).
      sections: renderPacketDocumentSections({
        documentKey: d.key,
        storedSections: d.sections,
        company,
        recipientName: order.customer_name,
        recipientEmail: order.customer_email,
        deliveryDetails: { orderRef: order.order_reference },
      }),
    })),
    signed: Boolean(order.signed_at),
    signedAt: order.signed_at,
    payment: { status: payment.status, paidAt: payment.paidAt },
  });
});

// ── POST /csr-orders/sign ─────────────────────────────────────────
const signBody = z
  .object({
    token: z.string().min(10).max(600),
    signerName: z.string().trim().min(2).max(160),
    signatureImage: z
      .string()
      .max(SIGNATURE_MAX_CHARS)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u)
      .optional()
      .nullable(),
    consentEsign: z.literal(true),
    acknowledgedDocumentKeys: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

router.post("/csr-orders/sign", mutateLimiter, async (req, res) => {
  const parsed = signBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const b = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolveOpenOrder(supabase, b.token);
  if (!resolved.ok) {
    res.status(errorStatus(resolved.code)).json({ error: resolved.code });
    return;
  }
  const order = resolved.order;
  if (order.signed_at) {
    res.status(409).json({ error: "already_signed" });
    return;
  }

  // Every paperwork document must be acknowledged before signing.
  const documents = parseOrderDocuments(
    order.documents as Parameters<typeof parseOrderDocuments>[0],
  );
  const ackedKeys = new Set(b.acknowledgedDocumentKeys);
  const missing = documents.map((d) => d.key).filter((k) => !ackedKeys.has(k));
  if (missing.length > 0) {
    res.status(400).json({ error: "documents_not_acknowledged", missing });
    return;
  }

  const nowIso = new Date().toISOString();
  const ip = req.ip ?? null;
  const userAgent = (req.get("user-agent") ?? "").slice(0, 500) || null;

  // Optimistic guard against a double-submit: only flip rows that are
  // still unsigned. The link stays valid (same version) so the
  // customer can continue straight to payment.
  const { data: updated, error: updErr } = await supabase
    .schema("resupply")
    .from("csr_order_requests")
    .update({
      status: "signed",
      signed_at: nowIso,
      signer_name: b.signerName,
      signature_image: b.signatureImage ?? null,
      signer_ip: ip,
      signer_user_agent: userAgent,
      consent_esign: true,
      updated_at: nowIso,
    })
    .eq("id", order.id)
    .is("signed_at", null)
    .select("id");
  if (updErr) throw updErr;
  if (!updated || updated.length === 0) {
    res.status(409).json({ error: "already_signed" });
    return;
  }

  await logAudit({
    action: "csr_order.signed",
    targetTable: "csr_order_requests",
    targetId: order.id,
    metadata: {
      document_count: documents.length,
      has_drawn_signature: Boolean(b.signatureImage),
    },
    ip,
    userAgent,
  }).catch((err) => {
    logger.warn({ err }, "csr_order.signed audit write failed");
  });

  res.json({ status: "signed", signedAt: nowIso });
});

// ── POST /csr-orders/checkout ─────────────────────────────────────
const checkoutBody = z.object({ token: z.string().min(10).max(600) }).strict();

router.post("/csr-orders/checkout", mutateLimiter, async (req, res) => {
  const parsed = checkoutBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const config = readStripeConfigOrNull();
  if (!config) {
    res.status(503).json(SHOP_UNAVAILABLE_BODY);
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolveOpenOrder(supabase, parsed.data.token);
  if (!resolved.ok) {
    res.status(errorStatus(resolved.code)).json({ error: resolved.code });
    return;
  }
  const order = resolved.order;

  // Server-side gate: paperwork must be signed before payment.
  if (!order.signed_at) {
    res.status(409).json({ error: "signature_required" });
    return;
  }

  const payment = await lookupPaymentState(supabase, order.stripe_session_id);
  if (payment.status === "paid" || payment.status === "refunded") {
    res.status(409).json({ error: "already_paid" });
    return;
  }

  const stripe = getStripeClient(config);

  // Reuse an in-flight session when it's still open — a double-click
  // (or a back-button return) lands on the same Stripe page instead of
  // minting a duplicate.
  if (order.stripe_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(
        order.stripe_session_id,
      );
      if (existing.payment_status === "paid") {
        res.status(409).json({ error: "already_paid" });
        return;
      }
      if (existing.status === "open" && existing.url) {
        res.json({ url: existing.url });
        return;
      }
    } catch (err) {
      // Session lookup failure (deleted / cross-mode key) — fall
      // through and mint a fresh one.
      req.log?.warn(
        { ...stripeErrLogFields(err), orderRequestId: order.id },
        "csr-orders.checkout: existing session retrieve failed; minting fresh",
      );
    }
  }

  const items = parseOrderItems(
    order.items as Parameters<typeof parseOrderItems>[0],
  );
  if (items.length === 0) {
    res.status(409).json({ error: "order_has_no_items" });
    return;
  }

  const returnBase = `${config.publicBaseUrl}/order-pay?token=${encodeURIComponent(parsed.data.token)}`;

  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      ...(order.customer_email ? { customer_email: order.customer_email } : {}),
      // Free-form CSR pricing: ad-hoc price_data per line (these are
      // not catalog SKUs — the CSR set the description + amount).
      line_items: items.map((it) => ({
        price_data: {
          currency: order.currency,
          product_data: { name: it.description.slice(0, 250) },
          unit_amount: it.unitAmountCents,
        },
        quantity: it.quantity,
      })),
      success_url: `${returnBase}&checkout=success`,
      cancel_url: `${returnBase}&checkout=cancel`,
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      metadata: {
        source: "pennfit-csr-order",
        csr_order_request_id: order.id,
        order_reference: order.order_reference,
      },
      automatic_tax: { enabled: false },
    });
  } catch (err) {
    req.log?.error(
      { ...stripeErrLogFields(err), orderRequestId: order.id },
      "csr-orders.checkout: stripe session create failed",
    );
    res.status(502).json({ error: "stripe_create_failed" });
    return;
  }

  if (!session.url) {
    req.log?.error(
      { sessionId: session.id, orderRequestId: order.id },
      "csr-orders.checkout: stripe session has no url",
    );
    res.status(502).json({ error: "stripe_create_failed" });
    return;
  }

  // Mirror the session into shop_orders as a fresh `pending` row so the
  // existing charge webhook owns the paid/refunded lifecycle. INSERT-
  // or-IGNORE on conflict for the same reason as /shop/checkout: a
  // webhook that already advanced the row must never be reverted.
  const nowIso = new Date().toISOString();
  const { error: mirrorErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .upsert(
      {
        stripe_session_id: session.id,
        status: "pending",
        fulfillment_method: "ship",
        customer_email: order.customer_email,
        updated_at: nowIso,
      },
      { onConflict: "stripe_session_id", ignoreDuplicates: true },
    );
  if (mirrorErr) {
    req.log?.error(
      { err: mirrorErr, sessionId: session.id, orderRequestId: order.id },
      "csr-orders.checkout: shop_orders mirror failed",
    );
    res.status(500).json({ error: "shop_order_persist_failed" });
    return;
  }

  // Point the request at the latest session (payment state derivation
  // joins on this).
  const { error: linkErr } = await supabase
    .schema("resupply")
    .from("csr_order_requests")
    .update({ stripe_session_id: session.id, updated_at: nowIso })
    .eq("id", order.id);
  if (linkErr) {
    req.log?.error(
      { err: linkErr, sessionId: session.id, orderRequestId: order.id },
      "csr-orders.checkout: session link update failed",
    );
    res.status(500).json({ error: "shop_order_persist_failed" });
    return;
  }

  res.json({ url: session.url });
});

export default router;

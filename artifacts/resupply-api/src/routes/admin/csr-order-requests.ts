// CSR "sign & pay" orders — admin endpoints (the Orders page).
//
//   GET  /admin/csr-order-requests              — recent requests (paged)
//   POST /admin/csr-order-requests              — create + send to the customer
//   GET  /admin/csr-order-requests/:id          — detail (incl. fresh signing link)
//   POST /admin/csr-order-requests/:id/resend   — reissue link + resend invite
//   POST /admin/csr-order-requests/:id/cancel   — cancel (invalidates links)
//
// A CSR builds an order (free-form line items priced in cents),
// optionally attaches paperwork from the patient-packet template
// catalog, and the customer receives a signed HMAC link to review,
// e-sign, and pay via Stripe Hosted Checkout. Payment state is derived
// from the mirrored shop_orders row — see lib/csr-order/order.ts.
//
// Permission posture: `returns.manage` — the operational CSR tier that
// already owns shop-order fulfillment actions. The signing link is an
// HMAC token (RESUPPLY_LINK_HMAC_KEY) — see lib/csr-order/token.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  getSupabaseServiceRoleClient,
  type Json,
} from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

import {
  DEFAULT_CSR_ORDER_TTL_DAYS,
  buildCsrOrderSigningLink,
  computeAmountTotalCents,
  deliverCsrOrderInvite,
  generateCsrOrderReference,
  lookupPaymentState,
  lookupPaymentStates,
  parseOrderDocuments,
  parseOrderItems,
  snapshotOrderDocuments,
  type CsrOrderPaymentState,
} from "../../lib/csr-order/order";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

// Stripe's minimum USD charge is $0.50; enforcing it at create time
// surfaces the problem to the CSR instead of the customer.
const MIN_TOTAL_CENTS = 50;
const MAX_TOTAL_CENTS = 100_000_00; // $100k sanity cap

const itemSchema = z
  .object({
    description: z.string().trim().min(1).max(250),
    quantity: z.number().int().min(1).max(99),
    unitAmountCents: z.number().int().min(0).max(5_000_000),
  })
  .strict();

const createBody = z
  .object({
    customerName: z.string().trim().min(2).max(160),
    customerEmail: z
      .string()
      .trim()
      .toLowerCase()
      .email()
      .max(254)
      .optional()
      .nullable(),
    customerPhone: z.string().trim().min(7).max(32).optional().nullable(),
    items: z.array(itemSchema).min(1).max(20),
    noteToCustomer: z.string().trim().max(2000).optional().nullable(),
    /** Paperwork documents from the patient-packet template catalog
     *  (choice documents like the ABN are not supported here). */
    documentKeys: z.array(z.string().min(1).max(64)).max(20).default([]),
    expiresInDays: z.number().int().min(1).max(120).optional(),
  })
  .strict();

interface OrderRequestRow {
  id: string;
  order_reference: string;
  status: "sent" | "viewed" | "signed" | "canceled";
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  items: Json;
  amount_total_cents: number;
  currency: string;
  note_to_customer: string | null;
  documents: Json;
  link_version: number;
  expires_at: string | null;
  sent_at: string | null;
  first_viewed_at: string | null;
  signed_at: string | null;
  signer_name: string | null;
  canceled_at: string | null;
  stripe_session_id: string | null;
  created_by_email: string | null;
  created_at: string;
}

const LIST_COLUMNS =
  "id, order_reference, status, customer_name, customer_email, customer_phone, items, amount_total_cents, currency, note_to_customer, documents, link_version, expires_at, sent_at, first_viewed_at, signed_at, signer_name, canceled_at, stripe_session_id, created_by_email, created_at";

function projectRequest(row: OrderRequestRow, payment: CsrOrderPaymentState) {
  const documents = parseOrderDocuments(row.documents);
  return {
    id: row.id,
    orderReference: row.order_reference,
    status: row.status,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    items: parseOrderItems(row.items),
    amountTotalCents: row.amount_total_cents,
    currency: row.currency,
    noteToCustomer: row.note_to_customer,
    documents: documents.map((d) => ({
      key: d.key,
      title: d.title,
      requiresSignature: d.requiresSignature,
    })),
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    firstViewedAt: row.first_viewed_at,
    signedAt: row.signed_at,
    signerName: row.signer_name,
    canceledAt: row.canceled_at,
    payment,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

async function loadRequest(id: string): Promise<OrderRequestRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("csr_order_requests")
    .select(LIST_COLUMNS)
    .eq("id", id)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OrderRequestRow | null) ?? null;
}

// ── GET /admin/csr-order-requests ─────────────────────────────────
const listQuery = z.object({
  status: z.enum(["sent", "viewed", "signed", "canceled"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  "/admin/csr-order-requests",
  requirePermission("returns.manage"),
  adminReadRateLimiter,
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status, page, pageSize } = parsed.data;
    const offset = (page - 1) * pageSize;

    const supabase = getSupabaseServiceRoleClient();
    let rowsQuery = supabase
      .schema("resupply")
      .from("csr_order_requests")
      .select(LIST_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (status) rowsQuery = rowsQuery.eq("status", status);
    const { data, count, error } = await rowsQuery;
    if (error) throw error;

    const rows = (data ?? []) as OrderRequestRow[];
    const payments = await lookupPaymentStates(
      supabase,
      rows.flatMap((r) => (r.stripe_session_id ? [r.stripe_session_id] : [])),
    );

    res.json({
      requests: rows.map((r) =>
        projectRequest(
          r,
          (r.stripe_session_id
            ? payments.get(r.stripe_session_id)
            : undefined) ?? {
            status: "not_started",
            paidAt: null,
            shopOrderId: null,
          },
        ),
      ),
      total: count ?? 0,
      page,
      pageSize,
    });
  },
);

// ── POST /admin/csr-order-requests ────────────────────────────────
router.post(
  "/admin/csr-order-requests",
  requirePermission("returns.manage"),
  adminRateLimit({
    name: "csr_order_requests_create",
    windowMs: 60_000,
    max: 20,
  }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body ?? {});
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

    const email = b.customerEmail?.trim() || null;
    const rawPhone = b.customerPhone?.trim() || null;
    let phoneE164: string | null = null;
    if (rawPhone) {
      phoneE164 = normalizeE164(rawPhone);
      if (!phoneE164) {
        res.status(400).json({ error: "invalid_phone" });
        return;
      }
    }
    if (!email && !phoneE164) {
      res.status(400).json({ error: "no_recipient" });
      return;
    }

    const amountTotalCents = computeAmountTotalCents(b.items);
    if (amountTotalCents < MIN_TOTAL_CENTS) {
      res.status(400).json({
        error: "amount_below_minimum",
        minTotalCents: MIN_TOTAL_CENTS,
      });
      return;
    }
    if (amountTotalCents > MAX_TOTAL_CENTS) {
      res.status(400).json({ error: "amount_above_maximum" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const snapshot = await snapshotOrderDocuments(supabase, [
      ...new Set(b.documentKeys),
    ]);
    if (!snapshot.ok) {
      res.status(400).json({
        error: "invalid_document_keys",
        invalidKeys: snapshot.invalidKeys,
      });
      return;
    }

    const ttlDays = b.expiresInDays ?? DEFAULT_CSR_ORDER_TTL_DAYS;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + ttlDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: created, error: insertErr } = await supabase
      .schema("resupply")
      .from("csr_order_requests")
      .insert({
        order_reference: generateCsrOrderReference(),
        status: "sent",
        customer_name: b.customerName,
        customer_email: email,
        customer_phone: phoneE164,
        items: b.items as unknown as Json,
        amount_total_cents: amountTotalCents,
        currency: "usd",
        note_to_customer: b.noteToCustomer?.trim() || null,
        documents: snapshot.documents as unknown as Json,
        link_version: 1,
        expires_at: expiresAt,
        sent_at: nowIso,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id, order_reference, link_version")
      .single();
    if (insertErr) throw insertErr;

    const signingLink = buildCsrOrderSigningLink(
      created.id,
      created.link_version,
      ttlDays * 24 * 60 * 60,
    );
    const { emailSent, smsSent } = await deliverCsrOrderInvite({
      supabase,
      customerName: b.customerName,
      email,
      phone: phoneE164,
      link: signingLink,
      orderReference: created.order_reference,
      amountTotalCents,
      hasDocuments: snapshot.documents.length > 0,
      orderRequestId: created.id,
    });

    req.log?.info?.(
      {
        orderRequestId: created.id,
        adminEmail: req.adminEmail,
        itemCount: b.items.length,
        documentCount: snapshot.documents.length,
        emailSent,
        smsSent,
      },
      "admin/csr-order-requests: created + sent",
    );

    void logAudit({
      action: "csr_order.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_order_requests",
      targetId: created.id,
      metadata: {
        order_reference: created.order_reference,
        amount_total_cents: amountTotalCents,
        item_count: b.items.length,
        document_count: snapshot.documents.length,
        email_sent: emailSent,
        sms_sent: smsSent,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch(() => {});

    res.status(201).json({
      id: created.id,
      orderReference: created.order_reference,
      status: "sent",
      signingLink,
      emailSent,
      smsSent,
    });
  },
);

// ── GET /admin/csr-order-requests/:id ─────────────────────────────
router.get(
  "/admin/csr-order-requests/:id",
  requirePermission("returns.manage"),
  adminReadRateLimiter,
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const row = await loadRequest(params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const payment = await lookupPaymentState(supabase, row.stripe_session_id);
    res.json({
      request: projectRequest(row, payment),
      // A copyable link for the CURRENT version — only while open.
      signingLink:
        row.status === "canceled"
          ? null
          : buildCsrOrderSigningLink(row.id, row.link_version),
    });
  },
);

// ── POST /admin/csr-order-requests/:id/resend ─────────────────────
router.post(
  "/admin/csr-order-requests/:id/resend",
  requirePermission("returns.manage"),
  adminRateLimit({
    name: "csr_order_requests_resend",
    windowMs: 60_000,
    max: 20,
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const row = await loadRequest(params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status === "canceled") {
      res.status(409).json({ error: "order_canceled" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const payment = await lookupPaymentState(supabase, row.stripe_session_id);
    if (payment.status === "paid" || payment.status === "refunded") {
      res.status(409).json({ error: "already_paid" });
      return;
    }

    // Reissue: bump link_version (invalidates outstanding links) and
    // extend the expiry window from now.
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + DEFAULT_CSR_ORDER_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const newVersion = row.link_version + 1;
    const { error: bumpErr } = await supabase
      .schema("resupply")
      .from("csr_order_requests")
      .update({
        link_version: newVersion,
        expires_at: expiresAt,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .eq("link_version", row.link_version);
    if (bumpErr) throw bumpErr;

    const signingLink = buildCsrOrderSigningLink(row.id, newVersion);
    const { emailSent, smsSent } = await deliverCsrOrderInvite({
      supabase,
      customerName: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      link: signingLink,
      orderReference: row.order_reference,
      amountTotalCents: row.amount_total_cents,
      hasDocuments: parseOrderDocuments(row.documents).length > 0,
      reminder: true,
      orderRequestId: row.id,
    });

    req.log?.info?.(
      {
        orderRequestId: row.id,
        adminEmail: req.adminEmail,
        emailSent,
        smsSent,
      },
      "admin/csr-order-requests: link reissued + resent",
    );

    res.json({ status: row.status, signingLink, emailSent, smsSent });
  },
);

// ── POST /admin/csr-order-requests/:id/cancel ─────────────────────
router.post(
  "/admin/csr-order-requests/:id/cancel",
  requirePermission("returns.manage"),
  adminRateLimit({
    name: "csr_order_requests_cancel",
    windowMs: 60_000,
    max: 30,
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const row = await loadRequest(params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status === "canceled") {
      res.json({ status: "canceled" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const payment = await lookupPaymentState(supabase, row.stripe_session_id);
    if (payment.status === "paid" || payment.status === "refunded") {
      // A paid order is refunded through the shop-order refund flow,
      // not canceled here.
      res.status(409).json({ error: "already_paid" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: cancelErr } = await supabase
      .schema("resupply")
      .from("csr_order_requests")
      .update({
        status: "canceled",
        canceled_at: nowIso,
        canceled_by_email: req.adminEmail ?? null,
        // Invalidate every outstanding link immediately.
        link_version: row.link_version + 1,
        updated_at: nowIso,
      })
      .eq("id", row.id)
      .neq("status", "canceled");
    if (cancelErr) throw cancelErr;

    void logAudit({
      action: "csr_order.canceled",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "csr_order_requests",
      targetId: row.id,
      metadata: { order_reference: row.order_reference },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch(() => {});

    res.json({ status: "canceled" });
  },
);

export default router;

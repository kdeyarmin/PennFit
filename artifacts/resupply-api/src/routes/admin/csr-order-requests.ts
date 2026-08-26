// CSR signature orders — admin endpoints (the Orders page).
//
//   GET  /admin/csr-order-requests              — recent requests (paged)
//   POST /admin/csr-order-requests              — create + send to the customer
//   GET  /admin/csr-order-requests/:id          — detail (incl. fresh signing link)
//   POST /admin/csr-order-requests/:id/resend   — reissue link + resend invite
//   POST /admin/csr-order-requests/:id/cancel   — cancel (invalidates links)
//
// A CSR builds an order (free-form line items priced in cents, for the
// claim), optionally attaches paperwork from the patient-packet template
// catalog, and the customer receives a signed HMAC link to review and
// e-sign. Nothing is charged to the patient — the order is billed to their
// insurance through the claims pipeline.
//
// Draft-backed orders (a resupply_order_drafts row pointing at the request
// via csr_order_request_id) auto-queue fulfillments on sign. Ad-hoc
// (hand-built) orders stop at `signed` for staff to attach a patient +
// SKU — the list response surfaces `hasLinkedDraft` so that dead-end is
// visible in the admin UI.
//
// Permission posture: `returns.manage` — the operational CSR tier that
// already owns shop-order fulfillment actions. The signing link is an
// HMAC token (RESUPPLY_LINK_HMAC_KEY) — see lib/csr-order/token.ts.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, type Json } from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

import {
  DEFAULT_CSR_ORDER_TTL_DAYS,
  buildCsrOrderSigningLink,
  computeAmountTotalCents,
  deliverCsrOrderInvite,
  generateCsrOrderReference,
  parseOrderDocuments,
  parseOrderItems,
  snapshotOrderDocuments,
} from "../../lib/csr-order/order";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const idParam = z.object({ id: z.string().uuid() });

// A zero-value order is almost always a data-entry slip; the floor
// surfaces it to the CSR at create time rather than on the claim.
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
  created_by_email: string | null;
  created_at: string;
}

const LIST_COLUMNS =
  "id, order_reference, status, customer_name, customer_email, customer_phone, items, amount_total_cents, currency, note_to_customer, documents, link_version, expires_at, sent_at, first_viewed_at, signed_at, signer_name, canceled_at, created_by_email, created_at";

function projectRequest(
  row: OrderRequestRow,
  opts: {
    hasLinkedDraft: boolean;
    hasQueuedFulfillment: boolean;
  } = { hasLinkedDraft: false, hasQueuedFulfillment: false },
) {
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
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    // True when a resupply_order_drafts row points at this request.
    hasLinkedDraft: opts.hasLinkedDraft,
    // True when at least one fulfillment exists for the linked draft
    // (dispense-on-sign keys fulfillments.episode_id = draft.id). A
    // draft that failed soft (no_patient / no_sku / error) stays signed
    // without fulfillments — UI must not label those "queued".
    hasQueuedFulfillment: opts.hasQueuedFulfillment,
  };
}

/**
 * Batch-resolve linked drafts + whether each request already has
 * fulfillments queued. Fail-soft: lookup errors return empty maps (UI
 * falls back to "needs follow-up" — safer than claiming queued).
 */
async function loadDraftAndFulfillmentHints(
  orgId: string,
  requestIds: string[],
): Promise<{
  linkedDraftIds: Set<string>;
  queuedFulfillmentIds: Set<string>;
}> {
  const empty = {
    linkedDraftIds: new Set<string>(),
    queuedFulfillmentIds: new Set<string>(),
  };
  if (requestIds.length === 0) return empty;
  const supabase = getOrgScopedClient(orgId);
  const { data: drafts, error: draftErr } = await supabase
    .from("resupply_order_drafts")
    .select("id, csr_order_request_id")
    .in("csr_order_request_id", requestIds)
    .not("csr_order_request_id", "is", null)
    .limit(requestIds.length);
  if (draftErr) return empty;

  const linkedDraftIds = new Set<string>();
  const draftIdByRequest = new Map<string, string>();
  for (const row of drafts ?? []) {
    const r = row as { id: string; csr_order_request_id: string | null };
    if (!r.csr_order_request_id) continue;
    linkedDraftIds.add(r.csr_order_request_id);
    draftIdByRequest.set(r.csr_order_request_id, r.id);
  }

  const draftIds = [...draftIdByRequest.values()];
  if (draftIds.length === 0) {
    return { linkedDraftIds, queuedFulfillmentIds: new Set() };
  }

  // dispenseSignedCsrOrder keys fulfillments on episode_id = draft.id.
  const { data: fulfills, error: fulErr } = await supabase
    .from("fulfillments")
    .select("episode_id")
    .in("episode_id", draftIds)
    .limit(draftIds.length * 5);
  if (fulErr) {
    return { linkedDraftIds, queuedFulfillmentIds: new Set() };
  }

  const draftsWithFulfillment = new Set<string>();
  for (const f of fulfills ?? []) {
    const episodeId = (f as { episode_id: string | null }).episode_id;
    if (episodeId) draftsWithFulfillment.add(episodeId);
  }

  const queuedFulfillmentIds = new Set<string>();
  for (const [requestId, draftId] of draftIdByRequest) {
    if (draftsWithFulfillment.has(draftId)) {
      queuedFulfillmentIds.add(requestId);
    }
  }
  return { linkedDraftIds, queuedFulfillmentIds };
}

async function loadRequest(
  orgId: string,
  id: string,
): Promise<OrderRequestRow | null> {
  const supabase = getOrgScopedClient(orgId);
  const { data, error } = await supabase
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    let rowsQuery = supabase
      .from("csr_order_requests")
      .select(LIST_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (status) rowsQuery = rowsQuery.eq("status", status);
    const { data, count, error } = await rowsQuery;
    if (error) throw error;

    const rows = (data ?? []) as OrderRequestRow[];
    const hints = await loadDraftAndFulfillmentHints(
      orgId,
      rows.map((r) => r.id),
    );
    res.json({
      requests: rows.map((r) =>
        projectRequest(r, {
          hasLinkedDraft: hints.linkedDraftIds.has(r.id),
          hasQueuedFulfillment: hints.queuedFulfillmentIds.has(r.id),
        }),
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

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
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
      supabase: supabase,
      customerName: b.customerName,
      email,
      phone: phoneE164,
      link: signingLink,
      orderReference: created.order_reference,
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const row = await loadRequest(orgId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const hints = await loadDraftAndFulfillmentHints(orgId, [row.id]);
    res.json({
      request: projectRequest(row, {
        hasLinkedDraft: hints.linkedDraftIds.has(row.id),
        hasQueuedFulfillment: hints.queuedFulfillmentIds.has(row.id),
      }),
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const row = await loadRequest(orgId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status === "canceled") {
      res.status(409).json({ error: "order_canceled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    if (row.signed_at) {
      res.status(409).json({ error: "already_signed" });
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
      supabase: supabase,
      customerName: row.customer_name,
      email: row.customer_email,
      phone: row.customer_phone,
      link: signingLink,
      orderReference: row.order_reference,
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const row = await loadRequest(orgId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status === "canceled") {
      res.json({ status: "canceled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    if (row.signed_at) {
      // A signed order is worked through the claim, not canceled here.
      res.status(409).json({ error: "already_signed" });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: cancelErr } = await supabase
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

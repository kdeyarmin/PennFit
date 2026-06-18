// /admin/therapy-resupply/draft-orders — staged resupply order proposals.
//
// Companion to the read-only opportunities surface
// (routes/admin/therapy-resupply.ts). A draft is a PROPOSAL that a patient
// is due for a supply; it is NOT an order and nothing is charged. A CSR
// stages drafts here (manually from the opportunities page, or via the
// daily resupply-auto-draft worker), reviews the queue, and later approves
// a draft into the existing sign-&-pay order flow (approve endpoint is a
// follow-up).
//
//   GET  /admin/therapy-resupply/draft-orders          — review queue
//   POST /admin/therapy-resupply/draft-orders          — batch-stage from
//                                                         selected items
//   POST /admin/therapy-resupply/draft-orders/:id/dismiss — drop a proposal
//
// Org-scoped (the facade enforces the tenant filter + injects org_id on
// insert). PHI posture: rows reference patient ids + device descriptions;
// this module never logs them.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, type Json } from "@workspace/resupply-db";
import { normalizeE164 } from "@workspace/resupply-domain";

import {
  DEFAULT_CSR_ORDER_TTL_DAYS,
  buildCsrOrderSigningLink,
  computeAmountTotalCents,
  deliverCsrOrderInvite,
  generateCsrOrderReference,
  snapshotOrderDocuments,
} from "../../lib/csr-order/order.js";
import {
  type DraftSeed,
  stageResupplyDrafts,
} from "../../lib/resupply/resupply-draft-staging.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

// Stripe's USD minimum is $0.50; a $100k sanity cap. Mirrors the bounds
// the CSR order-requests route enforces so approve and the Orders page
// agree.
const MIN_TOTAL_CENTS = 50;
const MAX_TOTAL_CENTS = 100_000_00;

const router: IRouter = Router();

const DRAFT_STATUSES = [
  "proposed",
  "approved",
  "dismissed",
  "ordered",
] as const;

const listQuery = z
  .object({
    status: z.enum(DRAFT_STATUSES).optional().default("proposed"),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
  })
  .strict();

const seedSchema = z.object({
  patientId: z.string().uuid(),
  category: z.string().min(1).max(64),
  source: z.string().max(120).nullish(),
  sourceDescription: z.string().max(240).nullish(),
  nextEligibleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
    .nullish(),
});

const createBody = z
  .object({
    items: z.array(seedSchema).min(1).max(500),
  })
  .strict();

const dismissBody = z
  .object({ reason: z.string().max(280).optional() })
  .strict();

// Approve = convert the proposal into a CSR sign-&-pay order request. The
// CSR finalises the priced line items (the SPA pre-fills one from the
// draft's suggested SKU) + the recipient at review time, since the draft
// itself carries no price.
const orderItemSchema = z
  .object({
    description: z.string().trim().min(1).max(250),
    quantity: z.number().int().min(1).max(99),
    unitAmountCents: z.number().int().min(0).max(5_000_000),
  })
  .strict();

const approveBody = z
  .object({
    customerName: z.string().trim().min(2).max(160),
    customerEmail: z.string().trim().toLowerCase().email().max(254).nullish(),
    customerPhone: z.string().trim().min(7).max(32).nullish(),
    items: z.array(orderItemSchema).min(1).max(20),
    noteToCustomer: z.string().trim().max(2000).nullish(),
    documentKeys: z.array(z.string().min(1).max(64)).max(20).default([]),
    expiresInDays: z.number().int().min(1).max(120).optional(),
    /** Email/SMS the checkout link now (default true). */
    deliver: z.boolean().optional().default(true),
  })
  .strict();

interface DraftRow {
  id: string;
  patient_id: string;
  category: string;
  source: string | null;
  source_description: string | null;
  next_eligible_date: string | null;
  suggested_product_id: string | null;
  suggested_quantity: number;
  status: string;
  origin: string;
  created_at: string;
}

router.get(
  "/admin/therapy-resupply/draft-orders",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { status, limit } = parsed.data;
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("resupply_order_drafts")
      .select(
        "id, patient_id, category, source, source_description, next_eligible_date, suggested_product_id, suggested_quantity, status, origin, created_at",
      )
      .eq("status", status)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    const rows = (data ?? []) as DraftRow[];
    const nameById = new Map<string, string>();
    const ids = Array.from(new Set(rows.map((r) => r.patient_id)));
    if (ids.length > 0) {
      const { data: patients, error: pErr } = await supabase
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .in("id", ids);
      if (pErr) throw pErr;
      for (const p of (patients ?? []) as Array<{
        id: string;
        legal_first_name: string | null;
        legal_last_name: string | null;
      }>) {
        const name = [p.legal_first_name, p.legal_last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        nameById.set(p.id, name);
      }
    }

    res.json({
      status,
      count: rows.length,
      drafts: rows.map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        patientName: nameById.get(r.patient_id) || null,
        category: r.category,
        source: r.source,
        sourceDescription: r.source_description,
        nextEligibleDate: r.next_eligible_date,
        suggestedProductId: r.suggested_product_id,
        suggestedQuantity: r.suggested_quantity,
        status: r.status,
        origin: r.origin,
        createdAt: r.created_at,
      })),
    });
  },
);

router.post(
  "/admin/therapy-resupply/draft-orders",
  requirePermission("orders.create"),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const seeds: DraftSeed[] = parsed.data.items.map((i) => ({
      patientId: i.patientId,
      category: i.category,
      source: i.source ?? null,
      sourceDescription: i.sourceDescription ?? null,
      nextEligibleDate: i.nextEligibleDate ?? null,
    }));
    const result = await stageResupplyDrafts(supabase, seeds, {
      origin: "manual",
      createdByUserId: req.adminUserId ?? null,
      createdByEmail: req.adminEmail ?? null,
    });
    res.json(result);
  },
);

router.post(
  "/admin/therapy-resupply/draft-orders/:id/dismiss",
  requirePermission("orders.create"),
  async (req, res) => {
    const parsed = dismissBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("resupply_order_drafts")
      .update({
        status: "dismissed",
        dismissed_reason: parsed.data.reason ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id.data)
      .in("status", ["proposed", "approved"])
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "draft_not_found_or_not_open" });
      return;
    }
    res.json({ ok: true, id: id.data });
  },
);

router.post(
  "/admin/therapy-resupply/draft-orders/:id/approve",
  requirePermission("orders.create"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parsed = approveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const b = parsed.data;
    const draftId = idParse.data;

    const email = b.customerEmail?.trim() || null;
    let phoneE164: string | null = null;
    if (b.customerPhone?.trim()) {
      phoneE164 = normalizeE164(b.customerPhone.trim());
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
      res
        .status(400)
        .json({
          error: "amount_below_minimum",
          minTotalCents: MIN_TOTAL_CENTS,
        });
      return;
    }
    if (amountTotalCents > MAX_TOTAL_CENTS) {
      res.status(400).json({ error: "amount_above_maximum" });
      return;
    }

    const supabase = getOrgScopedClient(orgId);

    // The draft must still be open. Load it first so we never create an
    // order request for an already-ordered/dismissed proposal.
    const { data: draft, error: draftErr } = await supabase
      .from("resupply_order_drafts")
      .select("id, status")
      .eq("id", draftId)
      .maybeSingle();
    if (draftErr) throw draftErr;
    if (!draft) {
      res.status(404).json({ error: "draft_not_found" });
      return;
    }
    if (draft.status !== "proposed" && draft.status !== "approved") {
      res.status(409).json({ error: "draft_not_open", status: draft.status });
      return;
    }

    const snapshot = await snapshotOrderDocuments(supabase, [
      ...new Set(b.documentKeys),
    ]);
    if (!snapshot.ok) {
      res
        .status(400)
        .json({
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

    const link = buildCsrOrderSigningLink(
      created.id,
      created.link_version,
      ttlDays * 24 * 60 * 60,
    );
    let emailSent = false;
    let smsSent = false;
    if (b.deliver) {
      ({ emailSent, smsSent } = await deliverCsrOrderInvite({
        supabase,
        customerName: b.customerName,
        email,
        phone: phoneE164,
        link,
        orderReference: created.order_reference,
        amountTotalCents,
        hasDocuments: snapshot.documents.length > 0,
        orderRequestId: created.id,
      }));
    }

    // Flip the draft to ordered + record the request it produced. Guard on
    // the open statuses so a concurrent approve can't double-flip.
    const { error: updateErr } = await supabase
      .from("resupply_order_drafts")
      .update({
        status: "ordered",
        csr_order_request_id: created.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", draftId)
      .in("status", ["proposed", "approved"]);
    if (updateErr) throw updateErr;

    res.status(201).json({
      ok: true,
      draftId,
      orderRequestId: created.id,
      orderReference: created.order_reference,
      link,
      emailSent,
      smsSent,
    });
  },
);

export default router;

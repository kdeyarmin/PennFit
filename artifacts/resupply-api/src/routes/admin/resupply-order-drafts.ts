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

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  type DraftSeed,
  stageResupplyDrafts,
} from "../../lib/resupply/resupply-draft-staging.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

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

export default router;

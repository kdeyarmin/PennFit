// /admin/therapy-resupply — resupply opportunities from device data.
//
// The therapy-cloud snapshots already cache each vendor's `supplies[]`
// roster (mask / cushion / tubing / filter …) with a `nextEligibleDate`
// — the date the patient's plan next allows a replacement. This surface
// reads that roster across the whole base and lists the items eligible
// now (or due within a horizon), so a CSR can turn "device says the
// mask is due" straight into a resupply order. High-leak patients whose
// mask interface is due float to the top (re-fit + resupply in one
// touch).
//
//   GET /admin/therapy-resupply/summary           — KPI tiles
//   GET /admin/therapy-resupply/opportunities      — due/overdue items
//   GET /admin/therapy-resupply/opportunities.csv  — same as a report
//
// Aggregation + jsonb expansion is pushed into Postgres via the
// resupply.therapy_resupply_* RPCs (migration 0180). The list route
// does a second batched `patients` read to attach display names.
//
// PHI / log posture: device serials and supply dates are PHI-adjacent;
// this module never logs them. `summary` is pure counts (reports.read);
// the list + CSV return patient names (patients.read).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Supply categories the vendor snapshots use (unified enum). Used to
// validate the optional `category` filter.
const SUPPLY_CATEGORIES = [
  "mask",
  "cushion",
  "headgear",
  "tubing",
  "filter",
  "humidifier_chamber",
  "other",
] as const;

const summaryQuery = z
  .object({
    dueWithinDays: z.coerce.number().int().min(0).max(90).optional().default(0),
  })
  .strict();

const listQuery = z
  .object({
    dueWithinDays: z.coerce.number().int().min(0).max(90).optional().default(0),
    limit: z.coerce.number().int().min(1).max(1000).optional().default(200),
    category: z.enum(SUPPLY_CATEGORIES).optional(),
  })
  .strict();

// PostgREST returns bigint/numeric as strings; coerce defensively.
function int(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : Math.trunc(n);
}

interface SummaryRow {
  patients_with_due: number | string;
  items_due: number | string;
  items_overdue: number | string;
  masks_due: number | string;
  cushions_due: number | string;
  tubing_due: number | string;
  filters_due: number | string;
  high_leak_refit: number | string;
}

router.get(
  "/admin/therapy-resupply/summary",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = summaryQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const dueWithinDays = parsed.data.dueWithinDays;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("therapy_resupply_summary", { p_due_within_days: dueWithinDays });
    if (error) throw error;

    const row = (Array.isArray(data) ? data[0] : data) as SummaryRow | null;
    res.json({
      dueWithinDays,
      summary: {
        patientsWithDue: int(row?.patients_with_due),
        itemsDue: int(row?.items_due),
        itemsOverdue: int(row?.items_overdue),
        byCategory: {
          mask: int(row?.masks_due),
          cushion: int(row?.cushions_due),
          tubing: int(row?.tubing_due),
          filter: int(row?.filters_due),
        },
        highLeakRefit: int(row?.high_leak_refit),
      },
    });
  },
);

interface OpportunityRpcRow {
  patient_id: string;
  source: string;
  category: string;
  description: string | null;
  last_replaced_date: string | null;
  next_eligible_date: string | null;
  days_until_eligible: number | string | null;
  high_leak: boolean | null;
  fetched_at: string | null;
}

interface Opportunity {
  patientId: string;
  patientName: string | null;
  source: string;
  category: string;
  description: string | null;
  lastReplacedDate: string | null;
  nextEligibleDate: string | null;
  daysUntilEligible: number | null;
  highLeak: boolean;
  fetchedAt: string | null;
}

async function buildOpportunities(
  dueWithinDays: number,
  limit: number,
  category: (typeof SUPPLY_CATEGORIES)[number] | undefined,
): Promise<Opportunity[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .rpc("therapy_resupply_opportunities", {
      p_due_within_days: dueWithinDays,
      // Over-fetch when filtering by category so the post-filter still
      // returns a full page (the RPC can't cheaply filter per category
      // without losing the high-leak-first ordering).
      p_limit: category ? Math.min(limit * 5, 1000) : limit,
    });
  if (error) throw error;

  let rows = ((data ?? []) as OpportunityRpcRow[]).map(
    (r): Opportunity => ({
      patientId: r.patient_id,
      patientName: null,
      source: r.source,
      category: r.category,
      description: r.description,
      lastReplacedDate: r.last_replaced_date,
      nextEligibleDate: r.next_eligible_date,
      daysUntilEligible:
        r.days_until_eligible === null || r.days_until_eligible === undefined
          ? null
          : int(r.days_until_eligible),
      highLeak: r.high_leak === true,
      fetchedAt: r.fetched_at,
    }),
  );

  if (category) {
    rows = rows.filter((r) => r.category === category).slice(0, limit);
  }

  if (rows.length === 0) return rows;

  const ids = Array.from(new Set(rows.map((r) => r.patientId)));
  const { data: patientRows, error: pErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, legal_last_name")
    .in("id", ids);
  if (pErr) throw pErr;
  const nameById = new Map<string, string>();
  for (const p of (patientRows ?? []) as Array<{
    id: string;
    legal_first_name: string | null;
    legal_last_name: string | null;
  }>) {
    const name = [p.legal_first_name, p.legal_last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    nameById.set(p.id, name || "");
  }
  for (const r of rows) {
    r.patientName = nameById.get(r.patientId) || null;
  }
  return rows;
}

router.get(
  "/admin/therapy-resupply/opportunities",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { dueWithinDays, limit, category } = parsed.data;
    const opportunities = await buildOpportunities(
      dueWithinDays,
      limit,
      category,
    );
    res.json({
      dueWithinDays,
      count: opportunities.length,
      opportunities,
    });
  },
);

function csvCell(v: string | number | boolean | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get(
  "/admin/therapy-resupply/opportunities.csv",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { dueWithinDays, limit, category } = parsed.data;
    const opportunities = await buildOpportunities(
      dueWithinDays,
      limit,
      category,
    );

    const filename = `resupply-opportunities-${dueWithinDays}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "patient_id,patient_name,source,category,description," +
        "last_replaced_date,next_eligible_date,days_until_eligible," +
        "high_leak\n",
    );
    for (const o of opportunities) {
      res.write(
        [
          csvCell(o.patientId),
          csvCell(o.patientName),
          csvCell(o.source),
          csvCell(o.category),
          csvCell(o.description),
          csvCell(o.lastReplacedDate),
          csvCell(o.nextEligibleDate),
          csvCell(o.daysUntilEligible),
          csvCell(o.highLeak),
        ].join(",") + "\n",
      );
    }
    res.end();
  },
);

export default router;

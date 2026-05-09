// /admin/followups — cross-flow daily queue of open CSR follow-ups
// across both shop_customers (Phase 17) and patients (Phase 19).
//
// One HTTP request returns followups from both surfaces via two SQL
// queries in parallel, each joined with the corresponding identity
// table for display name, then merged into a single list ordered by
// due_at ASC (most overdue first), capped at 200 total.
//
// Each row carries a `kind: "shop_customer" | "patient"` discriminator
// so the UI can route the customer/patient link correctly. We
// intentionally keep the two tables separate at the SQL level (rather
// than a UNION query) because the schemas differ in subject id type
// and identity fields, and the merge in JS is trivially fast at this
// row volume.
//
// PHI posture: bodies are returned plain (CSR is admin-gated), but
// we never log them. Only counts hit the request log.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// We cap each side at 200; in practice the open queue is tiny but
// this prevents a runaway from monopolizing one side's slots.
const PER_SIDE_CAP = 200;
const TOTAL_CAP = 200;

router.get("/admin/followups", requireAdmin, async (req, res) => {
  const supabase = getSupabaseServiceRoleClient();

  // The original Drizzle implementation joined each followup table
  // against its identity table. PostgREST exposes embedded selects
  // via FK relationships (the customer_id / patient_id FKs are in
  // place), but the relationship name needs the column to be unique
  // — which it isn't in our schema (multiple followups per customer).
  // Two-step is cleaner and round-trip cost is bounded: at most 4
  // queries, all within the same Supabase region.
  const [shopFollowupsRes, patientFollowupsRes] = await Promise.all([
    supabase
      .schema("resupply")
      .from("shop_customer_followups")
      .select("id, customer_id, body, due_at, created_by_email, created_at")
      .is("completed_at", null)
      .order("due_at", { ascending: true })
      .limit(PER_SIDE_CAP),
    supabase
      .schema("resupply")
      .from("patient_followups")
      .select("id, patient_id, body, due_at, created_by_email, created_at")
      .is("completed_at", null)
      .order("due_at", { ascending: true })
      .limit(PER_SIDE_CAP),
  ]);
  if (shopFollowupsRes.error) throw shopFollowupsRes.error;
  if (patientFollowupsRes.error) throw patientFollowupsRes.error;

  const shopFollowups = shopFollowupsRes.data ?? [];
  const patientFollowups = patientFollowupsRes.data ?? [];
  const customerIds = Array.from(
    new Set(shopFollowups.map((r) => r.customer_id)),
  );
  const patientIds = Array.from(
    new Set(patientFollowups.map((r) => r.patient_id)),
  );

  const [customersRes, patientsRes] = await Promise.all([
    customerIds.length > 0
      ? supabase
          .schema("resupply")
          .from("shop_customers")
          .select("customer_id, display_name, email_lower")
          .in("customer_id", customerIds)
      : Promise.resolve({ data: [], error: null } as const),
    patientIds.length > 0
      ? supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name")
          .in("id", patientIds)
      : Promise.resolve({ data: [], error: null } as const),
  ]);
  if (customersRes.error) throw customersRes.error;
  if (patientsRes.error) throw patientsRes.error;

  const customerByIdEntries = (customersRes.data ?? []).map(
    (c) => [c.customer_id, c] as const,
  );
  const customerById = new Map(customerByIdEntries);
  const patientByIdEntries = (patientsRes.data ?? []).map(
    (p) => [p.id, p] as const,
  );
  const patientById = new Map(patientByIdEntries);

  const merged = [
    ...shopFollowups.map((r) => {
      const c = customerById.get(r.customer_id);
      return {
        kind: "shop_customer" as const,
        id: r.id,
        subjectId: r.customer_id,
        subjectDisplayName: c?.display_name ?? null,
        subjectEmail: c?.email_lower ?? null,
        body: r.body,
        dueAt: r.due_at,
        createdByEmail: r.created_by_email,
        createdAt: r.created_at,
      };
    }),
    ...patientFollowups.map((r) => {
      const p = patientById.get(r.patient_id);
      const fullName = p
        ? `${p.legal_first_name} ${p.legal_last_name}`.trim()
        : "";
      return {
        kind: "patient" as const,
        id: r.id,
        subjectId: r.patient_id,
        subjectDisplayName: fullName || null,
        subjectEmail: null as string | null,
        body: r.body,
        dueAt: r.due_at,
        createdByEmail: r.created_by_email,
        createdAt: r.created_at,
      };
    }),
  ];
  merged.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const trimmed = merged.slice(0, TOTAL_CAP);

  req.log?.info(
    {
      count: trimmed.length,
      shopCount: shopFollowups.length,
      patientCount: patientFollowups.length,
      adminEmail: req.adminEmail,
    },
    "admin.followups.list",
  );

  res.json({
    followups: trimmed.map((r) => ({
      kind: r.kind,
      id: r.id,
      subjectId: r.subjectId,
      subjectDisplayName: r.subjectDisplayName,
      subjectEmail: r.subjectEmail,
      body: r.body,
      dueAt: r.dueAt,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt,
    })),
  });
});

export default router;

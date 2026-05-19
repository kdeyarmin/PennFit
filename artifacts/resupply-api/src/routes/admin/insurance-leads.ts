// /admin/shop/insurance-leads/* — admin queue + status updates for
// the lead-capture form on the public /insurance page.
//
// Endpoints (all requireAdmin-gated):
//
//   GET   /admin/shop/insurance-leads?status=new
//                                   — paginated list, default sort
//                                     newest first, optional status
//                                     filter.
//   PATCH /admin/shop/insurance-leads/:id
//                                   — update status and/or csr note.
//                                     Stamps moderated_at +
//                                     moderated_by on every change.
//
// PHI handling:
//   The list endpoint returns the patient's name, email, phone, DOB,
//   carrier, and member-id in the clear — every admin who can hit
//   /admin/* has already cleared the PHI-access policy gate
//   (requireAdmin + the team allowlist). For the audit log we emit a
//   counts-only line that records the row count + filter + actor,
//   but NEVER the per-row PHI itself, mirroring the policy used for
//   the patients/conversations endpoints.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  INSURANCE_LEAD_STATUSES,
  type InsuranceLeadStatus,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { requirePermission } from "../../middlewares/requireAdmin";

type InsuranceLeadsUpdate = Database["resupply"]["Tables"]["insurance_leads"]["Update"];

const router: IRouter = Router();

const listQuery = z.object({
  // Allow filtering by status, plus an "all" sentinel for the
  // admin's "show me everything" toggle.
  // z.enum needs a mutable tuple — INSURANCE_LEAD_STATUSES is
  // readonly, so spread into a fresh array literal here.
  status: z
    .enum(["all", ...INSURANCE_LEAD_STATUSES] as [
      "all",
      ...typeof INSURANCE_LEAD_STATUSES,
    ])
    .optional()
    .default("all"),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number.parseInt(v, 10) : 100;
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(200, n));
    }),
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchBody = z
  .object({
    status: z
      .enum([...INSURANCE_LEAD_STATUSES] as [
        InsuranceLeadStatus,
        ...InsuranceLeadStatus[],
      ])
      .optional(),
    csrNote: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => (v === undefined || v === null || v === "" ? null : v)),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.csrNote !== undefined, {
    message: "must include status or csrNote",
  });

// Insurance-lead admin queue. CSR contact workflow — matches the
// rest of the inbox tier (`conversations.manage`).
router.get("/admin/shop/insurance-leads", requirePermission("conversations.manage"), async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { status, limit } = parsed.data;
  const supabase = getSupabaseServiceRoleClient();

  let leadsQuery = supabase
    .schema("resupply")
    .from("insurance_leads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status !== "all") leadsQuery = leadsQuery.eq("status", status);
  const { data: rows, error: listErr } = await leadsQuery;
  if (listErr) throw listErr;

  // Status counts for the KPI strip above the table. PostgREST has
  // no GROUP BY, so we run four parallel count(head=true) queries.
  // Each is index-backed by the (status, created_at) partial index.
  const [newCount, contactedCount, verifiedCount, closedCount] =
    await Promise.all([
      supabase
        .schema("resupply")
        .from("insurance_leads")
        .select("*", { count: "exact", head: true })
        .eq("status", "new"),
      supabase
        .schema("resupply")
        .from("insurance_leads")
        .select("*", { count: "exact", head: true })
        .eq("status", "contacted"),
      supabase
        .schema("resupply")
        .from("insurance_leads")
        .select("*", { count: "exact", head: true })
        .eq("status", "verified"),
      supabase
        .schema("resupply")
        .from("insurance_leads")
        .select("*", { count: "exact", head: true })
        .eq("status", "closed"),
    ]);

  if (newCount.error) throw newCount.error;
  if (contactedCount.error) throw contactedCount.error;
  if (verifiedCount.error) throw verifiedCount.error;
  if (closedCount.error) throw closedCount.error;

  const counts: Record<InsuranceLeadStatus, number> = {
    new: newCount.count ?? 0,
    contacted: contactedCount.count ?? 0,
    verified: verifiedCount.count ?? 0,
    closed: closedCount.count ?? 0,
  };

  req.log?.info?.(
    { rowCount: rows?.length ?? 0, filter: status, counts },
    "admin/shop/insurance-leads: list",
  );

  res.json({
    rows: (rows ?? []).map((r) => ({
      id: r.id,
      fullName: r.full_name,
      email: r.email,
      phone: r.phone,
      dateOfBirth: r.date_of_birth,
      insuranceCarrier: r.insurance_carrier,
      memberId: r.member_id,
      groupNumber: r.group_number,
      prescribingPhysician: r.prescribing_physician,
      notes: r.notes,
      status: r.status,
      csrNote: r.csr_note,
      notificationEmailDelivered: r.notification_email_delivered,
      confirmationEmailDelivered: r.confirmation_email_delivered,
      moderatedAt: r.moderated_at,
      moderatedBy: r.moderated_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    counts,
  });
});

router.patch(
  "/admin/shop/insurance-leads/:id",
  // Status mutations (move lead through new → contacted → verified
  // → closed). Same scope as the list above.
  requirePermission("conversations.manage"),
  async (req, res) => {
    // req.params is typed as Record<string, string | string[]> in
    // strict express; this route's path uses a single :id segment so
    // narrow with a runtime guard.
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parse = patchBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    // Build the partial update set explicitly so we never overwrite
    // fields the caller didn't intend to touch.
    const nowIso = new Date().toISOString();
    const update: InsuranceLeadsUpdate = {
      updated_at: nowIso,
      moderated_at: nowIso,
      moderated_by: req.adminEmail ?? null,
    };
    if (parse.data.status !== undefined) update.status = parse.data.status;
    if (parse.data.csrNote !== undefined) update.csr_note = parse.data.csrNote;

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("insurance_leads")
      .update(update)
      .eq("id", idParam)
      .select(
        "id, status, csr_note, moderated_at, moderated_by, updated_at",
      )
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    req.log?.info?.(
      {
        leadId: row.id,
        statusUpdated: parse.data.status !== undefined,
        noteUpdated: parse.data.csrNote !== undefined,
        actor: req.adminEmail ?? null,
      },
      "admin/shop/insurance-leads: patch",
    );

    res.json({
      id: row.id,
      status: row.status,
      csrNote: row.csr_note,
      moderatedAt: row.moderated_at,
      moderatedBy: row.moderated_by,
      updatedAt: row.updated_at,
    });
  },
);

export default router;

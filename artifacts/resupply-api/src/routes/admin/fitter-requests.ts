// /admin/fitter-requests/* — the queue a mask fitting now ends in.
//
// Under `fitter.lead_capture_only` the patient no longer files their own
// insurance order; they send a REQUEST and somebody here places the
// order. This is that worklist.
//
// Endpoints (all permission-gated):
//
//   GET   /admin/fitter-requests?status=new
//                            — list + KPI counts, oldest-waiting first
//                              within the open statuses.
//   PATCH /admin/fitter-requests/:id
//                            — move a request through
//                              new → contacted → in_progress → closed,
//                              and/or leave a CSR note.
//
// PHI handling mirrors the insurance-lead queue it sits beside: the rows
// carry name, phone, date of birth and (when the patient supplied them)
// insurance identifiers in the clear, because every admin reaching
// /admin/* has already cleared the PHI-access gate. The log line is
// counts + filter + actor and never the per-row values.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type FitRequestRow =
  Database["resupply"]["Tables"]["fitter_fit_requests"]["Row"];
type FitRequestUpdate =
  Database["resupply"]["Tables"]["fitter_fit_requests"]["Update"];

const router: IRouter = Router();

const STATUSES = ["new", "contacted", "in_progress", "closed"] as const;
type FitRequestStatus = (typeof STATUSES)[number];

const listQuery = z.object({
  status: z
    .enum(["all", ...STATUSES] as ["all", ...typeof STATUSES])
    .optional()
    .default("all"),
  requestType: z
    .enum(["all", "full_details", "callback"])
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
      .enum([...STATUSES] as [FitRequestStatus, ...FitRequestStatus[]])
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

function toView(r: FitRequestRow) {
  return {
    id: r.id,
    requestType: r.request_type,
    status: r.status,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    preferredContactMethod: r.preferred_contact_method,
    preferredContactTime: r.preferred_contact_time,
    dateOfBirth: r.date_of_birth,
    insuranceCarrier: r.insurance_carrier,
    memberId: r.member_id,
    groupNumber: r.group_number,
    prescribingPhysician: r.prescribing_physician,
    notes: r.notes,
    population: r.population,
    fitterLeadId: r.fitter_lead_id,
    fitSessionId: r.fit_session_id,
    recommendedMaskId: r.recommended_mask_id,
    recommendedMaskName: r.recommended_mask_name,
    recommendedMaskType: r.recommended_mask_type,
    recommendedMaskSize: r.recommended_mask_size,
    csrNote: r.csr_note,
    contactedAt: r.contacted_at,
    contactedBy: r.contacted_by,
    closedAt: r.closed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Same scope as the insurance-lead queue: both are top-of-funnel
// requests worked by the same CSR cohort.
router.get(
  "/admin/fitter-requests",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { status, requestType, limit } = parsed.data;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    let rowsQuery = supabase
      .from("fitter_fit_requests")
      .select("*")
      // OLDEST first, deliberately, and unlike every other admin list in
      // this codebase. This is a promise-shaped queue — the confirmation
      // email tells the patient "within one business day" — so the row
      // that has waited longest is the one that matters, and a
      // newest-first sort buries it the moment volume picks up.
      .order("created_at", { ascending: true })
      .limit(limit);
    if (status !== "all") rowsQuery = rowsQuery.eq("status", status);
    if (requestType !== "all") {
      rowsQuery = rowsQuery.eq("request_type", requestType);
    }

    const { data: rows, error: listErr } = await rowsQuery;
    if (listErr) throw listErr;

    // KPI strip. PostgREST has no GROUP BY, so parallel count-only
    // queries — each index-backed by (org_id, status, created_at).
    const countBase = () =>
      supabase
        .from("fitter_fit_requests")
        .select("*", { count: "exact", head: true });
    const [newCount, contactedCount, inProgressCount, closedCount] =
      await Promise.all([
        countBase().eq("status", "new"),
        countBase().eq("status", "contacted"),
        countBase().eq("status", "in_progress"),
        countBase().eq("status", "closed"),
      ]);
    if (newCount.error) throw newCount.error;
    if (contactedCount.error) throw contactedCount.error;
    if (inProgressCount.error) throw inProgressCount.error;
    if (closedCount.error) throw closedCount.error;

    const counts: Record<FitRequestStatus, number> = {
      new: newCount.count ?? 0,
      contacted: contactedCount.count ?? 0,
      in_progress: inProgressCount.count ?? 0,
      closed: closedCount.count ?? 0,
    };

    req.log?.info?.(
      {
        rowCount: rows?.length ?? 0,
        filter: { status, requestType },
        counts,
      },
      "admin/fitter-requests: list",
    );

    res.json({
      rows: ((rows ?? []) as FitRequestRow[]).map(toView),
      counts,
    });
  },
);

router.patch(
  "/admin/fitter-requests/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "fitter_requests.update", preset: "mutation" }),
  async (req, res) => {
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

    const nowIso = new Date().toISOString();
    const update: FitRequestUpdate = {};
    if (parse.data.status !== undefined) {
      update.status = parse.data.status;
      // Stamp the lifecycle timestamps from the transition rather than
      // asking the caller for them, so "who first reached this patient"
      // survives a later status change. `contacted_at` is set once —
      // moving back from closed to contacted must not rewrite history.
      if (
        parse.data.status === "contacted" ||
        parse.data.status === "in_progress"
      ) {
        update.contacted_at = nowIso;
        update.contacted_by = req.adminEmail ?? null;
      }
      update.closed_at = parse.data.status === "closed" ? nowIso : null;
    }
    if (parse.data.csrNote !== undefined) update.csr_note = parse.data.csrNote;

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Only stamp `contacted_at` the FIRST time. Reading it back before
    // the write costs one round-trip and keeps the "first reached"
    // timestamp honest through re-opens.
    if (update.contacted_at) {
      const { data: existing, error: readErr } = await supabase
        .from("fitter_fit_requests")
        .select("contacted_at")
        .eq("id", idParam)
        .maybeSingle();
      if (readErr) throw readErr;
      if (existing?.contacted_at) {
        delete update.contacted_at;
        delete update.contacted_by;
      }
    }

    const { data: row, error } = await supabase
      .from("fitter_fit_requests")
      .update(update)
      .eq("id", idParam)
      .select(
        "id, status, csr_note, contacted_at, contacted_by, closed_at, updated_at",
      )
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    req.log?.info?.(
      { id: row.id, status: row.status, actor: req.adminEmail ?? null },
      "admin/fitter-requests: updated",
    );

    res.json({
      id: row.id,
      status: row.status,
      csrNote: row.csr_note,
      contactedAt: row.contacted_at,
      contactedBy: row.contacted_by,
      closedAt: row.closed_at,
      updatedAt: row.updated_at,
    });
  },
);

export default router;

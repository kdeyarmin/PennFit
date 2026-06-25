// /admin/analytics/* — clinical-side analytics surfaces.
//
//   GET /admin/analytics/resupply-funnel?days=30      — episode flow
//   GET /admin/analytics/compliance-cohorts?days=180  — adherence by
//                                                       signup-month
//                                                       and by payer
//   GET /admin/analytics/csr-productivity?days=14     — per-admin
//                                                       audit-action rollup
//
// All three are read-only aggregations over data we already have.
// No new schema. The window is `days` (1..365, default 30, capped
// so a CSR can't accidentally ask for "last 10 years" and time the
// route out). Aggregation logic lives in lib/analytics/aggregate.ts
// — this route is the DB-read + window-validation + audit layer.
//
// Storefront analytics (orders, email health, mask popularity)
// stays at /admin/storefront/analytics. These routes are about the
// CLINICAL business: resupply throughput, patient adherence, team
// productivity.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  type Database,
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import {
  aggregateComplianceCohorts,
  aggregatePatientRetention,
  aggregateResupplyFunnel,
  aggregateResupplyKpis,
  type EpisodeKpiRow,
  type EpisodeRow,
  type PatientCohortPoint,
  type RetentionEpisodeRow,
} from "../../lib/analytics/aggregate";
import {
  COMPLIANT_MINUTES_PER_NIGHT,
  WINDOW_DAYS,
  findBestAdherenceWindow,
} from "../../lib/compliance-attestation";
import { safeCsvCell } from "../../lib/safe-csv-cell";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

type EpisodeDbRow = Database["resupply"]["Tables"]["episodes"]["Row"];
type PatientDbRow = Database["resupply"]["Tables"]["patients"]["Row"];

// PostgREST caps a single response at ~1000 rows. A window like days=365 on
// a busy DME can hold far more than 1000 episodes/patients/nights, so a
// "window-bounded" select is NOT automatically under the cap — it silently
// truncates and every count/sum below it is understated. Offset-page past
// the cap. `page(from, to)` must return a query already `.order()`ed (for
// stable paging) and `.range(from, to)`d.
const PAGE = 1000;
async function collectAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

const windowSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

router.get(
  "/admin/analytics/resupply-funnel",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // PAGINATED — a multi-month window on a busy tenant holds >1000
    // episodes; an unpaginated read would truncate and understate the funnel.
    const data = await collectAllRows<{ status: EpisodeDbRow["status"] }>(
      (from, to) =>
        supabase
          .from("episodes")
          .select("status")
          .gte("created_at", cutoff)
          .order("id", { ascending: true })
          .range(from, to),
    );
    const result = aggregateResupplyFunnel(data as EpisodeRow[]);
    res.json({ windowDays: days, ...result });
  },
);

// Headline resupply-program KPIs: connection (response) rate,
// confirmation/conversion rate, fulfillment rate, and orders per
// active patient — the numbers DME operators benchmark a resupply
// program on. Read-only aggregation over episodes + conversations +
// inbound messages. The conversation / message / fulfillment / paid-order
// counts are aggregated server-side (migration 0437) so the window KPIs
// are exact regardless of volume (no client-side row cap).
router.get(
  "/admin/analytics/resupply-kpis",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // The episode rollup is a paginated table read (a multi-month window
    // can exceed the ~1000-row cap on a busy tenant). The four formerly-
    // capped aggregations (outreach conversations, inbound replies,
    // fulfillment line items, paid-order AOV) are folded into
    // resupply.resupply_kpi_window_aggregates (migration 0437) so they no
    // longer silently truncate above the old `.limit(20000/50000)` caps. The
    // active-patient COUNT stays exact — it is the orders-per-patient
    // denominator. These three reads are independent, so fan them out
    // concurrently.
    const [
      episodeRows,
      { count: activePatientCount, error: patErr },
      { data: kpiAggRows, error: kpiAggErr },
    ] = await Promise.all([
      // Episodes created in the window → confirmation/fulfillment + unique
      // patients. PAGINATED — the window does NOT bound this under the
      // ~1000-row cap on a busy tenant, so an unpaginated read would
      // truncate and understate every per-episode KPI below.
      collectAllRows<Pick<EpisodeDbRow, "status" | "patient_id">>((from, to) =>
        supabase
          .from("episodes")
          .select("status, patient_id")
          .gte("created_at", cutoff)
          .order("id", { ascending: true })
          .range(from, to),
      ),
      // Active-patient count for the orders-per-patient denominator.
      supabase
        .from("patients")
        .select("*", { count: "exact", head: true })
        .eq("status", "active"),
      // Window aggregates: outreach_count, responded_count (distinct),
      // fulfillment_line_items, orders_with_fulfillments (distinct),
      // paid_order_count, paid_order_sum_cents.
      supabase.raw().schema("resupply").rpc("resupply_kpi_window_aggregates", {
        p_org_id: orgId,
        p_cutoff: cutoff,
      }),
    ]);
    if (patErr) throw patErr;
    if (kpiAggErr) throw kpiAggErr;

    const episodes: EpisodeKpiRow[] = (episodeRows as EpisodeDbRow[]).map(
      (r) => ({
        status: r.status,
        patientId: r.patient_id,
      }),
    );

    const agg = (
      (kpiAggRows ?? []) as Array<{
        outreach_count: number | string | null;
        responded_count: number | string | null;
        fulfillment_line_items: number | string | null;
        orders_with_fulfillments: number | string | null;
        paid_order_count: number | string | null;
        paid_order_sum_cents: number | string | null;
      }>
    )[0];

    const result = aggregateResupplyKpis({
      episodes,
      outreachCount: Number(agg?.outreach_count ?? 0),
      respondedCount: Number(agg?.responded_count ?? 0),
      activePatientCount: activePatientCount ?? 0,
      windowDays: days,
      fulfillmentAggregates: {
        lineItems: Number(agg?.fulfillment_line_items ?? 0),
        ordersWithFulfillments: Number(agg?.orders_with_fulfillments ?? 0),
      },
      paidOrderAggregates: {
        count: Number(agg?.paid_order_count ?? 0),
        sumCents: Number(agg?.paid_order_sum_cents ?? 0),
      },
    });
    res.json({ windowDays: days, ...result });
  },
);

router.get(
  "/admin/analytics/compliance-cohorts",
  requirePermission("reports.read"),
  async (req, res) => {
    // Default to a wider window than the others — compliance cohorts
    // are most useful at the 6+ month horizon since the 90-day trial
    // doesn't even complete inside a 30-day window.
    const parsed = z
      .object({
        days: z.coerce.number().int().min(30).max(730).optional().default(180),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Pull patients onboarded in the window. We don't fetch every
    // patient on file — large practices have tens of thousands of
    // historical rows and the per-patient adherence math below
    // would be expensive. The window bounds the cohort to recently
    // onboarded patients, which is exactly the segment the
    // adherence-trial dashboard is about anyway.
    // PAGINATED — a busy onboarding window can hold >1000 patients; an
    // unpaginated read would truncate the cohort denominator and drop the
    // excess patients from the adherence math entirely.
    const patientRows = await collectAllRows<
      Pick<PatientDbRow, "id" | "insurance_payer" | "created_at">
    >((from, to) =>
      supabase
        .from("patients")
        .select("id, insurance_payer, created_at")
        .gte("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to),
    );

    const patientIds = (patientRows as PatientDbRow[]).map((r) => r.id);
    if (patientIds.length === 0) {
      res.json({
        windowDays: days,
        byMonth: [],
        byPayer: [],
      });
      return;
    }

    // Bulk-pull every therapy night for the cohort patients. We
    // limit to the first 90 days after their signup window — outside
    // that is irrelevant to the Medicare adherence-trial number.
    // PostgREST has no batch GROUP BY for our use case, so we
    // partition in JS.
    // CHUNKED + PAGINATED — the cohort can be many hundreds of patients with
    // up to ~90 nights each, so the join easily exceeds the ~1000-row cap
    // (and a huge `.in()` list would blow the URL length). Chunk the id list,
    // and offset-page each chunk so no night is silently dropped from the
    // adherence math.
    const horizonCutoff = isoDaysAgo(days + 90);
    const NIGHT_ID_CHUNK = 300;
    const nightRows: Array<{
      patient_id: string;
      night_date: string;
      usage_minutes: number | null;
    }> = [];
    for (let i = 0; i < patientIds.length; i += NIGHT_ID_CHUNK) {
      const idChunk = patientIds.slice(i, i + NIGHT_ID_CHUNK);
      const chunkRows = await collectAllRows<{
        patient_id: string;
        night_date: string;
        usage_minutes: number | null;
      }>((from, to) =>
        supabase
          .from("patient_therapy_nights")
          .select("patient_id, night_date, source, usage_minutes")
          .in("patient_id", idChunk)
          .gte("night_date", horizonCutoff)
          .order("patient_id", { ascending: true })
          .order("night_date", { ascending: true })
          // (patient_id, night_date) is NOT unique — a patient can have
          // multiple source rows for one night — so add the `id` tiebreaker
          // to give offset paging a total order (no boundary dup/skip).
          .order("id", { ascending: true })
          .range(from, to),
      );
      nightRows.push(...chunkRows);
    }

    const nightsByPatient = new Map<
      string,
      Array<{ date: string; usageMinutes: number | null }>
    >();
    for (const row of nightRows ?? []) {
      const list = nightsByPatient.get(row.patient_id) ?? [];
      list.push({
        date: row.night_date,
        usageMinutes: row.usage_minutes,
      });
      nightsByPatient.set(row.patient_id, list);
    }

    const asOfDate = new Date().toISOString().slice(0, 10);
    const points: PatientCohortPoint[] = (
      (patientRows ?? []) as PatientDbRow[]
    ).map((patient) => {
      const nights = nightsByPatient.get(patient.id) ?? [];
      let qualifies = false;
      if (nights.length > 0) {
        const sorted = [...nights].sort((a, b) => (a.date < b.date ? -1 : 1));
        const anchor = sorted[0]!.date;
        const result = findBestAdherenceWindow(sorted, anchor, asOfDate);
        qualifies = result.qualifies;
      }
      return {
        signedUpAt: patient.created_at,
        qualifies,
        insurancePayer: patient.insurance_payer,
      };
    });

    const aggregated = aggregateComplianceCohorts(points);
    res.json({
      windowDays: days,
      compliantMinutesPerNight: COMPLIANT_MINUTES_PER_NIGHT,
      adherenceWindowDays: WINDOW_DAYS,
      ...aggregated,
    });
  },
);

router.get(
  "/admin/analytics/csr-productivity",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const to = new Date();
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - days);
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Per-operator productivity is re-derived from EVENT tables (the
    // same sources as /admin/productivity) now that the historical
    // audit_log source is retired — never from audit_log (CLAUDE.md
    // hard rule). Each signal is an "action" the operator took in the
    // window; byAction breaks the total down and lastActiveDate is the
    // most recent action timestamp.
    const { data: admins, error: adminsErr } = await supabase
      .from("admin_users")
      .select("id, email_lower")
      .eq("status", "active");
    if (adminsErr) throw adminsErr;
    const adminList = (admins ?? []) as Array<{
      id: string;
      email_lower: string;
    }>;
    if (adminList.length === 0) {
      res.json({ windowDays: days, rows: [], totalActions: 0 });
      return;
    }
    const adminIds = adminList.map((a) => a.id);

    const [closed, approved, rejected, alertsResolved, followupsDone] =
      await Promise.all([
        csrActionRows(
          supabase,
          "conversations",
          "assigned_admin_user_id",
          "updated_at",
          adminIds,
          (q) =>
            q
              .eq("status", "closed")
              .gte("updated_at", fromIso)
              .lte("updated_at", toIso),
        ),
        csrActionRows(
          supabase,
          "shop_returns",
          "admin_user_id",
          "approved_at",
          adminIds,
          (q) => q.gte("approved_at", fromIso).lte("approved_at", toIso),
        ),
        csrActionRows(
          supabase,
          "shop_returns",
          "admin_user_id",
          "rejected_at",
          adminIds,
          (q) => q.gte("rejected_at", fromIso).lte("rejected_at", toIso),
        ),
        csrActionRows(
          supabase,
          "csr_compliance_alerts",
          "resolved_by_user_id",
          "resolved_at",
          adminIds,
          (q) =>
            q
              .eq("status", "resolved")
              .gte("resolved_at", fromIso)
              .lte("resolved_at", toIso),
        ),
        csrActionRows(
          supabase,
          "patient_followups",
          "completed_by_user_id",
          "completed_at",
          adminIds,
          (q) =>
            q
              .not("completed_at", "is", null)
              .gte("completed_at", fromIso)
              .lte("completed_at", toIso),
        ),
      ]);

    const acc = new Map<
      string,
      { byAction: Record<string, number>; lastTs: string | null }
    >();
    const apply = (
      actionRows: Array<{ id: string; ts: string | null }>,
      action: string,
    ): void => {
      for (const r of actionRows) {
        let entry = acc.get(r.id);
        if (!entry) {
          entry = { byAction: {}, lastTs: null };
          acc.set(r.id, entry);
        }
        entry.byAction[action] = (entry.byAction[action] ?? 0) + 1;
        if (r.ts && (entry.lastTs === null || r.ts > entry.lastTs)) {
          entry.lastTs = r.ts;
        }
      }
    };
    apply(closed, "conversation_closed");
    apply(approved, "return_approved");
    apply(rejected, "return_rejected");
    apply(alertsResolved, "compliance_alert_resolved");
    apply(followupsDone, "followup_completed");

    const rows = adminList
      .map((a) => {
        const entry = acc.get(a.id);
        const byAction = entry?.byAction ?? {};
        const total = Object.values(byAction).reduce((s, n) => s + n, 0);
        return {
          operator: a.email_lower,
          total,
          byAction,
          lastActiveDate: entry?.lastTs ? entry.lastTs.slice(0, 10) : null,
        };
      })
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total);

    res.json({
      windowDays: days,
      rows,
      totalActions: rows.reduce((s, r) => s + r.total, 0),
    });
  },
);

// Structural builder type — mirrors the local one in productivity.ts.
// The upstream PostgREST generic chain is too deep to spell out; this
// captures only the chainable methods csrActionRows exercises.
type CsrActionQuery = {
  eq(column: string, value: string): CsrActionQuery;
  gte(column: string, value: string): CsrActionQuery;
  lte(column: string, value: string): CsrActionQuery;
  in(column: string, values: readonly string[]): CsrActionQuery;
  not(column: string, operator: string, value: unknown): CsrActionQuery;
  limit(count: number): Promise<{ data: unknown; error: unknown }>;
};

/**
 * Fetch (attribution id, timestamp) pairs for one action source within
 * the window, scoped to the given admin ids. The caller tallies
 * per-operator counts + last-active. Mirrors productivity.ts's grouped
 * fetch but keeps the timestamp so we can surface "last active".
 */
async function csrActionRows(
  supabase: OrgScopedClient,
  table:
    | "conversations"
    | "shop_returns"
    | "csr_compliance_alerts"
    | "patient_followups",
  attributionCol: string,
  tsCol: string,
  adminIds: string[],
  refine: (q: CsrActionQuery) => CsrActionQuery,
): Promise<Array<{ id: string; ts: string | null }>> {
  if (adminIds.length === 0) return [];
  const base = supabase
    .from(table)
    .select(`${attributionCol}, ${tsCol}`) as unknown as CsrActionQuery;
  const refined = refine(base.in(attributionCol, adminIds));
  const { data, error } = await refined.limit(50_000);
  if (error) throw error;
  const out: Array<{ id: string; ts: string | null }> = [];
  for (const row of (data ?? []) as unknown as Array<
    Record<string, string | null>
  >) {
    const id = row[attributionCol];
    if (typeof id === "string" && id.length > 0) {
      out.push({ id, ts: row[tsCol] ?? null });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────
// GET /admin/analytics/episodes-stuck — drill-down on episodes
// that have lingered in a non-terminal stage past an SLA bucket.
// The funnel shows "X episodes are awaiting_response"; this shows
// WHICH episodes so a supervisor can actually triage.
//
//   ?stage=awaiting_response | outreach_pending | confirmed
//   ?limit=20 (default 25, max 100)
//
// Rows are sorted oldest-first so the most overdue items surface
// first. The "confirmed" stage is the gap between patient OK and
// fulfillment write — sitting here means Pacware didn't get the
// order, which is a hot-path failure mode worth surfacing.
// ────────────────────────────────────────────────────────────────
const stuckQuery = z.object({
  stage: z.enum(["outreach_pending", "awaiting_response", "confirmed"]),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

router.get(
  "/admin/analytics/episodes-stuck",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = stuckQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { stage, limit } = parsed.data;
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    const { data, error } = await supabase
      .from("episodes")
      .select(
        "id, patient_id, status, created_at, due_at, expires_at, prescription_id",
      )
      .eq("status", stage)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (error) throw error;

    // Decorate each row with the patient name + payer so a
    // supervisor can scan the list without opening every row.
    const stuckEpisodes = (data ?? []) as EpisodeDbRow[];
    const patientIds = Array.from(
      new Set(stuckEpisodes.map((r) => r.patient_id)),
    );
    const { data: patients, error: pErr } = patientIds.length
      ? await supabase
          .from("patients")
          .select("id, legal_first_name, legal_last_name, insurance_payer")
          .in("id", patientIds)
      : { data: [], error: null };
    if (pErr) throw pErr;
    const byId = new Map(
      ((patients ?? []) as PatientDbRow[]).map((p) => [p.id, p] as const),
    );

    const now = Date.now();
    const episodes = stuckEpisodes.map((e) => {
      const p = byId.get(e.patient_id);
      const createdAt = e.created_at;
      const ageDays = Math.floor(
        (now - new Date(createdAt).getTime()) / 86_400_000,
      );
      const patientName = p
        ? `${p.legal_first_name} ${p.legal_last_name}`.trim()
        : null;
      return {
        id: e.id,
        patientId: e.patient_id,
        patientName,
        insurancePayer: p?.insurance_payer ?? null,
        status: e.status,
        createdAt,
        dueAt: e.due_at,
        expiresAt: e.expires_at,
        prescriptionId: e.prescription_id,
        ageDays,
      };
    });

    res.json({ stage, count: episodes.length, episodes });
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/analytics/resupply-funnel.csv — the funnel JSON as a
// flat CSV. Payers and accreditation reviewers ask for these as
// part of operational audits.
//
// One row per status bucket (outreach_pending, awaiting_response,
// confirmed, fulfilled, declined, expired, canceled) plus a header
// row that totals the window.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/analytics/resupply-funnel.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = windowSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // PAGINATED — same ~1000-row cap as the JSON funnel above; the CSV must
    // not truncate or the exported counts disagree with reality.
    const data = await collectAllRows<{ status: EpisodeDbRow["status"] }>(
      (from, to) =>
        supabase
          .from("episodes")
          .select("status")
          .gte("created_at", cutoff)
          .order("id", { ascending: true })
          .range(from, to),
    );
    const agg = aggregateResupplyFunnel(data as EpisodeRow[]);

    const filename = `resupply-funnel-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write("stage,count,kind\n");
    for (const [stage, count] of Object.entries(agg.byStage)) {
      res.write(`${stage},${count},funnel\n`);
    }
    for (const [stage, count] of Object.entries(agg.dropOuts)) {
      res.write(`${stage},${count},drop_out\n`);
    }
    res.write(`total,${agg.total},summary\n`);
    res.write(
      `fulfillment_rate,${
        agg.fulfillmentRate == null ? "" : agg.fulfillmentRate
      },summary\n`,
    );
    res.end();
  },
);

// ────────────────────────────────────────────────────────────────
// GET /admin/analytics/compliance-cohorts.csv — flat CSV with one
// row per (group, kind) pair. Surveyors ask for this verbatim
// during the adherence-rate portion of a DMEPOS visit.
// ────────────────────────────────────────────────────────────────
router.get(
  "/admin/analytics/compliance-cohorts.csv",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = z
      .object({
        days: z.coerce.number().int().min(30).max(730).optional().default(180),
      })
      .safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const cutoff = isoDaysAgo(days);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    // PAGINATED — same cohort/night truncation guard as the JSON
    // compliance-cohorts handler above (a >1000-patient window, or a cohort
    // whose nights exceed the cap, would otherwise corrupt the CSV).
    const patientRows = await collectAllRows<
      Pick<PatientDbRow, "id" | "insurance_payer" | "created_at">
    >((from, to) =>
      supabase
        .from("patients")
        .select("id, insurance_payer, created_at")
        .gte("created_at", cutoff)
        .order("id", { ascending: true })
        .range(from, to),
    );
    const patientIds = (patientRows as PatientDbRow[]).map((r) => r.id);

    const filename = `compliance-cohorts-${days}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write("kind,group,patients,qualifying,rate\n");

    if (patientIds.length === 0) {
      res.end();
      return;
    }
    const horizonCutoff = isoDaysAgo(days + 90);
    const NIGHT_ID_CHUNK = 300;
    const nightRows: Array<{
      patient_id: string;
      night_date: string;
      usage_minutes: number | null;
    }> = [];
    for (let i = 0; i < patientIds.length; i += NIGHT_ID_CHUNK) {
      const idChunk = patientIds.slice(i, i + NIGHT_ID_CHUNK);
      const chunkRows = await collectAllRows<{
        patient_id: string;
        night_date: string;
        usage_minutes: number | null;
      }>((from, to) =>
        supabase
          .from("patient_therapy_nights")
          .select("patient_id, night_date, source, usage_minutes")
          .in("patient_id", idChunk)
          .gte("night_date", horizonCutoff)
          .order("patient_id", { ascending: true })
          .order("night_date", { ascending: true })
          // (patient_id, night_date) is NOT unique — a patient can have
          // multiple source rows for one night — so add the `id` tiebreaker
          // to give offset paging a total order (no boundary dup/skip).
          .order("id", { ascending: true })
          .range(from, to),
      );
      nightRows.push(...chunkRows);
    }
    const nightsByPatient = new Map<
      string,
      Array<{ date: string; usageMinutes: number | null }>
    >();
    for (const row of nightRows) {
      const list = nightsByPatient.get(row.patient_id) ?? [];
      list.push({ date: row.night_date, usageMinutes: row.usage_minutes });
      nightsByPatient.set(row.patient_id, list);
    }
    const asOfDate = new Date().toISOString().slice(0, 10);
    const points: PatientCohortPoint[] = (
      (patientRows ?? []) as PatientDbRow[]
    ).map((p) => {
      const nights = nightsByPatient.get(p.id) ?? [];
      let qualifies = false;
      if (nights.length > 0) {
        const sorted = [...nights].sort((a, b) => (a.date < b.date ? -1 : 1));
        const result = findBestAdherenceWindow(
          sorted,
          sorted[0]!.date,
          asOfDate,
        );
        qualifies = result.qualifies;
      }
      return {
        signedUpAt: p.created_at,
        qualifies,
        insurancePayer: p.insurance_payer,
      };
    });
    const agg = aggregateComplianceCohorts(points);
    for (const b of agg.byMonth) {
      res.write(
        `by_month,${csvCell(b.cohort)},${b.total},${b.qualifying},${
          b.rate ?? ""
        }\n`,
      );
    }
    for (const b of agg.byPayer) {
      res.write(
        `by_payer,${csvCell(b.payer)},${b.total},${b.qualifying},${
          b.rate ?? ""
        }\n`,
      );
    }
    res.end();
  },
);

// Patient retention — repeat-supply + active/lapsed rates measured on
// fulfilled episodes. The owner's "are we keeping patients?" number,
// which the headline KPIs (throughput, conversion) don't answer.
//
// Three window knobs, all bounded:
//   * lookbackDays  — how far back to read fulfilled episodes (and thus
//                     the earliest cohort). Default 365, max 1095.
//   * activeDays    — a patient is "active" if their latest fulfilled
//                     episode is within this window. Default 120 (a bit
//                     longer than a typical 90-day resupply cadence so a
//                     patient mid-cycle isn't miscounted as lapsed).
//   * reorderDays   — a patient counts toward the repeat-rate
//                     denominator only once their first fulfilled
//                     episode is this old (had a real chance to
//                     reorder). Default 90.
const retentionQuerySchema = z.object({
  lookbackDays: z.coerce
    .number()
    .int()
    .min(30)
    .max(1095)
    .optional()
    .default(365),
  activeDays: z.coerce.number().int().min(1).max(365).optional().default(120),
  reorderDays: z.coerce.number().int().min(1).max(365).optional().default(90),
});

router.get(
  "/admin/analytics/patient-retention",
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = retentionQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { lookbackDays, activeDays, reorderDays } = parsed.data;
    const cutoff = isoDaysAgo(lookbackDays);
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Fulfilled episodes only — the real-shipment signal. Capped for
    // safety on a very long lookback; a DME book that exceeds this in a
    // year is a good problem to have and the rates stay representative.
    const { data, error } = await supabase
      .from("episodes")
      .select("patient_id, created_at")
      .eq("status", "fulfilled")
      .gte("created_at", cutoff)
      .limit(100000);
    if (error) throw error;

    const episodes: RetentionEpisodeRow[] = (
      (data ?? []) as EpisodeDbRow[]
    ).map((r) => ({
      patientId: r.patient_id,
      createdAt: r.created_at,
    }));
    const result = aggregatePatientRetention({
      episodes,
      nowMs: Date.now(),
      activeWindowDays: activeDays,
      reorderWindowDays: reorderDays,
    });
    res.json({ lookbackDays, activeDays, reorderDays, ...result });
  },
);

// Delegates to the shared safe-csv-cell helper for formula-injection
// neutralisation + RFC 4180 quoting.
function csvCell(value: unknown): string {
  return safeCsvCell(value);
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

export default router;

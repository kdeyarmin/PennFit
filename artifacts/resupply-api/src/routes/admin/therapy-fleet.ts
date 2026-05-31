// /admin/therapy-fleet — population-level therapy-cloud analytics.
//
// The per-patient Device Data tab answers "how is THIS patient doing?";
// this surface answers "how is my whole CPAP base doing, and who do I
// call today?". Both read the same `patient_therapy_nights` rollup that
// the nightly sync mirrors out of ResMed AirView / Philips Care
// Orchestrator / React Health / Health Connect.
//
//   GET  /admin/therapy-fleet/overview                     — KPI tiles
//   GET  /admin/therapy-fleet/worklist                     — outreach queue
//   GET  /admin/therapy-fleet/worklist.csv                 — CSV report
//   POST /admin/therapy-fleet/worklist/:patientId/action   — triage state
//
// Aggregation is pushed into Postgres via the resupply.therapy_fleet_*
// RPCs (migration 0179) — PostgREST can't GROUP BY, and we never want
// to stream every night row into Node. The worklist route does a second
// `patients` read to attach display names to the RPC's patient-id list,
// and a third read of `patient_worklist_actions` (migration 0181) to
// attach each patient's current triage state — so a CSR can acknowledge
// / snooze / mark-contacted / resolve a row and have it stop
// re-surfacing (snoozed + resolved are hidden unless `includeHandled`).
//
// PHI / log posture: usage / AHI / leak values ARE PHI. This module
// never logs them, and the worklist reads stay admin-gated. `overview`
// carries no patient identifiers (pure counts) so it gates on
// `reports.read`; the worklist + CSV return patient names and gate on
// `patients.read`; the action write gates on `patients.update`. The
// action audit envelope records status + patient id only — never the
// free-text note (which MAY contain PHI).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Triage states a CSR can set on a worklist row. `snoozed` requires a
// future `snoozeUntil`; `resolved` + active snoozes are hidden from the
// default worklist. Kept in lockstep with the CHECK in migration 0181.
export const WORKLIST_ACTION_STATUSES = [
  "acknowledged",
  "snoozed",
  "contacted",
  "resolved",
] as const;
export type WorklistActionStatus = (typeof WORKLIST_ACTION_STATUSES)[number];

// Reason codes the worklist RPC can emit, in priority-weight order. Kept
// in lockstep with the CASE arms in migration 0179 and the SPA labels.
export const WORKLIST_REASONS = [
  "compliance_risk",
  "no_recent_data",
  "high_ahi",
  "high_leak",
  "usage_decline",
] as const;
export type WorklistReason = (typeof WORKLIST_REASONS)[number];

const overviewQuery = z
  .object({
    windowDays: z.coerce.number().int().min(7).max(90).optional().default(30),
  })
  .strict();

const worklistQuery = z
  .object({
    windowDays: z.coerce.number().int().min(7).max(90).optional().default(30),
    limit: z.coerce.number().int().min(1).max(500).optional().default(200),
    // Optional single-reason filter so a CSR can pull "just the
    // high-leak re-fit list" or "just the compliance-risk list".
    reason: z.enum(WORKLIST_REASONS).optional(),
    // When false (default) resolved + actively-snoozed patients are
    // hidden; when true the full queue (including handled rows) returns.
    includeHandled: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v === "true"),
  })
  .strict();

const actionBody = z
  .object({
    action: z.enum(WORKLIST_ACTION_STATUSES),
    // Required when action === "snoozed"; ignored otherwise.
    snoozeUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
      .refine((s) => {
        const d = new Date(s);
        return !isNaN(d.getTime()) && d.toISOString().startsWith(s);
      }, "must be a valid calendar date")
      .optional(),
    // Optional short CSR note. MAY contain PHI — stored, never logged.
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((b) => b.action !== "snoozed" || Boolean(b.snoozeUntil), {
    message: "snoozeUntil is required when action is 'snoozed'",
    path: ["snoozeUntil"],
  });

// PostgREST returns bigint/numeric columns as strings to preserve
// precision; coerce defensively (null stays null).
function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}
function int(v: unknown): number {
  return Math.trunc(num(v) ?? 0);
}

interface OverviewRow {
  patients_with_data: number | string;
  compliant: number | string;
  at_risk: number | string;
  non_compliant: number | string;
  no_recent_data: number | string;
  high_ahi: number | string;
  high_leak: number | string;
  low_usage: number | string;
  avg_usage_minutes: number | string | null;
  avg_ahi: number | string | null;
  avg_leak_l_min: number | string | null;
  total_nights: number | string;
}

router.get(
  "/admin/therapy-fleet/overview",
  // Pure counts, no patient identifiers — viewable by anyone who can
  // see ops dashboards.
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = overviewQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const windowDays = parsed.data.windowDays;

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .rpc("therapy_fleet_overview", { p_window_days: windowDays });
    if (error) throw error;

    // The RPC returns a single-row table.
    const row = (Array.isArray(data) ? data[0] : data) as OverviewRow | null;
    res.json({
      windowDays,
      overview: {
        patientsWithData: int(row?.patients_with_data),
        cohorts: {
          compliant: int(row?.compliant),
          atRisk: int(row?.at_risk),
          nonCompliant: int(row?.non_compliant),
          noRecentData: int(row?.no_recent_data),
        },
        clinicalFlags: {
          highAhi: int(row?.high_ahi),
          highLeak: int(row?.high_leak),
          lowUsage: int(row?.low_usage),
        },
        averages: {
          usageMinutes: num(row?.avg_usage_minutes),
          ahi: num(row?.avg_ahi),
          leakLMin: num(row?.avg_leak_l_min),
        },
        totalNights: int(row?.total_nights),
      },
    });
  },
);

interface WorklistRpcRow {
  patient_id: string;
  nights_with_data: number | string;
  nights_over_4h: number | string;
  avg_usage_minutes: number | string | null;
  avg_ahi: number | string | null;
  avg_leak_l_min: number | string | null;
  prior_avg_usage_minutes: number | string | null;
  last_night_date: string | null;
  days_since_last_night: number | string | null;
  reasons: string[] | null;
  priority: number | string;
}

interface WorklistAction {
  status: WorklistActionStatus;
  snoozeUntil: string | null;
  note: string | null;
  updatedByEmail: string | null;
  updatedAt: string | null;
}

interface WorklistEntry {
  patientId: string;
  patientName: string | null;
  nightsWithData: number;
  nightsOver4h: number;
  avgUsageMinutes: number | null;
  avgAhi: number | null;
  avgLeakLMin: number | null;
  priorAvgUsageMinutes: number | null;
  lastNightDate: string | null;
  daysSinceLastNight: number | null;
  reasons: WorklistReason[];
  priority: number;
  action: WorklistAction | null;
}

interface WorklistActionRow {
  patient_id: string;
  status: string;
  snooze_until: string | null;
  note: string | null;
  updated_by_email: string | null;
  updated_at: string | null;
}

// A handled row is hidden from the default worklist when it is resolved
// or carries a snooze that hasn't elapsed yet. ISO dates compare
// lexicographically, so a plain string compare against today is correct.
function isHidden(action: WorklistAction | null, todayIso: string): boolean {
  if (!action) return false;
  if (action.status === "resolved") return true;
  if (action.status === "snoozed" && action.snoozeUntil) {
    return action.snoozeUntil > todayIso;
  }
  return false;
}

// Shared by the JSON + CSV endpoints: run the RPC, filter by reason if
// asked, attach each patient's triage state (hiding handled rows unless
// includeHandled), then attach display names. Returns the merged list.
async function buildWorklist(
  windowDays: number,
  limit: number,
  reason: WorklistReason | undefined,
  includeHandled: boolean,
): Promise<WorklistEntry[]> {
  const supabase = getSupabaseServiceRoleClient();
  // Over-fetch when we'll post-filter (reason membership and/or hiding
  // handled rows) so the trimmed result still fills a page. The RPC
  // can't cheaply apply either predicate itself.
  const needsOverfetch = Boolean(reason) || !includeHandled;
  const { data, error } = await supabase
    .schema("resupply")
    .rpc("therapy_fleet_worklist", {
      p_window_days: windowDays,
      p_limit: needsOverfetch ? Math.min(limit * 4, 500) : limit,
    });
  if (error) throw error;

  let rows = ((data ?? []) as WorklistRpcRow[]).map((r): WorklistEntry => {
    const reasons = (r.reasons ?? []).filter((x): x is WorklistReason =>
      (WORKLIST_REASONS as readonly string[]).includes(x),
    );
    return {
      patientId: r.patient_id,
      patientName: null,
      nightsWithData: int(r.nights_with_data),
      nightsOver4h: int(r.nights_over_4h),
      avgUsageMinutes: num(r.avg_usage_minutes),
      avgAhi: num(r.avg_ahi),
      avgLeakLMin: num(r.avg_leak_l_min),
      priorAvgUsageMinutes: num(r.prior_avg_usage_minutes),
      lastNightDate: r.last_night_date,
      daysSinceLastNight: num(r.days_since_last_night),
      reasons,
      priority: int(r.priority),
      action: null,
    };
  });

  if (reason) {
    rows = rows.filter((r) => r.reasons.includes(reason));
  }
  if (rows.length === 0) return rows;

  // Attach current triage state in one batched read, then hide handled
  // rows unless the caller asked for them.
  const candidateIds = rows.map((r) => r.patientId);
  const { data: actionRows, error: aErr } = await supabase
    .schema("resupply")
    .from("patient_worklist_actions")
    .select(
      "patient_id, status, snooze_until, note, updated_by_email, updated_at",
    )
    .in("patient_id", candidateIds);
  if (aErr) throw aErr;
  const actionByPatient = new Map<string, WorklistAction>();
  for (const a of (actionRows ?? []) as WorklistActionRow[]) {
    actionByPatient.set(a.patient_id, {
      status: (WORKLIST_ACTION_STATUSES as readonly string[]).includes(a.status)
        ? (a.status as WorklistActionStatus)
        : "acknowledged",
      snoozeUntil: a.snooze_until,
      note: a.note,
      updatedByEmail: a.updated_by_email,
      updatedAt: a.updated_at,
    });
  }
  for (const r of rows) {
    r.action = actionByPatient.get(r.patientId) ?? null;
  }
  if (!includeHandled) {
    const todayIso = new Date().toISOString().slice(0, 10);
    rows = rows.filter((r) => !isHidden(r.action, todayIso));
  }

  rows = rows.slice(0, limit);
  if (rows.length === 0) return rows;

  // Attach display names. The RPC deliberately returns only ids (so the
  // aggregation stays cheap); resolve names in one batched read.
  const ids = rows.map((r) => r.patientId);
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
  "/admin/therapy-fleet/worklist",
  // Returns patient names — gate on patient-record read.
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = worklistQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { windowDays, limit, reason, includeHandled } = parsed.data;
    const entries = await buildWorklist(
      windowDays,
      limit,
      reason,
      includeHandled,
    );
    res.json({ windowDays, count: entries.length, entries });
  },
);

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get(
  "/admin/therapy-fleet/worklist.csv",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = worklistQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { windowDays, limit, reason, includeHandled } = parsed.data;
    const entries = await buildWorklist(
      windowDays,
      limit,
      reason,
      includeHandled,
    );

    const filename = `therapy-fleet-worklist-${windowDays}d-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.write(
      "patient_id,patient_name,priority,reasons,nights_with_data," +
        "nights_over_4h,avg_usage_minutes,avg_ahi,avg_leak_l_min," +
        "prior_avg_usage_minutes,last_night_date,days_since_last_night\n",
    );
    for (const e of entries) {
      res.write(
        [
          csvCell(e.patientId),
          csvCell(e.patientName),
          csvCell(e.priority),
          csvCell(e.reasons.join("|")),
          csvCell(e.nightsWithData),
          csvCell(e.nightsOver4h),
          csvCell(e.avgUsageMinutes),
          csvCell(e.avgAhi),
          csvCell(e.avgLeakLMin),
          csvCell(e.priorAvgUsageMinutes),
          csvCell(e.lastNightDate),
          csvCell(e.daysSinceLastNight),
        ].join(",") + "\n",
      );
    }
    res.end();
  },
);

const patientIdParam = z.string().uuid();

// POST /admin/therapy-fleet/worklist/:patientId/action — set a
// patient's current triage state (acknowledge / snooze / mark-contacted
// / resolve). Upserts one row per patient. `resolved` + a future
// `snoozeUntil` remove the patient from the default worklist.
router.post(
  "/admin/therapy-fleet/worklist/:patientId/action",
  requirePermission("patients.update"),
  async (req, res) => {
    const idCheck = patientIdParam.safeParse(req.params.patientId);
    if (!idCheck.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const patientId = idCheck.data;

    const parsed = actionBody.safeParse(req.body);
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
    const { action, note } = parsed.data;
    // snoozeUntil only applies to the snoozed state; clear it otherwise
    // so a re-acknowledge doesn't leave a stale hide-until date.
    const snoozeUntil =
      action === "snoozed" ? (parsed.data.snoozeUntil ?? null) : null;

    const supabase = getSupabaseServiceRoleClient();

    const { data: existsRow, error: existsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle();
    if (existsErr) throw existsErr;
    if (!existsRow) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }

    const now = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .schema("resupply")
      .from("patient_worklist_actions")
      .upsert(
        {
          patient_id: patientId,
          status: action,
          snooze_until: snoozeUntil,
          note: note ?? null,
          updated_by_email: req.adminEmail ?? null,
          updated_by_user_id: req.adminUserId ?? null,
          updated_at: now,
        },
        { onConflict: "patient_id" },
      );
    if (upsertErr) throw upsertErr;

    // Audit envelope: status + patient id + snooze date only. The note
    // MAY contain PHI, so it is never logged.
    await logAudit({
      action: "therapy.worklist.action.set",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_worklist_actions",
      targetId: patientId,
      metadata: {
        patient_id: patientId,
        status: action,
        snooze_until: snoozeUntil,
        has_note: Boolean(note),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "therapy.worklist.action.set audit write failed");
    });

    res.json({
      patientId,
      action: {
        status: action,
        snoozeUntil,
        note: note ?? null,
        updatedByEmail: req.adminEmail ?? null,
        updatedAt: now,
      },
    });
  },
);

export default router;

// /admin/analytics/rt-outcomes — per-RT outcomes dashboard (Phase 3,
// RT #24). "What is each respiratory therapist actually moving?" —
// encounters authored, distinct patients managed, follow-ups committed,
// and interventions logged, rolled up per author over a window.
//
// Derived ONLY from `clinical_encounters` (the F3 append-only log) —
// never `audit_log` (retired; ground rule 4). The response is
// aggregates / counts per staff author: NO patient ids, NO clinical
// text ever leaves this route. `clinical.read`-gated, so an RT sees
// their own + peers' counts and management sees the team's.
//
// "Adherence lift" (did usage actually improve after the intervention?)
// needs a therapy-metric before/after join and is a deliberate
// follow-up — we surface honest encounter-derived counts here rather
// than fabricate an outcome number we can't yet measure.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

export const ENCOUNTER_TYPES = [
  "mask_fit",
  "troubleshoot",
  "setup_education",
  "adherence_intervention",
  "phone",
  "other",
] as const;
export type EncounterType = (typeof ENCOUNTER_TYPES)[number];

/** One row of `clinical_encounters` as this route reads it. */
export interface EncounterRow {
  author_user_id: string | null;
  author_email: string;
  encounter_type: string;
  patient_id: string;
  follow_up_at: string | null;
  created_at: string;
}

export interface RtOutcomeRow {
  authorEmail: string;
  authorUserId: string | null;
  encountersTotal: number;
  /** Distinct patients this RT touched in the window. */
  patientsManaged: number;
  /** Encounters that committed a future follow-up. */
  followUpsCommitted: number;
  /** `adherence_intervention` encounters — the "did something about it" count. */
  interventions: number;
  byType: Record<EncounterType, number>;
  lastActiveAt: string | null;
}

export interface RtOutcomesReport {
  windowDays: number;
  rows: RtOutcomeRow[];
  totals: {
    encounters: number;
    rts: number;
    patientsManaged: number;
    followUpsCommitted: number;
    interventions: number;
  };
}

function emptyByType(): Record<EncounterType, number> {
  return {
    mask_fit: 0,
    troubleshoot: 0,
    setup_education: 0,
    adherence_intervention: 0,
    phone: 0,
    other: 0,
  };
}

function normalizeType(t: string): EncounterType {
  return (ENCOUNTER_TYPES as readonly string[]).includes(t)
    ? (t as EncounterType)
    : "other";
}

interface Acc {
  authorEmail: string;
  authorUserId: string | null;
  encountersTotal: number;
  patients: Set<string>;
  followUpsCommitted: number;
  byType: Record<EncounterType, number>;
  lastActiveAt: string | null;
}

/**
 * Pure: fold encounter rows into a per-author outcome rollup. Grouped
 * by `author_email` (the stable label; `author_user_id` can be null
 * after an ex-employee row is gone). Sorted most-active-first. No I/O —
 * unit-tested directly.
 */
export function buildRtOutcomes(
  rows: EncounterRow[],
  windowDays: number,
): RtOutcomesReport {
  const byAuthor = new Map<string, Acc>();
  const allPatients = new Set<string>();

  for (const r of rows) {
    const email = (r.author_email ?? "").trim() || "<unknown>";
    let acc = byAuthor.get(email);
    if (!acc) {
      acc = {
        authorEmail: email,
        authorUserId: r.author_user_id ?? null,
        encountersTotal: 0,
        patients: new Set<string>(),
        followUpsCommitted: 0,
        byType: emptyByType(),
        lastActiveAt: null,
      };
      byAuthor.set(email, acc);
    }
    acc.encountersTotal += 1;
    if (r.patient_id) {
      acc.patients.add(r.patient_id);
      allPatients.add(r.patient_id);
    }
    if (r.follow_up_at) acc.followUpsCommitted += 1;
    acc.byType[normalizeType(r.encounter_type)] += 1;
    if (
      r.created_at &&
      (acc.lastActiveAt === null ||
        Date.parse(r.created_at) > Date.parse(acc.lastActiveAt))
    ) {
      acc.lastActiveAt = r.created_at;
    }
    // Backfill a stable user id if the first row for this author had none.
    if (acc.authorUserId === null && r.author_user_id) {
      acc.authorUserId = r.author_user_id;
    }
  }

  const outRows: RtOutcomeRow[] = Array.from(byAuthor.values())
    .map((a) => ({
      authorEmail: a.authorEmail,
      authorUserId: a.authorUserId,
      encountersTotal: a.encountersTotal,
      patientsManaged: a.patients.size,
      followUpsCommitted: a.followUpsCommitted,
      interventions: a.byType.adherence_intervention,
      byType: a.byType,
      lastActiveAt: a.lastActiveAt,
    }))
    .sort(
      (x, y) =>
        y.encountersTotal - x.encountersTotal ||
        x.authorEmail.localeCompare(y.authorEmail),
    );

  return {
    windowDays,
    rows: outRows,
    totals: {
      encounters: rows.length,
      rts: outRows.length,
      patientsManaged: allPatients.size,
      followUpsCommitted: outRows.reduce((n, r) => n + r.followUpsCommitted, 0),
      interventions: outRows.reduce((n, r) => n + r.interventions, 0),
    },
  };
}

const querySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).default(90),
});

router.get(
  "/admin/analytics/rt-outcomes",
  // Limiter before the auth gate (CodeQL "missing rate limiting" wants
  // the throttle ahead of authorization).
  adminReadRateLimiter,
  requirePermission("clinical.read"),
  async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const { windowDays } = parsed.data;
    const since = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();

    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("clinical_encounters")
      .select(
        "author_user_id, author_email, encounter_type, patient_id, follow_up_at, created_at",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    const report = buildRtOutcomes(
      (data ?? []) as unknown as EncounterRow[],
      windowDays,
    );
    res.json(report);
  },
);

export default router;

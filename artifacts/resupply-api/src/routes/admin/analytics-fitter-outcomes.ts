// /admin/analytics/fitter-outcomes — how well the mask fitter is doing.
//
//   GET /admin/analytics/fitter-outcomes?days=90
//
// WHY THIS EXISTS
// ---------------
// Every number here was already being written and none of it was being
// read as a rate. `mask_fit_outcomes` (0201/0203) fed the engine's
// per-mask tuning multiplier and `fit_sessions` (0483) drove the RT
// review queue, but nothing answered "how often does a mask we fitted
// come back as a bad fit" — which is the single number this market's
// vendors sell on, and the one a DME evaluating us will ask for.
//
// This is a READ-SIDE build: no new capture, no migration. The cohort
// math is the pure, unit-tested `buildFitterOutcomesReport` in
// @workspace/resupply-domain; this file only sources rows and maps them.
//
// WHAT IS DELIBERATELY NOT REPORTED
// ---------------------------------
// The fitter SPA emits scan-failure reason codes (`no_face`,
// `iris_too_small`, …) through `track()`. They land in
// `public.usage_events`, which is an anonymous funnel table with NO
// `org_id` — reading it here would show one DME another DME's scan
// failures. Scan health is reported instead from
// `fit_sessions.scan_quality_grade`, which is org-scoped and describes
// the scans that actually produced a fitting.
//
// PHI: none leaves this route. Aggregates and mask identifiers only — no
// patient ids, no names, no per-patient rows.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  buildFitterOutcomesReport,
  type FitEntryPoint,
  type FitSessionInput,
  type FitSessionOutcome,
  type MaskFitOutcomeInput,
  type MaskFitVerdict,
  type ScanQualityGrade,
} from "@workspace/resupply-domain";

import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

/**
 * Row caps, and why they are enforced by PAGING rather than one big limit.
 *
 * PostgREST is configured with `max_rows = 1000` (supabase/config.toml),
 * so a single request asking for 20,000 rows silently returns 1,000 and
 * reports no error. A `rows.length >= 20_000` truncation check against
 * that never fires — the page would compute every rate from the newest
 * 1,000 rows while telling the reader the period was complete. That is
 * precisely the lie about the denominator this page exists to avoid, so
 * these reads walk the window a page at a time and only report truncation
 * when the real ceiling is reached.
 */
const PAGE_SIZE = 1000;
const SESSION_ROW_CAP = 20_000;
const OUTCOME_ROW_CAP = 20_000;

interface PagedRead {
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  error: { message: string } | null;
}

/**
 * Read up to `cap` rows in `PAGE_SIZE` pages, newest first.
 *
 * `truncated` means the cap stopped us, not that the window was empty —
 * the caller surfaces it so a partial period never renders as a complete
 * one.
 */
async function readPaged(
  makeQuery: () => {
    range: (
      from: number,
      to: number,
    ) => PromiseLike<{
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    }>;
  },
  cap: number,
): Promise<PagedRead> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < cap; offset += PAGE_SIZE) {
    const size = Math.min(PAGE_SIZE, cap - offset);
    const { data, error } = await makeQuery().range(offset, offset + size - 1);
    if (error) return { rows, truncated: false, error };
    const page = data ?? [];
    rows.push(...page);
    // A short page means the window is exhausted.
    if (page.length < size) return { rows, truncated: false, error: null };
  }
  return { rows, truncated: true, error: null };
}

const query = z
  .object({
    days: z.coerce.number().int().min(1).max(730).default(90),
  })
  .strict();

const ENTRY_POINTS = new Set<FitEntryPoint>([
  "remote_link",
  "in_office",
  "kiosk_qr",
]);
const OUTCOMES = new Set<FitSessionOutcome>([
  "high_confidence",
  "moderate_confidence",
  "low_confidence",
  "contraindicated",
  "outside_validated_range",
]);
const SCAN_GRADES = new Set<ScanQualityGrade>(["good", "marginal", "poor"]);
const VERDICTS = new Set<MaskFitVerdict>(["good", "leaking", "uncomfortable"]);

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

router.get(
  "/admin/analytics/fitter-outcomes",
  adminReadRateLimiter,
  // Refit rates and override reasons are clinical outcome data — same
  // gate as the mask-fit worklist and the fit-session review queue.
  requirePermission("clinical.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const parsed = query.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const days = parsed.data.days;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const supabase = getOrgScopedClient(orgId);

    const [sessionsRes, outcomesRes] = await Promise.all([
      readPaged(
        () =>
          supabase
            .from("fit_sessions")
            .select(
              "id, created_at, entry_point, outcome, scan_quality_grade, degraded, primary_mask_model_id, override_mask_model_id, override_reason, ordered_mask_model_id, reviewed_at, dispensed_at",
            )
            .gte("created_at", since)
            .order("created_at", { ascending: false }) as never,
        SESSION_ROW_CAP,
      ),
      readPaged(
        () =>
          supabase
            .from("mask_fit_outcomes")
            .select("mask_id, fit_outcome, created_at")
            .gte("created_at", since)
            .order("created_at", { ascending: false }) as never,
        OUTCOME_ROW_CAP,
      ),
    ]);

    if (sessionsRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: sessionsRes.error.message });
      return;
    }
    if (outcomesRes.error) {
      res
        .status(500)
        .json({ error: "query_failed", message: outcomesRes.error.message });
      return;
    }

    const sessionRows = sessionsRes.rows;
    const outcomeRows = outcomesRes.rows;

    const sessions: FitSessionInput[] = sessionRows.map((r) => {
      const entryPoint = str(r.entry_point) as FitEntryPoint | null;
      const outcome = str(r.outcome) as FitSessionOutcome | null;
      const grade = str(r.scan_quality_grade) as ScanQualityGrade | null;
      return {
        id: String(r.id),
        createdAt: String(r.created_at ?? ""),
        // An unrecognised value falls back to the default rather than
        // inventing a bucket; the CHECK constraint makes this unreachable
        // in practice, but the report must not throw on a stray row.
        entryPoint:
          entryPoint && ENTRY_POINTS.has(entryPoint)
            ? entryPoint
            : "remote_link",
        outcome: outcome && OUTCOMES.has(outcome) ? outcome : null,
        scanQualityGrade: grade && SCAN_GRADES.has(grade) ? grade : null,
        degraded: r.degraded === true,
        primaryMaskModelId: str(r.primary_mask_model_id),
        overrideMaskModelId: str(r.override_mask_model_id),
        overrideReason: str(r.override_reason),
        orderedMaskModelId: str(r.ordered_mask_model_id),
        reviewedAt: str(r.reviewed_at),
        dispensedAt: str(r.dispensed_at),
      };
    });

    const outcomes: MaskFitOutcomeInput[] = outcomeRows.flatMap((r) => {
      const verdict = str(r.fit_outcome) as MaskFitVerdict | null;
      // A verdict we don't recognise is dropped rather than bucketed as
      // "good" — a mis-bucketed bad fit understates the headline rate.
      if (!verdict || !VERDICTS.has(verdict)) return [];
      return [{ maskId: str(r.mask_id), verdict }];
    });

    const report = buildFitterOutcomesReport(sessions, outcomes);

    // Resolve display names by SLUG, not by id.
    //
    // `mask_fit_outcomes.mask_id` is text holding the recommendation
    // engine's identifier — "resmed-airfit-f20" — while `mask_models.id`
    // is a uuid. The matching column is `mask_models.slug`. Querying `id`
    // with slug values matched nothing on real data, so the per-mask table
    // silently showed raw slugs for every row.
    //
    // Still best-effort: an unresolvable id keeps showing its raw value
    // rather than dropping the row, since the rate is the point and the
    // label is the decoration.
    const maskIds = report.refit.byMask.map((m) => m.maskId);
    const labels = new Map<string, string>();
    if (maskIds.length > 0) {
      const { data } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_models")
        .select("slug, manufacturer, model_name")
        .in("slug", maskIds)) as {
        data: Array<Record<string, unknown>> | null;
      };
      for (const row of data ?? []) {
        const slug = str(row.slug);
        if (!slug) continue;
        const name = [str(row.manufacturer), str(row.model_name)]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (name) labels.set(slug, name);
      }
    }

    res.json({
      window: { days, since },
      truncated: {
        sessions: sessionsRes.truncated,
        outcomes: outcomesRes.truncated,
      },
      report: {
        ...report,
        refit: {
          ...report.refit,
          byMask: report.refit.byMask.map((m) => ({
            ...m,
            maskLabel: labels.get(m.maskId) ?? m.maskLabel,
          })),
        },
      },
    });
  },
);

export default router;

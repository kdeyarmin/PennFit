// Therapy-cloud connection validation + portal reconciliation.
//
// Two things that did not exist, both for the same reason: every check we
// had was a check against ourselves.
//
//   POST /admin/integrations/:source/validate
//     One patient, four named steps, so the FIRST real call to a vendor
//     is deliberate and small rather than buried in a nightly sync
//     across a thousand links — where a wrong endpoint shape is
//     indistinguishable from "the vendor has no data for these patients".
//
//   POST /admin/integrations/:source/reconcile
//     Diff the vendor's own portal export against what we stored.
//     `diff-settings.ts` compares our new snapshot to our PREVIOUS
//     snapshot, which by construction cannot notice that we are missing a
//     patient, missing nights, or reading a device the portal swapped
//     out. A sync could have been quietly behind for months.
//
// PHI: the validate response carries step outcomes and vendor error CODES
// — never a response body. The reconcile response and its stored row
// carry counts plus a CAPPED sample of partner patient ids; without the
// sample the report says "14 patients disagree" and gives nobody a way to
// act on it. No names, no clinical content.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient, type Json } from "@workspace/resupply-db";
import {
  INTEGRATION_SOURCES,
  reconcileIntegrationSource,
  type LocalPatientRow,
  type PortalPatientRow,
} from "@workspace/resupply-integrations";

import { recordReconciliationOutcome } from "../../lib/integrations/connector-status";
import { logger } from "../../lib/logger";
import { validateIntegrationConnection } from "../../lib/integrations/validate-connection";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const PAGE_SIZE = 1000;
/** PostgREST URL-length ceiling for a chunked `.in(...)`. */
const READ_CHUNK = 200;
/** A portal export for one practice; well above a realistic roster. */
const MAX_PORTAL_ROWS = 20_000;

/**
 * Whether the night-count / average-usage comparison actually ran.
 *
 * Reported because the alternative is a zero nobody can interpret: a
 * report that skipped the comparison and one that ran it and found
 * nothing wrong are the same output, and the first is the state this
 * whole route existed in before.
 */
type TherapyComparison =
  /** The export carried no night or usage columns. */
  | "not_requested"
  /** It did, but no window was given, so there is nothing to compare
   *  against — our nights and theirs only mean the same thing over the
   *  same dates. */
  | "skipped_no_window"
  /** Our own nights could not be read. */
  | "unavailable"
  | "compared";

/**
 * Nights-with-usage and average usage per patient over the window,
 * straight from `patient_therapy_nights` — the same rollup the
 * compliance rules read, so the reconciliation compares the portal
 * against the number the practice actually acts on.
 *
 * Chunked and paged: nights are one row per patient per day, so a month
 * for a mid-sized practice is well past the ~1000-row truncation point,
 * and a silent truncation here would invent usage mismatches out of
 * nothing.
 *
 * A NULL `usage_minutes` is a gap in the feed, not a zero-usage night
 * (migration 0046 says so explicitly), so it counts toward neither the
 * night tally nor the average.
 */
async function loadTherapyMetrics(
  supabase: ReturnType<typeof getOrgScopedClient>,
  patientIds: readonly string[],
  windowStart: string,
  windowEnd: string,
): Promise<Map<string, { nightsWithUsage: number; avgUsageMinutes: number }>> {
  const totals = new Map<string, { nights: number; minutes: number }>();

  for (let i = 0; i < patientIds.length; i += READ_CHUNK) {
    const chunk = patientIds.slice(i, i + READ_CHUNK);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("patient_therapy_nights")
        .select("patient_id, usage_minutes")
        .in("patient_id", chunk)
        .gte("night_date", windowStart)
        .lte("night_date", windowEnd)
        .order("patient_id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const row of data as Array<{
        patient_id: string | null;
        usage_minutes: number | null;
      }>) {
        if (!row.patient_id) continue;
        if (typeof row.usage_minutes !== "number") continue;
        if (row.usage_minutes <= 0) continue;
        const acc = totals.get(row.patient_id) ?? { nights: 0, minutes: 0 };
        acc.nights += 1;
        acc.minutes += row.usage_minutes;
        totals.set(row.patient_id, acc);
      }
      if (data.length < PAGE_SIZE) break;
    }
  }

  const out = new Map<
    string,
    { nightsWithUsage: number; avgUsageMinutes: number }
  >();
  for (const [patientId, acc] of totals) {
    out.set(patientId, {
      nightsWithUsage: acc.nights,
      // Averaged over nights WITH usage, matching how portals report it.
      avgUsageMinutes: acc.minutes / acc.nights,
    });
  }
  return out;
}

const sourceSchema = z.enum(INTEGRATION_SOURCES);

const validateBody = z
  .object({
    /** The vendor's own id for a patient the operator can see in the
     *  portal — so a failure is unambiguous rather than "maybe that
     *  patient just isn't there". */
    partnerPatientId: z.string().trim().min(1).max(128),
    windowDays: z.coerce.number().int().min(1).max(120).optional(),
  })
  .strict();

const reconcileBody = z
  .object({
    /**
     * Rows lifted from the vendor's portal export. Accepted as JSON
     * rather than raw CSV because every vendor's export has different
     * headers — the UI does the column mapping, which keeps a
     * per-vendor parser out of the server.
     */
    rows: z
      .array(
        z
          .object({
            partnerPatientId: z.string().trim().min(1).max(128),
            deviceSerial: z.string().trim().max(128).nullable().optional(),
            nightsWithUsage: z.coerce
              .number()
              .int()
              .min(0)
              .max(400)
              .nullable()
              .optional(),
            avgUsageMinutes: z.coerce
              .number()
              .min(0)
              .max(1440)
              .nullable()
              .optional(),
          })
          .strict(),
      )
      .max(MAX_PORTAL_ROWS),
    windowStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    windowEnd: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// POST /admin/integrations/:source/validate
// ---------------------------------------------------------------------------
router.post(
  "/admin/integrations/:source/validate",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const source = sourceSchema.safeParse(req.params.source);
    if (!source.success) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }
    const parsed = validateBody.safeParse(req.body);
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

    // The validator records its own outcome to
    // `integration_connector_status` (migration 0542), so the answer to
    // "has this connector ever actually worked here, and when?" survives
    // the response being closed.
    const result = await validateIntegrationConnection({
      orgId,
      source: source.data,
      partnerPatientId: parsed.data.partnerPatientId,
      windowDays: parsed.data.windowDays,
      actorEmail: req.adminEmail ?? null,
    });

    await logAudit({
      action: "integration.connection_validated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "patient_therapy_links",
      targetId: null,
      // Structural only. The partner patient id is deliberately NOT
      // logged: it is the vendor's identifier for a real person.
      metadata: {
        source: source.data,
        ok: result.ok,
        failed_step:
          result.steps.find((s) => s.status === "fail")?.name ?? null,
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// POST /admin/integrations/:source/reconcile
// ---------------------------------------------------------------------------
router.post(
  "/admin/integrations/:source/reconcile",
  adminWriteRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const source = sourceSchema.safeParse(req.params.source);
    if (!source.success) {
      res.status(400).json({ error: "unknown_source" });
      return;
    }
    const parsed = reconcileBody.safeParse(req.body);
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

    const supabase = getOrgScopedClient(orgId);

    // What WE hold for this source. Paged: a practice's link table grows
    // without bound and an unpaginated read truncates at ~1000, which
    // here would invent hundreds of "missing locally" discrepancies out
    // of nothing.
    const local: LocalPatientRow[] = [];
    /** partner id → our patient id, so nights can be attributed back. */
    const patientIdByPartnerId = new Map<string, string>();
    try {
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .from("patient_therapy_links")
          .select(
            "patient_id, partner_patient_id, device_serial, last_synced_at, status",
          )
          .eq("source", source.data)
          .eq("status", "active")
          .order("partner_patient_id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const row of data as Array<{
          patient_id: string | null;
          partner_patient_id: string | null;
          device_serial: string | null;
          last_synced_at: string | null;
        }>) {
          if (!row.partner_patient_id) continue;
          local.push({
            partnerPatientId: row.partner_patient_id,
            deviceSerial: row.device_serial,
            lastSyncedAt: row.last_synced_at,
          });
          if (row.patient_id) {
            patientIdByPartnerId.set(row.partner_patient_id, row.patient_id);
          }
        }
        if (data.length < PAGE_SIZE) break;
      }
    } catch (err) {
      logger.error(
        {
          event: "integration.reconcile_local_read_failed",
          source: source.data,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "reconcile: could not read local therapy links",
      );
      res.status(503).json({ error: "lookup_failed" });
      return;
    }

    const portal: PortalPatientRow[] = parsed.data.rows.map((r) => ({
      partnerPatientId: r.partnerPatientId,
      deviceSerial: r.deviceSerial ?? null,
      nightsWithUsage: r.nightsWithUsage ?? null,
      avgUsageMinutes: r.avgUsageMinutes ?? null,
    }));

    // ── Therapy metrics ───────────────────────────────────────────────
    //
    // `patient_therapy_links` carries neither a night count nor an
    // average, so without this every local row leaves both undefined and
    // the reconciler — which correctly refuses to compare a value it does
    // not have — skips its night-count and usage checks entirely. The
    // report then says zero discrepancies no matter how far behind the
    // sync is, on the two numbers the runbook calls the clinically
    // important ones: compliance and resupply eligibility are decided
    // from them.
    //
    // It is gated on a WINDOW, and that is not a nicety. Our nights and
    // the portal's export only mean the same thing over the same dates;
    // comparing our rolling history against their unstated period would
    // report every patient in the practice. When no window is given the
    // comparison does not run — and the response SAYS so, rather than
    // reporting a zero it did not earn.
    const wantsTherapyCompare = portal.some(
      (r) => r.nightsWithUsage !== null || r.avgUsageMinutes !== null,
    );
    const hasWindow = Boolean(parsed.data.windowStart && parsed.data.windowEnd);
    let therapyComparison: TherapyComparison = "not_requested";

    if (wantsTherapyCompare && !hasWindow) {
      therapyComparison = "skipped_no_window";
    } else if (wantsTherapyCompare && hasWindow) {
      try {
        const metrics = await loadTherapyMetrics(
          supabase,
          [...new Set(patientIdByPartnerId.values())],
          parsed.data.windowStart as string,
          parsed.data.windowEnd as string,
        );
        for (const row of local) {
          const patientId = patientIdByPartnerId.get(row.partnerPatientId);
          const m = patientId ? metrics.get(patientId) : undefined;
          // Absent stays absent: a patient with no rows in the window is
          // "we have nothing", not "we have zero nights", and the
          // reconciler must keep skipping them rather than reporting a
          // mismatch against a number we never held.
          if (!m) continue;
          row.nightsWithUsage = m.nightsWithUsage;
          row.avgUsageMinutes = m.avgUsageMinutes;
        }
        therapyComparison = "compared";
      } catch (err) {
        logger.warn(
          {
            event: "integration.reconcile_nights_read_failed",
            source: source.data,
            errName: err instanceof Error ? err.name : "unknown",
          },
          "reconcile: could not load therapy nights; night/usage comparison skipped",
        );
        therapyComparison = "unavailable";
      }
    }

    const result = reconcileIntegrationSource(source.data, portal, local);

    // Persist the run so a practice can see whether the gap is closing.
    // Best-effort: the operator has the answer on screen either way, and
    // a failed write must not lose it.
    let runId: string | null = null;
    try {
      const { data, error } = await supabase
        .from("integration_reconciliation_runs")
        .insert({
          source: source.data,
          status: "completed",
          portal_rows: result.portalRows,
          local_rows: result.localRows,
          matched_count: result.matchedCount,
          missing_locally_count: result.missingLocallyCount,
          missing_in_portal_count: result.missingInPortalCount,
          mismatched_count: result.mismatchedCount,
          discrepancies: result.discrepancies as unknown as Json,
          window_start: parsed.data.windowStart ?? null,
          window_end: parsed.data.windowEnd ?? null,
          run_by_email: req.adminEmail ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;
      runId = (data as { id: string } | null)?.id ?? null;
    } catch (err) {
      logger.warn(
        {
          event: "integration.reconcile_persist_failed",
          source: source.data,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "reconcile: could not record the run",
      );
    }

    // Stamp the connector's own status row too, so the integrations
    // health page can say when this source was last reconciled without
    // joining the runs table. Fail-soft for the same reason as above.
    await recordReconciliationOutcome({
      orgId,
      source: source.data,
      status: runId ? "completed" : "failed",
    });

    await logAudit({
      action: "integration.reconciled",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "integration_reconciliation_runs",
      targetId: runId,
      metadata: {
        source: source.data,
        portal_rows: result.portalRows,
        local_rows: result.localRows,
        missing_locally: result.missingLocallyCount,
        missing_in_portal: result.missingInPortalCount,
        mismatched: result.mismatchedCount,
      },
    });

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ runId, therapyComparison, ...result });
  },
);

// ---------------------------------------------------------------------------
// GET /admin/integrations/reconciliation-runs — the history, so a practice
// can see whether the gap is closing rather than only how big it is today.
// ---------------------------------------------------------------------------
router.get(
  "/admin/integrations/reconciliation-runs",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const { data, error } = await getOrgScopedClient(orgId)
      .from("integration_reconciliation_runs")
      .select(
        "id, source, status, portal_rows, local_rows, matched_count, missing_locally_count, missing_in_portal_count, mismatched_count, window_start, window_end, run_by_email, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ runs: data ?? [] });
  },
);

export default router;

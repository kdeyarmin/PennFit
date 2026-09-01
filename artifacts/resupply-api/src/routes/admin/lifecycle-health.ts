// GET /admin/lifecycle-health — is the resupply lifecycle healthy, and
// how do we know?
//
// The platform has single-purpose watchers already: a dead-letter
// digest, a delivery-failure spike monitor, a KPI evaluator over
// metrics_daily. Each earns its keep and none of them can answer the
// question above, because the lifecycle's failure modes are spread
// across intake, outreach, fulfilment, billing, integrations and
// tenancy — and the expensive ones are exactly the quiet ones no single
// subsystem owns. Shipped and never billed is nobody's error log.
//
// COMPUTED LIVE, NOT READ FROM A SNAPSHOT
// ---------------------------------------
// The worker scan and this route share the same collectors and the same
// evaluator, but this route takes its OWN reading rather than rendering
// the last scan. A panel that shows a two-hour-old number without saying
// so is how an operator acts on a problem that was already fixed, or
// misses one that started twenty minutes ago.
//
// The one exception is dead-letter depth, which needs a pg-boss handle
// that an HTTP request does not have. That signal is read from the last
// scan's snapshot and reports its own age, so it is visibly a stored
// reading rather than a fresh one.
//
// IT CHANGES NOTHING. Read-only, no writes, no side effects — opening
// the panel neither opens nor resolves an alert.
//
// PHI: signal keys, statuses, counts, ages, ratios and a bounded detail
// map of numbers and vocabulary strings. Nothing here reaches a patient
// record.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { PLATFORM_SCOPE } from "../../lib/lifecycle-health/alerts";
import { collectTenantObservations } from "../../lib/lifecycle-health/collect";
import {
  compareForDisplay,
  evaluateSignal,
  formatSignalValue,
  resolveSignalThresholds,
  type SignalObservation,
} from "../../lib/lifecycle-health/evaluate";
import {
  isWorkerOnly,
  LIFECYCLE_SIGNALS,
  TENANT_SIGNALS,
} from "../../lib/lifecycle-health/signals";
import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const HOUR_MS = 60 * 60 * 1000;

interface SnapshotRow {
  signal_key: string;
  status: string;
  observed_value: number | null;
  sample_size: number | null;
  detail: Record<string, unknown> | null;
  observed_at: string;
}

interface OpenAlertRow {
  signal_key: string;
  status: string;
  peak_status: string;
  first_observed_at: string;
  last_notified_at: string | null;
  notify_count: number;
}

/**
 * The last scan's readings, keyed by signal.
 *
 * Used for two things: filling in the worker-only signals, and stamping
 * every row with when the background scan last looked — so "the monitor
 * is quiet" and "the monitor has not run since Tuesday" do not render
 * the same.
 */
async function readSnapshot(
  db: ReturnType<typeof getOrgScopedClient>,
  scopeId: string,
): Promise<Map<string, SnapshotRow>> {
  const { data, error } = await db
    .from("lifecycle_health_observations")
    .select("signal_key,status,observed_value,sample_size,detail,observed_at")
    .eq("scope_id", scopeId);
  if (error) throw error;
  const out = new Map<string, SnapshotRow>();
  for (const row of (data ?? []) as unknown as SnapshotRow[]) {
    out.set(row.signal_key, row);
  }
  return out;
}

async function readOpen(
  db: ReturnType<typeof getOrgScopedClient>,
  scopeId: string,
): Promise<Map<string, OpenAlertRow>> {
  const { data, error } = await db
    .from("lifecycle_health_alerts")
    .select(
      "signal_key,status,peak_status,first_observed_at,last_notified_at,notify_count",
    )
    .eq("scope_id", scopeId)
    .is("resolved_at", null);
  if (error) throw error;
  const out = new Map<string, OpenAlertRow>();
  for (const row of (data ?? []) as unknown as OpenAlertRow[]) {
    out.set(row.signal_key, row);
  }
  return out;
}

/** Turn a stored snapshot row back into an observation. */
function snapshotToObservation(row: SnapshotRow): SignalObservation {
  if (
    row.status === "disabled" ||
    row.status === "not_configured" ||
    row.status === "unknown"
  ) {
    return {
      state: row.status,
      value: null,
      reason: String(row.detail?.reason ?? "") || undefined,
    };
  }
  return {
    state: "measured",
    value: row.observed_value,
    sample: row.sample_size,
    detail: (row.detail ?? {}) as Record<string, number | string | null>,
  };
}

router.get(
  "/admin/lifecycle-health",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId || !orgId.trim()) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const now = Date.now();
    const db = getOrgScopedClient(orgId);

    // The snapshot and open-alert reads are supporting detail, not the
    // panel: a failure in either must not blank the live readings.
    const [snapshot, open] = await Promise.all([
      readSnapshot(db, orgId).catch((err) => {
        logger.warn(
          {
            event: "lifecycle_health.snapshot_read_failed",
            errName: err instanceof Error ? err.name : "unknown",
          },
          "lifecycle-health: could not read the last scan snapshot",
        );
        return new Map<string, SnapshotRow>();
      }),
      readOpen(db, orgId).catch((err) => {
        logger.warn(
          {
            event: "lifecycle_health.open_alerts_read_failed",
            errName: err instanceof Error ? err.name : "unknown",
          },
          "lifecycle-health: could not read open alerts",
        );
        return new Map<string, OpenAlertRow>();
      }),
    ]);

    const observations = await collectTenantObservations(orgId, { nowMs: now });

    const rows = TENANT_SIGNALS.map((signal) => {
      const stored = snapshot.get(signal.key) ?? null;

      // Worker-only signals cannot be measured from an HTTP request.
      // Read the stored one and say how old it is; never silently render
      // it as though it were taken now.
      const fromWorker = isWorkerOnly(signal.key);
      const observation: SignalObservation = fromWorker
        ? stored
          ? snapshotToObservation(stored)
          : {
              state: "unknown",
              value: null,
              reason:
                "This signal is measured by the background scan, which has not reported yet.",
            }
        : (observations[signal.key] ?? {
            state: "unknown",
            value: null,
            reason: "No reading was taken for this signal.",
          });

      const evaluation = evaluateSignal(signal, observation);
      const thresholds = resolveSignalThresholds(signal, process.env);
      const alert = open.get(signal.key) ?? null;
      const openSince = alert ? Date.parse(alert.first_observed_at) : NaN;

      return {
        key: signal.key,
        label: signal.label,
        category: signal.category,
        severity: signal.severity,
        unit: signal.unit,
        why: signal.why,
        href: signal.remedyHref,
        runbookAnchor: signal.runbookAnchor,

        /** ok | warning | failure | disabled | not_configured | unknown */
        status: evaluation.status,
        value: evaluation.value,
        /** Pre-formatted, so three surfaces cannot render one number three ways. */
        display: formatSignalValue(evaluation.value, signal.unit),
        sample: evaluation.sample,
        reason: evaluation.reason,
        /** A breach held back because the population was too small to judge. */
        withheld: evaluation.withheld,
        /** True when the read hit its cap — the value is a FLOOR, not a total. */
        truncated: evaluation.truncated,
        detail: evaluation.detail,

        warnThreshold: thresholds.warn,
        failThreshold: thresholds.fail,
        /**
         * `default` | `env` | `default_after_invalid_env`. The third one
         * matters: somebody set the variable and it did not take, which
         * looks identical to a default from every other angle.
         */
        thresholdSource: thresholds.source,
        warnEnv: signal.warnEnv,
        failEnv: signal.failEnv,

        /** True when this reading came from the last background scan. */
        fromLastScan: fromWorker,
        lastScanAt: stored?.observed_at ?? null,
        lastScanAgeHours:
          stored && Number.isFinite(Date.parse(stored.observed_at))
            ? Math.round(
                ((now - Date.parse(stored.observed_at)) / HOUR_MS) * 10,
              ) / 10
            : null,

        /** The open alert this signal already has, if any. */
        alertOpen: alert !== null,
        alertOpenHours:
          alert && Number.isFinite(openSince)
            ? Math.round(((now - openSince) / HOUR_MS) * 10) / 10
            : null,
        alertPeakStatus: alert?.peak_status ?? null,
        alertNotifyCount: alert?.notify_count ?? null,
      };
    }).sort(compareForDisplay);

    const count = (status: string) =>
      rows.filter((r) => r.status === status).length;

    // How stale is the background scan itself? Its own liveness is a
    // signal: a panel that renders perfectly while nothing has scanned
    // for a day is the exact false comfort this subsystem exists to
    // remove.
    const scanTimes = [...snapshot.values()]
      .map((r) => Date.parse(r.observed_at))
      .filter((t) => Number.isFinite(t));
    const lastScanAt = scanTimes.length > 0 ? Math.max(...scanTimes) : null;

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      signals: rows,
      refreshedAt: new Date(now).toISOString(),
      /** null when the background scan has never reported for this tenant. */
      lastScanAt:
        lastScanAt === null ? null : new Date(lastScanAt).toISOString(),
      lastScanAgeHours:
        lastScanAt === null
          ? null
          : Math.round(((now - lastScanAt) / HOUR_MS) * 10) / 10,
      totals: {
        signalCount: rows.length,
        catalogSize: LIFECYCLE_SIGNALS.length,
        failure: count("failure"),
        warning: count("warning"),
        ok: count("ok"),
        // Reported separately, always. Folding these into "ok" is the
        // single change that would make this panel lie.
        disabled: count("disabled"),
        notConfigured: count("not_configured"),
        unknown: count("unknown"),
        truncated: rows.filter((r) => r.truncated).length,
        openAlerts: open.size,
      },
      scope: {
        kind: "tenant",
        /**
         * Two signals are about rows that belong to NO tenant and are
         * therefore not in this response. They are reported once, to the
         * platform operator, rather than repeated identically inside
         * every practice's panel.
         */
        platformSignalsElsewhere: LIFECYCLE_SIGNALS.filter(
          (s) => s.scope === "platform",
        ).map((s) => s.key),
        platformScopeId: PLATFORM_SCOPE,
      },
    });
  },
);

export default router;

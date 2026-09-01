// The alert lifecycle: when to open, when to escalate, when to say
// nothing, and when to close.
//
// The DECISION is pure and lives at the top of this file; the
// persistence is below it. That split exists because "did we notify the
// right number of times" is the property that actually matters here and
// it is untestable through a database mock.
//
// WHY SUPPRESSION IS THE HARD HALF
// --------------------------------
// A monitor that re-sends on every tick is a monitor whose emails get a
// filter rule inside a week, and after that it is indistinguishable from
// having no monitor — worse, actually, because everyone believes there
// is one. The existing daily DLQ digest can afford to re-send because
// its cadence IS daily. An hourly lifecycle scan cannot.
//
// So the rule is: tell someone when something CHANGES, and once a day
// while it stays wrong.
//
//   new problem          -> notify (open)
//   got worse            -> notify (escalate)
//   same, seen recently  -> say nothing (suppress)
//   same, seen a day ago -> notify (renotify)
//   fixed itself         -> notify once (resolve), then stop
//   could not measure    -> say nothing, and DO NOT close anything
//
// That last line is the one that is easy to get wrong. An unreadable
// signal is not a healthy signal. If a failed read resolved open alerts,
// a database hiccup would clear the board and the recovery notice would
// tell everyone the problem had gone away.
//
// GETTING BETTER IS NOT THE SAME AS BEING FIXED
// ---------------------------------------------
// failure -> warning is a de-escalation, not a resolution, and it is
// deliberately silent: nobody needs an email saying a fire is now a
// smaller fire. The alert keeps its `peak_status`, so the responder can
// still see it was a failure when they arrive.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

import type { SignalEvaluation } from "./evaluate";

/** The open-alert row this subsystem reads and writes. */
export interface OpenAlert {
  id: string;
  signalKey: string;
  status: "warning" | "failure";
  peakStatus: "warning" | "failure";
  firstObservedAt: string;
  lastObservedAt: string;
  lastNotifiedAt: string | null;
  lastNotifiedStatus: string | null;
  notifyCount: number;
  observedValue: number | null;
}

export type AlertAction =
  | "open"
  | "escalate"
  | "renotify"
  | "suppress"
  | "deescalate"
  | "resolve"
  | "none";

export interface AlertDecision {
  action: AlertAction;
  /** Does anybody get told about this one? */
  notify: boolean;
  /** Plain-language justification, logged and shown in the alert history. */
  reason: string;
}

/**
 * How long an unchanged, still-open alert stays quiet.
 *
 * Configurable, and read per call rather than at module load, so raising
 * it during an incident takes effect on the next tick instead of on the
 * next deploy.
 */
export const RENOTIFY_HOURS_ENV = "LIFECYCLE_HEALTH_RENOTIFY_HOURS";
export const DEFAULT_RENOTIFY_HOURS = 24;

export function renotifyHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[RENOTIFY_HOURS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RENOTIFY_HOURS;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Decide what happens to one signal on one tick. Pure.
 *
 * @param open  the currently-open alert for this signal, if any
 * @param evaluation  this tick's reading
 * @param nowMs  the clock, injected so the suppression window is testable
 */
export function decideAlertAction(input: {
  open: OpenAlert | null;
  evaluation: Pick<SignalEvaluation, "status" | "key">;
  nowMs: number;
  renotifyHours: number;
}): AlertDecision {
  const { open, evaluation, nowMs } = input;
  const status = evaluation.status;
  const alerting = status === "warning" || status === "failure";

  // Not measurable. Say nothing, change nothing — and specifically do
  // NOT resolve an open alert. See the header.
  if (status === "unknown") {
    return {
      action: "none",
      notify: false,
      reason: open
        ? "Signal unreadable this tick; the open alert stands rather than being closed on a failed read."
        : "Signal unreadable this tick.",
    };
  }

  if (!alerting) {
    if (!open) {
      return { action: "none", notify: false, reason: "Within threshold." };
    }
    // `disabled` and `not_configured` DO close an open alert: unlike a
    // failed read, they are positive statements about the system's
    // shape — the tenant turned the feature off, or the connector was
    // removed — and leaving an alert open against a feature that no
    // longer exists is a permanent unfixable row on the panel.
    const why =
      status === "ok"
        ? "Back inside threshold."
        : status === "disabled"
          ? "The feature this signal watches is no longer enabled for this tenant."
          : "The integration this signal watches is no longer configured.";
    return { action: "resolve", notify: true, reason: why };
  }

  if (!open) {
    return {
      action: "open",
      notify: true,
      reason: `New ${status}.`,
    };
  }

  if (status === "failure" && open.status === "warning") {
    return {
      action: "escalate",
      notify: true,
      reason: "Escalated from warning to failure.",
    };
  }

  if (status === "warning" && open.status === "failure") {
    // Quiet on purpose. Nobody needs an email saying a fire is now a
    // smaller fire, and the row keeps its peak so the responder still
    // sees what it was.
    return {
      action: "deescalate",
      notify: false,
      reason: "Improved from failure to warning; still open.",
    };
  }

  const lastNotified = open.lastNotifiedAt
    ? Date.parse(open.lastNotifiedAt)
    : NaN;
  if (!Number.isFinite(lastNotified)) {
    // An open alert nobody was ever told about — the send failed, or the
    // row predates notification. Tell them now.
    return {
      action: "renotify",
      notify: true,
      reason: "Open alert with no recorded notification.",
    };
  }

  const quietFor = (nowMs - lastNotified) / HOUR_MS;
  if (quietFor >= input.renotifyHours) {
    return {
      action: "renotify",
      notify: true,
      reason: `Still ${status} after ${Math.floor(quietFor)}h.`,
    };
  }

  return {
    action: "suppress",
    notify: false,
    reason: `Already reported ${Math.floor(quietFor)}h ago; suppressed until ${input.renotifyHours}h.`,
  };
}

// ── Persistence ──────────────────────────────────────────────────────
//
// `scope_id` is an org uuid as text, or the literal 'platform'. Tenant
// rows also carry `org_id`, so the org-scoped client's automatic filter
// reaches them; platform rows carry NULL and are read through `.raw()`
// with an explicit `scope_id` filter.

export const PLATFORM_SCOPE = "platform";

type Db = ReturnType<typeof getOrgScopedClient>;

interface AlertRow {
  id: string;
  signal_key: string;
  status: string;
  peak_status: string;
  first_observed_at: string;
  last_observed_at: string;
  last_notified_at: string | null;
  last_notified_status: string | null;
  notify_count: number;
  observed_value: number | null;
}

function toOpenAlert(row: AlertRow): OpenAlert {
  return {
    id: row.id,
    signalKey: row.signal_key,
    status: row.status === "failure" ? "failure" : "warning",
    peakStatus: row.peak_status === "failure" ? "failure" : "warning",
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    lastNotifiedAt: row.last_notified_at,
    lastNotifiedStatus: row.last_notified_status,
    notifyCount: row.notify_count,
    observedValue: row.observed_value,
  };
}

/**
 * Every open alert for one scope, keyed by signal.
 *
 * The catalog is ~27 entries, so this is a single unpaginated read of a
 * set bounded by the catalog itself — there is no way for it to exceed
 * the row cap, because the unique index permits at most one open row per
 * signal per scope.
 */
export async function readOpenAlerts(
  db: Db,
  scopeId: string,
): Promise<Map<string, OpenAlert>> {
  const { data, error } = await db
    .from("lifecycle_health_alerts")
    .select(
      "id,signal_key,status,peak_status,first_observed_at,last_observed_at,last_notified_at,last_notified_status,notify_count,observed_value",
    )
    .eq("scope_id", scopeId)
    .is("resolved_at", null);
  if (error) throw error;
  const out = new Map<string, OpenAlert>();
  for (const row of (data ?? []) as unknown as AlertRow[]) {
    out.set(row.signal_key, toOpenAlert(row));
  }
  return out;
}

function worse(a: string, b: string): "warning" | "failure" {
  return a === "failure" || b === "failure" ? "failure" : "warning";
}

/**
 * Apply one decision. Returns whether a row was written.
 *
 * The insert relies on the partial unique index to arbitrate: if a
 * concurrent tick opened the same alert first, this insert fails and the
 * failure is treated as "somebody else already reported it" rather than
 * as an error. That is the whole reason the index exists — two
 * overlapping scans both pass any read-then-write check the application
 * could make.
 */
export async function applyAlertDecision(input: {
  db: Db;
  scopeId: string;
  orgId: string | null;
  evaluation: SignalEvaluation;
  decision: AlertDecision;
  open: OpenAlert | null;
  nowIso: string;
}): Promise<boolean> {
  const { db, scopeId, orgId, evaluation, decision, open, nowIso } = input;
  const status = evaluation.status === "failure" ? "failure" : "warning";

  switch (decision.action) {
    case "open": {
      const { error } = await db.from("lifecycle_health_alerts").insert({
        scope_id: scopeId,
        org_id: orgId,
        signal_key: evaluation.key,
        status,
        peak_status: status,
        observed_value: evaluation.value,
        threshold_value:
          status === "failure"
            ? evaluation.failThreshold
            : evaluation.warnThreshold,
        sample_size: evaluation.sample,
        detail: evaluation.detail,
        first_observed_at: nowIso,
        last_observed_at: nowIso,
        last_notified_at: nowIso,
        last_notified_status: status,
        notify_count: 1,
      } as never);
      if (error) {
        // Almost certainly the unique index doing its job. Log and move
        // on — a duplicate-open race is the expected case, not a fault.
        logger.info(
          {
            event: "lifecycle_health.alert_insert_conflict",
            signal: evaluation.key,
            scope: scopeId === PLATFORM_SCOPE ? "platform" : "tenant",
          },
          "lifecycle-health: an alert for this signal was already open",
        );
        return false;
      }
      return true;
    }
    case "escalate":
    case "renotify":
    case "deescalate":
    case "suppress": {
      if (!open) return false;
      const notified = decision.notify;
      const { error } = await db
        .from("lifecycle_health_alerts")
        .update({
          status,
          peak_status: worse(open.peakStatus, status),
          observed_value: evaluation.value,
          threshold_value:
            status === "failure"
              ? evaluation.failThreshold
              : evaluation.warnThreshold,
          sample_size: evaluation.sample,
          detail: evaluation.detail,
          last_observed_at: nowIso,
          updated_at: nowIso,
          ...(notified
            ? {
                last_notified_at: nowIso,
                last_notified_status: status,
                notify_count: open.notifyCount + 1,
              }
            : {}),
        } as never)
        .eq("id", open.id);
      if (error) throw error;
      return true;
    }
    case "resolve": {
      if (!open) return false;
      const { error } = await db
        .from("lifecycle_health_alerts")
        .update({
          resolved_at: nowIso,
          resolved_reason: "recovered",
          last_observed_at: nowIso,
          updated_at: nowIso,
        } as never)
        .eq("id", open.id);
      if (error) throw error;
      return true;
    }
    case "none":
      return false;
  }
}

/**
 * Overwrite the last-scan snapshot for one signal.
 *
 * Written for EVERY signal on every scan, including the healthy ones,
 * because "the monitor is quiet" and "the monitor has not run since
 * Tuesday" are different states and only `observed_at` tells them apart.
 */
export async function recordObservation(input: {
  db: Db;
  scopeId: string;
  orgId: string | null;
  evaluation: SignalEvaluation;
  nowIso: string;
}): Promise<void> {
  const { db, scopeId, orgId, evaluation, nowIso } = input;
  const { error } = await db.from("lifecycle_health_observations").upsert(
    {
      scope_id: scopeId,
      org_id: orgId,
      signal_key: evaluation.key,
      status: evaluation.status,
      observed_value: evaluation.value,
      sample_size: evaluation.sample,
      detail: evaluation.detail,
      observed_at: nowIso,
    } as never,
    { onConflict: "scope_id,signal_key" },
  );
  if (error) throw error;
}

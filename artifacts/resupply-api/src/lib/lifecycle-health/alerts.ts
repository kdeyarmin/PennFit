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
// reaches them; platform rows carry `org_id IS NULL` by CHECK constraint
// and must therefore NOT go through it.
//
// That distinction is load-bearing, not stylistic. `getOrgScopedClient`
// appends `org_id = <tenant>` to every select and FORCES `org_id:
// <tenant>` onto every insert/upsert payload — it overwrites an explicit
// `org_id: null` rather than deferring to it. Pointing the platform pass
// at it would write rows the database rejects outright (the scope/org
// agreement CHECK in migration 0543) and read back an empty set forever,
// with the rejected insert looking exactly like the benign
// duplicate-open race the insert path is written to tolerate. So the
// platform pass reaches the same two tables through `.raw()` with an
// explicit `scope_id` filter, and the tenant pass keeps the automatic
// scoping that makes its isolation structural.

export const PLATFORM_SCOPE = "platform";

type Db = ReturnType<typeof getOrgScopedClient>;

/** The two tables this module owns. */
type AlertTable = "lifecycle_health_alerts" | "lifecycle_health_observations";

/**
 * Table access for one scope.
 *
 * @param db - The org-scoped client (the platform pass still needs one to
 *   reach `.raw()`; the tenant it is bound to is irrelevant there).
 * @param scopeId - A tenant uuid, or `PLATFORM_SCOPE`.
 * @param table - Which of this module's two tables.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function scoped(db: Db, scopeId: string, table: AlertTable): any {
  // raw-org-scope-exempt: platform-scope rows carry `org_id IS NULL` by
  // CHECK constraint, so the org-scoped filter/tag cannot address them.
  // Every query below pins `scope_id` explicitly instead, and the only
  // rows matching `scope_id = 'platform'` are the ones that belong to no
  // tenant — so this widens nothing.
  return scopeId === PLATFORM_SCOPE
    ? db.raw().schema("resupply").from(table)
    : db.from(table);
}

/** Rows a platform write must carry that the org-scoped tag would supply. */
function scopeColumns(
  scopeId: string,
  orgId: string | null,
): Record<string, unknown> {
  return scopeId === PLATFORM_SCOPE
    ? { scope_id: scopeId, org_id: null }
    : { scope_id: scopeId, org_id: orgId };
}

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
  const { data, error } = await scoped(db, scopeId, "lifecycle_health_alerts")
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

/** What applying one decision actually did. */
export interface AlertApplyResult {
  /**
   * Did THIS call own the transition?
   *
   * False when a concurrent scan opened the same alert first (the unique
   * index arbitrates) or when there was nothing to write. A caller that
   * ignores this and notifies anyway defeats the index: two workers race,
   * one loses the insert, and both still send — which is the duplicate the
   * index exists to prevent.
   */
  applied: boolean;
  /**
   * The notification stamp to write ONCE DELIVERY IS CONFIRMED, or null
   * when this transition tells nobody anything.
   *
   * See `markAlertNotified` for why the stamp is not written here.
   */
  pendingNotify: { signalKey: string; notifyCount: number } | null;
}

/**
 * Apply one decision.
 *
 * The insert relies on the partial unique index to arbitrate: if a
 * concurrent tick opened the same alert first, this insert fails and the
 * failure is treated as "somebody else already reported it" rather than
 * as an error. That is the whole reason the index exists — two
 * overlapping scans both pass any read-then-write check the application
 * could make. The caller must honour `applied: false` by staying quiet.
 *
 * NOTHING HERE STAMPS A NOTIFICATION. See `markAlertNotified`.
 */
export async function applyAlertDecision(input: {
  db: Db;
  scopeId: string;
  orgId: string | null;
  evaluation: SignalEvaluation;
  decision: AlertDecision;
  open: OpenAlert | null;
  nowIso: string;
}): Promise<AlertApplyResult> {
  const { db, scopeId, orgId, evaluation, decision, open, nowIso } = input;
  const status = evaluation.status === "failure" ? "failure" : "warning";
  const table = scoped(db, scopeId, "lifecycle_health_alerts");
  const nothing: AlertApplyResult = { applied: false, pendingNotify: null };

  switch (decision.action) {
    case "open": {
      const { error } = await table.insert({
        ...scopeColumns(scopeId, orgId),
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
        // Opened UNNOTIFIED. If the digest never goes out, the next scan
        // sees a null `last_notified_at` and `decideAlertAction` returns
        // `renotify` — so a failed send costs one scan interval, not a
        // full day of silence about a problem nobody was told about.
        last_notified_at: null,
        last_notified_status: null,
        notify_count: 0,
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
        return nothing;
      }
      return {
        applied: true,
        pendingNotify: { signalKey: evaluation.key, notifyCount: 1 },
      };
    }
    case "escalate":
    case "renotify":
    case "deescalate":
    case "suppress": {
      if (!open) return nothing;
      const { error } = await table
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
        } as never)
        .eq("id", open.id);
      if (error) throw error;
      return {
        applied: true,
        pendingNotify: decision.notify
          ? { signalKey: evaluation.key, notifyCount: open.notifyCount + 1 }
          : null,
      };
    }
    case "resolve": {
      if (!open) return nothing;
      const { error } = await table
        .update({
          resolved_at: nowIso,
          resolved_reason: "recovered",
          last_observed_at: nowIso,
          updated_at: nowIso,
        } as never)
        .eq("id", open.id);
      if (error) throw error;
      // A resolved row is closed; there is no open alert left to suppress,
      // so there is nothing to stamp even though the digest mentions it.
      return { applied: true, pendingNotify: null };
    }
    case "none":
      return nothing;
  }
}

/**
 * Record that somebody was actually told about an open alert.
 *
 * SEPARATE FROM THE TRANSITION, AND DELIBERATELY AFTER IT
 * ------------------------------------------------------
 * `last_notified_at` is what suppresses the next 24 hours of scans. Written
 * at transition time — before the digest is composed, before SendGrid is
 * reached, before a single recipient accepts it — it suppressed on the
 * strength of an INTENTION to notify. A mail failure, an unconfigured
 * sender, an empty recipient list: each silently bought a full quiet
 * window for a problem nobody had heard about, and the alert sat open and
 * unmentioned until it either resolved itself or a day elapsed.
 *
 * So the stamp waits for a confirmed delivery. Nothing is lost if this
 * write itself fails: the row simply stays unstamped and the next scan
 * re-notifies, which is the correct side to fail on.
 *
 * @param signalKeys - Signals whose open alert was successfully reported,
 *   with the notify count each should now carry.
 * @returns How many rows were stamped.
 */
export async function markAlertsNotified(input: {
  db: Db;
  scopeId: string;
  pending: ReadonlyArray<{ signalKey: string; notifyCount: number }>;
  status: ReadonlyMap<string, "warning" | "failure">;
  nowIso: string;
}): Promise<number> {
  const { db, scopeId, pending, status, nowIso } = input;
  let stamped = 0;
  for (const item of pending) {
    const { error } = await scoped(db, scopeId, "lifecycle_health_alerts")
      .update({
        last_notified_at: nowIso,
        last_notified_status: status.get(item.signalKey) ?? null,
        notify_count: item.notifyCount,
        updated_at: nowIso,
      } as never)
      .eq("scope_id", scopeId)
      .eq("signal_key", item.signalKey)
      .is("resolved_at", null);
    if (error) {
      logger.warn(
        {
          event: "lifecycle_health.notify_stamp_failed",
          signal: item.signalKey,
          scope: scopeId === PLATFORM_SCOPE ? "platform" : "tenant",
        },
        "lifecycle-health: reported an alert but could not record that it was reported; the next scan will report it again",
      );
      continue;
    }
    stamped += 1;
  }
  return stamped;
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
  const { error } = await scoped(
    db,
    scopeId,
    "lifecycle_health_observations",
  ).upsert(
    {
      ...scopeColumns(scopeId, orgId),
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

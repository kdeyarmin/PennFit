// Clinical analytics — pure aggregation helpers.
//
// Each helper takes a raw shape pulled from PostgREST and reduces
// it to the projection the SPA needs. PURE: no DB, no Date.now()
// (callers pass `asOfDate` for any horizon math), no logging.
// The route layer is responsible for the DB read; this layer is
// the math.
//
// Why separate from the route:
//   1. Testable without standing up a Supabase mock.
//   2. The same projection might land in a future scheduled report
//      that doesn't share the route's request lifecycle.

// ── Resupply funnel ────────────────────────────────────────────────

/** Episode lifecycle as defined in lib/resupply-db/src/schema/episodes.ts.
 *  Listed in funnel-order so the chart renders left-to-right. */
export const EPISODE_FUNNEL_STAGES = [
  "outreach_pending",
  "awaiting_response",
  "confirmed",
  "fulfilled",
] as const;
export type EpisodeFunnelStage = (typeof EPISODE_FUNNEL_STAGES)[number];

/** Lifecycle drop-offs we DO want to surface but not as funnel
 *  stages (they're terminal-bad outcomes). */
export const EPISODE_DROP_OUT_STATUSES = [
  "declined",
  "expired",
  "canceled",
] as const;
export type EpisodeDropOutStatus = (typeof EPISODE_DROP_OUT_STATUSES)[number];

export interface EpisodeRow {
  status: string;
}

export interface ResupplyFunnelResult {
  /** Total episodes that landed in the window, INCLUDING drop-outs. */
  total: number;
  /** Counts by stage. A given episode currently in state X is
   *  counted only at X (not at the stages it has already passed
   *  through). The conversion-rate column on the SPA uses these. */
  byStage: Record<EpisodeFunnelStage, number>;
  /** Terminal-bad counts (declined / expired / canceled). */
  dropOuts: Record<EpisodeDropOutStatus, number>;
  /** byStage["fulfilled"] / total, rounded to 4 decimals.
   *  Null when total is 0. */
  fulfillmentRate: number | null;
}

export function aggregateResupplyFunnel(
  episodes: EpisodeRow[],
): ResupplyFunnelResult {
  const byStage: Record<EpisodeFunnelStage, number> = {
    outreach_pending: 0,
    awaiting_response: 0,
    confirmed: 0,
    fulfilled: 0,
  };
  const dropOuts: Record<EpisodeDropOutStatus, number> = {
    declined: 0,
    expired: 0,
    canceled: 0,
  };

  for (const ep of episodes) {
    if (isFunnelStage(ep.status)) {
      byStage[ep.status] += 1;
    } else if (isDropOut(ep.status)) {
      dropOuts[ep.status] += 1;
    }
    // Statuses outside both sets are silently ignored — future
    // additions to the episode lifecycle will surface in the
    // total but not the funnel until added here.
  }

  const total = episodes.length;
  const fulfillmentRate =
    total === 0 ? null : round4(byStage.fulfilled / total);
  return { total, byStage, dropOuts, fulfillmentRate };
}

function isFunnelStage(s: string): s is EpisodeFunnelStage {
  return (EPISODE_FUNNEL_STAGES as readonly string[]).includes(s);
}
function isDropOut(s: string): s is EpisodeDropOutStatus {
  return (EPISODE_DROP_OUT_STATUSES as readonly string[]).includes(s);
}

// ── Resupply program KPIs ──────────────────────────────────────────

/** Episode statuses that count as a confirmed resupply order. */
const CONFIRMED_ORDER_STATUSES = new Set(["confirmed", "fulfilled"]);

export interface EpisodeKpiRow {
  status: string;
  patientId: string;
}

export interface ResupplyKpiInput {
  /** Episodes created in the window. */
  episodes: EpisodeKpiRow[];
  /** Resupply conversations (episode-linked) created in the window —
   *  the denominator for connection rate. */
  outreachCount: number;
  /** Of those, how many received at least one inbound patient message. */
  respondedCount: number;
  /** Currently-active patients (orders-per-patient denominator). */
  activePatientCount: number;
  /** Analysis window in days (drives annualization). */
  windowDays: number;
}

export interface ResupplyKpiResult {
  totalEpisodes: number;
  confirmedOrders: number;
  fulfilledOrders: number;
  uniquePatientsServed: number;
  outreachCount: number;
  respondedCount: number;
  activePatientCount: number;
  /** confirmedOrders / totalEpisodes. Null when no episodes. */
  confirmationRate: number | null;
  /** fulfilledOrders / confirmedOrders. Null when no confirmed orders. */
  fulfillmentRate: number | null;
  /** respondedCount / outreachCount. Null when no outreach. */
  connectionRate: number | null;
  /** confirmedOrders per active patient, annualized. Null when there
   *  are no active patients or a zero window. */
  ordersPerActivePatientAnnualized: number | null;
}

/**
 * Roll up the resupply program's headline KPIs — the metrics DME
 * operators benchmark a resupply program on: connection (response)
 * rate, confirmation/conversion rate, fulfillment rate, and orders
 * per active patient. Pure: the route supplies the counts it reads
 * from Postgres.
 */
export function aggregateResupplyKpis(
  input: ResupplyKpiInput,
): ResupplyKpiResult {
  const totalEpisodes = input.episodes.length;
  let confirmedOrders = 0;
  let fulfilledOrders = 0;
  const patientIds = new Set<string>();
  for (const ep of input.episodes) {
    if (CONFIRMED_ORDER_STATUSES.has(ep.status)) confirmedOrders += 1;
    if (ep.status === "fulfilled") fulfilledOrders += 1;
    if (ep.patientId) patientIds.add(ep.patientId);
  }

  const confirmationRate =
    totalEpisodes === 0 ? null : round4(confirmedOrders / totalEpisodes);
  const fulfillmentRate =
    confirmedOrders === 0 ? null : round4(fulfilledOrders / confirmedOrders);
  const connectionRate =
    input.outreachCount === 0
      ? null
      : round4(input.respondedCount / input.outreachCount);
  const ordersPerActivePatientAnnualized =
    input.activePatientCount === 0 || input.windowDays === 0
      ? null
      : round4(
          (confirmedOrders / input.activePatientCount) *
            (365 / input.windowDays),
        );

  return {
    totalEpisodes,
    confirmedOrders,
    fulfilledOrders,
    uniquePatientsServed: patientIds.size,
    outreachCount: input.outreachCount,
    respondedCount: input.respondedCount,
    activePatientCount: input.activePatientCount,
    confirmationRate,
    fulfillmentRate,
    connectionRate,
    ordersPerActivePatientAnnualized,
  };
}

// ── Compliance cohorts ─────────────────────────────────────────────

/**
 * Cohort = patients grouped by signup month (YYYY-MM). For each
 * cohort we report:
 *   * cohort size (count of patients in that month)
 *   * the share whose latest 30-night window inside their first
 *     90 days hit the Medicare adherence threshold
 *     (≥ 4 hours on ≥ 70% of nights).
 *
 * The route layer is responsible for computing the adherence flag
 * per patient (the existing compliance-attestation library does
 * exactly that math). This helper aggregates the per-patient flags
 * into cohort buckets.
 */
export interface PatientCohortPoint {
  /** YYYY-MM-DD or YYYY-MM-DD HH:MM:SS … doesn't matter — only the
   *  YYYY-MM prefix is used. */
  signedUpAt: string;
  qualifies: boolean;
  /** Optional payer dimension. NULL counts as the literal string
   *  "Unspecified" so a CSR can see uninsured cohort retention
   *  separately from a specific payer. */
  insurancePayer: string | null;
}

export interface ComplianceCohortBucket {
  cohort: string; // YYYY-MM
  total: number;
  qualifying: number;
  rate: number | null;
}

export interface ComplianceCohortsResult {
  byMonth: ComplianceCohortBucket[];
  byPayer: Array<{
    payer: string;
    total: number;
    qualifying: number;
    rate: number | null;
  }>;
}

export function aggregateComplianceCohorts(
  points: PatientCohortPoint[],
): ComplianceCohortsResult {
  const months = new Map<string, { total: number; qualifying: number }>();
  const payers = new Map<string, { total: number; qualifying: number }>();
  for (const p of points) {
    const month = (p.signedUpAt ?? "").slice(0, 7);
    if (month.length === 7) {
      const bucket = months.get(month) ?? { total: 0, qualifying: 0 };
      bucket.total += 1;
      if (p.qualifies) bucket.qualifying += 1;
      months.set(month, bucket);
    }
    const payer = (p.insurancePayer ?? "").trim() || "Unspecified";
    const pbucket = payers.get(payer) ?? { total: 0, qualifying: 0 };
    pbucket.total += 1;
    if (p.qualifies) pbucket.qualifying += 1;
    payers.set(payer, pbucket);
  }

  const byMonth: ComplianceCohortBucket[] = Array.from(months.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([cohort, { total, qualifying }]) => ({
      cohort,
      total,
      qualifying,
      rate: total === 0 ? null : round4(qualifying / total),
    }));

  const byPayer = Array.from(payers.entries())
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([payer, { total, qualifying }]) => ({
      payer,
      total,
      qualifying,
      rate: total === 0 ? null : round4(qualifying / total),
    }));

  return { byMonth, byPayer };
}

// ── CSR productivity ───────────────────────────────────────────────

/**
 * CSR productivity rolls audit_log rows up by (operator, action).
 * The route layer reads audit_log within the date window; this
 * helper buckets the rows so the SPA can render a per-operator
 * table without doing the rollup itself.
 *
 * Only audit actions that represent CSR-visible work are
 * counted. Read-only actions (`patient.view`, `audit.export`) are
 * filtered out so the "I sent 0 messages today but I'm clearly
 * working" feedback loop doesn't punish browsing.
 *
 * ⚠️ KNOWN GAP — see also delivery-failures.ts header comment.
 *
 *   @workspace/resupply-audit became a no-op stub when migration
 *   0156 retired the HIPAA tamper-evident audit chain, so no NEW
 *   rows are landing in resupply.audit_log. This rollup runs against
 *   whatever PRE-stub rows still exist in the table. As those rows
 *   slide outside the requested date window, the report increasingly
 *   shows zero activity for every CSR — a false "the team isn't
 *   working" signal.
 *
 *   Why not just delete the report: the action enumeration here
 *   ({{PRODUCTIVE_ACTIONS}}) is the operational source-of-truth for
 *   what counts as "CSR work" across ~30 admin surfaces. Re-sourcing
 *   each action requires inspecting that surface's actual write site
 *   (conversations.assignment → conversations.assigned_to + updated_at
 *   inferred history, shop_returns.approve → shop_returns.approved_at,
 *   etc.) — different per action, ~30 individual surface migrations.
 *   That's a separate epic, not a single PR. Until then the route
 *   handler (see routes/admin/analytics.ts) returns a `degraded: true`
 *   flag in the response so the SPA can render a banner.
 */
export interface AuditRow {
  /** Email of the admin who performed the action, when known.
   *  System actions (cron, webhook) carry null and are bucketed
   *  separately. */
  operatorEmail: string | null;
  action: string;
  occurredAt: string;
}

/** Actions we count as "productive work" — every other audit row
 *  is excluded from the productivity rollup. Same dimension a
 *  performance review would care about. */
export const PRODUCTIVE_ACTIONS = new Set<string>([
  "conversations.reply",
  "conversations.assignment",
  "patient.note.create",
  "patient.prescription.create",
  "patient.prescription.status_changed",
  "patient.followup.complete",
  "patient.sleep_study.create",
  "patient.sleep_study.update",
  "patient.insurance.create",
  "patient.insurance.update",
  "patient.prior_authorization.create",
  "patient.prior_authorization.update",
  "patient.equipment.create",
  "patient.equipment.update",
  "patient.swo.generated",
  "patient.compliance_attestation.generated",
  "shop_returns.approve",
  "shop_returns.reject",
  "shop_returns.refund",
  "shop_returns.mark_shipped",
  "shop_returns.mark_received",
  "shop_returns.replace",
  "fax.inbound.triage",
  "fax.inbound_media.admin_download",
  "physician_fax.dispatch",
  "provider.create",
  "equipment_recall.create",
  "equipment_recall.update",
  "equipment_recall.scan",
]);

export interface CsrProductivityRow {
  operator: string; // email; "system" when null
  total: number;
  byAction: Record<string, number>;
  /** Most-recent date the operator did any productive action, as
   *  YYYY-MM-DD. */
  lastActiveDate: string | null;
}

export interface CsrProductivityResult {
  /** windowDays mirrors the date-window the route enforced. */
  windowDays: number;
  rows: CsrProductivityRow[];
  /** Sum of `total` across rows — the headline number. */
  totalActions: number;
}

export function aggregateCsrProductivity(
  rows: AuditRow[],
  windowDays: number,
): CsrProductivityResult {
  const byOperator = new Map<string, CsrProductivityRow>();
  let totalActions = 0;
  for (const r of rows) {
    if (!PRODUCTIVE_ACTIONS.has(r.action)) continue;
    const op = r.operatorEmail ?? "system";
    const date = (r.occurredAt ?? "").slice(0, 10);
    let bucket = byOperator.get(op);
    if (!bucket) {
      bucket = { operator: op, total: 0, byAction: {}, lastActiveDate: null };
      byOperator.set(op, bucket);
    }
    bucket.total += 1;
    bucket.byAction[r.action] = (bucket.byAction[r.action] ?? 0) + 1;
    if (date.length === 10) {
      if (!bucket.lastActiveDate || date > bucket.lastActiveDate) {
        bucket.lastActiveDate = date;
      }
    }
    totalActions += 1;
  }
  const out = Array.from(byOperator.values()).sort((a, b) => b.total - a.total);
  return { windowDays, rows: out, totalActions };
}

// ── helpers ──────────────────────────────────────────────────────

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

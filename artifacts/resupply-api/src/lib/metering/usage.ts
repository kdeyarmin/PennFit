// Per-tenant usage metering emitter (G12).
//
// Records billable usage that the platform billing console reads
// (`currentUsage()` in routes/platform/billing.ts) and compares against
// the tenant's plan allowances. Before this emitter, those event-based
// metrics (AI interactions, outbound messages, billing transactions,
// fax/voice) had no automatic writer, so a tenant's metered usage always
// read as zero. This is the emitter wired into the request paths that
// actually generate the usage.
//
// Storage model: usage accrues into `resupply.tenant_usage_monthly_rollups`
// — one row per (org, month, metric_key), incremented atomically via the
// `increment_tenant_usage_rollup` RPC (migration 0367). We deliberately do
// NOT write per-turn `tenant_usage_events` rows here: that table's
// `metric_key` CHECK forbids the camelCase metric keys the billing console
// uses (so every insert would fail the constraint), and summing per-event
// rows on read would silently undercount once a tenant exceeds PostgREST's
// `max_rows` page cap. A single rollup row per metric sidesteps both.
//
// Posture — fire-and-forget + fail-soft. Metering is a BILLING signal, not
// an access gate, so it must NEVER throw, block, or measurably slow a user
// request. A missing tenant context or a DB error is logged and swallowed:
// we lose one metering datapoint, never a feature. (Contrast with access
// checks, which fail CLOSED — here a failure fails OPEN, because
// over-blocking a paying user to protect a usage counter is the wrong
// trade.)

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

// The event-based billable metrics the platform billing console reads
// (routes/platform/billing.ts → currentUsage). The live-counted metrics
// (activePatients, seats, locations, ordersPerMonth, activeSubscriptions)
// are derived from their own tables on read and are NOT emitted here.
export const USAGE_METRIC_KEYS = [
  "outboundMessagesPerMonth",
  "aiTextInteractionsPerMonth",
  "billingTransactionsPerMonth",
  "faxEvents",
  "aiVoiceEvents",
] as const;

export type UsageMetricKey = (typeof USAGE_METRIC_KEYS)[number];

export interface RecordTenantUsageInput {
  /** Tenant the usage belongs to. A missing/blank value is a silent no-op. */
  orgId: string | undefined | null;
  metricKey: UsageMetricKey;
  /** Defaults to 1. Non-finite or negative values are clamped to 0. */
  quantity?: number;
  /** Short origin tag for debugging (e.g. "storefront.chat"). */
  source?: string;
  metadata?: Record<string, unknown>;
}

function normalizeQuantity(q: number | undefined): number {
  if (q === undefined) return 1;
  if (!Number.isFinite(q) || q < 0) return 0;
  return Math.floor(q);
}

/**
 * Record tenant usage by atomically incrementing the current month's
 * rollup for `(orgId, metricKey)`. Fire-and-forget and fail-soft: it
 * resolves to `void` on success OR on any failure (missing org, DB error)
 * — it never throws and never rejects, so a hot-path caller can
 * `void recordTenantUsage(...)` without a try/catch and without awaiting.
 *
 * No-ops (records nothing) when the tenant context is absent or the
 * effective quantity is zero — neither carries a billing signal. The
 * `source`/`metadata` inputs are accepted for callsite clarity; the rollup
 * stores only the running per-metric total.
 */
export async function recordTenantUsage(
  input: RecordTenantUsageInput,
): Promise<void> {
  const orgId = input.orgId?.trim();
  if (!orgId) return; // no tenant context → nothing to meter (not an error)
  const quantity = normalizeQuantity(input.quantity);
  if (quantity === 0) return; // a zero-quantity event carries no signal
  try {
    const { error } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .rpc("increment_tenant_usage_rollup", {
        p_org_id: orgId,
        p_metric_key: input.metricKey,
        p_quantity: quantity,
      });
    if (error) throw error;
  } catch (err) {
    logger.warn(
      {
        event: "tenant_usage_record_failed",
        metricKey: input.metricKey,
        orgId,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "tenant usage metering rollup increment failed (ignored)",
    );
  }
}

/**
 * Shared chokepoint for the `outboundMessagesPerMonth` billing metric: call
 * this from every PATIENT-FACING outbound SMS/email sender right after a
 * successful send. Fire-and-forget (returns void, not a promise) so a
 * sender can drop it on its hot path without awaiting.
 *
 * Count only patient-facing messages — reminders, outreach, campaigns,
 * recall/maintenance nudges, CSR/agent replies, etc. Do NOT call it for
 * internal operator emails (owner digest, DLQ/metric alerts, failed-order
 * digests, invite/password auth mail): those don't consume a tenant's
 * patient-message allowance.
 */
export function recordOutboundMessageUsage(input: {
  orgId: string | undefined | null;
  /** Channel, for debugging/metadata only — both count as one message. */
  channel: "sms" | "email";
  /** Short origin tag, e.g. "reminders.sms" or "clinical_outreach". */
  source: string;
  /** Defaults to 1; pass a batch size for a single bulk send if applicable. */
  count?: number;
}): void {
  void recordTenantUsage({
    orgId: input.orgId,
    metricKey: "outboundMessagesPerMonth",
    quantity: input.count ?? 1,
    source: input.source,
    metadata: { channel: input.channel },
  });
}

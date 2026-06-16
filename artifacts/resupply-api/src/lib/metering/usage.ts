// Per-tenant usage metering emitter (G12).
//
// Records billable usage as `resupply.tenant_usage_events` rows. The
// platform billing console aggregates these per month — `currentUsage()`
// in routes/platform/billing.ts sums them by `metric_key` over the current
// period and compares against the tenant's plan allowances. Before this
// emitter, those event-based metrics (AI interactions, outbound messages,
// billing transactions, fax/voice) could only be entered by hand via the
// operator POST endpoints, so a tenant's metered usage always read as
// zero. This is the automatic emitter wired into the request paths that
// actually generate the usage.
//
// Posture — fire-and-forget + fail-soft. Metering is a BILLING signal, not
// an access gate, so it must NEVER throw, block, or measurably slow a user
// request. A missing tenant context or a DB error is logged and swallowed:
// we lose one metering datapoint, never a feature. (Contrast with access
// checks, which fail CLOSED — here a failure fails OPEN, because
// over-blocking a paying user to protect a usage counter is the wrong
// trade.)
//
// `tenant_usage_events` is not in the generated Supabase types (it's
// platform-operator data, queried via `.raw()` everywhere), so this writes
// through the same `.raw().schema("resupply")` path the billing route uses
// and stamps `org_id` explicitly.

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
 * Record one usage event for a tenant. Fire-and-forget and fail-soft: it
 * resolves to `void` on success OR on any failure (missing org, DB error)
 * — it never throws and never rejects, so a hot-path caller can
 * `void recordTenantUsage(...)` without a try/catch and without awaiting.
 *
 * No-ops (records nothing) when the tenant context is absent or the
 * effective quantity is zero — neither carries a billing signal.
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
      .from("tenant_usage_events")
      .insert({
        org_id: orgId,
        metric_key: input.metricKey,
        quantity,
        source: input.source ?? "system",
        occurred_at: new Date().toISOString(),
        metadata: input.metadata ?? {},
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
      "tenant usage metering insert failed (ignored)",
    );
  }
}

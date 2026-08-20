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
import { reportMeteredOverage } from "../platform-billing/stripe";

// The event-based billable metrics the platform billing console reads
// (routes/platform/billing.ts → currentUsage). The live-counted metrics
// (activePatients, seats, locations, ordersPerMonth, activeSubscriptions)
// are derived from their own tables on read and are NOT emitted here.
export const USAGE_METRIC_KEYS = [
  "outboundMessagesPerMonth",
  "aiTextInteractionsPerMonth",
  // AI token throughput (input + output), summed per month. These are
  // COST signals (folded through the platform cost-rate card into vendor
  // COGS), NOT billing allowances — no plan caps them, and they have no
  // metered add-on, so `reportMeteredOverage` no-ops for them. Recorded
  // fire-and-forget by `recordAiTokenUsage` at each LLM call site.
  "aiInputTokensPerMonth",
  "aiOutputTokensPerMonth",
  "billingTransactionsPerMonth",
  "faxEvents",
  "aiVoiceEvents",
  // Completed virtual mask fittings (migration 0419). The Virtual Mask
  // Fitter plan includes a monthly amount and bills per-fitting beyond it
  // (fitter_fitting_metered add-on). Incremented once per completed
  // fitting that comes back from a patient's signed link.
  "fitterFittingsPerMonth",
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
    const { data, error } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .rpc("increment_tenant_usage_rollup", {
        p_org_id: orgId,
        p_metric_key: input.metricKey,
        p_quantity: quantity,
      });
    if (error) throw error;
    // The RPC returns the post-increment running total (migration 0422) — the
    // ATOMIC value for this increment, so overage is computed without racing
    // concurrent increments.
    const newTotal = typeof data === "number" ? data : undefined;
    // Report billable OVERAGE to Stripe for standard metered metrics (SMS /
    // AI / billing transactions — migration 0421). Fire-and-forget + fail-soft
    // + gated: no-ops unless the overage flag is on and the metric has a
    // report-overage metered add-on, so this is a no-op for every metric until
    // an operator enables it. The fitter metric is excluded automatically (its
    // add-on reports all usage via a separate path, not overage).
    //
    // The measurement above is already committed at this point, and that
    // ordering is deliberate: billing is strictly DOWNSTREAM of metering,
    // so nothing here — an unlimited allowance, a disabled flag, an
    // unreachable Stripe — can suppress a usage datapoint. A tenant lifted
    // to unlimited is still fully metered; only their invoice changes.
    //
    // `.catch` rather than a bare `void`: reportMeteredOverage documents
    // itself as never-throwing and try/catches internally, but a floating
    // promise would turn any future regression there into an UNHANDLED
    // REJECTION on a hot path — the one thing this fail-soft emitter
    // promises callers can't happen.
    void reportMeteredOverage({
      orgId,
      metricKey: input.metricKey,
      increment: quantity,
      newTotal,
    }).catch((err: unknown) => {
      logger.warn(
        {
          event: "tenant_usage_overage_report_failed",
          metricKey: input.metricKey,
          orgId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "metered overage report failed (usage already recorded; ignored)",
      );
    });
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

/**
 * Shared chokepoint for AI token throughput: call this from every text-LLM
 * call site right after a model response with its token usage. Records
 * input and output tokens into their monthly rollups so the platform
 * cost-rate card can fold them into vendor COGS. Fire-and-forget +
 * fail-soft (no awaiting, never throws). A zero/absent token count is a
 * silent no-op (recordTenantUsage drops zero-quantity events), so an
 * offline/degraded turn with no usage records nothing.
 */
export function recordAiTokenUsage(input: {
  orgId: string | undefined | null;
  inputTokens: number | undefined | null;
  outputTokens: number | undefined | null;
  /** Short origin tag, e.g. "storefront.chat" or "admin.assistant". */
  source: string;
}): void {
  const inTok = input.inputTokens ?? 0;
  const outTok = input.outputTokens ?? 0;
  if (inTok > 0) {
    void recordTenantUsage({
      orgId: input.orgId,
      metricKey: "aiInputTokensPerMonth",
      quantity: inTok,
      source: input.source,
    });
  }
  if (outTok > 0) {
    void recordTenantUsage({
      orgId: input.orgId,
      metricKey: "aiOutputTokensPerMonth",
      quantity: outTok,
      source: input.source,
    });
  }
}

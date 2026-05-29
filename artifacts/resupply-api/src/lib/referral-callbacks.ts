// Outbound status callbacks for inbound referrals.
//
// When a lifecycle event happens on a referral the originating
// source cares about (accept, reject, PA decision, ship), we
// enqueue a row in inbound_referral_status_outbox. The worker
// (worker/jobs/inbound-referral-status-outbound.ts) drains it,
// resolves the per-target URL + signing secret, HMAC-signs the
// body, and POSTs with exponential-backoff retries.
//
// Why this file (vs. direct worker emit at each call site):
// One small enqueue helper means every call site does the same
// thing — the payload shape, dedupe heuristics, and audit log are
// all built once. The worker is the only consumer of the table.
//
// PHI posture: payloads embed source_order_id, source slug, and
// status only. NOT the patient name, full demographics, or HCPCS
// detail — the originating source already has those; we ack the
// state transition, not the data.

import { logAudit } from "@workspace/resupply-audit";
import {
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "./logger";

export type ReferralLifecycleEvent =
  | "order.accepted"
  | "order.rejected"
  | "prior_auth.decision"
  | "shop_order.shipped"
  | "shop_order.delivered";

export type ReferralTargetKind = "parachute" | "ehr_fhir";

export interface EnqueueReferralStatusInput {
  referralId: string;
  eventType: ReferralLifecycleEvent;
  /**
   * Additional event-specific fields merged into the payload.
   * Common base fields (event_id, event_type, occurred_at,
   * source_order_id, source) are added by this helper.
   */
  data?: Record<string, unknown>;
  /** Tests override; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface EnqueueOutcome {
  /** Status row id, or null when no callback is configured for the source. */
  outboxId: string | null;
  /** When null, why we skipped — useful for the calling route to surface. */
  skippedReason?:
    | "source_not_callback_capable"
    | "referral_not_found"
    | "tenant_not_found";
}

/**
 * Enqueue a status callback. Returns null + skippedReason when the
 * source isn't configured for callbacks (e.g. a Parachute partner
 * who never set PARACHUTE_API_BASE_URL, or an ehr_fhir_<slug>
 * tenant whose callback_url is null) — the caller treats that as
 * a no-op, not an error.
 */
export async function enqueueReferralStatusEvent(
  input: EnqueueReferralStatusInput,
): Promise<EnqueueOutcome> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: referral } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .select(
      "id, source, source_order_id, triage_status, accepted_order_id, accepted_order_kind",
    )
    .eq("id", input.referralId)
    .limit(1)
    .maybeSingle();
  if (!referral) {
    return { outboxId: null, skippedReason: "referral_not_found" };
  }

  const targetKind = resolveTargetKind(referral.source);
  if (!targetKind) {
    // Unknown source slug (e.g. 'test') — silently skip.
    return { outboxId: null, skippedReason: "source_not_callback_capable" };
  }

  // For ehr_fhir, also verify the tenant has callback config set —
  // we want to fail fast rather than queue a row that will exhaust.
  if (targetKind === "ehr_fhir") {
    const slug = referral.source.replace(/^ehr_fhir_/, "");
    const { data: tenant } = await supabase
      .schema("resupply")
      .from("ehr_fhir_tenants")
      .select("id, callback_url, outbound_signing_secret, is_active")
      .eq("slug", slug)
      .limit(1)
      .maybeSingle();
    if (!tenant || !tenant.is_active) {
      return { outboxId: null, skippedReason: "tenant_not_found" };
    }
    if (!tenant.callback_url || !tenant.outbound_signing_secret) {
      // Tenant exists but opted out of outbound. Silent skip.
      return {
        outboxId: null,
        skippedReason: "source_not_callback_capable",
      };
    }
  } else if (targetKind === "parachute") {
    const env = input.env ?? process.env;
    if (!env.PARACHUTE_API_BASE_URL || !env.PARACHUTE_SIGNING_SECRET) {
      return {
        outboxId: null,
        skippedReason: "source_not_callback_capable",
      };
    }
  }

  const payload = buildPayload({
    eventType: input.eventType,
    source: referral.source,
    sourceOrderId: referral.source_order_id,
    triageStatus: referral.triage_status,
    acceptedOrderId: referral.accepted_order_id,
    acceptedOrderKind: referral.accepted_order_kind,
    extra: input.data ?? {},
  });

  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("inbound_referral_status_outbox")
    .insert({
      referral_id: referral.id,
      target_kind: targetKind,
      event_type: input.eventType,
      payload_json: payload as unknown as Json,
      status: "queued",
      next_attempt_at: new Date().toISOString(),
    })
    .select("id")
    .maybeSingle();
  if (insertErr || !inserted) {
    logger.warn(
      {
        referral_id: input.referralId,
        event_type: input.eventType,
        err_code: insertErr?.code,
      },
      "referral_callbacks.enqueue_failed",
    );
    throw insertErr ?? new Error("enqueue insert returned no row");
  }

  await logAudit({
    action: `inbound_referral.callback.enqueued`,
    adminEmail: "system:callbacks",
    adminUserId: null,
    targetTable: "inbound_referral_status_outbox",
    targetId: inserted.id,
    metadata: {
      referral_id: referral.id,
      event_type: input.eventType,
      target_kind: targetKind,
    },
    ip: null,
    userAgent: null,
  }).catch((err) => {
    logger.warn({ err }, "referral_callbacks.enqueue audit write failed");
  });

  return { outboxId: inserted.id };
}

/** Exported so the worker can resolve too. */
export function resolveTargetKind(source: string): ReferralTargetKind | null {
  if (source === "parachute") return "parachute";
  if (source.startsWith("ehr_fhir_")) return "ehr_fhir";
  return null;
}

/**
 * Find the inbound referral (if any) that materialised into `shopOrderId`
 * via the accept route and enqueue a lifecycle callback. No-op when
 * the order didn't originate from a referral.
 *
 * Used by the shop-orders ship + deliver mutators to fan out
 * lifecycle events back to the EHR / Parachute partner that
 * submitted the original DME order.
 */
export async function enqueueShopOrderLifecycleCallback(
  shopOrderId: string,
  eventType: ReferralLifecycleEvent,
  extra?: Record<string, unknown>,
): Promise<EnqueueOutcome | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: referral } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .select("id")
    .eq("accepted_order_id", shopOrderId)
    .eq("accepted_order_kind", "shop_order")
    .limit(1)
    .maybeSingle();
  if (!referral) return null;
  return enqueueReferralStatusEvent({
    referralId: referral.id,
    eventType,
    data: extra,
  });
}

/**
 * Pure payload builder. Exposed for unit tests + so the worker can
 * regenerate a canonical payload if needed for a manual replay.
 */
export function buildPayload(input: {
  eventType: ReferralLifecycleEvent;
  source: string;
  sourceOrderId: string;
  triageStatus: string;
  acceptedOrderId: string | null;
  acceptedOrderKind: string | null;
  extra: Record<string, unknown>;
}): Record<string, unknown> {
  // event_id is fresh per-payload — partners use it for idempotency
  // on their side. Same shape as the inbound dedupe header.
  return {
    event_id: cryptoRandomId(),
    event_type: input.eventType,
    occurred_at: new Date().toISOString(),
    source: input.source,
    source_order_id: input.sourceOrderId,
    triage_status: input.triageStatus,
    accepted_order_id: input.acceptedOrderId,
    accepted_order_kind: input.acceptedOrderKind,
    ...input.extra,
  };
}

function cryptoRandomId(): string {
  // Node 20+ has globalThis.crypto.randomUUID().
  return globalThis.crypto.randomUUID();
}

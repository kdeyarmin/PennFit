// Persist a Stripe chargeback dispute into resupply.stripe_disputes
// (migration 0429). Called from the charge.dispute.created/updated/closed
// webhook cases so a dispute and its evidence deadline are durable + surfaced
// on the admin worklist, instead of living only in a WARN log line.
//
// Upserts on stripe_dispute_id, links the dispute to its shop_order by
// stripe_charge_id when one matches, and is FAIL-SOFT — a persistence error
// never breaks the webhook ACK (the loud WARN log still fires at the callsite).
//
// PHI/secret posture: dispute ids + amounts only; no card data, no order body.

import type Stripe from "stripe";

import { getOrgScopedClient } from "@workspace/resupply-db";

interface DisputeLog {
  warn?: (obj: unknown, msg?: string) => void;
}

const CLOSED_STATUSES = new Set(["won", "lost", "warning_closed"]);

function unixToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

export async function persistStripeDispute(
  orgId: string | null,
  dispute: Stripe.Dispute,
  log?: DisputeLog,
): Promise<void> {
  if (!orgId) return;
  try {
    const supabase = getOrgScopedClient(orgId);
    const chargeId =
      typeof dispute.charge === "string"
        ? dispute.charge
        : (dispute.charge?.id ?? null);

    // Best-effort link to the originating order.
    let orderId: string | null = null;
    if (chargeId) {
      const { data: order } = await supabase
        .from("shop_orders")
        .select("id")
        .eq("stripe_charge_id", chargeId)
        .limit(1)
        .maybeSingle();
      orderId = order?.id ?? null;
    }

    const isClosed = CLOSED_STATUSES.has(dispute.status);
    const nowIso = new Date().toISOString();
    const { error } = await supabase.from("stripe_disputes").upsert(
      {
        stripe_dispute_id: dispute.id,
        stripe_charge_id: chargeId,
        order_id: orderId,
        amount_cents: dispute.amount,
        currency: dispute.currency,
        reason: dispute.reason,
        status: dispute.status,
        evidence_due_by: unixToIso(dispute.evidence_details?.due_by),
        is_charge_refundable: dispute.is_charge_refundable ?? null,
        opened_at: unixToIso(dispute.created),
        closed_at: isClosed ? nowIso : null,
        outcome: isClosed ? dispute.status : null,
        updated_at: nowIso,
      },
      { onConflict: "stripe_dispute_id" },
    );
    if (error) {
      log?.warn?.(
        {
          event: "stripe_dispute_persist_failed",
          dispute_id: dispute.id,
          err: error.message,
        },
        "stripe: dispute persist failed",
      );
    }
  } catch (err) {
    log?.warn?.(
      { event: "stripe_dispute_persist_threw", dispute_id: dispute.id, err },
      "stripe: dispute persist threw",
    );
  }
}

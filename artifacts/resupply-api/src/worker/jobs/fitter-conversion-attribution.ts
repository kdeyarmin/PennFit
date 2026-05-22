// pg-boss job: attribute newly-placed orders back to the fitter_leads
// row whose email matches the order's patient_email.
//
// Why this exists
// ---------------
// A patient runs the fitter, sees a recommendation, and a few days
// later places an order. The fitter_leads row and the orders row
// live in different schemas with no FK between them — by design,
// the lead is captured anonymously at /consent while the order
// later collects full PII at checkout, so there is no shared key
// at write-time other than the patient's email address.
//
// This worker closes the loop. Hourly it:
//   1. Pulls every public.orders row whose created_at falls in a
//      look-back window (default 24h, slightly overlapping the
//      cron interval so a long-running tick can't drop one).
//   2. Looks up the matching fitter_leads row by (lowercased)
//      email.
//   3. Stamps first_order_id + first_order_placed_at on the lead
//      and flips journey_stage='converted' if the lead is still
//      in 'consent', 'completed', or 'campaign_active' — i.e.
//      never overwrites a terminal state ('unsubscribed', already
//      'converted').
//
// Side effect: the supply-campaign dispatcher's WHERE excludes
// 'converted', so a stamped lead drops out of the touchpoint
// pipeline on the next tick — no further nurture emails ship to
// a patient who already bought.
//
// Schedule
// --------
// Hourly at :29. Sequenced before the supply-campaign dispatcher
// (:43) so a brand-new conversion is reflected in the dispatcher's
// next pass.

import type PgBoss from "pg-boss";

import {
  type Database,
  escapePostgRESTFilterValue,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

type FitterLeadsUpdate = Database["resupply"]["Tables"]["fitter_leads"]["Update"];

import { logger } from "../../lib/logger";

const JOB_NAME = "fitter-lead.attribution";
/** Hourly at :29 — clear of the campaign dispatcher (:43). */
const JOB_CRON = "29 * * * *";
/** Window over which to scan new orders. Slightly larger than the
 *  cron interval so a tick that runs late doesn't drop a recent
 *  conversion. */
const ORDER_LOOKBACK_MS = 90 * 60 * 1000; // 90 minutes

export interface AttributionStats {
  ordersScanned: number;
  leadsMatched: number;
  attributed: number;
  skippedTerminal: number;
  errors: number;
}

export async function runFitterConversionAttribution(): Promise<AttributionStats> {
  const stats: AttributionStats = {
    ordersScanned: 0,
    leadsMatched: 0,
    attributed: 0,
    skippedTerminal: 0,
    errors: 0,
  };

  const supabase = getSupabaseServiceRoleClient();
  const sinceIso = new Date(Date.now() - ORDER_LOOKBACK_MS).toISOString();

  // Pull recent orders. We only need id + email + created_at; the
  // lead row carries the marketing attribution columns. We DON'T
  // join on the DB side — PostgREST has no cross-schema joins, and
  // a per-row lookup against fitter_leads is fine at the volumes
  // we see (orders/hour is a one- to two-digit number).
  const { data: orders, error: ordErr } = await supabase
    .schema("public")
    .from("orders")
    .select("id, patient_email, patient_first_name, created_at")
    .gte("created_at", sinceIso)
    .not("patient_email", "is", null)
    .order("created_at", { ascending: true });
  if (ordErr) throw ordErr;
  stats.ordersScanned = orders?.length ?? 0;
  if (!orders || orders.length === 0) return stats;

  // Build a map from lowercased email → most-recent order id +
  // placed_at + patient_first_name. Multiple orders for the same
  // email collapse to the FIRST one (in createdAt-ascending order,
  // the first match wins so the lead's first_order_* columns reflect
  // the genuinely first attributed order even if the scan window
  // contains two).
  const byEmail = new Map<
    string,
    { orderId: string; placedAt: string; firstName: string | null }
  >();
  for (const o of orders) {
    const e = typeof o.patient_email === "string" ? o.patient_email.toLowerCase() : null;
    if (!e) continue;
    if (byEmail.has(e)) continue;
    // Use public.orders.patient_first_name directly — the storefront
    // checkout form splits the name into first / last at /order, so
    // we don't need to parse a combined "Sarah Smith" string. The
    // cap-at-30-chars filter in composeTouchpoint is a backstop
    // against unlikely long strings.
    let firstName: string | null = null;
    if (typeof o.patient_first_name === "string") {
      const trimmed = o.patient_first_name.trim();
      if (trimmed.length > 0 && trimmed.length <= 30) {
        firstName = trimmed;
      }
    }
    byEmail.set(e, {
      orderId: o.id as string,
      placedAt: (o.created_at as string) ?? new Date().toISOString(),
      firstName,
    });
  }
  if (byEmail.size === 0) return stats;

  // Bulk lookup leads matching any of these emails. ILIKE-OR chunked
  // at 50 to stay under the 8KB PostgREST URI cap. Same pattern as
  // fitter-lead-reengage.ts.
  const emails = Array.from(byEmail.keys());
  const CHUNK = 50;
  interface LeadRow {
    id: string;
    email: string;
    journey_stage: string;
    first_order_id: string | null;
  }
  const leadByEmail = new Map<string, LeadRow>();
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const orClauses = chunk
      .map((e) => `email.ilike.${escapePostgRESTFilterValue(e)}`)
      .join(",");
    const { data: leads, error: leadErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .select("id, email, journey_stage, first_order_id, created_at")
      .or(orClauses)
      .order("created_at", { ascending: false });
    if (leadErr) throw leadErr;
    for (const l of leads ?? []) {
      const e = typeof l.email === "string" ? l.email.toLowerCase() : null;
      if (!e) continue;
      // First write wins — and because we ordered created_at DESC
      // above, the first hit is the MOST RECENT lead row for the
      // email. That's the right row to attribute against; a patient
      // who restarted the fitter and then bought should attribute
      // to the restart, not to a months-old abandoned row.
      if (!leadByEmail.has(e)) {
        leadByEmail.set(e, {
          id: l.id as string,
          email: e,
          journey_stage: l.journey_stage as string,
          first_order_id: l.first_order_id as string | null,
        });
      }
    }
  }
  stats.leadsMatched = leadByEmail.size;

  // Re-order phase first-touch (T7) lands 30 days after the order.
  // Imported from the route module so the offset stays in sync
  // (single source of truth across the route + worker).
  const REORDER_T7_OFFSET_MS = 30 * 86_400_000;

  // Stamp each matched lead.
  for (const [email, order] of byEmail) {
    const lead = leadByEmail.get(email);
    if (!lead) continue;

    // Don't overwrite an already-attributed lead — first_order_id
    // is the FIRST order, not the latest. Don't touch an
    // unsubscribed row either (terminal state we preserve).
    if (lead.first_order_id) {
      stats.skippedTerminal += 1;
      continue;
    }
    if (lead.journey_stage === "unsubscribed") {
      stats.skippedTerminal += 1;
      continue;
    }

    // Branch on the lead's current stage:
    //   * 'consent', 'completed', 'campaign_active' — actively
    //     engaged. Flip to 'reorder_active' so the supply-campaign
    //     worker now sends re-order nudges (T7-T10) instead of the
    //     pre-purchase touches. campaign_touch_count is pinned to
    //     TOTAL_TOUCHPOINTS (=6) so the next touch the dispatcher
    //     computes is T7 regardless of where they were in the
    //     pre-purchase journey.
    //   * 'expired' — campaign already ran its full 60d sequence.
    //     The patient came back later and bought; stamp the
    //     attribution but DON'T restart campaigns. They explicitly
    //     aged out of the nurture sequence. (The
    //     lapsed-customer-winback worker handles them 180d later.)
    const willStartReorder =
      lead.journey_stage === "consent" ||
      lead.journey_stage === "completed" ||
      lead.journey_stage === "campaign_active";

    const update: FitterLeadsUpdate = {
      first_order_id: order.orderId,
      first_order_placed_at: order.placedAt,
      // Always stamp first_name when we have one — it's useful even
      // for the no-reorder branches (e.g. ops reading the admin
      // queue), and the column is otherwise empty for converted
      // leads.
      ...(order.firstName ? { first_name: order.firstName } : {}),
    };
    if (willStartReorder) {
      update.journey_stage = "reorder_active";
      update.campaign_touch_count = 6; // TOTAL_TOUCHPOINTS — next touch is T7
      update.next_campaign_touch_at = new Date(
        new Date(order.placedAt).getTime() + REORDER_T7_OFFSET_MS,
      ).toISOString();
    } else {
      update.journey_stage = "converted";
      update.next_campaign_touch_at = null;
    }

    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update(update)
      .eq("id", lead.id)
      // Belt-and-suspenders: only stamp if first_order_id is still
      // null. A concurrent worker run can't double-attribute.
      .is("first_order_id", null);
    if (updateErr) {
      stats.errors += 1;
      logger.warn(
        { err: updateErr.message, leadId: lead.id },
        "fitter-lead.attribution: update failed",
      );
      continue;
    }
    stats.attributed += 1;
  }

  return stats;
}

export async function registerFitterConversionAttributionJob(
  boss: PgBoss,
): Promise<void> {
  // Same boot-time flag as the supply-campaign dispatcher — they're
  // a matched pair. Disabling one without the other leaves either
  // leads that won't expire (no attribution → never marked
  // converted) or campaigns running blind (no attribution
  // visibility). One flag, both workers.
  if (process.env.RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED !== "1") {
    logger.info(
      { event: "fitter-lead.attribution.disabled" },
      "fitter-lead.attribution: not registered (RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED!=1)",
    );
    return;
  }
  await boss.createQueue(JOB_NAME);
  await boss.work(JOB_NAME, async () => {
    try {
      const stats = await runFitterConversionAttribution();
      logger.info(
        { event: "fitter-lead.attribution.completed", ...stats },
        "fitter-lead.attribution: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fitter-lead.attribution: failed",
      );
      throw err;
    }
  });
  await boss.schedule(JOB_NAME, JOB_CRON);
  logger.info({ cron: JOB_CRON }, "fitter-lead.attribution scheduled");
}

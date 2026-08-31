// record-shipment-evidence.ts — the single writer of
// `fulfillments.shipped_at`, and with it the first writer of
// `episodes.status = 'fulfilled'`.
//
// WHAT WAS BROKEN
// ---------------
// Nothing in the app had ever stamped `shipped_at`. Resupply confirm
// inserts `status='queued'` and PacWare ships out of band, so four
// readers had been dark since day one:
//
//   * worker/jobs/reminders.ts:641 anchors cadence on
//     MAX(COALESCE(shipped_at, created_at)) — i.e. on QUEUE time, so a
//     patient's next refill was timed from when we entered the order,
//     not from when they received it.
//   * lib/analytics/reorder-funnel.ts's `shipped` stage was permanently 0.
//   * resupply.fulfillments_to_bill_count() filters on shipped rows and
//     always returned 0.
//   * lib/billing/claim-builder.ts:197 falls back to today's date, so
//     every claim carried the wrong date of service.
//
// WHAT THIS DOES
// --------------
// One idempotent chokepoint used by both evidence sources (the PacWare
// shipped-orders import and the CSR "mark shipped" action):
//
//   1. Atomically claim the fulfillment (`.is("shipped_at", null)`), so
//      two concurrent imports cannot double-fire. Same conditional-update
//      pattern as the confirm path in order-flow.ts.
//   2. Close the episode `fulfilled` / `shipped`, dated on the SHIP date
//      rather than now, so time-to-fulfil stays honest when the evidence
//      arrives days late.
//   3. Open — or re-anchor — the next cycle from `shipped_at`.
//
// Steps 2 and 3 are fail-soft. The box has already left; a bookkeeping
// failure must not fail the import row or the CSR's click. Step 1 throws:
// it is the load-bearing write.
//
// A NOTE ON WHAT THIS DELIBERATELY REFUSES TO DO
// ----------------------------------------------
// `shipped_at` becomes the date of service on an 837P
// (claim-builder.ts:197). Only REAL evidence may write it. The
// safety-net grace sweep, which advances a ladder that never got
// confirmation, closes the episode `assumed_shipped` and never touches
// the fulfillment — inventing a ship date for a payer is a compliance
// problem, not a data-quality one.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  FULFILLMENT_CANCELLED,
  FULFILLMENT_DELIVERED,
  FULFILLMENT_SHIPPED,
} from "@workspace/resupply-domain";

import { closeEpisode } from "../episodes/close-episode";
import { openOutreachEpisode } from "../episodes/open-outreach-episode";
import { reanchorEpisodeDueAt } from "../episodes/reanchor-due-at";
import { logger } from "../logger";

/** Where the evidence came from. Recorded in `shipment_metadata` so a
 *  later audit can tell a scanned confirmation from a CSR's judgement. */
export type ShipmentEvidenceSource =
  | "pacware_import"
  | "admin_manual"
  | "carrier";

export interface RecordShipmentEvidenceInput {
  orgId: string;
  fulfillmentId: string;
  /** The real ship date. Anchors both the episode close-out and the next
   *  cycle's due date. */
  shippedAt: Date;
  deliveredAt?: Date | null;
  source: ShipmentEvidenceSource;
  pacwareOrderRef?: string | null;
  trackingNumber?: string | null;
  carrier?: string | null;
}

export type RecordShipmentEvidenceStatus =
  | "applied"
  /** Already carried a `shipped_at`. Re-importing the same file is a
   *  no-op, not an error. */
  | "already_recorded"
  | "not_found"
  /** Cancelled. A cancelled line is never resurrected by an import. */
  | "not_shippable";

export interface RecordShipmentEvidenceResult {
  status: RecordShipmentEvidenceStatus;
  fulfillmentId: string;
  episodeId: string | null;
  /** This call flipped the episode to `fulfilled`. */
  episodeClosed: boolean;
  nextEpisodeId: string | null;
  /** False when an existing next cycle was re-anchored instead of a new
   *  one being opened — the normal case, since the confirm path already
   *  opened one. */
  nextEpisodeCreated: boolean;
  reanchored: boolean;
}

interface FulfillmentRow {
  id: string;
  episode_id: string | null;
  patient_id: string | null;
  item_sku: string | null;
  status: string | null;
  shipped_at: string | null;
  pacware_order_ref: string | null;
}

export async function recordShipmentEvidence(
  input: RecordShipmentEvidenceInput,
): Promise<RecordShipmentEvidenceResult> {
  const supabase = getOrgScopedClient(input.orgId);
  const nowIso = new Date().toISOString();

  const base = {
    fulfillmentId: input.fulfillmentId,
    episodeId: null as string | null,
    episodeClosed: false,
    nextEpisodeId: null as string | null,
    nextEpisodeCreated: false,
    reanchored: false,
  };

  const { data: row, error: readErr } = await supabase
    .from("fulfillments")
    .select(
      "id, episode_id, patient_id, item_sku, status, shipped_at, pacware_order_ref",
    )
    .eq("id", input.fulfillmentId)
    .limit(1)
    .maybeSingle();
  if (readErr) throw readErr;

  const fulfillment = row as FulfillmentRow | null;
  if (!fulfillment) return { ...base, status: "not_found" };
  if (fulfillment.status === FULFILLMENT_CANCELLED) {
    return { ...base, status: "not_shippable" };
  }

  base.episodeId = fulfillment.episode_id;

  // 1. Atomic claim. `.is("shipped_at", null)` is the whole guard: two
  //    concurrent imports of the same file both run this UPDATE, Postgres
  //    serialises them, and the loser matches zero rows.
  const { data: claimed, error: claimErr } = await supabase
    .from("fulfillments")
    .update({
      status: input.deliveredAt ? FULFILLMENT_DELIVERED : FULFILLMENT_SHIPPED,
      shipped_at: input.shippedAt.toISOString(),
      delivered_at: input.deliveredAt ? input.deliveredAt.toISOString() : null,
      pacware_order_ref:
        input.pacwareOrderRef ?? fulfillment.pacware_order_ref ?? null,
      shipment_metadata: {
        source: input.source,
        trackingNumber: input.trackingNumber ?? null,
        carrier: input.carrier ?? null,
        recordedAt: nowIso,
      },
      updated_at: nowIso,
    })
    .eq("id", input.fulfillmentId)
    .is("shipped_at", null)
    .select("id");
  if (claimErr) throw claimErr;

  if ((claimed ?? []).length === 0) {
    return { ...base, status: "already_recorded" };
  }

  // 2. Close the episode. Fail-soft from here down.
  if (fulfillment.episode_id) {
    try {
      const closed = await closeEpisode({
        orgId: input.orgId,
        episodeId: fulfillment.episode_id,
        status: "fulfilled",
        reason: "shipped",
        fulfillmentId: input.fulfillmentId,
        at: input.shippedAt,
        // The order is normally `confirmed` by the time it ships.
        allowFromConfirmed: true,
      });
      base.episodeClosed = closed.closed;
    } catch (err) {
      logger.warn(
        {
          event: "resupply.ship_evidence_close_failed",
          fulfillmentId: input.fulfillmentId,
          episodeId: fulfillment.episode_id,
          errName: err instanceof Error ? err.name : "unknown",
        },
        "resupply: episode close-out failed after recording shipment",
      );
    }
  }

  // 3. Open or re-anchor the next cycle, dated from the real ship.
  try {
    const next = await openNextCycle({
      orgId: input.orgId,
      episodeId: fulfillment.episode_id,
      shippedAt: input.shippedAt,
    });
    base.nextEpisodeId = next.episodeId;
    base.nextEpisodeCreated = next.created;
    base.reanchored = next.reanchored;
  } catch (err) {
    logger.warn(
      {
        event: "resupply.ship_evidence_next_cycle_failed",
        fulfillmentId: input.fulfillmentId,
        episodeId: fulfillment.episode_id,
        errName: err instanceof Error ? err.name : "unknown",
      },
      "resupply: next-cycle open failed after recording shipment",
    );
  }

  return { ...base, status: "applied" };
}

/**
 * Open the next cycle anchored on the ship date, or re-anchor the one
 * the confirm path already opened.
 *
 * `openOutreachEpisode` is idempotent against outreach-open rows, so it
 * hands back the existing episode rather than opening a second. That is
 * the normal path — the confirm opened a cycle dated from the confirm,
 * and this corrects it to the ship.
 */
async function openNextCycle(args: {
  orgId: string;
  episodeId: string | null;
  shippedAt: Date;
}): Promise<{
  episodeId: string | null;
  created: boolean;
  reanchored: boolean;
}> {
  if (!args.episodeId)
    return { episodeId: null, created: false, reanchored: false };

  const supabase = getOrgScopedClient(args.orgId);

  const { data: episode, error: epErr } = await supabase
    .from("episodes")
    .select("id, patient_id, prescription_id")
    .eq("id", args.episodeId)
    .limit(1)
    .maybeSingle();
  if (epErr) throw epErr;
  const ep = episode as {
    patient_id: string;
    prescription_id: string;
  } | null;
  if (!ep) return { episodeId: null, created: false, reanchored: false };

  const { data: rx, error: rxErr } = await supabase
    .from("prescriptions")
    .select("cadence_days, status")
    .eq("id", ep.prescription_id)
    .limit(1)
    .maybeSingle();
  if (rxErr) throw rxErr;
  const prescription = rx as {
    cadence_days: number | null;
    status: string | null;
  } | null;

  // An inactive prescription must not spawn another cycle — that is the
  // clinician's decision, expressed by deactivating it.
  if (!prescription || prescription.status !== "active") {
    return { episodeId: null, created: false, reanchored: false };
  }

  const cadenceDays =
    typeof prescription.cadence_days === "number" &&
    prescription.cadence_days > 0
      ? prescription.cadence_days
      : 90;

  const opened = await openOutreachEpisode({
    orgId: args.orgId,
    patientId: ep.patient_id,
    prescriptionId: ep.prescription_id,
    cadenceDays,
    from: args.shippedAt,
  });

  if (opened.created) {
    return { episodeId: opened.episodeId, created: true, reanchored: false };
  }

  // An episode was already open — normally the one the confirm path
  // opened, dated from the confirm rather than the ship. Correct it.
  const dueAt = new Date(
    args.shippedAt.getTime() + cadenceDays * 24 * 60 * 60 * 1000,
  );
  const reanchored = await reanchorEpisodeDueAt({
    orgId: args.orgId,
    episodeId: opened.episodeId,
    dueAt,
    source: "shipment_evidence",
  });

  return { episodeId: opened.episodeId, created: false, reanchored };
}

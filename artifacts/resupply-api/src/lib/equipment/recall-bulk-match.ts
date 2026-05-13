// Bulk match-and-queue helper for recalls.
//
// Given a recall id, find every active equipment_assets row that
// matches the recall's criteria, then:
//   1. Stamp asset.recall_id and asset.status='recalled'.
//   2. Upsert a recall_notifications row in 'queued' state per
//      (recall_id, asset_id).
// Returns the count of matched assets and the count of newly
// queued notifications (existing queued rows are not re-touched).
//
// This is a one-shot per recall; the bulk update + the notification
// queue both stay idempotent so a CSR can hit "Run match" twice
// without double-touching anything.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  recallMatchesAsset,
  type RecallSerialMatch,
} from "./recall-match";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface BulkMatchResult {
  recallId: string;
  matchedCount: number;
  newlyQueuedCount: number;
  alreadyQueuedCount: number;
  skippedNonMatchCount: number;
}

export async function runRecallBulkMatch(
  supabase: SupabaseClient,
  recallId: string,
): Promise<BulkMatchResult> {
  // 1. Load the recall row + its match criteria.
  const { data: recall, error: recallErr } = await supabase
    .schema("resupply")
    .from("equipment_recalls")
    .select("id, manufacturer, model_match, serial_match, status")
    .eq("id", recallId)
    .limit(1)
    .maybeSingle();
  if (recallErr) throw recallErr;
  if (!recall) {
    throw new Error(`recall ${recallId} not found`);
  }

  // 2. Candidate assets: same manufacturer, active or in service.
  // We over-fetch by manufacturer and let recallMatchesAsset apply
  // the model + serial filters. The (manufacturer, model, status)
  // index makes this cheap.
  const { data: candidates, error: candErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("id, patient_id, manufacturer, model, serial_number, recall_id")
    .ilike("manufacturer", recall.manufacturer)
    .in("status", ["active"]);
  if (candErr) throw candErr;

  const serialMatch = (recall.serial_match ?? null) as RecallSerialMatch;
  const matched = (candidates ?? []).filter((a) =>
    recallMatchesAsset({
      asset: {
        manufacturer: a.manufacturer,
        model: a.model,
        serialNumber: a.serial_number,
      },
      recall: {
        manufacturer: recall.manufacturer,
        modelMatch: recall.model_match,
        serialMatch,
      },
    }),
  );

  if (matched.length === 0) {
    return {
      recallId,
      matchedCount: 0,
      newlyQueuedCount: 0,
      alreadyQueuedCount: 0,
      skippedNonMatchCount: (candidates ?? []).length,
    };
  }

  // 3. Stamp asset.recall_id + status='recalled' for matches.
  // We only update rows that aren't already pointing at THIS
  // recall — preserves the audit story that a row's first match
  // wins, and matches our idempotency posture.
  const matchedIds = matched.map((a) => a.id);
  const { error: updErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .update({ recall_id: recallId, status: "recalled" })
    .in("id", matchedIds)
    .neq("recall_id", recallId);
  if (updErr) throw updErr;

  // 4. Check which (recall, asset) pairs already have a
  // notifications row so we can report newlyQueued vs alreadyQueued.
  const { data: existing, error: existingErr } = await supabase
    .schema("resupply")
    .from("recall_notifications")
    .select("asset_id")
    .eq("recall_id", recallId)
    .in("asset_id", matchedIds);
  if (existingErr) throw existingErr;
  const alreadyQueued = new Set(
    (existing ?? []).map((r) => r.asset_id),
  );
  const toInsert = matched.filter((a) => !alreadyQueued.has(a.id));

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .insert(
        toInsert.map((a) => ({
          recall_id: recallId,
          asset_id: a.id,
          patient_id: a.patient_id,
          status: "queued",
        })),
      );
    if (insErr) throw insErr;
  }

  return {
    recallId,
    matchedCount: matched.length,
    newlyQueuedCount: toInsert.length,
    alreadyQueuedCount: alreadyQueued.size,
    skippedNonMatchCount:
      (candidates ?? []).length - matched.length,
  };
}

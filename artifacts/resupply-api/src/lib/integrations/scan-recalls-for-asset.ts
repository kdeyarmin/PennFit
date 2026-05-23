// After an auto-linked equipment_assets row lands, scan it against
// active recalls and queue a recall_notifications row when a match
// is found.
//
// Idempotency
// -----------
// recall_notifications has a (recall_id, asset_id) unique index
// (recall_notifications_recall_asset_unique). We rely on that
// constraint: a duplicate insert returns a 23505 error which we
// treat as a no-op, the same pattern used by evaluatePatientSmartTriggers.

import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { recallMatchesAsset } from "../equipment/recall-match";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface RecallScanOutcome {
  matchedRecallIds: string[];
  notificationsQueued: number;
}

/**
 * Scan an equipment asset for active recalls and queue a notification row for each match.
 *
 * @param assetId - The ID of the equipment asset to scan
 * @returns An object containing `matchedRecallIds`: array of recall IDs that matched the asset, and `notificationsQueued`: number of newly inserted notification rows
 * @throws If a Supabase read or write operation fails
 */
export async function scanRecallsForAsset(
  supabase: Supabase,
  assetId: string,
): Promise<RecallScanOutcome> {
  const { data: asset, error: aErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("id, patient_id, manufacturer, model, serial_number, status")
    .eq("id", assetId)
    .limit(1)
    .maybeSingle();
  if (aErr) throw aErr;
  if (!asset) return { matchedRecallIds: [], notificationsQueued: 0 };
  if (asset.status !== "active") return { matchedRecallIds: [], notificationsQueued: 0 };

  const { data: recalls, error: rErr } = await supabase
    .schema("resupply")
    .from("equipment_recalls")
    .select(
      "id, manufacturer, model_match, serial_match, status",
    )
    .eq("status", "active")
    .ilike("manufacturer", asset.manufacturer);
  if (rErr) throw rErr;

  const matched: string[] = [];
  let queued = 0;
  for (const recall of recalls ?? []) {
    const matches = recallMatchesAsset({
      asset: {
        manufacturer: asset.manufacturer,
        model: asset.model,
        serialNumber: asset.serial_number,
      },
      recall: {
        manufacturer: recall.manufacturer,
        modelMatch: recall.model_match,
        serialMatch: recall.serial_match as
          | null
          | { kind: "list"; serials: string[] }
          | { kind: "range"; from: string; to: string },
      },
    });
    if (!matches) continue;
    matched.push(recall.id);

    const { error: insErr } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .insert({
        recall_id: recall.id,
        asset_id: asset.id,
        patient_id: asset.patient_id,
        status: "queued",
      });
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") continue;
      throw insErr;
    }
    queued += 1;
  }
  return { matchedRecallIds: matched, notificationsQueued: queued };
}

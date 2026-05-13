// After an auto-linked equipment_assets row lands, scan it against
// active recalls and queue a recall_notifications row when a match
// is found.
//
// Idempotency
// -----------
// recall_notifications has a (recall_id, asset_id) unique-ish
// semantic — re-running is a no-op when the row already exists for
// a (recall, asset) pair. We enforce that here with a SELECT-first;
// the table doesn't have a hard unique index on the pair, so we
// guard application-side rather than relying on a 23505 round-trip.

import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { recallMatchesAsset } from "../equipment/recall-match";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface RecallScanOutcome {
  matchedRecallIds: string[];
  notificationsQueued: number;
}

export async function scanRecallsForAsset(
  supabase: Supabase,
  assetId: string,
): Promise<RecallScanOutcome> {
  const { data: asset, error: aErr } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("id, patient_id, manufacturer, model, serial_number")
    .eq("id", assetId)
    .limit(1)
    .maybeSingle();
  if (aErr) throw aErr;
  if (!asset) return { matchedRecallIds: [], notificationsQueued: 0 };

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

    const { data: priorRow } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .select("id")
      .eq("recall_id", recall.id)
      .eq("asset_id", asset.id)
      .limit(1)
      .maybeSingle();
    if (priorRow) continue;

    const { error: insErr } = await supabase
      .schema("resupply")
      .from("recall_notifications")
      .insert({
        recall_id: recall.id,
        asset_id: asset.id,
        patient_id: asset.patient_id,
        status: "queued",
      });
    if (insErr) throw insErr;
    queued += 1;
  }
  return { matchedRecallIds: matched, notificationsQueued: queued };
}

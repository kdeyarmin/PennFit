// Expiry-aware claim on worker_dedup_keys.
//
// The table's PRIMARY KEY makes a plain INSERT conflict on ANY existing
// row — including one whose expires_at is long past. Since nothing
// pruned the table before the daily sweeper landed (see
// idempotency-keys-prune.ts), a "14-day" frequency cap claimed this way
// was actually permanent: after one successful send the stale row
// blocked every later claim forever (app-review 2026-06-10, P1-2).
//
// claimDedupKey deletes any EXPIRED row for the key first, then
// inserts. Under two concurrent claimants both may delete the expired
// row, but exactly one INSERT wins the PK; the loser sees 23505 and
// reports "held". An unexpired row is never deleted, so an active
// cooldown still holds.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export type DedupClaimOutcome =
  | { outcome: "claimed" }
  | { outcome: "held" }
  | { outcome: "error"; error: { code?: string; message: string } };

export async function claimDedupKey(
  supabase: Supabase,
  key: string,
  expiresAtIso: string,
): Promise<DedupClaimOutcome> {
  const { error: expireErr } = await supabase
    .schema("resupply")
    .from("worker_dedup_keys")
    .delete()
    .eq("key", key)
    .lte("expires_at", new Date().toISOString());
  if (expireErr) {
    // Fall through to the insert anyway — worst case the stale row
    // still blocks (the pre-fix behavior), never a double-send.
    return {
      outcome: "error",
      error: { code: expireErr.code, message: expireErr.message },
    };
  }

  const { error: insertErr } = await supabase
    .schema("resupply")
    .from("worker_dedup_keys")
    .insert({ key, expires_at: expiresAtIso });
  if (!insertErr) return { outcome: "claimed" };
  if (insertErr.code === "23505") return { outcome: "held" };
  return {
    outcome: "error",
    error: { code: insertErr.code, message: insertErr.message },
  };
}

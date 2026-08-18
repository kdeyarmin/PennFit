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

/**
 * Give a claimed key back.
 *
 * A frequency cap is a promise about messages we SENT. When the claim
 * succeeds but the send afterwards doesn't — no invite row, vendor
 * outage, missing credentials — leaving the row in place silently
 * suppresses that recipient for the whole cooldown despite nothing having
 * reached them. Callers that claim ahead of a fallible send must release
 * on every failure path.
 *
 * Best-effort by design: a failed release is logged by the caller and
 * leaves the cooldown in place, which is the safe direction (a missed
 * message beats a duplicate one).
 */
export async function releaseDedupKey(
  supabase: Supabase,
  key: string,
): Promise<{ released: boolean }> {
  const { error } = await supabase
    .schema("resupply")
    .from("worker_dedup_keys")
    .delete()
    .eq("key", key);
  return { released: !error };
}

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
    // Don't attempt the insert if the expiry sweep fails. Worst case the
    // stale row still blocks (the pre-fix behavior); we never risk a
    // double-send.
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

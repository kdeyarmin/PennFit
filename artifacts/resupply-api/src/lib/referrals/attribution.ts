// Patient-referral conversion attribution.
//
// A referral is "converted" when an email matching `referee_email`
// (case-insensitive) places a paid shop order. The Stripe webhook is
// a natural place to call this, but coupling it there forces us to
// re-deploy the webhook every time the referral flow changes. This
// helper is callable from anywhere — webhook, periodic sweep, or
// admin trigger — and is idempotent (already-converted rows are
// skipped).

import { type getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type Supabase = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface AttributionResult {
  scanned: number;
  converted: number;
}

/**
 * Walk every paid shop_orders row younger than `lookbackDays` and,
 * for each one, mark any matching pending referral as `converted`.
 * The match is case-insensitive on email. Order rows without a
 * customer_email (rare; old guest checkouts) are skipped.
 *
 * Idempotent — re-running yields scanned ≥ converted-on-first-run,
 * converted = 0.
 */
export async function attributePendingReferrals(
  supabase: Supabase,
  options: { lookbackDays?: number } = {},
): Promise<AttributionResult> {
  const days = options.lookbackDays ?? 90;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  // Pull recent paid orders. Capped at 1000 — for a busy DME that's
  // ~a month of volume, which gives the sweep plenty of overlap to
  // catch slow-converting referrals.
  const { data: orders, error: oErr } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("id, customer_email, created_at")
    .eq("status", "paid")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (oErr) throw oErr;

  let scanned = 0;
  let converted = 0;
  for (const order of orders ?? []) {
    scanned += 1;
    const email = (order.customer_email ?? "").trim();
    if (!email) continue;
    // Escape LIKE metacharacters so an email with `_` or `%`
    // doesn't fan out to other patients' referral rows.
    const escapedEmail = email.replace(/[\\%_]/g, (c: string) => `\\${c}`);
    const { data: candidates, error: rErr } = await supabase
      .schema("resupply")
      .from("patient_referrals")
      .select("id, referee_email, status")
      .ilike("referee_email", escapedEmail)
      .eq("status", "pending")
      .limit(5);
    if (rErr) throw rErr;
    for (const ref of candidates ?? []) {
      const { error: uErr } = await supabase
        .schema("resupply")
        .from("patient_referrals")
        .update({
          status: "converted",
          converted_at: new Date().toISOString(),
          converted_order_id: order.id,
        })
        .eq("id", ref.id)
        .eq("status", "pending");
      if (uErr) throw uErr;
      converted += 1;
    }
  }
  return { scanned, converted };
}

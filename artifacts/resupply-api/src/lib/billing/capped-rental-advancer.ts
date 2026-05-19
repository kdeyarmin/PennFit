// Capped-rental lifecycle advancer.
//
// Runs as a daily worker. For each active capped_rental_cycles row:
//   * If today >= start_date + (current_month * 30 days), advance:
//     - current_month += 1
//     - Generate a draft insurance_claims for this month with the
//       right modifier rotation (KH for months 1-3; KI + KX when
//       compliant for 4-13).
//     - Set latest_claim_id.
//   * When current_month == max_months + 1, mark ownership_transferred_on
//     and status='transferred'.
//
// The actual claim insert reuses the existing claim builder (one-click
// from a "synthetic fulfillment" — we record the rental-cycle id in
// the claim notes for traceability).

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

const SYSTEM_ACTOR = "system:cron:capped-rental-advance";

export interface AdvanceStats {
  scanned: number;
  advanced: number;
  transferred: number;
  errored: number;
  byHcpcs: Record<string, number>;
}

const COMPLIANT_KX_HCPCS = new Set(["E0601", "E0470", "E0471"]);

export async function runCappedRentalAdvance(): Promise<AdvanceStats> {
  const supabase = getSupabaseServiceRoleClient();
  const stats: AdvanceStats = {
    scanned: 0,
    advanced: 0,
    transferred: 0,
    errored: 0,
    byHcpcs: {},
  };
  const { data: cycles } = await supabase
    .schema("resupply")
    .from("capped_rental_cycles")
    .select(
      "id, patient_id, hcpcs_code, payer_profile_id, insurance_coverage_id, start_date, current_month, max_months, status",
    )
    .eq("status", "active")
    .limit(2000);
  for (const cycle of cycles ?? []) {
    stats.scanned += 1;
    try {
      const advanced = await advanceCycle(supabase, cycle);
      if (advanced === "advanced") {
        stats.advanced += 1;
        stats.byHcpcs[cycle.hcpcs_code] =
          (stats.byHcpcs[cycle.hcpcs_code] ?? 0) + 1;
      } else if (advanced === "transferred") {
        stats.transferred += 1;
      }
    } catch (err) {
      stats.errored += 1;
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          cycleId: cycle.id,
        },
        "capped-rental.advance: per-cycle failure",
      );
    }
  }
  return stats;
}

type Cycle = Pick<
  Database["resupply"]["Tables"]["capped_rental_cycles"]["Row"],
  | "id"
  | "patient_id"
  | "hcpcs_code"
  | "payer_profile_id"
  | "insurance_coverage_id"
  | "start_date"
  | "current_month"
  | "max_months"
  | "status"
>;

async function advanceCycle(
  supabase: SupabaseClient,
  cycle: Cycle,
): Promise<"advanced" | "transferred" | "noop"> {
  // Is the next month due? Anniversary = start + (current_month * 30 days).
  const start = new Date(`${cycle.start_date}T00:00:00Z`);
  const nextDueMs = start.getTime() + cycle.current_month * 30 * 24 * 3600 * 1000;
  if (Date.now() < nextDueMs) return "noop";

  // Ownership transfer at month max+1.
  if (cycle.current_month >= cycle.max_months) {
    await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .update({
        status: "transferred",
        ownership_transferred_on: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq("id", cycle.id);
    return "transferred";
  }

  // Resolve compliance for KX gate.
  const isCompliant = await isPatientCompliant(supabase, cycle.patient_id);
  const nextMonth = cycle.current_month + 1;
  const modifiers = pickModifiers(cycle.hcpcs_code, nextMonth, isCompliant);

  const { data: payer } = cycle.payer_profile_id
    ? await supabase
        .schema("resupply")
        .from("payer_profiles")
        .select("display_name, payer_legal_name")
        .eq("id", cycle.payer_profile_id)
        .limit(1)
        .maybeSingle()
    : { data: null };

  const billedCents = await defaultBilledForHcpcs(
    supabase,
    cycle.payer_profile_id,
    cycle.hcpcs_code,
  );
  const dos = new Date(nextDueMs).toISOString().slice(0, 10);

  const { data: claimRow, error: claimErr } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .insert({
      patient_id: cycle.patient_id,
      insurance_coverage_id: cycle.insurance_coverage_id,
      payer_name: payer?.payer_legal_name ?? payer?.display_name ?? "unknown",
      date_of_service: dos,
      payer_profile_id: cycle.payer_profile_id,
      status: "draft",
      total_billed_cents: billedCents,
      notes: `[capped-rental:${cycle.id}] month ${nextMonth}/${cycle.max_months}`,
    })
    .select("id")
    .single();
  if (claimErr) throw claimErr;

  await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .insert({
      claim_id: claimRow.id,
      hcpcs_code: cycle.hcpcs_code,
      modifier: modifiers.join(","),
      quantity: 1,
      billed_cents: billedCents,
      status: "pending",
    });

  await supabase
    .schema("resupply")
    .from("insurance_claim_events")
    .insert({
      claim_id: claimRow.id,
      event_type: "note",
      note: `Generated by capped-rental advancer for cycle ${cycle.id} (month ${nextMonth}).`,
      actor_email: SYSTEM_ACTOR,
    });

  await supabase
    .schema("resupply")
    .from("capped_rental_cycles")
    .update({
      current_month: nextMonth,
      latest_claim_id: claimRow.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cycle.id);

  return "advanced";
}

function pickModifiers(
  hcpcs: string,
  month: number,
  isCompliant: boolean,
): string[] {
  const mods: string[] = ["RR"];
  if (month <= 3) mods.push("KH");
  else if (month <= 13) {
    mods.push("KI");
    if (isCompliant && COMPLIANT_KX_HCPCS.has(hcpcs)) mods.push("KX");
  }
  return mods;
}

async function isPatientCompliant(
  supabase: SupabaseClient,
  patientId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes")
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(60);
  const compliant = (nights ?? []).filter(
    (n) => (n.usage_minutes ?? 0) >= 240,
  ).length;
  return compliant >= 21;
}

async function defaultBilledForHcpcs(
  supabase: SupabaseClient,
  payerProfileId: string | null,
  hcpcs: string,
): Promise<number> {
  if (payerProfileId) {
    const { data: fee } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .select("allowed_cents")
      .eq("payer_profile_id", payerProfileId)
      .eq("hcpcs_code", hcpcs)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fee) return fee.allowed_cents;
  }
  const { data: map } = await supabase
    .schema("resupply")
    .from("product_hcpcs_map")
    .select("default_billed_cents")
    .eq("hcpcs_code", hcpcs)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  return map?.default_billed_cents ?? 0;
}

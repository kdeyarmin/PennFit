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
  const { data: cycles, error: cyclesErr } = await supabase
    .schema("resupply")
    .from("capped_rental_cycles")
    .select(
      "id, patient_id, hcpcs_code, payer_profile_id, insurance_coverage_id, start_date, current_month, max_months, status",
    )
    .eq("status", "active")
    .limit(2000);
  // Throw — not fall through. PostgREST returns errors in-band, so a
  // swallowed error here makes `cycles` null, the loop a no-op, and
  // the job report "completed { scanned: 0 }": monthly Medicare rental
  // claims silently stop being drafted with zero failure signal for as
  // long as the error persists. Throwing fails the pg-boss job so the
  // DLQ/monitor sees it.
  if (cyclesErr) throw cyclesErr;
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
          err,
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

/**
 * Advance a capped rental cycle by one month when its next monthly anniversary is due.
 *
 * Attempts to atomically claim the next month; if claimed, creates a draft insurance claim,
 * a line item, and a claim event, then links the generated claim to the cycle. If the cycle
 * has reached its maximum months the function marks ownership as transferred. If the cycle
 * is not yet due or another worker already advanced it, no changes are made.
 *
 * @param cycle - The capped rental cycle record to evaluate and potentially advance
 * @returns `"advanced"` when the month was claimed and a draft claim was created; `"transferred"` when the cycle reached its max months and ownership was transferred; `"noop"` when the cycle is not due or another worker already advanced it
 */
async function advanceCycle(
  supabase: SupabaseClient,
  cycle: Cycle,
): Promise<"advanced" | "transferred" | "noop"> {
  // Is the next month due? Anniversary = start + (current_month * 30 days).
  const start = new Date(`${cycle.start_date}T00:00:00Z`);
  const nextDueMs =
    start.getTime() + cycle.current_month * 30 * 24 * 3600 * 1000;
  if (Date.now() < nextDueMs) return "noop";

  // Ownership transfer at month max+1.
  if (cycle.current_month >= cycle.max_months) {
    const { error: transferErr } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .update({
        status: "transferred",
        ownership_transferred_on: new Date().toISOString().slice(0, 10),
        updated_at: new Date().toISOString(),
      })
      .eq("id", cycle.id);
    if (transferErr) {
      logger.error(
        { err: transferErr.message, cycleId: cycle.id },
        "capped-rental: ownership transfer stamp failed — cycle stays active",
      );
      return "noop";
    }
    return "transferred";
  }

  const nextMonth = cycle.current_month + 1;

  // Atomically CLAIM this month BEFORE generating anything. The guarded
  // update only succeeds for the worker that flips current_month from
  // its observed value to nextMonth; a concurrent tick, a pg-boss
  // stalled re-claim, or a manual re-run sees zero rows updated and
  // no-ops. This — not the (human-reviewed) `draft` status — is what
  // prevents a SECOND draft claim being generated for the same rental
  // month: previously the advance happened AFTER the insert, so two
  // overlapping ticks both inserted before either advanced, and any
  // failure before the advance left the cycle re-eligible so the next
  // pass duplicated the claim.
  const { data: claimed, error: claimMonthErr } = await supabase
    .schema("resupply")
    .from("capped_rental_cycles")
    .update({
      current_month: nextMonth,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cycle.id)
    .eq("current_month", cycle.current_month)
    .select("id");
  if (claimMonthErr) throw claimMonthErr;
  if (!claimed || claimed.length === 0) {
    // Another tick already advanced this cycle past current_month.
    return "noop";
  }

  try {
    // Resolve compliance for KX gate.
    const isCompliant = await isPatientCompliant(supabase, cycle.patient_id);
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

    const dos = new Date(nextDueMs).toISOString().slice(0, 10);
    const billedCents = await defaultBilledForHcpcs(
      supabase,
      cycle.payer_profile_id,
      cycle.hcpcs_code,
      dos,
    );

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

    const { error: lineErr } = await supabase
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
    if (lineErr) throw lineErr;

    const { error: eventErr } = await supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .insert({
        claim_id: claimRow.id,
        event_type: "note",
        note: `Generated by capped-rental advancer for cycle ${cycle.id} (month ${nextMonth}).`,
        actor_email: SYSTEM_ACTOR,
      });
    if (eventErr) throw eventErr;

    // current_month was already advanced by the claim above; just link
    // the generated claim as the latest.
    const { error: linkErr } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .update({
        latest_claim_id: claimRow.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cycle.id);
    if (linkErr) throw linkErr;

    return "advanced";
  } catch (err) {
    // Roll the month back so a transient failure RETRIES on the next
    // run rather than silently skipping this rental month's claim. The
    // `current_month = nextMonth` guard ensures we never clobber a
    // concurrent further-advance.
    const { error: rollbackErr } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .update({
        current_month: cycle.current_month,
        updated_at: new Date().toISOString(),
      })
      .eq("id", cycle.id)
      .eq("current_month", nextMonth);
    if (rollbackErr) {
      logger.error(
        { err: rollbackErr.message, cycleId: cycle.id, nextMonth },
        "capped-rental: month rollback failed — this rental month's claim may be skipped",
      );
    }
    throw err;
  }
}

/**
 * Selects the HCPCS modifier codes applicable for a given capped-rental month.
 *
 * Always includes `"RR"`. Adds `"KH"` for months 1–3. For months 4–13 it adds `"KI"`,
 * and also adds `"KX"` when `isCompliant` is true and the `hcpcs` code is in the compliant set.
 *
 * @param hcpcs - The HCPCS code for the product or service
 * @param month - The rental month number (1-based)
 * @param isCompliant - Whether the patient meets the KX compliance criteria
 * @returns An array of modifier codes to apply to the claim line item
 */
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
  const { data: nights, error: nightsErr } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select("usage_minutes")
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(60);
  // Throw: a swallowed read error would silently classify the patient
  // non-compliant, dropping the KX modifier from a real claim (payer
  // denial). The caller's per-cycle catch counts it as errored instead.
  if (nightsErr) throw nightsErr;
  const compliant = (nights ?? []).filter(
    (n) => (n.usage_minutes ?? 0) >= 240,
  ).length;
  return compliant >= 21;
}

async function defaultBilledForHcpcs(
  supabase: SupabaseClient,
  payerProfileId: string | null,
  hcpcs: string,
  onDate: string,
): Promise<number> {
  if (payerProfileId) {
    const { data: fee, error: feeErr } = await supabase
      .schema("resupply")
      .from("payer_fee_schedules")
      .select("allowed_cents")
      .eq("payer_profile_id", payerProfileId)
      .eq("hcpcs_code", hcpcs)
      // Only a fee row effective on the date of service — mirrors
      // claim-builder's lookupFeeSchedule. The prior "newest
      // effective_from" pick could bill a future-dated or already-
      // expired rate onto the generated rental claim.
      .lte("effective_from", onDate)
      .or(`effective_through.is.null,effective_through.gte.${onDate}`)
      .order("effective_from", { ascending: false })
      .limit(1)
      .maybeSingle();
    // Throw: swallowing a read error here would silently fall through
    // to a 0-cent draft claim. The caller's per-cycle catch counts it.
    if (feeErr) throw feeErr;
    if (fee) return fee.allowed_cents;
  }
  const { data: map, error: mapErr } = await supabase
    .schema("resupply")
    .from("product_hcpcs_map")
    .select("default_billed_cents")
    .eq("hcpcs_code", hcpcs)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (mapErr) throw mapErr;
  return map?.default_billed_cents ?? 0;
}

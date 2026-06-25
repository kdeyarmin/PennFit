// Capped-rental lifecycle advancer.
//
// Runs as a daily worker. For each active capped_rental_cycles row:
//   * If today >= start_date + (current_month * 30 days), advance:
//     - current_month += 1
//     - Generate a draft insurance_claims for this month with the CMS
//       capped-rental modifier rotation (KH month 1; KI months 2-3;
//       KJ months 4..max, + KX when compliant). See
//       pickCappedRentalModifiers in @workspace/resupply-domain.
//     - Set latest_claim_id.
//   * When current_month == max_months + 1, mark ownership_transferred_on
//     and status='transferred'.
//
// The actual claim insert reuses the existing claim builder (one-click
// from a "synthetic fulfillment" — we record the rental-cycle id in
// the claim notes for traceability).

import {
  type Database,
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";
import {
  type AdherenceNight,
  decideCappedRentalAdvance,
  findBestAdherenceWindow,
  pickCappedRentalModifiers,
} from "@workspace/resupply-domain";

import { logger } from "../logger";
import { therapyNightSourceRank } from "../therapy-night-source-priority";
import { forEachActiveOrg } from "../../worker/lib/for-each-active-org";

type SupabaseClient = OrgScopedClient;

const SYSTEM_ACTOR = "system:cron:capped-rental-advance";

export interface AdvanceStats {
  scanned: number;
  advanced: number;
  transferred: number;
  errored: number;
  byHcpcs: Record<string, number>;
}

/**
 * Advance due capped-rental cycles.
 *
 * @param orgId  Optional. When supplied (e.g. an admin "advance-now"
 *   button scoped to req.orgId), advance ONLY that tenant. When omitted
 *   (the daily cron), fan out across EVERY active tenant.
 */
export async function runCappedRentalAdvance(
  orgId?: string,
): Promise<AdvanceStats> {
  const stats: AdvanceStats = {
    scanned: 0,
    advanced: 0,
    transferred: 0,
    errored: 0,
    byHcpcs: {},
  };
  // Single-tenant path: an explicit caller (admin trigger) sweeps just its
  // own org. Same fail-loud posture (the cycles-read throw propagates).
  if (orgId) {
    await advanceCappedRentalForOrg(orgId, stats);
    return stats;
  }
  // Fan out across every active tenant — capped_rental_cycles is org-scoped
  // and any active tenant can create cycles via the admin UI, so the daily
  // advance must run once per tenant (every sibling billing cron already
  // does). Single-tenant deploy: listActiveOrgIds() returns just the seed
  // org, so behavior is unchanged. Per-tenant failures are isolated by
  // forEachActiveOrg; the cycles-read throw inside advanceCappedRentalForOrg
  // therefore fails ONE tenant's sweep, and we re-surface it after the
  // fan-out (below) so the pg-boss job still fails for DLQ/monitor
  // visibility — preserving the file's deliberate fail-loud posture.
  const fan = await forEachActiveOrg(
    async (id) => advanceCappedRentalForOrg(id, stats),
    { jobName: "capped-rental.advance" },
  );
  if (fan.failedOrgIds.length > 0) {
    throw new Error(
      `capped-rental.advance: ${fan.failedOrgIds.length} tenant(s) failed this tick`,
    );
  }
  return stats;
}

/**
 * Advance every active capped-rental cycle for ONE tenant, accumulating
 * into the shared `stats`. Builds an org-scoped client so every read /
 * write is filtered to `orgId`.
 */
async function advanceCappedRentalForOrg(
  orgId: string,
  stats: AdvanceStats,
): Promise<void> {
  const supabase = getOrgScopedClient(orgId);
  const { data: cycles, error: cyclesErr } = await supabase
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
  // long as the error persists. Throwing surfaces this tenant as failed
  // (forEachActiveOrg isolates it, runCappedRentalAdvance re-throws) so
  // the DLQ/monitor sees it.
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
  // Anniversary / transfer decision (pure, shared with the CSR override
  // route + claim-preview UI).
  const decision = decideCappedRentalAdvance({
    startDate: cycle.start_date,
    currentMonth: cycle.current_month,
    maxMonths: cycle.max_months,
    asOf: new Date(),
  });
  const nextDueMs = decision.nextDueMs;
  if (decision.action === "noop") return "noop";

  // Ownership transfer at month max+1.
  if (decision.action === "transfer") {
    const { error: transferErr } = await supabase
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

  const nextMonth = decision.nextMonth;

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
    const modifiers = pickCappedRentalModifiers(
      cycle.hcpcs_code,
      nextMonth,
      isCompliant,
    );

    const { data: payer } = cycle.payer_profile_id
      ? await supabase
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

async function isPatientCompliant(
  supabase: SupabaseClient,
  patientId: string,
): Promise<boolean> {
  // KX asserts the patient met Medicare LCD L33718 adherence (≥4h on ≥21 of
  // 30 consecutive CALENDAR days within the first 90 days of therapy). Use the
  // SAME canonical window finder the compliance attestation + referral reports
  // use (findBestAdherenceWindow) so the modifier we put on the wire matches
  // what we would attest to the payer — instead of a divergent "count reported
  // nights in the last 30 days" heuristic that (a) double-counted a calendar
  // day reported by multiple integration sources and (b) could be truncated by
  // a LIMIT. Dedupe by night via the shared source-priority ranking first.
  const { data: nightRowsRaw, error: nightsErr } = await supabase
    .from("patient_therapy_nights")
    .select("night_date, source, usage_minutes")
    .eq("patient_id", patientId)
    .order("night_date", { ascending: true });
  // Throw: a swallowed read error would silently classify the patient
  // non-compliant, dropping the KX modifier from a real claim (payer
  // denial). The caller's per-cycle catch counts it as errored instead.
  if (nightsErr) throw nightsErr;
  const nightRows = (nightRowsRaw ?? []) as Array<{
    night_date: string;
    source: string;
    usage_minutes: number | null;
  }>;
  if (nightRows.length === 0) return false;

  const byDate = new Map<string, (typeof nightRows)[number]>();
  for (const row of nightRows) {
    if (!row.night_date) continue;
    const existing = byDate.get(row.night_date);
    if (
      !existing ||
      therapyNightSourceRank(row.source) <
        therapyNightSourceRank(existing.source)
    ) {
      byDate.set(row.night_date, row);
    }
  }
  const nights: AdherenceNight[] = Array.from(byDate.values())
    .map((r) => ({ date: r.night_date, usageMinutes: r.usage_minutes }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (nights.length === 0) return false;

  const anchorDate = nights[0]!.date;
  // Match the attestation/referral path's asOf (UTC calendar day) so the KX
  // determination is identical to the document we'd fax the payer.
  const asOfDate = new Date().toISOString().slice(0, 10);
  return findBestAdherenceWindow(nights, anchorDate, asOfDate).qualifies;
}

async function defaultBilledForHcpcs(
  supabase: SupabaseClient,
  payerProfileId: string | null,
  hcpcs: string,
  onDate: string,
): Promise<number> {
  if (payerProfileId) {
    const { data: fee, error: feeErr } = await supabase
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
    .raw()
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

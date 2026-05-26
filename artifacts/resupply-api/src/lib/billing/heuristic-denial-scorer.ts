// Heuristic predicted-denial scorer.
//
// Assigns a 0..1 probability that the payer will reject a given
// claim, BEFORE we submit it. Pure heuristic — no ML training; the
// rules come from the published CARC/RARC catalog + the LCD L33718
// requirements + the per-payer modifier_rules + the observed denial
// rate in the deterministic preflight.
//
// The score is used in three places:
//   1. preflight UI — surfaces a "high-risk" badge so the CSR works
//      it before the green claims.
//   2. billing dashboard — sorts the draft queue by risk-weighted
//      dollars-at-stake.
//   3. AI scrub — claims scoring >= 0.5 get prioritised for the LLM
//      pass (the heuristic is the cheap pre-filter; the LLM is the
//      expensive deep look).
//
// Output shape:
//   { probability, factors, scoredAt }
// where `factors` is the audit-friendly array of contributors:
//   { key, weight, label }
//
// The weights sum non-linearly (we cap at 0.95 so no single claim is
// "guaranteed denied" — that would discourage CSRs from working it).

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ScoringFactor {
  key: string;
  weight: number;
  label: string;
}

export interface DenialScore {
  probability: number;
  factors: ScoringFactor[];
  scoredAt: string;
}

const SCORE_CAP = 0.95;
const SCORE_FLOOR = 0.02;

// ── Individual factor weights ────────────────────────────────────────
// Chosen so a "fully-broken" claim lands around 0.85-0.92 and a
// "looks clean" claim lands around 0.05-0.10. These can be tuned
// once we have ~5k decided claims of historical ground truth.
const W_NO_PAYER_PROFILE = 0.30;
const W_NO_REFERRING_PROVIDER = 0.25;
const W_NO_DIAGNOSIS = 0.35;
const W_NO_PRIOR_AUTH_WHEN_REQUIRED = 0.40;
const W_NO_PECOS_ENROLLMENT = 0.45; // Medicare auto-denial path
const W_MISSING_KX_ON_CONTINUING_RENTAL = 0.30;
const W_LINE_BILLED_OVER_FEE_SCHEDULE_2X = 0.10;
const W_DIAGNOSIS_HCPCS_MISMATCH = 0.30;
const W_SUBSCRIBER_ADDRESS_MISSING = 0.50;

const MEDICARE_LIKE_LOBS = new Set(["medicare_part_b", "medicare_advantage"]);
const CAPPED_RENTAL_HCPCS = new Set(["E0601", "E0470", "E0471", "E0562"]);

export async function scoreClaim(claimId: string): Promise<DenialScore | null> {
  const supabase = getSupabaseServiceRoleClient();
  const factors: ScoringFactor[] = [];

  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_profile_id, insurance_coverage_id, referring_provider_id, date_of_service, total_billed_cents",
    )
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (!claim) return null;

  // 1. Payer profile.
  if (!claim.payer_profile_id) {
    factors.push({
      key: "missing_payer_profile",
      weight: W_NO_PAYER_PROFILE,
      label: "No payer_profile_id selected — clearinghouse cannot route the claim.",
    });
  }

  // 2. Referring provider (Medicare DME hard requirement).
  let payer:
    | {
        line_of_business: string;
        requires_prior_auth_dme: boolean;
        display_name: string;
      }
    | null = null;
  if (claim.payer_profile_id) {
    const { data } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("display_name, line_of_business, requires_prior_auth_dme")
      .eq("id", claim.payer_profile_id)
      .limit(1)
      .maybeSingle();
    payer = data ?? null;
  }
  const isMedicareLike = payer
    ? MEDICARE_LIKE_LOBS.has(payer.line_of_business)
    : false;
  if (!claim.referring_provider_id && isMedicareLike) {
    factors.push({
      key: "missing_referring_provider_medicare",
      weight: W_NO_REFERRING_PROVIDER,
      label: "Medicare DME requires the ordering / prescribing physician NPI.",
    });
  } else if (!claim.referring_provider_id) {
    factors.push({
      key: "missing_referring_provider",
      weight: W_NO_REFERRING_PROVIDER * 0.4,
      label: "No referring provider — many commercial payers will reject.",
    });
  }

  // 3. Diagnosis (from latest sleep study).
  const { data: sleep } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .select("diagnosis_icd10")
    .eq("patient_id", claim.patient_id)
    .not("diagnosis_icd10", "is", null)
    .order("study_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const diagnosis = sleep?.diagnosis_icd10 ?? null;
  if (!diagnosis) {
    factors.push({
      key: "missing_diagnosis",
      weight: W_NO_DIAGNOSIS,
      label: "No ICD-10 diagnosis on file — payer will reject without one.",
    });
  }

  // 4. Subscriber address (5010 hard requirement).
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("address")
    .eq("id", claim.patient_id)
    .limit(1)
    .maybeSingle();
  if (!hasStructuredAddress(patient?.address)) {
    factors.push({
      key: "missing_subscriber_address",
      weight: W_SUBSCRIBER_ADDRESS_MISSING,
      label: "Subscriber address incomplete — 5010 syntactic rejection.",
    });
  }

  // 5. Per-line analysis.
  const { data: lines } = await supabase
    .schema("resupply")
    .from("insurance_claim_line_items")
    .select("hcpcs_code, modifier, billed_cents, quantity")
    .eq("claim_id", claim.id);
  const lineList = lines ?? [];

  // 5a. Prior-auth requirement.
  if (payer?.requires_prior_auth_dme && lineList.length > 0) {
    const hcpcsList = lineList.map((l) => l.hcpcs_code);
    const { data: pas } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select("auth_number, status, hcpcs_code, approved_through")
      .eq("patient_id", claim.patient_id)
      .eq("status", "approved")
      .in("hcpcs_code", hcpcsList);
    if (!pas || pas.length === 0) {
      factors.push({
        key: "missing_prior_auth_required",
        weight: W_NO_PRIOR_AUTH_WHEN_REQUIRED,
        label: `${payer.display_name} requires PA for DME and none is on file.`,
      });
    }
  }

  // 5b. PECOS (Medicare-like only).
  if (isMedicareLike && claim.referring_provider_id) {
    const { data: provider } = await supabase
      .schema("resupply")
      .from("providers")
      .select("npi")
      .eq("id", claim.referring_provider_id)
      .limit(1)
      .maybeSingle();
    if (provider?.npi) {
      const { data: pecos } = await supabase
        .schema("resupply")
        .from("providers_pecos_status")
        .select("enrollment_status")
        .eq("npi", provider.npi)
        .limit(1)
        .maybeSingle();
      if (!pecos || pecos.enrollment_status !== "approved") {
        factors.push({
          key: "ordering_provider_not_in_pecos",
          weight: W_NO_PECOS_ENROLLMENT,
          label:
            "Ordering provider is not PECOS-approved at the date of service.",
        });
      }
    }
  }

  // 5c. KX modifier on continuing-rental DME.
  if (claim.payer_profile_id) {
    for (const line of lineList) {
      if (!CAPPED_RENTAL_HCPCS.has(line.hcpcs_code)) continue;
      const mods = ((line.modifier ?? "") as string)
        .split(",")
        .map((m: string) => m.trim().toUpperCase());
      if (!mods.includes("KX") && rentalLikelyContinuing(claim.date_of_service)) {
        factors.push({
          key: "missing_kx_continuing_rental",
          weight: W_MISSING_KX_ON_CONTINUING_RENTAL,
          label: `${line.hcpcs_code} continuing rental requires KX (compliance proven).`,
        });
        break;
      }
    }
  }

  // 5d. Billed >> fee schedule (caps writeoff but signals coding error).
  if (claim.payer_profile_id) {
    const onDate =
      claim.date_of_service ?? new Date().toISOString().slice(0, 10);
    for (const line of lineList) {
      const { data: fee } = await supabase
        .schema("resupply")
        .from("payer_fee_schedules")
        .select("allowed_cents")
        .eq("payer_profile_id", claim.payer_profile_id)
        .eq("hcpcs_code", line.hcpcs_code)
        // Only a fee row effective on the date of service (mirrors
        // claim-builder); the prior "newest effective_from" pick could
        // compare against a future-dated or expired rate, mis-weighting
        // the predicted-denial score.
        .lte("effective_from", onDate)
        .or(`effective_through.is.null,effective_through.gte.${onDate}`)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fee && line.billed_cents > fee.allowed_cents * 2) {
        factors.push({
          key: "billed_over_fee_schedule_2x",
          weight: W_LINE_BILLED_OVER_FEE_SCHEDULE_2X,
          label: `${line.hcpcs_code} billed at ${centsToDollars(line.billed_cents)} vs fee schedule ${centsToDollars(fee.allowed_cents)}.`,
        });
        break;
      }
    }
  }

  // 5e. Diagnosis ↔ HCPCS pairing.
  if (diagnosis && lineList.length > 0) {
    const dxStripped = diagnosis.replace(/\./g, "");
    const looksLikeOsa = /^(G4733|G4730|R0683)/.test(dxStripped);
    const looksLikePapHcpcs = lineList.some(
      (l) =>
        l.hcpcs_code === "E0601" ||
        l.hcpcs_code === "E0470" ||
        l.hcpcs_code === "E0471",
    );
    if (looksLikePapHcpcs && !looksLikeOsa) {
      factors.push({
        key: "pap_without_osa_diagnosis",
        weight: W_DIAGNOSIS_HCPCS_MISMATCH,
        label: `PAP device billed but primary diagnosis is ${diagnosis} (not G47.33).`,
      });
    }
  }

  return finalize(factors);
}

function finalize(factors: ScoringFactor[]): DenialScore {
  // Use multiplicative survival math so factors don't overshoot 1:
  //   P(not denied) = ∏(1 - wᵢ)
  //   P(denied)     = 1 - P(not denied)
  let surviving = 1;
  for (const f of factors) {
    const w = Math.min(0.95, Math.max(0, f.weight));
    surviving *= 1 - w;
  }
  let probability = 1 - surviving;
  probability = Math.max(SCORE_FLOOR, Math.min(SCORE_CAP, probability));
  return {
    probability,
    factors,
    scoredAt: new Date().toISOString(),
  };
}

/**
 * Persist the score onto the insurance_claims row. Returns the score
 * the caller persisted (so the route can echo it in the response).
 */
export async function scoreAndPersist(
  claimId: string,
): Promise<DenialScore | null> {
  const score = await scoreClaim(claimId);
  if (!score) return null;
  const supabase = getSupabaseServiceRoleClient();
  await supabase
    .schema("resupply")
    .from("insurance_claims")
    .update({
      predicted_denial_probability: score.probability,
      predicted_denial_factors: score.factors as unknown as never,
      predicted_denial_scored_at: score.scoredAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
  return score;
}

function hasStructuredAddress(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const a = raw as { line1?: unknown; city?: unknown; state?: unknown; zip?: unknown };
  return (
    typeof a.line1 === "string" &&
    typeof a.city === "string" &&
    typeof a.state === "string" &&
    typeof a.zip === "string" &&
    a.line1.length > 0 &&
    a.city.length > 0 &&
    a.state.length >= 2 &&
    a.zip.length >= 5
  );
}

function rentalLikelyContinuing(dateOfService: string): boolean {
  // Without explicit rental-cycle tracking we approximate: any DOS
  // beyond 100 days from today is "old enough" to be in month 4+.
  // This is conservative — it errs toward flagging KX-missing on
  // newer rentals too, which is the safer denial-avoidance bias.
  const dosMs = new Date(dateOfService).getTime();
  if (!Number.isFinite(dosMs)) return false;
  const ageDays = (Date.now() - dosMs) / (24 * 3600 * 1000);
  return ageDays >= 100;
}

function centsToDollars(cents: number): string {
  // Sign-correct so negative line amounts (refunds, adjustments)
  // don't render as "$-2.-50" in the scorer's audit-row metadata.
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const d = Math.floor(abs / 100);
  const c = abs % 100;
  return `${sign}$${d}.${c.toString().padStart(2, "0")}`;
}

// Suppress the no-unused-vars lint on the SupabaseClient alias; it's
// only used by the typescript inference path inside the route layer.
export type _SupabaseClient = SupabaseClient;

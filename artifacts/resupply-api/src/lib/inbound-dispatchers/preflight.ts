// Pre-flight orchestrator for inbound referrals.
//
// Runs a fixed set of checks against a referral row and writes one
// inbound_referral_preflight_checks row per check. The worker
// (worker/jobs/inbound-referral-preflight.ts) drives this for new
// referrals; the admin route POST /admin/inbound-referrals/:id/run-preflight
// re-runs it on demand.
//
// What we check
// -------------
// 1. pa_requirement       — look up the payer (fuzzy on display_name)
//                           and emit `requires_pa: true|false`. Also
//                           emits `pas_endpoint_available` when the
//                           payer has a DaVinci PAS URL set so the
//                           accept flow can fast-track.
// 2. eligibility          — for the matched patient's most recent
//                           insurance_coverage whose payer_name fuzzy-
//                           matches the referral payer, call
//                           verifyEligibility() and report active/
//                           inactive / error / skipped.
// 3. docs_gap             — inspect inbound_referral_documents for
//                           prescription / face_to_face / sleep_study.
//                           Emit which kinds are missing.
// 4. physician_fax_queued — when docs_gap finds missing F2F AND the
//                           matched provider has a fax_e164, enqueue
//                           a physician_fax_outreach row. Otherwise
//                           skipped.
//
// The orchestrator is idempotent-ish: it always writes new rows
// (never updates). The CSR sees the history of every check; the
// preflight_completed_at stamp on the referral marks "we ran the
// full pass."
//
// PHI posture: outcomes embed patient_id / coverage_id (PHI-adjacent
// FKs). Logger emits referral id + check_kind + outcome_status only,
// never the patient FK or payer-name string.

import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { verifyEligibility } from "../billing/eligibility-verifier";
import { logger } from "../logger";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;
type ReferralRow =
  Database["resupply"]["Tables"]["inbound_referral_orders"]["Row"];

export type PreflightCheckKind =
  | "pa_requirement"
  | "eligibility"
  | "docs_gap"
  | "physician_fax_queued"
  | "pas_endpoint_available";

export type PreflightOutcomeStatus =
  | "info"
  | "ok"
  | "warn"
  | "error"
  | "skipped";

export interface PreflightRunOutcome {
  referralId: string;
  checks: Array<{
    kind: PreflightCheckKind;
    status: PreflightOutcomeStatus;
  }>;
}

interface RunInput {
  referralId: string;
  /** 'system:cron:preflight' or an admin email. */
  ranBy: string;
}

export async function runReferralPreflight(
  input: RunInput,
): Promise<PreflightRunOutcome> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: referral } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .select(
      "id, patient_match_id, provider_match_id, payer_name, hcpcs_items_json, ordering_npi, triage_status",
    )
    .eq("id", input.referralId)
    .limit(1)
    .maybeSingle();

  if (!referral) {
    throw new Error(`inbound referral ${input.referralId} not found`);
  }

  const checks: PreflightRunOutcome["checks"] = [];

  // 1+5. PA requirement + PAS endpoint availability
  const paOutcome = await checkPaRequirement(supabase, referral, input.ranBy);
  checks.push({ kind: "pa_requirement", status: paOutcome.status });
  if (paOutcome.pasEndpointAvailable) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "pas_endpoint_available",
      outcomeStatus: "info",
      outcomeJson: {
        payer_profile_id: paOutcome.payerProfileId,
        payer_slug: paOutcome.payerSlug,
        pas_endpoint_url_set: true,
      },
      ranBy: input.ranBy,
    });
    checks.push({ kind: "pas_endpoint_available", status: "info" });
  }

  // 2. Eligibility
  const eligOutcome = await checkEligibility(supabase, referral, input.ranBy);
  checks.push({ kind: "eligibility", status: eligOutcome.status });

  // 3+4. Docs gap + physician fax fallback
  const docsOutcome = await checkDocsGap(supabase, referral, input.ranBy);
  checks.push({ kind: "docs_gap", status: docsOutcome.status });
  if (docsOutcome.physicianFaxOutcome) {
    checks.push({
      kind: "physician_fax_queued",
      status: docsOutcome.physicianFaxOutcome,
    });
  }

  // Stamp the referral so the queue can show "preflight done".
  const { error: stampError } = await supabase
    .schema("resupply")
    .from("inbound_referral_orders")
    .update({
      preflight_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", referral.id);
  if (stampError) {
    logger.warn(
      {
        referral_id: referral.id,
        err_code: stampError.code,
      },
      "inbound_referral.preflight.stamp_failed",
    );
    throw stampError;
  }

  logger.info(
    {
      referral_id: referral.id,
      kinds: checks.map((c) => `${c.kind}:${c.status}`),
    },
    "inbound_referral.preflight.completed",
  );

  return { referralId: referral.id, checks };
}

// ────────────────────────────────────────────────────────────────────
// Check 1: PA requirement (+ PAS endpoint availability as a sidecar)
// ────────────────────────────────────────────────────────────────────

interface PaCheckOutcome {
  status: PreflightOutcomeStatus;
  pasEndpointAvailable: boolean;
  payerProfileId: string | null;
  payerSlug: string | null;
}

async function checkPaRequirement(
  supabase: SupabaseClient,
  referral: Pick<ReferralRow, "id" | "payer_name" | "hcpcs_items_json">,
  ranBy: string,
): Promise<PaCheckOutcome> {
  if (!referral.payer_name || referral.payer_name.trim().length === 0) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "pa_requirement",
      outcomeStatus: "warn",
      outcomeJson: { reason: "no_payer_name_in_referral" },
      ranBy,
    });
    return {
      status: "warn",
      pasEndpointAvailable: false,
      payerProfileId: null,
      payerSlug: null,
    };
  }

  // Fuzzy match on display_name first (Parachute often presents the
  // CSR-facing name); on miss, try payer_legal_name. ILIKE with a
  // %-wrapped query catches "Highmark" → "Highmark Blue Cross Blue
  // Shield (Western PA)".
  const term = `%${referral.payer_name.trim()}%`;
  const { data: byDisplay } = await supabase
    .schema("resupply")
    .from("payer_profiles")
    .select(
      "id, slug, display_name, payer_legal_name, requires_prior_auth_dme, davinci_pas_endpoint_url, is_active",
    )
    .ilike("display_name", term)
    .eq("is_active", true)
    .limit(2);

  let candidates = byDisplay ?? [];
  if (candidates.length === 0) {
    const { data: byLegal } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, slug, display_name, payer_legal_name, requires_prior_auth_dme, davinci_pas_endpoint_url, is_active",
      )
      .ilike("payer_legal_name", term)
      .eq("is_active", true)
      .limit(2);
    candidates = byLegal ?? [];
  }

  // Multi-match is ambiguous → don't pick; flag for CSR.
  if (candidates.length !== 1) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "pa_requirement",
      outcomeStatus: "warn",
      outcomeJson: {
        reason:
          candidates.length === 0
            ? "no_payer_match"
            : "ambiguous_payer_match",
        searched: referral.payer_name,
        candidate_count: candidates.length,
        candidate_slugs: candidates.map((c) => c.slug),
      },
      ranBy,
    });
    return {
      status: "warn",
      pasEndpointAvailable: false,
      payerProfileId: null,
      payerSlug: null,
    };
  }

  const payer = candidates[0]!;
  const requiresPa = payer.requires_prior_auth_dme === true;
  await recordCheck(supabase, {
    referralId: referral.id,
    checkKind: "pa_requirement",
    outcomeStatus: requiresPa ? "warn" : "ok",
    outcomeJson: {
      payer_profile_id: payer.id,
      payer_slug: payer.slug,
      matched_display_name: payer.display_name,
      requires_pa: requiresPa,
      hcpcs_codes: extractHcpcsCodes(referral.hcpcs_items_json),
    },
    ranBy,
  });
  return {
    status: requiresPa ? "warn" : "ok",
    pasEndpointAvailable:
      typeof payer.davinci_pas_endpoint_url === "string" &&
      payer.davinci_pas_endpoint_url.length > 0,
    payerProfileId: payer.id,
    payerSlug: payer.slug,
  };
}

// ────────────────────────────────────────────────────────────────────
// Check 2: Eligibility (270/271)
// ────────────────────────────────────────────────────────────────────

async function checkEligibility(
  supabase: SupabaseClient,
  referral: Pick<
    ReferralRow,
    "id" | "patient_match_id" | "payer_name" | "hcpcs_items_json"
  >,
  ranBy: string,
): Promise<{ status: PreflightOutcomeStatus }> {
  if (!referral.patient_match_id) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "eligibility",
      outcomeStatus: "skipped",
      outcomeJson: { reason: "no_patient_match" },
      ranBy,
    });
    return { status: "skipped" };
  }

  // Find the patient's most recent active insurance coverage that
  // fuzzy-matches the referral payer name. ILIKE is good enough for
  // a hint — full payer-resolution happens at accept time.
  let coverageQuery = supabase
    .schema("resupply")
    .from("insurance_coverages")
    .select("id, payer_name, member_id")
    .eq("patient_id", referral.patient_match_id)
    .order("created_at", { ascending: false })
    .limit(5);
  if (referral.payer_name) {
    coverageQuery = coverageQuery.ilike(
      "payer_name",
      `%${referral.payer_name.trim()}%`,
    );
  }
  const { data: coverages } = await coverageQuery;

  if (!coverages || coverages.length === 0) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "eligibility",
      outcomeStatus: "skipped",
      outcomeJson: { reason: "no_matching_coverage_for_payer" },
      ranBy,
    });
    return { status: "skipped" };
  }

  const coverage = coverages[0]!;
  const hcpcs = extractHcpcsCodes(referral.hcpcs_items_json);
  try {
    const result = await verifyEligibility({
      insuranceCoverageId: coverage.id,
      patientId: referral.patient_match_id,
      hcpcsCode: hcpcs[0],
      requestedByEmail: ranBy,
    });
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "eligibility",
      outcomeStatus: result.uploadOk ? "ok" : "warn",
      outcomeJson: {
        coverage_id: coverage.id,
        eligibility_check_id: result.eligibilityCheckId,
        upload_ok: result.uploadOk,
        trace_reference: result.traceReference,
        hcpcs_code: hcpcs[0] ?? null,
      },
      ranBy,
    });
    return { status: result.uploadOk ? "ok" : "warn" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.info(
      { referral_id: referral.id, reason: "eligibility_verify_failed" },
      "inbound_referral.preflight.eligibility_failed",
    );
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "eligibility",
      outcomeStatus: "error",
      outcomeJson: {
        coverage_id: coverage.id,
        error_message: message.slice(0, 500),
      },
      ranBy,
    });
    return { status: "error" };
  }
}

// ────────────────────────────────────────────────────────────────────
// Check 3+4: Docs gap (+ physician fax fallback when applicable)
// ────────────────────────────────────────────────────────────────────

/** Doc kinds we treat as clinically required for new-PAP / refill. */
const REQUIRED_DOC_KINDS = ["prescription", "face_to_face", "sleep_study"];

async function checkDocsGap(
  supabase: SupabaseClient,
  referral: Pick<ReferralRow, "id" | "patient_match_id" | "provider_match_id">,
  ranBy: string,
): Promise<{
  status: PreflightOutcomeStatus;
  physicianFaxOutcome: PreflightOutcomeStatus | null;
}> {
  const { data: docs } = await supabase
    .schema("resupply")
    .from("inbound_referral_documents")
    .select("doc_kind")
    .eq("referral_id", referral.id);

  const presentKinds = new Set((docs ?? []).map((d) => d.doc_kind));
  const missing = REQUIRED_DOC_KINDS.filter((k) => !presentKinds.has(k));

  if (missing.length === 0) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "docs_gap",
      outcomeStatus: "ok",
      outcomeJson: { missing: [], present: [...presentKinds] },
      ranBy,
    });
    return { status: "ok", physicianFaxOutcome: null };
  }

  await recordCheck(supabase, {
    referralId: referral.id,
    checkKind: "docs_gap",
    outcomeStatus: "warn",
    outcomeJson: { missing, present: [...presentKinds] },
    ranBy,
  });

  // Try the physician-fax fallback only when face_to_face is missing.
  let physicianFaxOutcome: PreflightOutcomeStatus | null = null;
  if (missing.includes("face_to_face")) {
    physicianFaxOutcome = await tryEnqueuePhysicianFax(
      supabase,
      referral,
      missing,
      ranBy,
    );
  }
  return { status: "warn", physicianFaxOutcome };
}

async function tryEnqueuePhysicianFax(
  supabase: SupabaseClient,
  referral: Pick<ReferralRow, "id" | "patient_match_id" | "provider_match_id">,
  missing: string[],
  ranBy: string,
): Promise<PreflightOutcomeStatus | null> {
  if (!referral.patient_match_id || !referral.provider_match_id) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "physician_fax_queued",
      outcomeStatus: "skipped",
      outcomeJson: {
        reason: !referral.patient_match_id
          ? "no_patient_match"
          : "no_provider_match",
      },
      ranBy,
    });
    return "skipped";
  }

  const { data: provider } = await supabase
    .schema("resupply")
    .from("providers")
    .select("id, legal_name, fax_e164")
    .eq("id", referral.provider_match_id)
    .limit(1)
    .maybeSingle();
  if (!provider || !provider.fax_e164) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "physician_fax_queued",
      outcomeStatus: "skipped",
      outcomeJson: { reason: "provider_has_no_fax" },
      ranBy,
    });
    return "skipped";
  }

  // Cool-down: don't fan out duplicate outreach for the same patient
  // / provider pair within 7 days. The Rx-renewal worker may have
  // already queued one.
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: recent } = await supabase
    .schema("resupply")
    .from("physician_fax_outreach")
    .select("id")
    .eq("patient_id", referral.patient_match_id)
    .eq("physician_fax_e164", provider.fax_e164)
    .gte("created_at", sevenDaysAgo)
    .limit(1)
    .maybeSingle();
  if (recent) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "physician_fax_queued",
      outcomeStatus: "skipped",
      outcomeJson: {
        reason: "recent_outreach_exists",
        existing_outreach_id: recent.id,
      },
      ranBy,
    });
    return "skipped";
  }

  const coverLetter = buildDocsGapCoverLetter({
    physicianName: provider.legal_name,
    missing,
  });
  const { data: inserted, error: insertErr } = await supabase
    .schema("resupply")
    .from("physician_fax_outreach")
    .insert({
      patient_id: referral.patient_match_id,
      physician_name: provider.legal_name,
      physician_fax_e164: provider.fax_e164,
      cover_letter_text: coverLetter,
      status: "pending",
      created_by_email: ranBy,
    })
    .select("id")
    .maybeSingle();
  if (insertErr || !inserted) {
    await recordCheck(supabase, {
      referralId: referral.id,
      checkKind: "physician_fax_queued",
      outcomeStatus: "error",
      outcomeJson: {
        reason: "insert_failed",
        error_code: insertErr?.code ?? null,
      },
      ranBy,
    });
    return "error";
  }

  await recordCheck(supabase, {
    referralId: referral.id,
    checkKind: "physician_fax_queued",
    outcomeStatus: "ok",
    outcomeJson: {
      outreach_id: inserted.id,
      missing_doc_kinds: missing,
    },
    producedRowTable: "physician_fax_outreach",
    producedRowId: inserted.id,
    ranBy,
  });
  return "ok";
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

interface RecordCheckInput {
  referralId: string;
  checkKind: PreflightCheckKind;
  outcomeStatus: PreflightOutcomeStatus;
  outcomeJson: Record<string, unknown>;
  producedRowTable?: string;
  producedRowId?: string;
  ranBy: string;
}

async function recordCheck(
  supabase: SupabaseClient,
  input: RecordCheckInput,
): Promise<void> {
  const { error } = await supabase
    .schema("resupply")
    .from("inbound_referral_preflight_checks")
    .insert({
      referral_id: input.referralId,
      check_kind: input.checkKind,
      outcome_status: input.outcomeStatus,
      outcome_json: input.outcomeJson as unknown as Json,
      produced_row_table: input.producedRowTable ?? null,
      produced_row_id: input.producedRowId ?? null,
      ran_by: input.ranBy,
    });
  if (error) {
    logger.warn(
      {
        referral_id: input.referralId,
        check_kind: input.checkKind,
        err_code: error.code,
      },
      "inbound_referral.preflight.record_check_failed",
    );
    throw error;
  }
}

function extractHcpcsCodes(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  const codes: string[] = [];
  for (const entry of json) {
    if (entry && typeof entry === "object" && "code" in entry) {
      const code = (entry as { code: unknown }).code;
      if (typeof code === "string" && code.length > 0) codes.push(code);
    }
  }
  return codes;
}

function buildDocsGapCoverLetter(input: {
  physicianName: string;
  missing: string[];
}): string {
  const labels: Record<string, string> = {
    prescription: "Prescription (signed Detailed Written Order)",
    face_to_face: "Face-to-face evaluation note",
    sleep_study: "Sleep study report",
  };
  const lines = [
    `Dear ${input.physicianName.trim()},`,
    "",
    "PennFit received an electronic DME order for your patient via our",
    "ePrescribe integration. To complete the order and bill the payer,",
    "we are missing the following clinical documentation:",
    "",
  ];
  for (const kind of input.missing) {
    lines.push(`  - ${labels[kind] ?? kind}`);
  }
  lines.push(
    "",
    "Please reply by fax to this number with the missing documents at",
    "your earliest convenience.",
    "",
    "Thank you,",
    "PennFit Clinical Operations",
  );
  return lines.join("\n");
}

// Dispense-readiness reviewer.
//
// AI-augmented pre-dispense gate. Different from claim-preflight
// (which is the "can I bill this claim?" gate) — this is the
// broader "is everything in place to send the product?" gate.
//
// Runs ~30 deterministic checks across:
//   * Patient identity + demographics + address + phone
//   * Insurance coverage (active, in-network, payer profile linked)
//   * Clinical documentation (sleep study + ICD-10 + qualifying AHI)
//   * Provider (active Rx, NPI, PECOS enrollment for Medicare-like)
//   * Prior authorization (when payer requires, active, covers HCPCS)
//   * Capped rental status (within window, not transferred)
//   * Compliance attestation (for capped rental continuation)
//   * Patient acknowledgments (HIPAA, AOB, ABN when needed,
//     supplier standards)
//   * SWO / DWO presence + expiry
//   * Equipment recall status
//   * DME organization compliance (accreditation, state license,
//     surety bond all current)
//   * Open grievances + compliance alerts (warning only)
//
// Then asks the LLM to synthesize a plain-English summary + a
// structured action plan with specific "how to obtain" guidance
// for every gap.
//
// PHI posture: same as the AI scrubber. Initials + DOB year +
// member-id fingerprint only. The findings array carries label +
// detail text that's safe to log (no patient names, no full IDs).

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export const DISPENSE_PROMPT_VERSION = "dispense-readiness-1.0";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 25_000;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type FindingSeverity = "ok" | "warning" | "error";
export type FindingCategory =
  | "patient_identity"
  | "patient_address"
  | "insurance"
  | "clinical_documentation"
  | "provider"
  | "prior_authorization"
  | "capped_rental"
  | "compliance_attestation"
  | "patient_acknowledgment"
  | "swo_dwo"
  | "equipment_recall"
  | "dme_organization"
  | "open_issues";

export interface ReadinessFinding {
  key: string;
  severity: FindingSeverity;
  category: FindingCategory;
  label: string;
  detail: string;
  /** Optional caller-suggested next action — the AI synthesizer
   *  reads this verbatim when present. */
  fixHint?: string | null;
}

export interface AiActionItem {
  priority: number;
  action: string;
  howToObtain: string;
  ownerRole: "csr" | "patient" | "physician" | "compliance_officer";
  estimatedDays: number | null;
  blocksDispense: boolean;
}

export interface AiSynthesis {
  summary: string;
  actionPlan: AiActionItem[];
  estimatedDaysToReady: number | null;
  confidence: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export interface ReviewInput {
  patientId: string;
  hcpcsCode: string;
  fulfillmentId?: string | null;
  payerProfileId?: string | null;
  insuranceCoverageId?: string | null;
}

export interface ReviewOutput {
  readyToDispense: boolean;
  overallVerdict:
    | "ready"
    | "gaps_with_fixable"
    | "gaps_with_blocking"
    | "errored";
  findings: ReadinessFinding[];
  ai: AiSynthesis;
  counts: {
    total: number;
    passed: number;
    warning: number;
    failed: number;
  };
}

// HCPCS families that always need a PA per most commercial + Medicare DME.
const PA_REQUIRED_HCPCS = new Set([
  "E0601",
  "E0470",
  "E0471",
  "E0562",
  "E1390",
]);

// HCPCS that require sleep study qualifying diagnosis.
const SLEEP_RELATED_HCPCS = new Set([
  "E0601",
  "E0470",
  "E0471",
  "A7030",
  "A7031",
  "A7032",
  "A7033",
  "A7034",
  "A7035",
  "A7036",
  "A7037",
  "A7038",
  "A7039",
  "A4604",
  "A7046",
]);

// HCPCS subject to Medicare capped-rental rules.
const CAPPED_RENTAL_HCPCS = new Set(["E0601", "E0470", "E0471", "E0562"]);

const MEDICARE_LIKE_LOBS = new Set([
  "medicare_part_b",
  "medicare_advantage",
]);

const QUALIFYING_OSA_ICD10 = new Set([
  "G47.33",
  "G47.30",
  "G47.31",
  "G47.36",
  "G47.37",
  "G47.39",
]);

export async function reviewDispenseReadiness(
  input: ReviewInput,
): Promise<ReviewOutput> {
  const supabase = getSupabaseServiceRoleClient();
  const findings = await runDeterministicChecks(supabase, input);
  const counts = countFindings(findings);
  const ai = await synthesizeWithAi(input, findings);
  const overallVerdict = computeVerdict(findings, ai);
  const readyToDispense = overallVerdict === "ready";
  return {
    readyToDispense,
    overallVerdict,
    findings,
    ai,
    counts,
  };
}

// ── Deterministic checks ─────────────────────────────────────────────

async function runDeterministicChecks(
  supabase: SupabaseClient,
  input: ReviewInput,
): Promise<ReadinessFinding[]> {
  const findings: ReadinessFinding[] = [];

  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select(
      "id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address",
    )
    .eq("id", input.patientId)
    .limit(1)
    .maybeSingle();
  if (!patient) {
    findings.push({
      key: "patient_exists",
      severity: "error",
      category: "patient_identity",
      label: "Patient record not found",
      detail: `No patient row for ${input.patientId}.`,
      fixHint: "Create the patient row before reviewing readiness.",
    });
    return findings;
  }

  // ── Patient identity + contact ──
  findings.push(
    patient.legal_first_name && patient.legal_last_name
      ? ok("patient_name", "patient_identity", "Patient legal name on file")
      : error(
          "patient_name",
          "patient_identity",
          "Patient legal name missing",
          "Both legal_first_name and legal_last_name are required for claims + DWO/SWO rendering.",
          "Have the patient (or guardian) confirm and CSR enter the legal name.",
        ),
  );
  findings.push(
    patient.date_of_birth
      ? ok("patient_dob", "patient_identity", "Patient DOB on file")
      : error(
          "patient_dob",
          "patient_identity",
          "Patient DOB missing",
          "DOB is required by every payer's eligibility check.",
          "Capture DOB at intake; verify against photo ID for accuracy.",
        ),
  );
  findings.push(
    patient.phone_e164
      ? ok("patient_phone", "patient_identity", "Patient phone on file")
      : warning(
          "patient_phone",
          "patient_identity",
          "Patient phone missing",
          "Phone is needed for SMS reminders, delivery confirmation, and the AI inbound IVR caller-id flow.",
          "Ask patient at next contact; record E.164 form.",
        ),
  );
  findings.push(
    patient.email
      ? ok("patient_email", "patient_identity", "Patient email on file")
      : warning(
          "patient_email",
          "patient_identity",
          "Patient email missing",
          "Email is needed for portal access, billing statements, EOB explainers.",
          "Ask patient at next contact.",
        ),
  );
  const addr = patient.address as
    | {
        line1?: string;
        city?: string;
        state?: string;
        zip?: string;
      }
    | null;
  if (
    addr?.line1 &&
    addr.city &&
    addr.state &&
    addr.zip
  ) {
    findings.push(
      ok(
        "patient_address",
        "patient_address",
        "Patient shipping address structured",
      ),
    );
  } else {
    findings.push(
      error(
        "patient_address",
        "patient_address",
        "Patient address incomplete",
        "Shipping address requires line1 + city + state + zip; 5010 claim submission requires the same.",
        "Confirm address with patient; record structured fields in the admin patient editor.",
      ),
    );
  }

  // ── Insurance coverage ──
  const coverageId = input.insuranceCoverageId ?? null;
  type Coverage = {
    id: string;
    rank: "primary" | "secondary" | "tertiary";
    payer_name: string;
    member_id: string;
    in_network: boolean | null;
    effective_date: string | null;
    termination_date: string | null;
  };
  const coverage: Coverage | null = await (async () => {
    if (coverageId) {
      const { data } = await supabase
        .schema("resupply")
        .from("insurance_coverages")
        .select(
          "id, rank, payer_name, member_id, in_network, effective_date, termination_date",
        )
        .eq("id", coverageId)
        .limit(1)
        .maybeSingle();
      return data ?? null;
    }
    const { data } = await supabase
      .schema("resupply")
      .from("insurance_coverages")
      .select(
        "id, rank, payer_name, member_id, in_network, effective_date, termination_date",
      )
      .eq("patient_id", input.patientId)
      .eq("rank", "primary")
      .limit(1)
      .maybeSingle();
    return data ?? null;
  })();
  if (!coverage) {
    findings.push(
      error(
        "insurance_coverage",
        "insurance",
        "No primary insurance coverage on file",
        "Cannot bill without a coverage row.",
        "Capture insurance card image at intake, enter member ID + payer.",
      ),
    );
  } else {
    findings.push(
      ok(
        "insurance_coverage",
        "insurance",
        `Insurance coverage on file (${coverage.payer_name})`,
      ),
    );
    const today = new Date().toISOString().slice(0, 10);
    if (
      coverage.termination_date &&
      coverage.termination_date < today
    ) {
      findings.push(
        error(
          "insurance_coverage_active",
          "insurance",
          "Insurance terminated before today",
          `Coverage termination date ${coverage.termination_date}.`,
          "Re-verify eligibility via 270/271; ask patient for updated card if applicable.",
        ),
      );
    } else {
      findings.push(
        ok(
          "insurance_coverage_active",
          "insurance",
          "Insurance coverage active for today",
        ),
      );
    }
    if (coverage.in_network === false) {
      findings.push(
        warning(
          "insurance_in_network",
          "insurance",
          "Coverage is out-of-network",
          "We can bill but reimbursement will be lower; the patient may have a higher responsibility.",
          "Confirm patient's awareness; consider sending an Advance Beneficiary Notice (ABN).",
        ),
      );
    }
  }

  // ── Payer profile + electronic billability ──
  let payerProfileId = input.payerProfileId ?? null;
  if (!payerProfileId && coverage) {
    const { data: matched } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("id")
      .ilike("display_name", coverage.payer_name)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    payerProfileId = matched?.id ?? null;
  }
  type PayerProfile = {
    id: string;
    display_name: string;
    line_of_business: string;
    paper_only: boolean;
    office_ally_payer_id: string | null;
    requires_prior_auth_dme: boolean;
  };
  let payer: PayerProfile | null = null;
  if (payerProfileId) {
    const { data } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select(
        "id, display_name, line_of_business, paper_only, office_ally_payer_id, requires_prior_auth_dme",
      )
      .eq("id", payerProfileId)
      .limit(1)
      .maybeSingle();
    payer = data ?? null;
  }
  if (!payer) {
    findings.push(
      error(
        "payer_profile",
        "insurance",
        "Payer profile not linked",
        "Coverage payer name doesn't match any active row in payer_profiles. Cannot route 837P without it.",
        "Confirm coverage payer; if a new payer, add a payer_profiles row from the admin catalog.",
      ),
    );
  } else if (payer.paper_only) {
    findings.push(
      warning(
        "payer_profile",
        "insurance",
        `${payer.display_name} is paper-only`,
        "Cannot submit electronic 837P; we'll render a HCFA-1500 instead.",
        "Confirm fax/mail address for the payer + use the HCFA route after dispense.",
      ),
    );
  } else if (!payer.office_ally_payer_id) {
    findings.push(
      error(
        "payer_profile_electronic",
        "insurance",
        `${payer.display_name} has no Office Ally payer id`,
        "Cannot submit 837P without it.",
        "Look up the Office Ally payer id and update the payer_profiles row.",
      ),
    );
  } else {
    findings.push(
      ok(
        "payer_profile_electronic",
        "insurance",
        `${payer.display_name} electronic + linked`,
      ),
    );
  }
  const isMedicareLike =
    payer !== null && MEDICARE_LIKE_LOBS.has(payer.line_of_business);

  // ── Clinical: sleep study + qualifying diagnosis ──
  if (SLEEP_RELATED_HCPCS.has(input.hcpcsCode)) {
    const { data: study } = await supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("id, study_date, study_type, ahi, diagnosis_icd10")
      .eq("patient_id", input.patientId)
      .order("study_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!study) {
      findings.push(
        error(
          "sleep_study",
          "clinical_documentation",
          "No sleep study on file",
          `${input.hcpcsCode} is a sleep-therapy HCPCS; payer requires a qualifying study.`,
          "Coordinate a PSG or HSAT via the patient's physician; once results arrive, attach via /admin/patients/:id/sleep-studies.",
        ),
      );
    } else {
      findings.push(
        ok(
          "sleep_study",
          "clinical_documentation",
          `Sleep study on file (${study.study_date}, ${study.study_type})`,
        ),
      );
      if (!study.diagnosis_icd10) {
        findings.push(
          error(
            "sleep_study_diagnosis",
            "clinical_documentation",
            "Sleep study has no ICD-10 diagnosis",
            "Payers require a qualifying diagnosis (typically G47.33 for OSA).",
            "Use the AI ICD-10 suggester (/suggest-icd10) for an auto-pick from the LCD L33718 allowlist, or have the interpreting physician confirm the code.",
          ),
        );
      } else if (!QUALIFYING_OSA_ICD10.has(study.diagnosis_icd10)) {
        findings.push(
          warning(
            "sleep_study_diagnosis",
            "clinical_documentation",
            `Sleep study diagnosis ${study.diagnosis_icd10} may not satisfy LCD L33718`,
            "LCD L33718 typically expects G47.33 (or G47.30/G47.36/G47.37/G47.39).",
            "Confirm with the interpreting physician whether the diagnosis is acceptable for PAP coverage.",
          ),
        );
      } else {
        findings.push(
          ok(
            "sleep_study_diagnosis",
            "clinical_documentation",
            `Qualifying diagnosis ${study.diagnosis_icd10}`,
          ),
        );
      }
      const ahiNum = study.ahi ? Number.parseFloat(study.ahi) : null;
      if (ahiNum !== null && ahiNum < 5) {
        findings.push(
          warning(
            "sleep_study_ahi",
            "clinical_documentation",
            `AHI ${ahiNum} below CMS qualifying threshold (5)`,
            "Patient may not meet CMS PAP-coverage criteria; expect denial.",
            "Send the patient for re-titration or confirm with the prescriber that the symptom set + RDI justifies treatment.",
          ),
        );
      }
    }
  }

  // ── Prescription ──
  const { data: rx } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select(
      "id, hcpcs_code, item_sku, status, valid_from, valid_until, provider_id",
    )
    .eq("patient_id", input.patientId)
    .eq("status", "active")
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!rx) {
    findings.push(
      error(
        "prescription",
        "provider",
        "No active prescription on file",
        "Cannot dispense without an Rx for the HCPCS.",
        "Fax-out request to the prescribing physician via /admin/physician-fax-outreach; once the signed Rx returns, attach via /admin/patients/:id/prescriptions.",
      ),
    );
  } else {
    findings.push(
      ok(
        "prescription",
        "provider",
        `Active prescription on file (${rx.hcpcs_code ?? rx.item_sku})`,
      ),
    );
    if (rx.valid_until && rx.valid_until < new Date().toISOString().slice(0, 10)) {
      findings.push(
        error(
          "prescription_active",
          "provider",
          "Prescription expired",
          `Rx valid_until ${rx.valid_until} is in the past.`,
          "Request renewal via /admin/prescriptions/send-renewal-due.",
        ),
      );
    }
    // Provider NPI + PECOS (for Medicare-like LOBs).
    if (rx.provider_id) {
      const { data: provider } = await supabase
        .schema("resupply")
        .from("providers")
        .select("npi, legal_name")
        .eq("id", rx.provider_id)
        .limit(1)
        .maybeSingle();
      if (!provider) {
        findings.push(
          error(
            "prescription_provider",
            "provider",
            "Prescribing provider row missing",
            "The prescription references a provider_id that no longer exists.",
            "Re-attach the correct provider via the prescription edit surface.",
          ),
        );
      } else if (!/^\d{10}$/.test(provider.npi)) {
        findings.push(
          error(
            "prescription_provider_npi",
            "provider",
            "Prescribing provider NPI invalid",
            `NPI '${provider.npi}' is not 10 digits.`,
            "Re-verify NPI via the NPPES lookup endpoint on /admin/providers.",
          ),
        );
      } else if (isMedicareLike) {
        const { data: pecos } = await supabase
          .schema("resupply")
          .from("providers_pecos_status")
          .select("enrollment_status")
          .eq("npi", provider.npi)
          .limit(1)
          .maybeSingle();
        if (!pecos || pecos.enrollment_status !== "approved") {
          findings.push(
            error(
              "prescription_provider_pecos",
              "provider",
              "Prescribing provider not PECOS-approved",
              `Medicare requires the ordering physician to be PECOS-approved. Current status: ${pecos?.enrollment_status ?? "unknown"}.`,
              "Trigger /admin/providers-pecos/sync-now; if still not approved, contact the prescriber for an alternate.",
            ),
          );
        } else {
          findings.push(
            ok(
              "prescription_provider_pecos",
              "provider",
              "Prescribing provider PECOS-approved",
            ),
          );
        }
      }
    } else {
      findings.push(
        error(
          "prescription_provider",
          "provider",
          "Prescription has no prescribing provider",
          "Required for the 2310D loop on 837P and for PA submission.",
          "Edit the prescription to attach the provider from /admin/providers.",
        ),
      );
    }
  }

  // ── Prior authorization ──
  const requiresPa =
    payer?.requires_prior_auth_dme &&
    PA_REQUIRED_HCPCS.has(input.hcpcsCode);
  if (requiresPa) {
    const { data: pa } = await supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select("auth_number, status, approved_through, hcpcs_code")
      .eq("patient_id", input.patientId)
      .eq("hcpcs_code", input.hcpcsCode)
      .order("approved_through", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!pa || pa.status !== "approved") {
      findings.push(
        error(
          "prior_authorization",
          "prior_authorization",
          `${payer?.display_name ?? "Payer"} requires PA for ${input.hcpcsCode}`,
          "No approved PA on file.",
          "Submit a PA via /admin/patients/:id/prior-authorizations or, if the payer supports it, the Da Vinci PAS endpoint at /submit-davinci-pas.",
        ),
      );
    } else {
      findings.push(
        ok(
          "prior_authorization",
          "prior_authorization",
          `PA approved (auth #${pa.auth_number ?? "(pending)"})`,
        ),
      );
      const today = new Date().toISOString().slice(0, 10);
      if (
        pa.approved_through &&
        pa.approved_through < today
      ) {
        findings.push(
          error(
            "prior_authorization_active",
            "prior_authorization",
            "PA expired",
            `PA approved_through ${pa.approved_through} is in the past.`,
            "File a renewal PA via /admin/patients/:id/prior-authorizations.",
          ),
        );
      }
    }
  }

  // ── Capped rental status ──
  if (CAPPED_RENTAL_HCPCS.has(input.hcpcsCode)) {
    const { data: cycle } = await supabase
      .schema("resupply")
      .from("capped_rental_cycles")
      .select("id, status, current_month, max_months")
      .eq("patient_id", input.patientId)
      .eq("hcpcs_code", input.hcpcsCode)
      .in("status", ["active", "paused"])
      .limit(1)
      .maybeSingle();
    if (cycle) {
      if (cycle.status === "paused") {
        findings.push(
          warning(
            "capped_rental_status",
            "capped_rental",
            "Capped rental cycle is paused",
            "We will not auto-advance this month.",
            "Confirm with patient whether to resume; PATCH cycle status back to 'active'.",
          ),
        );
      } else if (cycle.current_month >= cycle.max_months) {
        findings.push(
          warning(
            "capped_rental_status",
            "capped_rental",
            "Capped rental at or past max months",
            "Payer expects ownership transfer; further rental billing will deny.",
            "Mark cycle 'transferred' and dispense as patient-owned equipment going forward.",
          ),
        );
      } else {
        findings.push(
          ok(
            "capped_rental_status",
            "capped_rental",
            `Capped rental month ${cycle.current_month} of ${cycle.max_months}`,
          ),
        );
      }
    }
  }

  // ── Compliance attestation (for capped rental continuation) ──
  if (CAPPED_RENTAL_HCPCS.has(input.hcpcsCode)) {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: nights } = await supabase
      .schema("resupply")
      .from("patient_therapy_nights")
      .select("usage_minutes")
      .eq("patient_id", input.patientId)
      .gte("night_date", since)
      .limit(60);
    const compliant = (nights ?? []).filter(
      (n) => (n.usage_minutes ?? 0) >= 240,
    ).length;
    if (compliant >= 21) {
      findings.push(
        ok(
          "compliance_attestation",
          "compliance_attestation",
          `Patient compliant (${compliant}/21 nights in last 30 days)`,
        ),
      );
    } else {
      findings.push(
        warning(
          "compliance_attestation",
          "compliance_attestation",
          `Patient not yet 90-day compliant (${compliant}/21 nights >=4h)`,
          "Required for capped-rental continuation past month 3; surfaces the KX modifier on the claim.",
          "Continue outreach via the existing onboarding-check-ins cron; escalate to coaching_plans if usage remains low.",
        ),
      );
    }
  }

  // ── Patient acknowledgments ──
  const { data: forms } = await supabase
    .schema("resupply")
    .from("patient_form_acknowledgements")
    .select("form_kind, signed_at")
    .eq("patient_id", input.patientId);
  const formMap = new Map<string, string>();
  for (const f of forms ?? []) formMap.set(f.form_kind, f.signed_at);
  for (const [kind, label] of [
    ["hipaa_npp", "HIPAA Notice of Privacy Practices"],
    ["aob", "Assignment of Benefits"],
    ["supplier_standards", "Supplier Standards"],
  ] as const) {
    if (formMap.has(kind)) {
      findings.push(
        ok(
          `form_${kind}`,
          "patient_acknowledgment",
          `${label} on file`,
        ),
      );
    } else {
      findings.push(
        error(
          `form_${kind}`,
          "patient_acknowledgment",
          `${label} acknowledgment missing`,
          `Required by HIPAA / CMS standards before dispense.`,
          `Send the patient the portal sign-and-acknowledge link via /admin/patients/:id/portal-invite; CSR can also paper-scan via /admin/form-acknowledgements.`,
        ),
      );
    }
  }

  // ── Equipment recall check ──
  const { data: assets } = await supabase
    .schema("resupply")
    .from("equipment_assets")
    .select("id, status, recall_id, serial_number")
    .eq("patient_id", input.patientId)
    .eq("status", "recalled");
  if ((assets ?? []).length > 0) {
    findings.push(
      warning(
        "equipment_recall",
        "equipment_recall",
        `Patient has ${assets!.length} device(s) flagged as recalled`,
        "Confirm the new dispense isn't replacing a recalled device that needs a remediation form first.",
        "Open the recall queue at /admin/equipment-recalls and complete the remediation action before dispense.",
      ),
    );
  } else {
    findings.push(
      ok(
        "equipment_recall",
        "equipment_recall",
        "No recalled devices on file",
      ),
    );
  }

  // ── DME organization compliance (license / accreditation / bond) ──
  const { data: org } = await supabase
    .schema("resupply")
    .from("dme_organization")
    .select(
      "accreditation_expires_on, state_license_expires_on, surety_bond_expires_on",
    )
    .eq("singleton", true)
    .limit(1)
    .maybeSingle();
  if (org) {
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, label, date] of [
      [
        "dme_accreditation",
        "DME accreditation",
        org.accreditation_expires_on,
      ],
      [
        "dme_state_license",
        "DME state license",
        org.state_license_expires_on,
      ],
      [
        "dme_surety_bond",
        "DMEPOS surety bond",
        org.surety_bond_expires_on,
      ],
    ] as const) {
      if (!date) {
        findings.push(
          warning(
            key,
            "dme_organization",
            `${label} expiry not on file`,
            "Required by surveyors + DMEPOS supplier standards.",
            "Populate the dme_organization expiry date.",
          ),
        );
      } else if (date < today) {
        findings.push(
          error(
            key,
            "dme_organization",
            `${label} EXPIRED on ${date}`,
            "Cannot legally dispense without active credentials.",
            "Renew immediately; do not dispense until updated.",
          ),
        );
      } else {
        findings.push(
          ok(key, "dme_organization", `${label} valid through ${date}`),
        );
      }
    }
  }

  // ── Open issues (warnings only) ──
  const { count: openGrievances } = await supabase
    .schema("resupply")
    .from("patient_grievances")
    .select("id", { count: "exact", head: true })
    .eq("patient_id", input.patientId)
    .neq("status", "resolved");
  if ((openGrievances ?? 0) > 0) {
    findings.push(
      warning(
        "patient_grievances",
        "open_issues",
        `${openGrievances} open grievance(s) on file`,
        "Acknowledge + resolve before dispense if material to the product.",
        "Open the grievance queue at /admin/grievances.",
      ),
    );
  }
  const { count: openAlerts } = await supabase
    .schema("resupply")
    .from("csr_compliance_alerts")
    .select("id", { count: "exact", head: true })
    .eq("patient_id", input.patientId)
    .eq("status", "open");
  if ((openAlerts ?? 0) > 0) {
    findings.push(
      warning(
        "patient_alerts",
        "open_issues",
        `${openAlerts} open CSR compliance alert(s)`,
        "Review before dispense — may indicate prior denials or compliance gaps.",
        "Open the CSR queue at /admin/csr-compliance-alerts.",
      ),
    );
  }

  return findings;
}

function countFindings(findings: ReadinessFinding[]) {
  return {
    total: findings.length,
    passed: findings.filter((f) => f.severity === "ok").length,
    warning: findings.filter((f) => f.severity === "warning").length,
    failed: findings.filter((f) => f.severity === "error").length,
  };
}

function computeVerdict(
  findings: ReadinessFinding[],
  ai: AiSynthesis,
): ReviewOutput["overallVerdict"] {
  if (ai.errorMessage && ai.summary === "") return "errored";
  const errorCount = findings.filter((f) => f.severity === "error").length;
  if (errorCount === 0) return "ready";
  // If there are errors but every error has an actionable fix hint
  // present, classify as fixable. Errors with no hint or with
  // open-ended remediation paths (e.g. patient needs a new sleep
  // study, prescriber unreachable) are blocking.
  const blockingHints = [
    "Refer back",
    "Re-titration",
    "Re-verify",
    "Renew immediately",
  ];
  const blockingErrors = findings.filter(
    (f) =>
      f.severity === "error" &&
      (!f.fixHint ||
        blockingHints.some((b) => f.fixHint?.includes(b))),
  );
  return blockingErrors.length > 0
    ? "gaps_with_blocking"
    : "gaps_with_fixable";
}

// ── Small helpers ────────────────────────────────────────────────────

function ok(
  key: string,
  category: FindingCategory,
  label: string,
  detail?: string,
): ReadinessFinding {
  return {
    key,
    category,
    severity: "ok",
    label,
    detail: detail ?? "",
  };
}
function warning(
  key: string,
  category: FindingCategory,
  label: string,
  detail: string,
  fixHint?: string,
): ReadinessFinding {
  return {
    key,
    category,
    severity: "warning",
    label,
    detail,
    fixHint: fixHint ?? null,
  };
}
function error(
  key: string,
  category: FindingCategory,
  label: string,
  detail: string,
  fixHint?: string,
): ReadinessFinding {
  return {
    key,
    category,
    severity: "error",
    label,
    detail,
    fixHint: fixHint ?? null,
  };
}

// ── AI synthesizer ──────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are a HIPAA-compliant DME dispense-readiness reviewer. Given",
  "the structured findings from a deterministic check engine, write",
  "a plain-English executive summary + a prioritised action plan",
  "the CSR can work through.",
  "",
  "RULES:",
  "- Use plain English. No jargon. Patients and CSRs both read this.",
  "- Cite specific findings by key.",
  "- The action plan should be ordered by impact + urgency.",
  "- For each action, name the owner role: csr | patient | physician |",
  "  compliance_officer.",
  "- For each action, write a specific 'how to obtain' that names",
  "  the route, the form, or the upstream party. Cite our routes",
  "  by path (e.g. /admin/physician-fax-outreach) when relevant.",
  "- Estimate days_to_obtain conservatively (1-14 days typical).",
  "- Mark blocks_dispense=true when the gap is on the critical path",
  "  (no Rx, expired insurance, no PA when required, expired",
  "  state license).",
  "- Estimate estimated_days_to_ready = max of the blocking",
  "  estimated_days. Null when no gaps.",
  "",
  "NEVER include patient name, full DOB, address, or any PHI in any",
  "string. Reference the patient as 'the patient'.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object:",
  "{",
  '  "summary": "<one paragraph>",',
  '  "confidence": <0..1>,',
  '  "estimated_days_to_ready": <int or null>,',
  '  "action_plan": [',
  "    {",
  '      "priority": <1..N>,',
  '      "action": "<what to do>",',
  '      "how_to_obtain": "<concrete steps>",',
  '      "owner_role": "csr" | "patient" | "physician" | "compliance_officer",',
  '      "estimated_days": <int or null>,',
  '      "blocks_dispense": <bool>',
  "    }",
  "  ]",
  "}",
].join("\n");

async function synthesizeWithAi(
  input: ReviewInput,
  findings: ReadinessFinding[],
): Promise<AiSynthesis> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      summary:
        "AI synthesis unavailable — OPENAI_API_KEY not configured. " +
        "See the deterministic findings below for the gap list.",
      actionPlan: deriveFallbackActionPlan(findings),
      estimatedDaysToReady: null,
      confidence: null,
      latencyMs: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: "OPENAI_API_KEY not configured",
    };
  }
  const ctx = {
    hcpcsCode: input.hcpcsCode,
    findings: findings.map((f) => ({
      key: f.key,
      severity: f.severity,
      category: f.category,
      label: f.label,
      detail: f.detail,
      fixHint: f.fixHint ?? null,
    })),
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(ctx, null, 2) },
        ],
      }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        "dispense-readiness: openai HTTP error",
      );
      return {
        summary: "",
        actionPlan: deriveFallbackActionPlan(findings),
        estimatedDaysToReady: null,
        confidence: null,
        latencyMs,
        promptTokens: null,
        completionTokens: null,
        errorMessage: `openai http ${res.status}`,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseAiOutput(content);
    return {
      ...parsed,
      latencyMs,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return {
      summary: "",
      actionPlan: deriveFallbackActionPlan(findings),
      estimatedDaysToReady: null,
      confidence: null,
      latencyMs: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseAiOutput(content: string): Omit<
  AiSynthesis,
  "latencyMs" | "promptTokens" | "completionTokens" | "errorMessage"
> {
  try {
    const parsed = JSON.parse(content) as {
      summary?: unknown;
      confidence?: unknown;
      estimated_days_to_ready?: unknown;
      action_plan?: unknown;
    };
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.slice(0, 4000) : "";
    const confidence =
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null;
    const estimatedDays =
      typeof parsed.estimated_days_to_ready === "number" &&
      Number.isInteger(parsed.estimated_days_to_ready) &&
      parsed.estimated_days_to_ready >= 0
        ? parsed.estimated_days_to_ready
        : null;
    const actionPlan: AiActionItem[] = Array.isArray(parsed.action_plan)
      ? parsed.action_plan.flatMap((a) => parseAction(a))
      : [];
    return {
      summary,
      actionPlan,
      estimatedDaysToReady: estimatedDays,
      confidence,
    };
  } catch {
    return {
      summary: "Model returned malformed JSON; see deterministic findings.",
      actionPlan: [],
      estimatedDaysToReady: null,
      confidence: null,
    };
  }
}

function parseAction(raw: unknown): AiActionItem[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as {
    priority?: unknown;
    action?: unknown;
    how_to_obtain?: unknown;
    owner_role?: unknown;
    estimated_days?: unknown;
    blocks_dispense?: unknown;
  };
  const action = typeof r.action === "string" ? r.action.slice(0, 500) : "";
  if (!action) return [];
  return [
    {
      priority:
        typeof r.priority === "number" && Number.isFinite(r.priority)
          ? Math.max(1, Math.floor(r.priority))
          : 99,
      action,
      howToObtain:
        typeof r.how_to_obtain === "string"
          ? r.how_to_obtain.slice(0, 1000)
          : "",
      ownerRole:
        r.owner_role === "patient" ||
        r.owner_role === "physician" ||
        r.owner_role === "compliance_officer"
          ? r.owner_role
          : "csr",
      estimatedDays:
        typeof r.estimated_days === "number" &&
        Number.isInteger(r.estimated_days) &&
        r.estimated_days >= 0
          ? r.estimated_days
          : null,
      blocksDispense:
        typeof r.blocks_dispense === "boolean" ? r.blocks_dispense : false,
    },
  ];
}

function deriveFallbackActionPlan(
  findings: ReadinessFinding[],
): AiActionItem[] {
  // Used when the LLM isn't available. Build a minimal plan from
  // the error-severity findings + their fix hints.
  return findings
    .filter((f) => f.severity === "error" && f.fixHint)
    .map((f, idx) => ({
      priority: idx + 1,
      action: f.label,
      howToObtain: f.fixHint ?? "",
      ownerRole: ownerRoleForCategory(f.category),
      estimatedDays: null,
      blocksDispense: true,
    }));
}

function ownerRoleForCategory(
  category: FindingCategory,
): AiActionItem["ownerRole"] {
  switch (category) {
    case "provider":
      return "physician";
    case "patient_acknowledgment":
    case "patient_identity":
    case "patient_address":
      return "patient";
    case "dme_organization":
      return "compliance_officer";
    default:
      return "csr";
  }
}

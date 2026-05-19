// AI claim scrubber — pre-submission review of a draft claim.
//
// The deterministic preflight engine catches *structural* problems
// (missing field, total mismatch, invalid date). The AI scrub catches
// *semantic* problems the rule-based layer can't enumerate:
//
//   * HCPCS / diagnosis mismatch ("E0601 billed for a non-OSA diagnosis")
//   * Modifier-correctness for the payer + rental cycle stage that the
//     payer_modifier_rules table doesn't yet capture
//   * Quantity that exceeds payer / LCD limits
//   * Place-of-service / HCPCS combination errors
//   * Duplicate-of-recent-claim risk
//   * Wrong fee-schedule alignment when a published payer rate is known
//
// Output is structured patches the human (or the auto-apply endpoint)
// can one-click execute. We never round-trip free-form prose into
// the claim row.
//
// PHI posture:
//   The model gets:
//     - patient initials + DOB year only (no full name, full DOB)
//     - the payer profile (display name + LOB + Office Ally id; public)
//     - the HCPCS / modifier / units / billed-cents lines (clinical data, not directly PHI)
//     - the most recent sleep-study DIAGNOSIS code only (ICD-10 string)
//     - the prior-auth presence + number (number is a payer ref, not PHI)
//     - the preflight summary (already-built, PHI-safe)
//   The model does NOT get:
//     - patient legal name
//     - DOB (only year)
//     - patient address
//     - member ID (only a length + last-2-chars fingerprint)
//     - any free-text patient notes
//
// Failure modes:
//   Any error (timeout, HTTP failure, malformed JSON, model says nothing)
//   collapses to a verdict='errored' persisted row with the error
//   message. The route never throws back to the CSR.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { preflightClaim } from "./claim-preflight";
import { aiPatchSchema, parseAiPatches, type AiPatch } from "./ai-patch";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export const SCRUB_PROMPT_VERSION = "scrub-1.0";
export const DEFAULT_SCRUB_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const SYSTEM_PROMPT = [
  "You are a HIPAA-compliant CPAP/DME billing claim scrubber.",
  "Your job is to review a proposed insurance claim against payer and",
  "Medicare DME LCD rules, and identify any issues that would cause the",
  "claim to be rejected at 999 syntactic ack, 277CA claim status, or",
  "later as a CARC/RARC denial.",
  "",
  "RULES YOU CARE ABOUT:",
  "- LCD L33718 governs CPAP coverage. CPAP devices use HCPCS E0601.",
  "  Required ICD-10s: G47.33 (obstructive sleep apnea) is the primary;",
  "  G47.30 / R06.83 / others may be supportive but should not be the",
  "  only diagnosis. Quantity should be 1 per month for a rental.",
  "- Modifiers: RR (rental, all months), KH (month 1-3), KI (month 4-13),",
  "  KX (medical necessity proven; >=21 nights >=4h in any 30-day window),",
  "  NU (purchased outright), GA (ABN signed, expect denial), GZ (no ABN,",
  "  expect denial).",
  "- Resupply HCPCS: cushions A7031/A7032/A7033, masks A7030/A7034,",
  "  headgear A7035, tubing A7037 (std) / A4604 (heated), disposable",
  "  filters A7038 (2/month), reusable filter A7039 (1/6 months),",
  "  humidifier chamber A7046 (1/6 months). All of these need KX once",
  "  the patient is on month 4+ of the rental and compliance is proven.",
  "- Place of service for DME shipped to the patient's home is 12.",
  "- BPAP devices: E0470 (no backup rate) or E0471 (with backup rate).",
  "- Each HCPCS line MUST point to a supportive diagnosis.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object. Schema:",
  "{",
  '  "verdict": "ready" | "fixable" | "blocking",',
  '  "confidence": <0..1 number>,',
  '  "summary": "<one sentence>",',
  '  "findings": [',
  "    {",
  '      "key": "<stable id like hcpcs_diagnosis_mismatch>",',
  '      "severity": "ok" | "warning" | "error",',
  '      "problem": "<what is wrong, max 200 chars>",',
  '      "recommended_fix": "<how to fix it, max 200 chars>"',
  "    }",
  "  ],",
  '  "suggested_patches": [',
  '    // Each entry MUST match one of these shapes:',
  '    { "kind": "set_claim_field", "field": "<one of denial_reason|claim_number|date_of_service|patient_responsibility_cents>", "value": <string|number|null>, "rationale": "<why>" },',
  '    { "kind": "set_line_modifier", "hcpcsCode": "<HCPCS>", "modifierCsv": "<CSV>", "rationale": "<why>" },',
  '    { "kind": "set_line_billed_cents", "hcpcsCode": "<HCPCS>", "billedCents": <int>, "rationale": "<why>" },',
  '    { "kind": "add_diagnosis", "icd10": "<ICD-10>", "rationale": "<why>" },',
  '    { "kind": "add_line", "hcpcsCode": "<HCPCS>", "modifierCsv": "<CSV|null>", "quantity": <int>, "billedCents": <int>, "description": "<text>", "rationale": "<why>" },',
  '    { "kind": "remove_line", "hcpcsCode": "<HCPCS>", "rationale": "<why>" },',
  '    { "kind": "set_prior_auth_number", "authNumber": "<string>", "rationale": "<why>" }',
  "  ]",
  "}",
  "",
  "VERDICTS:",
  "- ready    = no errors AND <=1 warning; safe to submit as-is.",
  "- fixable  = errors exist but suggested_patches make the claim ready.",
  "- blocking = errors exist that require human review / outside data",
  "  (e.g. no sleep study on file).",
  "",
  "NEVER include patient name, full DOB, address, member ID, or any",
  "other PHI in any field. Reference the patient ONLY as 'the patient'.",
  "If the input is insufficient, return verdict='blocking' with a",
  "single finding explaining what's missing.",
].join("\n");

export interface ScrubInput {
  /** UUID. */
  claimId: string;
  /** Override model id for the call. */
  model?: string;
  /** Override OpenAI API key (for tests). */
  apiKey?: string;
  /** Test seam for fetch. */
  fetchImpl?: typeof fetch;
  /** Override timeout for the upstream call. */
  timeoutMs?: number;
}

export interface ScrubOutput {
  verdict: "ready" | "fixable" | "blocking" | "errored";
  summary: string;
  confidence: number | null;
  findings: ScrubFinding[];
  suggestedPatches: AiPatch[];
  droppedPatches: Array<{ index: number; reason: string }>;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export interface ScrubFinding {
  key: string;
  severity: "ok" | "warning" | "error";
  problem: string;
  recommendedFix: string;
}

/**
 * Run an AI scrub against a draft claim. Returns the structured
 * output ready for the route to persist. Never throws — even an
 * OpenAI 500 collapses to `verdict='errored'`.
 */
export async function scrubClaim(input: ScrubInput): Promise<ScrubOutput> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      verdict: "errored",
      summary: "AI scrub unavailable (OPENAI_API_KEY not set).",
      confidence: null,
      findings: [],
      suggestedPatches: [],
      droppedPatches: [],
      latencyMs: null,
      promptTokens: null,
      completionTokens: null,
      errorMessage: "OPENAI_API_KEY not configured",
    };
  }

  const supabase = getSupabaseServiceRoleClient();
  let claimContext;
  try {
    claimContext = await assembleClaimContext(supabase, input.claimId);
  } catch (err) {
    return errored(`context assembly failed: ${errMsg(err)}`);
  }
  if (!claimContext) {
    return errored("claim not found");
  }

  const userPrompt = JSON.stringify(claimContext, null, 2);
  const model = input.model ?? DEFAULT_SCRUB_MODEL;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1500,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        {
          event: "ai_scrub_http_error",
          status: res.status,
          detail: detail.slice(0, 200),
        },
        "ai-scrub: openai HTTP error",
      );
      return errored(`openai http ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseScrubOutput(content);
    return {
      ...parsed,
      latencyMs,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return errored(errMsg(err));
  } finally {
    clearTimeout(timer);
  }
}

function errored(message: string): ScrubOutput {
  return {
    verdict: "errored",
    summary: `AI scrub failed: ${message}`,
    confidence: null,
    findings: [],
    suggestedPatches: [],
    droppedPatches: [],
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    errorMessage: message,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Claim context assembly (PHI-safe) ────────────────────────────────

async function assembleClaimContext(
  supabase: SupabaseClient,
  claimId: string,
): Promise<Record<string, unknown> | null> {
  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, patient_id, payer_name, payer_profile_id, date_of_service, status, total_billed_cents, insurance_coverage_id, fulfillment_id, notes",
    )
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (!claim) return null;

  const [
    { data: patient },
    { data: coverage },
    { data: lines },
    { data: payer },
    { data: sleep },
    { data: pas },
  ] = await Promise.all([
    supabase
      .schema("resupply")
      .from("patients")
      .select("legal_first_name, legal_last_name, date_of_birth")
      .eq("id", claim.patient_id)
      .limit(1)
      .maybeSingle(),
    claim.insurance_coverage_id
      ? supabase
          .schema("resupply")
          .from("insurance_coverages")
          .select("member_id, plan_name, in_network, capped_rental_status")
          .eq("id", claim.insurance_coverage_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select("id, hcpcs_code, modifier, description, quantity, billed_cents")
      .eq("claim_id", claim.id),
    claim.payer_profile_id
      ? supabase
          .schema("resupply")
          .from("payer_profiles")
          .select(
            "display_name, line_of_business, region, requires_prior_auth_dme, claim_format",
          )
          .eq("id", claim.payer_profile_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .schema("resupply")
      .from("sleep_studies")
      .select("diagnosis_icd10, study_date")
      .eq("patient_id", claim.patient_id)
      .not("diagnosis_icd10", "is", null)
      .order("study_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .schema("resupply")
      .from("prior_authorizations")
      .select("auth_number, status, hcpcs_code, approved_through")
      .eq("patient_id", claim.patient_id)
      .eq("status", "approved"),
  ]);

  const preflight = await preflightClaim(claimId);

  return {
    claim: {
      id: claim.id,
      dateOfService: claim.date_of_service,
      payerName: claim.payer_name,
      totalBilledCents: claim.total_billed_cents,
    },
    patient: patient
      ? {
          initials: initials(
            patient.legal_first_name,
            patient.legal_last_name,
          ),
          dobYear: yearOf(patient.date_of_birth),
        }
      : null,
    coverage: coverage
      ? {
          memberIdFingerprint: fingerprint(coverage.member_id),
          planName: coverage.plan_name,
          inNetwork: coverage.in_network,
          cappedRentalStatus: coverage.capped_rental_status,
        }
      : null,
    payerProfile: payer ?? null,
    lines: (lines ?? []).map((l) => ({
      hcpcsCode: l.hcpcs_code,
      modifier: l.modifier,
      description: l.description,
      quantity: l.quantity,
      billedCents: l.billed_cents,
    })),
    diagnoses: sleep?.diagnosis_icd10 ? [sleep.diagnosis_icd10] : [],
    priorAuthorizations: (pas ?? []).map((p) => ({
      authNumber: p.auth_number,
      hcpcs: p.hcpcs_code,
      approvedThrough: p.approved_through,
    })),
    preflight: {
      readyToSubmit: preflight.readyToSubmit,
      errorCount: preflight.errorCount,
      warningCount: preflight.warningCount,
      items: preflight.items.map((i) => ({
        key: i.key,
        severity: i.severity,
        label: i.label,
        detail: i.detail,
      })),
    },
  };
}

function initials(first: string, last: string): string {
  const f = first.trim()[0] ?? "";
  const l = last.trim()[0] ?? "";
  return `${f.toUpperCase()}${l.toUpperCase()}`;
}

function yearOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  return m ? Number(m[1]) : null;
}

function fingerprint(s: string | null | undefined): string | null {
  if (!s) return null;
  // length + last 2 chars — enough for the model to spot "wrong length"
  // patterns (Medicare HICN vs MBI) without exposing the full id.
  const last2 = s.slice(-2);
  return `len=${s.length},end=${last2}`;
}

// ── Output parsing ───────────────────────────────────────────────────

function parseScrubOutput(
  content: string,
): Omit<ScrubOutput, "latencyMs" | "promptTokens" | "completionTokens" | "errorMessage"> {
  try {
    const parsed = JSON.parse(content) as {
      verdict?: unknown;
      confidence?: unknown;
      summary?: unknown;
      findings?: unknown;
      suggested_patches?: unknown;
    };
    const verdict =
      parsed.verdict === "ready" ||
      parsed.verdict === "fixable" ||
      parsed.verdict === "blocking"
        ? parsed.verdict
        : "blocking";
    const confidence =
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null;
    const summary =
      typeof parsed.summary === "string" ? parsed.summary.slice(0, 500) : "";
    const findings: ScrubFinding[] = Array.isArray(parsed.findings)
      ? parsed.findings.flatMap((f) => parseFinding(f))
      : [];
    const { patches, dropped } = parseAiPatches(parsed.suggested_patches);
    return {
      verdict,
      confidence,
      summary,
      findings,
      suggestedPatches: patches,
      droppedPatches: dropped,
    };
  } catch {
    return {
      verdict: "errored",
      confidence: null,
      summary: "Model returned malformed JSON.",
      findings: [],
      suggestedPatches: [],
      droppedPatches: [],
    };
  }
}

function parseFinding(raw: unknown): ScrubFinding[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as {
    key?: unknown;
    severity?: unknown;
    problem?: unknown;
    recommended_fix?: unknown;
    recommendedFix?: unknown;
  };
  const key = typeof r.key === "string" ? r.key.slice(0, 80) : "unknown";
  const severity =
    r.severity === "ok" || r.severity === "warning" || r.severity === "error"
      ? r.severity
      : "warning";
  const problem =
    typeof r.problem === "string" ? r.problem.slice(0, 400) : "";
  const recommendedFix =
    typeof r.recommended_fix === "string"
      ? r.recommended_fix.slice(0, 400)
      : typeof r.recommendedFix === "string"
        ? r.recommendedFix.slice(0, 400)
        : "";
  if (!problem) return [];
  return [{ key, severity, problem, recommendedFix }];
}

// Re-export the patch schema so route tests can sanity-check the
// model's output without re-importing from ai-patch.
export { aiPatchSchema };

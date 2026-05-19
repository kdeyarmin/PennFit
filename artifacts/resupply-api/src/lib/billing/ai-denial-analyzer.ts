// AI denial analyzer — post-denial root-cause + fix-plan.
//
// Triggered after a claim transitions to status='denied' (either by
// the ERA reconciler or a manual PATCH). Given:
//   * the claim + line items
//   * the CARC/RARC codes captured on the line items + claim event
//   * the denial_codes catalog rows for those codes (recommended_action)
//   * the payer profile
//
// Returns:
//   * a root-cause summary (one sentence the CSR sees first)
//   * a structured analysis (mapped codes, fix_steps, appeal sketch)
//   * suggested patches (same contract as the scrubber)
//   * a single recommendation: auto_resubmit | manual_resubmit |
//     appeal | bill_patient | write_off | manual_review
//
// The "auto_resubmit" gate is conservative — the model returns
// can_auto_resubmit=true ONLY when:
//   * all suggested patches are in the safe whitelist (set_line_modifier,
//     set_prior_auth_number, add_diagnosis, set_line_billed_cents),
//   * confidence >= 0.75,
//   * no patch removes a line.
// The route layer enforces these gates again so a hallucinated
// `can_auto_resubmit: true` can NOT push a destructive patch.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { parseAiPatches, type AiPatch } from "./ai-patch";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export const DENIAL_PROMPT_VERSION = "denial-1.0";
export const DEFAULT_DENIAL_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

const RECOMMENDATIONS = [
  "auto_resubmit",
  "manual_resubmit",
  "appeal",
  "bill_patient",
  "write_off",
  "manual_review",
] as const;

const SYSTEM_PROMPT = [
  "You are a HIPAA-compliant CPAP/DME claim-denial analyst.",
  "Your input is a JSON document describing a denied insurance claim:",
  "the claim header, line items, the payer profile, the CARC/RARC",
  "adjustment codes the payer returned (with our catalog's recommended",
  "action for each), and any prior scrub findings.",
  "",
  "Your job is to:",
  "1. Diagnose the root cause in one human-readable sentence.",
  "2. Map each CARC/RARC code to a category + explanation.",
  "3. Recommend a single next action:",
  "   - auto_resubmit  : the denial is mechanical (wrong modifier,",
  "     missing PA number, wrong diagnosis pairing) and patches",
  "     below will fix it without further human input.",
  "   - manual_resubmit: a fix is identifiable but requires CSR review",
  "     before resubmit (data we don't have, payer-specific judgment).",
  "   - appeal         : denial appears clinically wrong; suggest an",
  "     appeal letter based on the supporting documentation.",
  "   - bill_patient   : denial is a coverage-limit / non-covered",
  "     determination; patient becomes responsible (if ABN on file).",
  "   - write_off      : contractual writeoff (CARC 45, 96, etc.).",
  "   - manual_review  : ambiguous; CSR judgment required.",
  "",
  "4. Output STRICT JSON, no prose outside the object, with shape:",
  "{",
  '  "verdict": "<recommendation>",',
  '  "confidence": <0..1>,',
  '  "root_cause_summary": "<one sentence>",',
  '  "mapped_codes": [',
  '    { "code": "<carc/rarc>", "system": "carc"|"rarc",',
  '      "category": "<eligibility|authorization|documentation|medical_necessity|',
  '                  duplicate|coverage_limit|coding|cob|patient_liability|',
  '                  timely_filing|other>",',
  '      "explanation": "<one sentence>" }',
  "  ],",
  '  "fix_steps": [',
  '    { "step": "<imperative action>", "field_path": "<optional pointer>",',
  '      "new_value": "<optional new value>" }',
  "  ],",
  '  "appeal_letter_sketch": "<one paragraph; only required if recommendation==appeal>",',
  '  "suggested_patches": [ /* same schema as the scrubber */ ],',
  '  "can_auto_resubmit": <bool>',
  "}",
  "",
  "RULES:",
  "- Set can_auto_resubmit=true only when verdict==auto_resubmit AND",
  "  every suggested_patches entry uses one of:",
  "    set_line_modifier, set_prior_auth_number, add_diagnosis,",
  "    set_line_billed_cents.",
  "- NEVER include patient name, full DOB, address, member ID, or any",
  "  PHI in any string. Reference the patient as 'the patient'.",
  "- If input is insufficient, return verdict='manual_review' and a",
  "  single fix_step explaining what's missing.",
].join("\n");

export interface DenialAnalysisInput {
  claimId: string;
  /** Optional pointer to the ERA file this denial came from. */
  eraFileId?: string | null;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DenialAnalysisOutput {
  recommendation: (typeof RECOMMENDATIONS)[number];
  confidence: number | null;
  rootCauseSummary: string;
  mappedCodes: MappedDenialCode[];
  fixSteps: FixStep[];
  appealLetterSketch: string | null;
  suggestedPatches: AiPatch[];
  droppedPatches: Array<{ index: number; reason: string }>;
  canAutoResubmit: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export interface MappedDenialCode {
  code: string;
  system: "carc" | "rarc" | "unknown";
  category: string;
  explanation: string;
}

export interface FixStep {
  step: string;
  fieldPath: string | null;
  newValue: string | null;
}

const SAFE_AUTO_RESUBMIT_KINDS = new Set<AiPatch["kind"]>([
  "set_line_modifier",
  "set_prior_auth_number",
  "add_diagnosis",
  "set_line_billed_cents",
]);

export async function analyzeDenial(
  input: DenialAnalysisInput,
): Promise<DenialAnalysisOutput> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return errored("OPENAI_API_KEY not configured");
  }

  const supabase = getSupabaseServiceRoleClient();
  let denialContext;
  try {
    denialContext = await assembleDenialContext(supabase, input.claimId);
  } catch (err) {
    return errored(`context assembly failed: ${errMsg(err)}`);
  }
  if (!denialContext) {
    return errored("claim not found or not denied");
  }

  const userPrompt = JSON.stringify(denialContext, null, 2);
  const model = input.model ?? DEFAULT_DENIAL_MODEL;
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
          event: "ai_denial_http_error",
          status: res.status,
          detail: detail.slice(0, 200),
        },
        "ai-denial: openai HTTP error",
      );
      return errored(`openai http ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseDenialOutput(content);
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

function errored(message: string): DenialAnalysisOutput {
  return {
    recommendation: "manual_review",
    confidence: null,
    rootCauseSummary: `AI denial analysis failed: ${message}`,
    mappedCodes: [],
    fixSteps: [],
    appealLetterSketch: null,
    suggestedPatches: [],
    droppedPatches: [],
    canAutoResubmit: false,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    errorMessage: message,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Context assembly (PHI-safe) ──────────────────────────────────────

async function assembleDenialContext(
  supabase: SupabaseClient,
  claimId: string,
): Promise<Record<string, unknown> | null> {
  const { data: claim } = await supabase
    .schema("resupply")
    .from("insurance_claims")
    .select(
      "id, status, payer_name, payer_profile_id, date_of_service, total_billed_cents, total_paid_cents, denial_reason",
    )
    .eq("id", claimId)
    .limit(1)
    .maybeSingle();
  if (!claim) return null;

  const [{ data: lines }, { data: events }, { data: payer }] = await Promise.all([
    supabase
      .schema("resupply")
      .from("insurance_claim_line_items")
      .select(
        "hcpcs_code, modifier, billed_cents, allowed_cents, paid_cents, status, denial_reason, quantity",
      )
      .eq("claim_id", claim.id),
    supabase
      .schema("resupply")
      .from("insurance_claim_events")
      .select("event_type, amount_cents, payer_ref, note, occurred_at")
      .eq("claim_id", claim.id)
      .order("occurred_at", { ascending: false })
      .limit(20),
    claim.payer_profile_id
      ? supabase
          .schema("resupply")
          .from("payer_profiles")
          .select(
            "display_name, line_of_business, region, requires_prior_auth_dme",
          )
          .eq("id", claim.payer_profile_id)
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Pull catalog rows for any CARC/RARC code we can extract from the
  // claim or its line items. Codes show up in two places:
  //   1. claim.denial_reason / line.denial_reason as free text like
  //      "CARC 27; CARC 96" (composed by the ERA reconciler).
  //   2. events.note as part of the ERA file marker.
  const extractedCodes = new Set<{ system: "carc" | "rarc"; code: string }>();
  for (const text of [
    claim.denial_reason ?? "",
    ...((lines ?? []).map((l) => l.denial_reason ?? "")),
    ...((events ?? []).map((e) => e.note ?? "")),
  ]) {
    for (const m of text.matchAll(/(CARC|RARC)\s+([A-Z]?\d+)/gi)) {
      const system = m[1]!.toLowerCase() as "carc" | "rarc";
      extractedCodes.add({ system, code: m[2]!.toUpperCase() });
    }
  }
  const codeList = [...extractedCodes];
  let catalogEntries: Array<{
    code_system: string;
    code: string;
    description: string;
    category: string;
    recommended_action: string | null;
  }> = [];
  if (codeList.length > 0) {
    const { data } = await supabase
      .schema("resupply")
      .from("denial_codes")
      .select("code_system, code, description, category, recommended_action")
      .in(
        "code",
        codeList.map((c) => c.code),
      );
    catalogEntries = (data ?? []).filter((row) =>
      codeList.some(
        (c) => c.system === row.code_system && c.code === row.code,
      ),
    );
  }

  return {
    claim: {
      id: claim.id,
      status: claim.status,
      payerName: claim.payer_name,
      dateOfService: claim.date_of_service,
      totalBilledCents: claim.total_billed_cents,
      totalPaidCents: claim.total_paid_cents,
      headerDenialReason: claim.denial_reason,
    },
    payerProfile: payer ?? null,
    lines: (lines ?? []).map((l) => ({
      hcpcsCode: l.hcpcs_code,
      modifier: l.modifier,
      billedCents: l.billed_cents,
      paidCents: l.paid_cents,
      allowedCents: l.allowed_cents,
      quantity: l.quantity,
      status: l.status,
      denialReason: l.denial_reason,
    })),
    eraEvents: (events ?? []).slice(0, 10).map((e) => ({
      eventType: e.event_type,
      amountCents: e.amount_cents,
      payerRef: e.payer_ref,
      // Keep the note short — we don't need the full ERA filename
      // in the prompt; just the summary line.
      note: e.note ? e.note.slice(0, 240) : null,
      occurredAt: e.occurred_at,
    })),
    extractedDenialCodes: codeList,
    catalogEntries: catalogEntries.map((c) => ({
      system: c.code_system,
      code: c.code,
      description: c.description,
      category: c.category,
      recommendedAction: c.recommended_action,
    })),
  };
}

// ── Output parsing ───────────────────────────────────────────────────

function parseDenialOutput(
  content: string,
): Omit<
  DenialAnalysisOutput,
  "latencyMs" | "promptTokens" | "completionTokens" | "errorMessage"
> {
  try {
    const parsed = JSON.parse(content) as {
      verdict?: unknown;
      confidence?: unknown;
      root_cause_summary?: unknown;
      mapped_codes?: unknown;
      fix_steps?: unknown;
      appeal_letter_sketch?: unknown;
      suggested_patches?: unknown;
      can_auto_resubmit?: unknown;
    };
    const recommendation =
      typeof parsed.verdict === "string" &&
      (RECOMMENDATIONS as readonly string[]).includes(parsed.verdict)
        ? (parsed.verdict as DenialAnalysisOutput["recommendation"])
        : "manual_review";
    const confidence =
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : null;
    const rootCauseSummary =
      typeof parsed.root_cause_summary === "string"
        ? parsed.root_cause_summary.slice(0, 1000)
        : "";
    const mappedCodes: MappedDenialCode[] = Array.isArray(parsed.mapped_codes)
      ? parsed.mapped_codes.flatMap((c) => parseMapped(c))
      : [];
    const fixSteps: FixStep[] = Array.isArray(parsed.fix_steps)
      ? parsed.fix_steps.flatMap((s) => parseFixStep(s))
      : [];
    const appealLetterSketch =
      typeof parsed.appeal_letter_sketch === "string"
        ? parsed.appeal_letter_sketch.slice(0, 4000)
        : null;
    const { patches, dropped } = parseAiPatches(parsed.suggested_patches);
    // Re-derive can_auto_resubmit defensively: ONLY honour the
    // model's true value when ALL patches are in the safe whitelist
    // and confidence >= 0.75 and recommendation == auto_resubmit.
    const modelClaimedAuto =
      typeof parsed.can_auto_resubmit === "boolean"
        ? parsed.can_auto_resubmit
        : false;
    const safeForAuto =
      patches.length > 0 &&
      patches.every((p) => SAFE_AUTO_RESUBMIT_KINDS.has(p.kind)) &&
      (confidence ?? 0) >= 0.75 &&
      recommendation === "auto_resubmit";
    const canAutoResubmit = modelClaimedAuto && safeForAuto;

    return {
      recommendation,
      confidence,
      rootCauseSummary,
      mappedCodes,
      fixSteps,
      appealLetterSketch,
      suggestedPatches: patches,
      droppedPatches: dropped,
      canAutoResubmit,
    };
  } catch {
    return {
      recommendation: "manual_review",
      confidence: null,
      rootCauseSummary: "Model returned malformed JSON.",
      mappedCodes: [],
      fixSteps: [],
      appealLetterSketch: null,
      suggestedPatches: [],
      droppedPatches: [],
      canAutoResubmit: false,
    };
  }
}

function parseMapped(raw: unknown): MappedDenialCode[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as {
    code?: unknown;
    system?: unknown;
    category?: unknown;
    explanation?: unknown;
  };
  const code = typeof r.code === "string" ? r.code.slice(0, 8) : "";
  if (!code) return [];
  const system =
    r.system === "carc" || r.system === "rarc" ? r.system : "unknown";
  const category = typeof r.category === "string" ? r.category.slice(0, 40) : "other";
  const explanation =
    typeof r.explanation === "string" ? r.explanation.slice(0, 400) : "";
  return [{ code, system, category, explanation }];
}

function parseFixStep(raw: unknown): FixStep[] {
  if (!raw || typeof raw !== "object") return [];
  const r = raw as {
    step?: unknown;
    field_path?: unknown;
    new_value?: unknown;
  };
  const step = typeof r.step === "string" ? r.step.slice(0, 400) : "";
  if (!step) return [];
  return [
    {
      step,
      fieldPath: typeof r.field_path === "string" ? r.field_path.slice(0, 120) : null,
      newValue:
        typeof r.new_value === "string" ||
        typeof r.new_value === "number"
          ? String(r.new_value).slice(0, 240)
          : null,
    },
  ];
}

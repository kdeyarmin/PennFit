// AI ICD-10 suggester for sleep studies.
//
// Triggered after a sleep_studies row is captured without a
// diagnosis_icd10 (most common when the lab faxes results and a CSR
// transcribes the numerics but skips the dx). Reads the structured
// numerics + study type and proposes the right ICD-10 code with a
// confidence + explanation.
//
// Output is structured so the route can:
//   (a) suggest-only: stamp diagnosis_source='ai_suggested' + the
//       code on the row, queue a CSR review,
//   (b) auto-accept when confidence >= 0.9 and code is in the
//       LCD L33718 allowlist.
//
// PHI posture: same as the AI scrubber — initials + DOB year only.
// The clinical numerics aren't directly PHI but are protected via
// the same prompt + transport.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

export const ICD10_PROMPT_VERSION = "icd10-1.0";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 15_000;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// LCD L33718 (PAP for OSA) covered diagnoses. The model is asked to
// pick from this list; outputs outside it are downgraded to
// confidence 0 and the route falls back to manual review.
const LCD_L33718_ALLOWLIST = [
  "G47.33", // Obstructive sleep apnea (adult/pediatric)
  "G47.30", // Sleep apnea, unspecified
  "G47.31", // Primary central sleep apnea
  "G47.32", // High altitude periodic breathing
  "G47.36", // Sleep apnea in conditions classified elsewhere
  "G47.37", // Central sleep apnea in conditions classified elsewhere
  "G47.39", // Other sleep apnea
  "R06.83", // Snoring
];

const SYSTEM_PROMPT = [
  "You are an HIPAA-compliant ICD-10 coding assistant for a sleep",
  "lab. Given the numeric results of a sleep study, suggest the",
  "single best ICD-10 code from the CMS LCD L33718-covered list",
  "below, with a confidence score and a one-sentence rationale.",
  "",
  "CMS LCD L33718 — covered ICD-10s for PAP therapy (you MUST pick",
  "one of these or null):",
  "  G47.33 — Obstructive sleep apnea (adult/pediatric). Default",
  "           when AHI >= 5 with daytime symptoms or AHI >= 15.",
  "  G47.30 — Sleep apnea, unspecified.",
  "  G47.31 — Primary central sleep apnea (lab-confirmed centrals).",
  "  G47.32 — High altitude periodic breathing.",
  "  G47.36 — Sleep apnea in conditions classified elsewhere.",
  "  G47.37 — Central sleep apnea in conditions classified elsewhere.",
  "  G47.39 — Other sleep apnea (Cheyne-Stokes outside CHF, etc).",
  "  R06.83 — Snoring (subclinical AHI; rarely the primary code).",
  "",
  "Decision rules:",
  "  - AHI >= 5 + study_type IN (psg, split_night) -> G47.33 typically.",
  "  - HSAT studies almost always yield G47.33 unless RDI dominates.",
  "  - RDI > AHI by >= 5 and AHI < 5 -> consider G47.30 (unspecified).",
  "  - Pure snoring with AHI < 5 -> R06.83.",
  "  - Anything outside the allowlist -> return code=null, confidence=0",
  "    and explain in `rationale`.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object:",
  "{",
  '  "icd10": "<code from allowlist OR null>",',
  '  "confidence": <0..1>,',
  '  "rationale": "<one sentence>"',
  "}",
].join("\n");

export interface SuggestInput {
  sleepStudyId: string;
  model?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SuggestOutput {
  icd10: string | null;
  confidence: number;
  rationale: string;
  /** True iff the suggested code is on the allowlist. */
  inAllowlist: boolean;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  errorMessage: string | null;
}

export async function suggestIcd10(
  input: SuggestInput,
): Promise<SuggestOutput> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return errored("OPENAI_API_KEY not configured");
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: study } = await supabase
    .schema("resupply")
    .from("sleep_studies")
    .select(
      "id, study_type, ahi, rdi, lowest_spo2_pct, sleep_efficiency_pct, source",
    )
    .eq("id", input.sleepStudyId)
    .limit(1)
    .maybeSingle();
  if (!study) {
    return errored("sleep_study not found");
  }
  const context = {
    studyType: study.study_type,
    ahi: study.ahi ? Number.parseFloat(study.ahi) : null,
    rdi: study.rdi ? Number.parseFloat(study.rdi) : null,
    lowestSpo2Pct: study.lowest_spo2_pct,
    sleepEfficiencyPct: study.sleep_efficiency_pct,
    source: study.source,
  };
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model ?? DEFAULT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(context) },
        ],
      }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      logger.warn(
        { status: res.status, detail: detail.slice(0, 200) },
        "ai-icd10: openai HTTP error",
      );
      return errored(`openai http ${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseOutput(content);
    return {
      ...parsed,
      latencyMs,
      promptTokens: json.usage?.prompt_tokens ?? null,
      completionTokens: json.usage?.completion_tokens ?? null,
      errorMessage: null,
    };
  } catch (err) {
    return errored(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function errored(message: string): SuggestOutput {
  return {
    icd10: null,
    confidence: 0,
    rationale: `AI suggestion failed: ${message}`,
    inAllowlist: false,
    latencyMs: null,
    promptTokens: null,
    completionTokens: null,
    errorMessage: message,
  };
}

function parseOutput(
  content: string,
): Omit<
  SuggestOutput,
  "latencyMs" | "promptTokens" | "completionTokens" | "errorMessage"
> {
  try {
    const parsed = JSON.parse(content) as {
      icd10?: unknown;
      confidence?: unknown;
      rationale?: unknown;
    };
    const code =
      typeof parsed.icd10 === "string"
        ? parsed.icd10.toUpperCase().replace(/\s+/g, "")
        : null;
    const confidence =
      typeof parsed.confidence === "number" &&
      parsed.confidence >= 0 &&
      parsed.confidence <= 1
        ? parsed.confidence
        : 0;
    const rationale =
      typeof parsed.rationale === "string"
        ? parsed.rationale.slice(0, 500)
        : "";
    const inAllowlist =
      code !== null && LCD_L33718_ALLOWLIST.includes(code);
    return {
      icd10: inAllowlist ? code : null,
      confidence: inAllowlist ? confidence : 0,
      rationale,
      inAllowlist,
    };
  } catch {
    return {
      icd10: null,
      confidence: 0,
      rationale: "Model returned malformed JSON",
      inAllowlist: false,
    };
  }
}

export const ICD10_ALLOWLIST = LCD_L33718_ALLOWLIST;

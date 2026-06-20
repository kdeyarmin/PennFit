// Smart Note compliance engine.
//
// A nurse/clinician writes a clinical note on a patient. This module:
//   1. Assembles the patient's relevant chart context (most-recent sleep
//      study + recent therapy-night adherence aggregates) so the note can
//      be cross-checked against the objective record.
//   2. Asks an LLM to grade the note against a FIXED checklist of the
//      Medicare documentation elements required for PAP/CPAP continued
//      coverage (LCD L33718 territory) — every element either present or
//      missing, with actionable suggestions for the gaps.
//   3. Compares the note against the patient's PREVIOUS smart note so
//      trends and changes are surfaced ("usage trending down vs last
//      visit", etc).
//
// Provider selection follows the house pattern (see ai-icd10-suggester):
// Anthropic-first when ANTHROPIC_API_KEY is set, OpenAI fallback when
// only OPENAI_API_KEY is configured, and a deterministic OFFLINE review
// (heuristic keyword checklist) when neither key is present — so the
// feature degrades to a usable, if dumber, checklist instead of erroring.
//
// PHI posture: the note text is the very thing being reviewed, so it is
// sent to the model. We deliberately do NOT add direct identifiers
// (name / DOB / address / phone) to the assembled chart context — only
// clinical numerics. The note body and the review prose are NEVER logged;
// callers log structural metadata only (score, compliant, lengths).

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
  selectLlmProvider,
  sendWithRetry,
  type AnthropicClient,
} from "../llm-provider";
import { logger } from "../logger";

export const SMART_NOTE_PROMPT_VERSION = "smart-note-1.0";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;

// The Medicare PAP/CPAP documentation checklist. This is the fixed
// rubric the model grades each note against. Keys are stable so the UI
// can render a consistent checklist; the model is told to return a
// verdict for each `key`. Reconciliation in `parseReview()` defaults any
// element the model omits to `present: false`, so a dropped key fails
// closed (counts against compliance) rather than silently passing.
export const SMART_NOTE_ELEMENTS = [
  {
    key: "patient_identification",
    label: "Patient identification & date of service",
    guidance:
      "Patient is identifiable (name/DOB/MRN) and the encounter date / date of service is documented.",
  },
  {
    key: "osa_diagnosis",
    label: "OSA diagnosis with sleep-study support",
    guidance:
      "Obstructive sleep apnea diagnosis is stated and supported by a sleep study (AHI/RDI and/or ICD-10 G47.33).",
  },
  {
    key: "adherence_data",
    label: "Objective PAP adherence data",
    guidance:
      "Objective device usage is documented: hours/night and percentage of nights used >=4 hours over a 30-day period (Medicare requires >=4h on >=70% of nights in a consecutive 30-day window within the first 90 days).",
  },
  {
    key: "clinical_benefit",
    label: "Clinical benefit from therapy",
    guidance:
      "Documented improvement/benefit from therapy (e.g. reduced daytime sleepiness, improved symptoms).",
  },
  {
    key: "subjective_findings",
    label: "Subjective findings / patient-reported symptoms",
    guidance:
      "Patient-reported symptoms, complaints, or subjective status are documented.",
  },
  {
    key: "objective_findings",
    label: "Objective findings / exam or device data",
    guidance:
      "Objective exam findings or device-download data (AHI, leak, pressure) are documented.",
  },
  {
    key: "face_to_face",
    label: "Face-to-face re-evaluation",
    guidance:
      "Reference to the face-to-face clinical re-evaluation (the 31-91 day re-eval Medicare requires to continue PAP coverage).",
  },
  {
    key: "interventions_plan",
    label: "Assessment, interventions & follow-up plan",
    guidance:
      "An assessment plus the plan / interventions and a follow-up plan are documented.",
  },
  {
    key: "provider_attestation",
    label: "Provider attestation (name, credentials, signature, date)",
    guidance:
      "The documenting clinician's name, credentials, signature, and date are present.",
  },
] as const;

export type SmartNoteElementKey = (typeof SMART_NOTE_ELEMENTS)[number]["key"];

export interface SmartNoteElementResult {
  key: SmartNoteElementKey;
  label: string;
  present: boolean;
  /** Short evidence quote (if present) or what is missing (if absent). */
  detail: string;
}

export interface SmartNoteReview {
  compliant: boolean;
  /** 0..100, percentage of required elements documented. */
  score: number;
  summary: string;
  elements: SmartNoteElementResult[];
  missingElements: string[];
  suggestions: string[];
  chartConsistency: {
    summary: string;
    discrepancies: string[];
  };
  provider: "anthropic" | "openai" | "offline";
  promptVersion: string;
}

export interface SmartNoteComparison {
  /** Null when this is the patient's first smart note. */
  previousNoteId: string | null;
  summary: string;
  changes: string[];
}

// ---------------------------------------------------------------------
// Chart context assembly
// ---------------------------------------------------------------------

export interface SmartNoteChartContext {
  patientStatus: string | null;
  latestSleepStudy: {
    studyDate: string | null;
    studyType: string | null;
    ahi: number | null;
    diagnosisIcd10: string | null;
  } | null;
  adherence: {
    windowNights: number;
    nightsWithData: number;
    nightsOver4h: number;
    pctNightsOver4h: number | null;
    avgUsageHours: number | null;
    avgAhi: number | null;
    avgLeakLMin: number | null;
  } | null;
}

export interface PreviousSmartNote {
  id: string;
  noteText: string;
  createdAt: string;
  /** The prior note's review summary, for trend grounding. */
  reviewSummary: string | null;
}

// Loosely-typed Supabase client (matches the rest of the route layer,
// which calls getOrgScopedClient(orgId) and chains .from(...)).
type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        order: (
          col: string,
          opts: { ascending: boolean },
        ) => {
          limit: (n: number) => Promise<{ data: unknown[] | null }>;
        };
      };
    };
  };
};

const ADHERENCE_WINDOW_NIGHTS = 30;

/**
 * Assemble the objective chart context the model cross-checks the note
 * against. Best-effort: any sub-query failing degrades that slice to
 * null rather than failing the whole review.
 */
export async function assembleSmartNoteContext(
  supabase: SupabaseLike,
  patientId: string,
  patientStatus: string | null,
): Promise<SmartNoteChartContext> {
  const ctx: SmartNoteChartContext = {
    patientStatus,
    latestSleepStudy: null,
    adherence: null,
  };

  try {
    const { data } = await supabase
      .from("sleep_studies")
      .select("study_date, study_type, ahi, diagnosis_icd10")
      .eq("patient_id", patientId)
      .order("study_date", { ascending: false })
      .limit(1);
    const row = (data ?? [])[0] as
      | {
          study_date: string | null;
          study_type: string | null;
          ahi: string | number | null;
          diagnosis_icd10: string | null;
        }
      | undefined;
    if (row) {
      ctx.latestSleepStudy = {
        studyDate: row.study_date ?? null,
        studyType: row.study_type ?? null,
        ahi: toNumber(row.ahi),
        diagnosisIcd10: row.diagnosis_icd10 ?? null,
      };
    }
  } catch (err) {
    logger.warn({ err }, "smart-note: sleep_studies context lookup failed");
  }

  try {
    // Pull the most recent nights and aggregate the last 30 in-app —
    // simpler than a SQL window and the volume is tiny per patient.
    const { data } = await supabase
      .from("patient_therapy_nights")
      .select("night_date, usage_minutes, ahi, leak_rate_l_min")
      .eq("patient_id", patientId)
      .order("night_date", { ascending: false })
      .limit(ADHERENCE_WINDOW_NIGHTS);
    const rows = (data ?? []) as Array<{
      usage_minutes: number | null;
      ahi: string | number | null;
      leak_rate_l_min: string | number | null;
    }>;
    if (rows.length > 0) {
      const withUsage = rows.filter((r) => typeof r.usage_minutes === "number");
      const nightsOver4h = withUsage.filter(
        (r) => (r.usage_minutes ?? 0) >= 240,
      ).length;
      const avgUsageHours =
        withUsage.length > 0
          ? round1(
              withUsage.reduce((s, r) => s + (r.usage_minutes ?? 0), 0) /
                withUsage.length /
                60,
            )
          : null;
      ctx.adherence = {
        windowNights: rows.length,
        nightsWithData: withUsage.length,
        nightsOver4h,
        pctNightsOver4h:
          withUsage.length > 0
            ? Math.round((nightsOver4h / withUsage.length) * 100)
            : null,
        avgUsageHours,
        avgAhi: avgOf(rows.map((r) => toNumber(r.ahi))),
        avgLeakLMin: avgOf(rows.map((r) => toNumber(r.leak_rate_l_min))),
      };
    }
  } catch (err) {
    logger.warn(
      { err },
      "smart-note: patient_therapy_nights context lookup failed",
    );
  }

  return ctx;
}

// ---------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------

const SYSTEM_PROMPT = [
  "You are a Medicare compliance reviewer for a DME / CPAP resupply",
  "company. A nurse or clinician has written a clinical note on a CPAP",
  "patient. Your job is to grade that note against the fixed checklist of",
  "documentation elements Medicare requires for PAP/CPAP coverage, cross-",
  "check it against the patient's objective chart data, and return a",
  "structured review. Be strict but fair: an element is 'present' only if",
  "the note actually documents it, not merely implies it.",
  "",
  "REQUIRED ELEMENTS (grade every one of these by its `key`):",
  ...SMART_NOTE_ELEMENTS.map((e) => `  - ${e.key}: ${e.label}. ${e.guidance}`),
  "",
  "You are also given CHART CONTEXT (sleep study + recent device",
  "adherence). Use it to flag CONSISTENCY problems: if the note claims",
  "the patient is adherent but the device data shows <70% of nights >=4h,",
  "or the note's AHI contradicts the chart, list it under",
  "chartConsistency.discrepancies. If there is no relevant chart data,",
  "say so and do not invent discrepancies.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object:",
  "{",
  '  "summary": "<2-3 sentence overall compliance assessment>",',
  '  "elements": [',
  '    { "key": "<one of the required keys>", "present": <true|false>,',
  '      "detail": "<short evidence quote if present, else what is missing>" }',
  "  ],",
  '  "suggestions": ["<actionable fix for each gap>"],',
  '  "chartConsistency": {',
  '    "summary": "<1-2 sentences on how the note matches the chart>",',
  '    "discrepancies": ["<each concrete mismatch>"]',
  "  }",
  "}",
  "Return an entry in `elements` for EVERY required key.",
].join("\n");

const TREND_SYSTEM_PROMPT = [
  "You are comparing a clinician's NEW clinical note against the SAME",
  "patient's PREVIOUS note to surface trends and changes over time (e.g.",
  "symptoms improving/worsening, adherence rising/falling, plan changes).",
  "Be concise and clinical. Only report real, note-supported changes.",
  "",
  "OUTPUT — STRICT JSON, no prose outside the object:",
  "{",
  '  "summary": "<1-2 sentence trend summary>",',
  '  "changes": ["<each concrete change vs the previous note>"]',
  "}",
].join("\n");

function buildReviewUserPrompt(
  noteText: string,
  chart: SmartNoteChartContext,
): string {
  return JSON.stringify({ noteText, chart });
}

// ---------------------------------------------------------------------
// Public entrypoints
// ---------------------------------------------------------------------

export interface ReviewInput {
  noteText: string;
  chart: SmartNoteChartContext;
  /** Test seam — override provider clients. */
  anthropicClient?: AnthropicClient | null;
  openAiApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Grade a note against the Medicare checklist + chart context. Never
 * throws — provider failures degrade to the offline heuristic review.
 */
export async function reviewSmartNote(
  input: ReviewInput,
): Promise<SmartNoteReview> {
  const userPrompt = buildReviewUserPrompt(input.noteText, input.chart);
  const selection = selectLlmProvider();

  if (selection.provider === "anthropic") {
    const client = input.anthropicClient ?? getAnthropicClient();
    if (client) {
      const text = await callAnthropic(client, SYSTEM_PROMPT, userPrompt);
      if (text !== null) return finalizeReview(text, "anthropic");
      logger.warn(
        { event: "smart_note_anthropic_fallback" },
        "smart-note: anthropic review failed; falling back",
      );
    }
  }

  const openAiKey = input.openAiApiKey ?? process.env.OPENAI_API_KEY;
  if (
    (selection.provider === "openai" || selection.provider === "anthropic") &&
    openAiKey
  ) {
    const text = await callOpenAi(
      SYSTEM_PROMPT,
      userPrompt,
      openAiKey,
      input.fetchImpl,
      input.timeoutMs,
    );
    if (text !== null) return finalizeReview(text, "openai");
    logger.warn(
      { event: "smart_note_openai_fallback" },
      "smart-note: openai review failed; falling back to offline",
    );
  }

  return offlineReview(input.noteText, input.chart);
}

export interface CompareInput {
  noteText: string;
  previous: PreviousSmartNote | null;
  anthropicClient?: AnthropicClient | null;
  openAiApiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Compare a new note against the previous one for trends. Returns an
 * empty (first-note) comparison when there is no previous note, and a
 * graceful empty summary when the provider is offline/failing.
 */
export async function compareSmartNote(
  input: CompareInput,
): Promise<SmartNoteComparison> {
  if (!input.previous) {
    return {
      previousNoteId: null,
      summary: "First smart note on file — no prior note to compare against.",
      changes: [],
    };
  }

  const userPrompt = JSON.stringify({
    previousNote: {
      createdAt: input.previous.createdAt,
      text: input.previous.noteText,
      reviewSummary: input.previous.reviewSummary,
    },
    newNote: input.noteText,
  });

  const selection = selectLlmProvider();
  let text: string | null = null;

  if (selection.provider === "anthropic") {
    const client = input.anthropicClient ?? getAnthropicClient();
    if (client) {
      text = await callAnthropic(client, TREND_SYSTEM_PROMPT, userPrompt);
    }
  }
  if (text === null) {
    const openAiKey = input.openAiApiKey ?? process.env.OPENAI_API_KEY;
    if (openAiKey) {
      text = await callOpenAi(
        TREND_SYSTEM_PROMPT,
        userPrompt,
        openAiKey,
        input.fetchImpl,
        input.timeoutMs,
      );
    }
  }

  if (text === null) {
    return {
      previousNoteId: input.previous.id,
      summary:
        "Trend comparison unavailable (AI offline). Saved alongside the previous note for manual review.",
      changes: [],
    };
  }

  const parsed = parseComparison(text);
  return {
    previousNoteId: input.previous.id,
    summary: parsed.summary,
    changes: parsed.changes,
  };
}

// ---------------------------------------------------------------------
// Provider plumbing
// ---------------------------------------------------------------------

async function callAnthropic(
  client: AnthropicClient,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  const result = await sendWithRetry(client, {
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 1200,
    temperature: 0,
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userPrompt }],
  });
  if (!result.ok) {
    logger.warn(
      { event: "smart_note_anthropic_error", code: result.errorCode },
      "smart-note: anthropic call failed",
    );
    return null;
  }
  return getResponseText(result.response);
}

async function callOpenAi(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
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
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 1200,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "smart-note: openai HTTP error");
      return null;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return json.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    logger.warn({ err }, "smart-note: openai call threw");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------
// Parsing & reconciliation
// ---------------------------------------------------------------------

function finalizeReview(
  content: string,
  provider: "anthropic" | "openai",
): SmartNoteReview {
  const parsed = parseReview(content, provider);
  return parsed;
}

export function parseReview(
  content: string,
  provider: "anthropic" | "openai",
): SmartNoteReview {
  let raw: {
    summary?: unknown;
    elements?: unknown;
    suggestions?: unknown;
    chartConsistency?: unknown;
  };
  try {
    raw = JSON.parse(extractJson(content)) as typeof raw;
  } catch {
    // Malformed JSON — fail closed: every element missing.
    return reconcileElements(
      [],
      "AI returned malformed output; treat every element as unverified and review manually.",
      [],
      { summary: "", discrepancies: [] },
      provider,
    );
  }

  const byKey = new Map<string, { present: boolean; detail: string }>();
  if (Array.isArray(raw.elements)) {
    for (const e of raw.elements as Array<Record<string, unknown>>) {
      const key = typeof e.key === "string" ? e.key : null;
      if (!key) continue;
      byKey.set(key, {
        present: e.present === true,
        detail: typeof e.detail === "string" ? e.detail.slice(0, 400) : "",
      });
    }
  }

  const cc = (raw.chartConsistency ?? {}) as Record<string, unknown>;
  return reconcileElements(
    [...byKey.entries()].map(([key, v]) => ({ key, ...v })),
    typeof raw.summary === "string" ? raw.summary.slice(0, 800) : "",
    Array.isArray(raw.suggestions)
      ? (raw.suggestions as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.slice(0, 300))
          .slice(0, 20)
      : [],
    {
      summary: typeof cc.summary === "string" ? cc.summary.slice(0, 600) : "",
      discrepancies: Array.isArray(cc.discrepancies)
        ? (cc.discrepancies as unknown[])
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.slice(0, 300))
            .slice(0, 20)
        : [],
    },
    provider,
  );
}

function reconcileElements(
  modelElements: Array<{ key: string; present: boolean; detail: string }>,
  summary: string,
  suggestions: string[],
  chartConsistency: { summary: string; discrepancies: string[] },
  provider: "anthropic" | "openai" | "offline",
): SmartNoteReview {
  const lookup = new Map(modelElements.map((e) => [e.key, e]));
  const elements: SmartNoteElementResult[] = SMART_NOTE_ELEMENTS.map((def) => {
    const m = lookup.get(def.key);
    return {
      key: def.key,
      label: def.label,
      present: m?.present === true,
      detail: m?.detail ?? "Not documented in the note.",
    };
  });
  const presentCount = elements.filter((e) => e.present).length;
  const score = Math.round((presentCount / elements.length) * 100);
  const missingElements = elements
    .filter((e) => !e.present)
    .map((e) => e.label);
  return {
    compliant: missingElements.length === 0,
    score,
    summary:
      summary ||
      (missingElements.length === 0
        ? "All required Medicare documentation elements are present."
        : `${missingElements.length} required element(s) missing.`),
    elements,
    missingElements,
    suggestions,
    chartConsistency,
    provider,
    promptVersion: SMART_NOTE_PROMPT_VERSION,
  };
}

function parseComparison(content: string): {
  summary: string;
  changes: string[];
} {
  try {
    const raw = JSON.parse(extractJson(content)) as {
      summary?: unknown;
      changes?: unknown;
    };
    return {
      summary: typeof raw.summary === "string" ? raw.summary.slice(0, 600) : "",
      changes: Array.isArray(raw.changes)
        ? (raw.changes as unknown[])
            .filter((s): s is string => typeof s === "string")
            .map((s) => s.slice(0, 300))
            .slice(0, 20)
        : [],
    };
  } catch {
    return { summary: "", changes: [] };
  }
}

// ---------------------------------------------------------------------
// Offline heuristic review
// ---------------------------------------------------------------------

// When no LLM is configured we still want a usable checklist rather than
// an error. A lightweight keyword heuristic marks elements present when
// the note clearly mentions the concept. It is intentionally conservative
// (fails closed) — the operator sees an "offline" badge in the UI.
// Note: these intentionally use STEM / substring matching (no trailing
// word boundary) so e.g. "improved" matches "improv" and "adherence"
// matches "adheren". A trailing \b after a stem would never match.
const OFFLINE_KEYWORDS: Record<SmartNoteElementKey, RegExp> = {
  patient_identification: /\b(dob|mrn)\b|date of birth|patient id|d\.o\.b/i,
  osa_diagnosis: /\b(osa|ahi|rdi)\b|obstructive sleep apnea|g47\.33/i,
  adherence_data:
    /\d+(\.\d+)?\s*(hours?|hrs|h\b)|complian|adheren|nights|usage/i,
  clinical_benefit: /improv|benefit|better|reduced|resolv|less sleep/i,
  subjective_findings: /report|complain|states|denies|c\/o|symptom/i,
  objective_findings: /\b(ahi|spo2)\b|exam|leak|pressure|download|device data/i,
  face_to_face: /face[- ]to[- ]face|re[- ]?eval|in[- ]person|visit/i,
  interventions_plan:
    /\bplan\b|follow[- ]?up|recommend|continue|adjust|education/i,
  provider_attestation: /\b(rn|np|md|do|rrt|crt)\b|sign|credential/i,
};

function offlineReview(
  noteText: string,
  _chart: SmartNoteChartContext,
): SmartNoteReview {
  const modelElements = SMART_NOTE_ELEMENTS.map((def) => {
    const present = OFFLINE_KEYWORDS[def.key].test(noteText);
    return {
      key: def.key,
      present,
      detail: present
        ? "Keyword match (offline heuristic — verify manually)."
        : "No keyword match found in the note.",
    };
  });
  const review = reconcileElements(
    modelElements,
    "AI review is offline. This is a heuristic keyword checklist — verify each element manually before relying on it for compliance.",
    SMART_NOTE_ELEMENTS.filter(
      (def) => !OFFLINE_KEYWORDS[def.key].test(noteText),
    ).map((def) => `Add documentation for: ${def.label}.`),
    {
      summary: "Chart cross-check requires AI and is unavailable offline.",
      discrepancies: [],
    },
    "offline",
  );
  return review;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

// Tolerate models that wrap JSON in prose or markdown fences by slicing
// to the outermost braces.
function extractJson(content: string): string {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return content;
  return content.slice(start, end + 1);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function avgOf(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return round1(nums.reduce((s, n) => s + n, 0) / nums.length);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

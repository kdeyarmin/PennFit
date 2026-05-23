// AI classifier for inbound referrals.
//
// Runs Claude over a ParachuteOrder + the matcher results and asks
// for a structured triage hint: "what kind of order is this?",
// "what's the confidence?", "any obvious follow-up needed?".
//
// The CSR triage UI surfaces this verbatim so the human reading the
// queue can decide in seconds whether to one-click accept. The
// classifier never side-effects on its own — every action requires
// CSR confirmation.
//
// Provider:
//   Claude Sonnet 4.6 via @workspace/resupply-ai when
//   ANTHROPIC_API_KEY is set. Returns null silently when the key is
//   missing — Phase 1+2 still work without AI, the row just lands
//   in 'new' for human triage.
//
// PHI posture:
//   We send the parser's clinical fields (HCPCS codes, ICD-10 codes,
//   payer name) and the patient's first name + zip3 only. We do
//   NOT send: full name, DOB, email, phone, address, member id,
//   clinical notes. The classifier's job is structural ("this looks
//   like a CPAP resupply") — it doesn't need PHI.

import type { ParachuteOrder } from "@workspace/resupply-integrations-parachute";

import {
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  getAnthropicClient,
  getResponseText,
  selectLlmProvider,
} from "../llm-provider";

import { logger } from "../logger";

export type ReferralIntent =
  | "new_patient"
  | "refill"
  | "replacement"
  | "resupply"
  | "unknown";

export interface ReferralClassification {
  intent: ReferralIntent;
  /** 0.00–1.00. Used by the dispatcher to decide auto-triage. */
  confidence: number;
  /** One-sentence plain-English summary the CSR sees inline. */
  summary: string;
  /** Short bullets — anything the CSR should know before accepting. */
  flags: string[];
}

export interface ClassifyInput {
  order: ParachuteOrder;
  patientMatched: boolean;
  providerMatched: boolean;
  env?: NodeJS.ProcessEnv;
}

const SYSTEM_PROMPT = [
  "You are a DME (Durable Medical Equipment) triage classifier for a",
  "CPAP-resupply company. You receive a JSON summary of an inbound",
  "electronic order and emit ONE strict JSON object:",
  "",
  '  {',
  '    "intent": "new_patient" | "refill" | "replacement" | "resupply" | "unknown",',
  '    "confidence": <number 0..1>,',
  '    "summary": "one short factual sentence",',
  '    "flags": ["short bullet", ...]',
  '  }',
  "",
  "Definitions:",
  "  new_patient — first ever PAP setup; expect E0601 + mask + tubing + filters.",
  "  refill      — supplies for an existing patient still on therapy",
  "                (mask cushions, filters, water tank).",
  "  replacement — device or accessory swap for a damaged/recalled item.",
  "  resupply    — refill-cadence reorder (the most common case).",
  "  unknown     — shape doesn't fit any of the above.",
  "",
  "Rules:",
  "- Output JSON ONLY. No markdown fences. No prose before or after.",
  "- `confidence` reflects HOW SURE you are about `intent`. Above 0.85 means",
  "  the HCPCS codes + patient/provider match status make this an obvious call.",
  "  Use 0.5 or lower when the codes are ambiguous or the matchers struck out.",
  "- `summary` is ONE plain English sentence. Reference HCPCS counts, not",
  "  individual codes. e.g. \"Refill for 2 mask cushions and 1 filter.\"",
  "- `flags` lists ANYTHING a CSR should notice: missing diagnosis,",
  "  unmatched provider NPI, payer not in our common list, suspicious code",
  "  combination. Empty array when everything looks routine.",
  "- NEVER include patient name, DOB, member ID, address, phone, or email",
  "  in any field.",
].join("\n");

const DEFAULT_CONFIDENCE_FLOOR = 0;
const DEFAULT_CONFIDENCE_CEIL = 1;

export async function classifyReferral(
  input: ClassifyInput,
): Promise<ReferralClassification | null> {
  const env = input.env ?? process.env;
  const selection = selectLlmProvider(env);
  if (selection.provider === "offline") return null;

  if (selection.provider === "anthropic") {
    const client = getAnthropicClient(env);
    if (!client) return null;

    const userMessage = buildPrompt(input);
    const result = await client.send({
      model: DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
      max_tokens: 400,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
    if (!result.ok) {
      logger.warn(
        {
          event: "inbound_referral.classify.anthropic_error",
          code: result.errorCode,
          status: result.httpStatus,
        },
        "inbound referral classifier: anthropic call failed",
      );
      return null;
    }
    const text = getResponseText(result.response).trim();
    return parseClassification(text);
  }

  // OpenAI provider is not yet implemented for classification
  logger.warn(
    {
      event: "inbound_referral.classify.provider_not_supported",
      provider: selection.provider,
    },
    "inbound referral classifier: provider not supported",
  );
  return null;
}

function buildPrompt(input: ClassifyInput): string {
  const o = input.order;
  // Minimal PHI surface — first name + zip3 + clinical codes only.
  const summary = {
    event_type: o.eventType,
    payer_name: o.payerName,
    hcpcs: o.hcpcsLines.map((l) => ({
      code: l.code,
      modifiers: l.modifiers,
      qty: l.quantity,
    })),
    icd10_codes: o.icd10Codes,
    document_kinds: o.documents.map((d) => d.kind),
    patient_first_name: o.patient.firstName,
    patient_zip3: o.patient.postalCode?.slice(0, 3) ?? null,
    patient_matched_in_db: input.patientMatched,
    provider_matched_in_db: input.providerMatched,
    ordering_npi_present: o.provider.npi !== null,
  };
  return `Order:\n${JSON.stringify(summary, null, 2)}`;
}

export function parseClassification(
  raw: string,
): ReferralClassification | null {
  const stripped = raw
    .replace(/^\s*```(?:json)?/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    return null;
  }
  const intentRaw =
    typeof parsed.intent === "string" ? parsed.intent : "unknown";
  const intent: ReferralIntent = (
    [
      "new_patient",
      "refill",
      "replacement",
      "resupply",
      "unknown",
    ] as const
  ).includes(intentRaw as ReferralIntent)
    ? (intentRaw as ReferralIntent)
    : "unknown";

  let confidence =
    typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(
    DEFAULT_CONFIDENCE_FLOOR,
    Math.min(DEFAULT_CONFIDENCE_CEIL, confidence),
  );

  const summary =
    typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (summary.length === 0) return null;

  const flagsRaw = Array.isArray(parsed.flags) ? parsed.flags : [];
  const flags = flagsRaw
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 10);

  return {
    intent,
    confidence: Math.round(confidence * 100) / 100,
    summary: summary.slice(0, 400),
    flags,
  };
}

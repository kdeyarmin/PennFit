// Post-call summarization — runs Claude on the transcript after a
// voice call ends and writes a structured summary to the audit log.
//
// Why post-call (not streaming):
//   The agent's job during the call is to TALK fluently — we don't
//   want a second model burning latency on the same audio. Once the
//   call closes, we have the full bilateral transcript and can ask a
//   smarter model to look at the whole arc: did identity verification
//   succeed? did the patient sound distressed? did the agent promise
//   anything we need to follow through on? did the model recommend a
//   handoff that wasn't actually triggered?
//
// What we extract (the JSON shape returned by the model):
//   - outcome    : one-sentence plain-English summary of what happened.
//   - sentiment  : "positive" | "neutral" | "concerned" | "distressed"
//                  — drives the "needs human follow-up" queue.
//   - concerns   : free-text list of clinical-adjacent concerns the
//                  patient raised (sleep issues, mask comfort, etc.).
//                  Empty when the call was a routine refill.
//   - followUps  : actions the AGENT verbally committed to. Used by
//                  ops to verify the promised actions actually happen.
//   - recommendsHandoff : true when the model thinks a human should
//                          re-contact the patient. Independent of
//                          whether request_human_handoff was actually
//                          called during the call — captures the
//                          retrospective view.
//
// Provider:
//   Claude Sonnet 4.6 when ANTHROPIC_API_KEY is set; otherwise null
//   (we skip the summary rather than fall back to OpenAI, because the
//   structured-output reliability is materially worse on gpt-4o-mini
//   and a bad summary in the audit log is worse than no summary).
//
// PHI containment:
//   The transcript IS PHI — patients say their date of birth, address,
//   prescription, sometimes clinical symptoms. We send it to Claude.
//   The audit row metadata is
//   sanitized by @workspace/resupply-audit before write (PHI denylist,
//   size cap, depth cap), so any model-volunteered PHI is filtered
//   before persistence.
//
// Failure mode:
//   Returns `null` on any error (model error, JSON parse failure,
//   missing key). The ws-handler logs the failure but does NOT block
//   call cleanup — a flaky summary path must never delay hangup.

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getResponseText,
  type AnthropicClient,
} from "@workspace/resupply-ai";

import { logger } from "../logger";

export type CallSentiment = "positive" | "neutral" | "concerned" | "distressed";

export interface PostCallSummary {
  outcome: string;
  sentiment: CallSentiment;
  concerns: string[];
  followUps: string[];
  recommendsHandoff: boolean;
  /** True when the summarizer ran clean; false when fields were defaulted from a partial parse. */
  complete: boolean;
}

export interface TurnForSummary {
  /** "input" = patient said; "output" = agent said. */
  source: "input" | "output";
  text: string;
}

export interface SummarizeCallInput {
  client: AnthropicClient;
  /** Oldest first. */
  turns: ReadonlyArray<TurnForSummary>;
  /** Practice name embedded in the prompt for groundedness. */
  practiceName: string;
  /** Why the call ended (e.g. "twilio-stop", "model-end_call"). */
  endReason: string;
  /**
   * Optional, anonymous correlation ID for log correlation. NOT a
   * patient identifier — just so a flaky summary line can be tied to
   * the call that produced it.
   */
  conversationId?: string;
  /** Override the model. Defaults to Claude Sonnet 4.6. */
  model?: string;
}

const SYSTEM_PROMPT = [
  "You are a HIPAA-aware post-call summarizer for a CPAP resupply phone agent.",
  "You receive the verbatim transcript of an automated call between an AI",
  "agent and a patient (or a non-patient who answered the line) plus a short",
  "context line. Your job is to read the WHOLE call and emit ONE strict",
  "JSON object with these fields:",
  "",
  "  {",
  '    "outcome": "one short factual sentence — what happened on the call",',
  '    "sentiment": "positive" | "neutral" | "concerned" | "distressed",',
  '    "concerns": [ "short bullet of any clinical-adjacent concern raised", ... ],',
  '    "followUps": [ "short bullet of any action the AGENT promised", ... ],',
  '    "recommendsHandoff": true | false',
  "  }",
  "",
  "Rules:",
  "- Output JSON ONLY. No markdown fences. No prose before or after.",
  '- `outcome` is one sentence, factual, no editorializing. e.g. "Patient',
  '  verified identity and confirmed shipment of nasal pillow cushions."',
  '  or "Caller could not verify date of birth; agent ended the call."',
  "- `sentiment` is the PATIENT's overall tone:",
  "    positive   = engaged, happy, thankful",
  "    neutral    = transactional, no notable affect",
  "    concerned  = mild worry, mild frustration, asking a lot of",
  "                 clarifying questions",
  "    distressed = visibly upset, crying, expressing hopelessness, or",
  "                 mentioning any safety-relevant symptom",
  "- `concerns` lists ANYTHING clinical-adjacent the patient mentioned:",
  "  mask leaks, daytime fatigue, breathing trouble, sleep quality, etc.",
  "  Use plain English. Empty array if the call was a routine refill.",
  '- `followUps` lists actions the AGENT committed to: "agent said the',
  '  team would call back about the bill", "agent promised a label by',
  '  email". Empty array if the agent made no commitments beyond placing',
  "  the order.",
  "- `recommendsHandoff` is TRUE if a human teammate should follow up on",
  "  this call regardless of whether handoff was actually invoked during",
  "  the call. Reasons: distressed sentiment, unresolved billing/clinical",
  "  question, identity verification failure on a patient that sounded",
  "  legitimate, any safety signal.",
  "- NEVER include the patient's full name, full DOB, full address, full",
  "  phone, full email, member ID, SSN, or specific prescription details",
  '  in any field. Reference data only as fragments ("DOB ending in',
  '  fifty-two", "mask cushion shipment").',
  "- If the call was too short or empty to summarize, set outcome to",
  '  "No meaningful interaction." sentiment to "neutral", and return',
  "  empty arrays + recommendsHandoff=false.",
].join("\n");

const DEFAULT_TURN_TEXT_CAP = 600;
const DEFAULT_MAX_TURNS = 80;
/**
 * Per-field cap on the strings we accept out of the parsed summary
 * JSON (concerns + followUps). The audit-log sanitizer applies a
 * size cap of its own, but a single 64KB "concern" — a patient's
 * full medical history dumped into one bullet — would round-trip
 * through the logger and the audit row before being clipped. Cap
 * here so the upstream surfaces stay small.
 */
const DEFAULT_LIST_ITEM_CHAR_CAP = 300;

/**
 * Format the turns into a single user message. We cap per-turn text
 * length so a single long agent monologue can't blow the context
 * budget, and we cap the total turn count from oldest-first (i.e.
 * we keep the most recent N turns) so a 30-minute call still fits.
 *
 * Truncation is logged at INFO so ops can tell when a long call lost
 * its early context (sentiment + concerns from the open are absent
 * from the summary in that case).
 */
function buildTranscriptMessage(
  input: SummarizeCallInput,
  log: typeof logger = logger,
): string {
  const requested = input.turns.length;
  const turns = input.turns.slice(-DEFAULT_MAX_TURNS);
  if (requested > turns.length) {
    log.info(
      {
        event: "post_call_summary_turns_truncated",
        requested,
        used: turns.length,
        cap: DEFAULT_MAX_TURNS,
        conversationId: input.conversationId,
      },
      "post-call summary: dropped oldest turns to fit cap",
    );
  }
  const lines: string[] = [];
  lines.push(`Practice: ${input.practiceName}`);
  lines.push(`Call ended because: ${input.endReason}`);
  if (turns.length === 0) {
    lines.push("");
    lines.push("Transcript: (empty)");
    return lines.join("\n");
  }
  lines.push("");
  lines.push("Transcript (oldest first):");
  for (const t of turns) {
    const role = t.source === "input" ? "patient" : "agent";
    const text =
      t.text.length > DEFAULT_TURN_TEXT_CAP
        ? t.text.slice(0, DEFAULT_TURN_TEXT_CAP) + "…"
        : t.text;
    lines.push(`${role}: ${text}`);
  }
  return lines.join("\n");
}

function parseSummary(raw: string): PostCallSummary | null {
  // Tolerate a stray ```json fence even though the prompt forbids it —
  // models occasionally regress; we'd rather extract a usable summary
  // than discard a near-correct payload.
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
  const outcome =
    typeof parsed.outcome === "string" ? parsed.outcome.trim() : "";
  if (outcome.length === 0) return null;
  const sentimentRaw =
    typeof parsed.sentiment === "string" ? parsed.sentiment : "neutral";
  const sentiment: CallSentiment = (
    ["positive", "neutral", "concerned", "distressed"] as const
  ).includes(sentimentRaw as CallSentiment)
    ? (sentimentRaw as CallSentiment)
    : "neutral";
  const toStringArr = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return (
      v
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        // Per-item char cap before the array-length cap. Without this,
        // a single 64KB-long "concern" would survive the slice(0, 20)
        // and land in the audit log before its own sanitizer clips it.
        .map((s) =>
          s.length > DEFAULT_LIST_ITEM_CHAR_CAP
            ? s.slice(0, DEFAULT_LIST_ITEM_CHAR_CAP) + "…"
            : s,
        )
        .slice(0, 20)
    );
  };
  return {
    outcome: outcome.slice(0, 500),
    sentiment,
    concerns: toStringArr(parsed.concerns),
    followUps: toStringArr(parsed.followUps),
    recommendsHandoff: parsed.recommendsHandoff === true,
    // `complete` is true when sentiment wasn't defaulted from a junk value.
    complete: sentimentRaw === sentiment,
  };
}

/**
 * Run the summarizer. Always resolves — returns `null` on any error
 * so the caller never needs try/catch around the cleanup path.
 */
export async function summarizePostCall(
  input: SummarizeCallInput,
): Promise<PostCallSummary | null> {
  if (input.turns.length === 0) {
    return {
      outcome: "No meaningful interaction.",
      sentiment: "neutral",
      concerns: [],
      followUps: [],
      recommendsHandoff: false,
      complete: true,
    };
  }
  const userMessage = buildTranscriptMessage(input);
  const result = await input.client.send({
    model: input.model ?? DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 600,
    temperature: 0,
    // `cache_control: ephemeral` makes Anthropic serve the system
    // prompt from cache on every post-call summary after the first.
    // The block is static (~1.5K tokens, identical across calls) and
    // fires once per voice call — without caching every summary
    // re-pays the full input cost. Mirrors the pattern already in
    // routes/storefront/chat.ts:879.
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userMessage }],
  });
  if (!result.ok) {
    logger.warn(
      {
        event: "post_call_summary_anthropic_error",
        code: result.errorCode,
        status: result.httpStatus,
        conversationId: input.conversationId,
      },
      "post-call summary: anthropic call failed",
    );
    return null;
  }
  const text = getResponseText(result.response).trim();
  const parsed = parseSummary(text);
  if (!parsed) {
    logger.warn(
      {
        event: "post_call_summary_parse_failed",
        conversationId: input.conversationId,
        replyChars: text.length,
      },
      "post-call summary: could not parse model output",
    );
    return null;
  }
  return parsed;
}

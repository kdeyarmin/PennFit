// AI reply drafting for the CSR composer (Phase 4, CSR #15).
//
// Given a conversation's recent turns, ask Claude to draft a warm,
// accurate reply the CSR can edit before sending. The draft NEVER sends
// itself — it only populates the composer textarea; the human reviews
// and hits send through the existing /conversations/:id/reply path.
//
// Provider:
//   Claude (Sonnet 4.6) via @workspace/resupply-ai when
//   ANTHROPIC_API_KEY is set (selectLlmProvider). Returns a soft
//   "unavailable" result — never throws — when no Anthropic key is
//   configured, so the composer degrades to manual typing.
//
// PHI posture:
//   Message bodies ARE PHI. Before any text leaves PennPaps we run it
//   through `redactPiiForOutbound` (the same scrubber the storefront
//   chatbot uses) — phones, emails, DOBs, and long id runs become
//   `[redacted-*]` tokens. The patient's FIRST NAME is included for a
//   warm reply (same posture as the macro merge tokens); nothing
//   else identifying is sent. We log
//   redaction COUNTS only — never the bodies or the draft.

import { redactPiiForOutbound } from "../storefront/chatbotPii";
import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
  selectLlmProvider,
} from "../llm-provider";

/** The slice of a `messages` row this drafter needs. */
export interface DraftTurn {
  /** "inbound" (from the patient/customer) | "outbound" (from us). */
  direction: string;
  /** "patient" | "agent" | "system" | … — kept for future labeling. */
  sender_role: string;
  body: string;
}

export interface DraftReplyInput {
  channel: string;
  patientFirstName?: string | null;
  /** Oldest → newest. The drafter keeps only the most recent window. */
  turns: DraftTurn[];
  env?: NodeJS.ProcessEnv;
}

export interface BuiltDraftPrompt {
  system: string;
  user: string;
  /** Total PII tokens scrubbed from the transcript. */
  redactions: number;
}

export type DraftReplyResult =
  | {
      ok: true;
      draft: string;
      provider: "anthropic";
      redactions: number;
    }
  | {
      ok: false;
      reason: "offline" | "provider_unsupported" | "model_error" | "empty";
      redactions: number;
    };

/** Most recent N turns sent to the model — enough context, bounded cost. */
export const MAX_TURNS = 12;
/** Per-turn body cap so one giant paste can't blow the prompt budget. */
export const MAX_TURN_CHARS = 1000;

const SYSTEM_PROMPT = [
  "You are an assistant drafting a reply for a customer-service agent at",
  "PennPaps, a CPAP-resupply company. You are given the recent transcript",
  "of a conversation with a patient. Draft the agent's NEXT reply.",
  "",
  "Rules:",
  "- Write ONLY the reply text — no preamble, no sign-off block, no quotes,",
  "  no markdown, no 'Here is a draft:'.",
  "- Warm, concise, plain language. Match the channel: SMS = short (1–3",
  "  sentences); email = a short paragraph.",
  "- Be accurate. Do NOT invent order numbers, ship dates, prices, tracking",
  "  numbers, or clinical advice. If a fact is needed but not in the",
  "  transcript, ask a brief clarifying question or say you'll check.",
  "- Never include identifiers (phone, email, DOB, member id). Some appear",
  "  in the transcript as [redacted-*] — do not guess what they were.",
  "- If the patient seems distressed or it's clinical, be empathetic and",
  "  offer to connect them with the care team.",
].join("\n");

function speakerLabel(direction: string): string {
  return direction === "outbound" ? "Agent" : "Patient";
}

/**
 * Pure: turn the recent turns into a single redacted transcript string
 * (oldest→newest) plus the count of PII tokens scrubbed. No I/O.
 */
export function buildRedactedTranscript(turns: DraftTurn[]): {
  transcript: string;
  redactions: number;
} {
  // Drop blank turns FIRST, then keep the most recent window — so a
  // blank in the tail can't waste a slot the model could use for real
  // context.
  const recent = turns
    .filter((t) => (t.body ?? "").trim() !== "")
    .slice(-MAX_TURNS);
  let redactions = 0;
  const lines: string[] = [];
  for (const t of recent) {
    const raw = (t.body ?? "").slice(0, MAX_TURN_CHARS);
    const { text, counts } = redactPiiForOutbound(raw);
    redactions += Object.values(counts).reduce((a, b) => a + b, 0);
    lines.push(`${speakerLabel(t.direction)}: ${text.trim()}`);
  }
  return { transcript: lines.join("\n"), redactions };
}

/** Pure: assemble the system + user prompt for the drafter. */
export function buildDraftPrompt(input: DraftReplyInput): BuiltDraftPrompt {
  const { transcript, redactions } = buildRedactedTranscript(input.turns);
  const firstName = (input.patientFirstName ?? "").trim();
  const header = [
    `Channel: ${input.channel || "unknown"}`,
    firstName ? `Patient first name: ${firstName}` : null,
    "",
    "Transcript (oldest to newest):",
    transcript || "(no prior messages)",
    "",
    "Draft the agent's next reply:",
  ]
    .filter((l) => l !== null)
    .join("\n");
  return { system: SYSTEM_PROMPT, user: header, redactions };
}

/**
 * Draft a reply. Never throws; returns a soft result the route maps to a
 * 200 so the composer degrades gracefully when AI is unavailable.
 */
export async function draftConversationReply(
  input: DraftReplyInput,
): Promise<DraftReplyResult> {
  const env = input.env ?? process.env;
  const prompt = buildDraftPrompt(input);
  const selection = selectLlmProvider(env);

  if (selection.provider === "offline") {
    return { ok: false, reason: "offline", redactions: prompt.redactions };
  }
  if (selection.provider !== "anthropic") {
    // OpenAI text drafting isn't wired on this path yet — honest degrade
    // rather than a silent wrong-provider call.
    return {
      ok: false,
      reason: "provider_unsupported",
      redactions: prompt.redactions,
    };
  }

  const client = getAnthropicClient(env);
  if (!client) {
    return { ok: false, reason: "offline", redactions: prompt.redactions };
  }

  const result = await client.send({
    model: DEFAULT_ANTHROPIC_MODEL_CHAT,
    max_tokens: 600,
    temperature: 0.5,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });
  if (!result.ok) {
    return { ok: false, reason: "model_error", redactions: prompt.redactions };
  }
  const draft = getResponseText(result.response).trim();
  if (draft === "") {
    return { ok: false, reason: "empty", redactions: prompt.redactions };
  }
  return {
    ok: true,
    draft,
    provider: "anthropic",
    redactions: prompt.redactions,
  };
}

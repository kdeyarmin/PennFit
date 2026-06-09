// Email auto-reply generator — lets the storefront chatbot "brain"
// read an inbound patient email and draft a reply.
//
// This is the email sibling of `ai-fallback-impl.ts` (which drafts SMS
// replies). It reuses the SAME knowledge base the public `/api/chat`
// widget is grounded in (`buildChatSystemPrompt()`), so the assistant
// answers product / insurance / replacement-schedule / returns / setup /
// sleep-apnea-education questions over email with the same voice and the
// same facts — no second source of truth to drift.
//
// Provider selection mirrors the rest of the stack: Claude Sonnet 4.6
// when `ANTHROPIC_API_KEY` is set (warmer patient-facing copy), else
// `gpt-4o-mini`, else "offline".
//
// Safety posture (why this is conservative by design):
//   Email replies to a KNOWN patient are a bigger blast radius than the
//   anonymous web widget. So the model is asked for a structured
//   `{ handoff, reply }` decision and we ONLY send the reply when the
//   model is confident it can answer from general knowledge alone. Any
//   message that needs this person's order/account/shipment specifics, an
//   address/billing/insurance change, clinical judgement, a complaint, or
//   that explicitly asks for a human → `handoff: true`, and the caller
//   leaves the thread in `awaiting_admin` for a teammate. Any error,
//   empty output, or "offline" provider also degrades to handoff. The
//   human-review path is never removed — only short-circuited when the
//   bot can clearly help.
//
// PHI containment:
//   The inbound body + thread snippets are scrubbed through
//   `redactPiiForOutbound` (phone / email / SSN / DOB / long id runs)
//   before they reach the model, exactly like the web chat route. The
//   system prompt additionally forbids echoing any identifying detail in
//   the reply. We never send patient name, address, or DB metadata.

import {
  createAnthropicClient,
  getResponseText,
  sendWithRetry,
} from "@workspace/resupply-ai";

import { logger } from "../logger";
import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  selectLlmProvider,
} from "../llm-provider";
import { buildChatSystemPrompt } from "../storefront/chatbotKnowledge";
import { redactPiiForOutbound } from "../storefront/chatbotPii";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
// The patient already waited minutes-to-hours before replying; there is
// no latency pressure, so favour a generous timeout over a flaky cut-off.
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 700;
// Keep a couple of prior turns for context without paying for the whole
// thread. Matches the SMS fallback's window.
const MAX_THREAD_TURNS = 6;
const MAX_THREAD_BODY_CHARS = 600;
const MAX_INBOUND_BODY_CHARS = 4_000;

/**
 * Instruction block appended to the shared chatbot knowledge base. It
 * reframes the assistant for the email channel and pins the structured
 * `{ handoff, reply }` output contract + the hand-off rules.
 */
const EMAIL_REPLY_ADDENDUM = [
  "",
  "----------------------------------------------------------------",
  "EMAIL REPLY MODE",
  "",
  "You are now replying BY EMAIL to a message a patient or customer sent",
  "to PennPaps. Everything above is your knowledge base — use it to answer.",
  "",
  "First decide whether you can fully and safely answer using ONLY general",
  "knowledge (products, insurance basics, replacement schedules, returns &",
  "comfort guarantee, CPAP setup/troubleshooting, sleep-apnea education,",
  'how the service works). Set "handoff": true (and leave "reply" empty)',
  "when the message:",
  "  - asks about THIS person's specific order, shipment, tracking number,",
  "    account, subscription status, or a payment/charge,",
  "  - requests or disputes a change to their address, billing, insurance",
  "    claim, prescription on file, or a refund,",
  "  - describes a medical or clinical problem that needs judgement, an",
  "    adverse reaction, an injury, or a device-safety concern,",
  "  - is a complaint, a legal/privacy/records request, or explicitly asks",
  "    to speak with a person,",
  "  - or anything you are not confident you can answer correctly.",
  "When in doubt, hand off — a teammate following up is always acceptable;",
  "a wrong or made-up answer is not.",
  "",
  'When you CAN answer, write "reply" as a complete, ready-to-send email',
  "body: a short friendly greeting, the answer in a warm conversational",
  "tone (contractions, no corporate boilerplate), and end with the sign-off",
  "line exactly: — The PennPaps Team. Plain text only — no markdown, no",
  "bullet characters, no links other than plain https:// URLs. Keep it",
  "concise (a few short paragraphs at most).",
  "",
  "NEVER include the recipient's name, date of birth, phone number, full",
  "address, or insurance/member id in the reply, even if it appeared in",
  "their message. NEVER invent clinical, pricing, or order facts.",
  "",
  'Also REPORT YOUR CONFIDENCE in the reply as a number "confidence"',
  "between 0 and 1: how sure you are that your answer is correct, complete,",
  "and safe to send WITHOUT a human reviewing it first. Use ~0.95+ only",
  "when the question is squarely general CPAP/insurance/returns knowledge",
  "and your answer is unambiguous. Use ~0.6 when your answer is probably",
  "right but the question is a little ambiguous or partly specific to this",
  "person. Use ~0.3 when you're guessing. Only HIGH-confidence replies are",
  "sent automatically; anything below the bar is routed to a human, so",
  "report your honest doubt rather than inflating — an unsent reply just",
  "means a teammate follows up, which is always fine.",
  "",
  'OUTPUT STRICT JSON ONLY (no prose, no markdown fences): { "handoff":',
  'true|false, "reply": "...", "confidence": 0.0..1.0 }',
].join("\n");

// Only replies the model is at least this confident in are sent
// automatically; everything below routes to a human (awaiting_admin).
// Deliberately conservative — a missed auto-reply costs a teammate a
// follow-up, but a wrong one was sent to a patient. Overridable per
// environment via RESUPPLY_EMAIL_AUTO_REPLY_MIN_CONFIDENCE.
const DEFAULT_MIN_AUTO_REPLY_CONFIDENCE = 0.8;

function resolveMinConfidence(env: NodeJS.ProcessEnv): number {
  const raw = env.RESUPPLY_EMAIL_AUTO_REPLY_MIN_CONFIDENCE?.trim();
  if (!raw) return DEFAULT_MIN_AUTO_REPLY_CONFIDENCE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_MIN_AUTO_REPLY_CONFIDENCE;
  }
  return parsed;
}

export interface EmailReplyThreadTurn {
  role: "patient" | "agent";
  body: string;
}

export interface EmailReplyInput {
  /** The patient's latest inbound plaintext body. */
  body: string;
  /** The inbound subject line, if any (used only for context framing). */
  subject: string | null;
  /** Prior turns on the thread, oldest first. */
  thread: EmailReplyThreadTurn[];
}

export type EmailReplyResult =
  | { kind: "reply"; reply: string }
  /** The model (or our gate) decided a human should handle this. */
  | { kind: "handoff" }
  /** No LLM provider configured — caller should route to a human. */
  | { kind: "offline" };

// The composed system prompt (knowledge base + email addendum) is large
// and identical across calls; cache it with a short TTL so an admin-side
// catalog/FAQ edit becomes visible within minutes, mirroring the web
// chat route's cache.
const SYSTEM_PROMPT_TTL_MS = 10 * 60 * 1000;
let cachedSystemPrompt: string | null = null;
let cachedSystemPromptAtMs = 0;
function getEmailSystemPrompt(): string {
  const now = Date.now();
  if (
    cachedSystemPrompt === null ||
    now - cachedSystemPromptAtMs > SYSTEM_PROMPT_TTL_MS
  ) {
    cachedSystemPrompt = buildChatSystemPrompt() + "\n" + EMAIL_REPLY_ADDENDUM;
    cachedSystemPromptAtMs = now;
  }
  return cachedSystemPrompt;
}

/** Test seam — drop the cached system prompt. */
export function __resetEmailAutoReplyCacheForTests(): void {
  cachedSystemPrompt = null;
  cachedSystemPromptAtMs = 0;
}

let fetchImplOverride: typeof fetch | undefined;
/** Test seam — override the fetch used by the OpenAI path. */
export function __setEmailAutoReplyFetchForTests(
  impl: typeof fetch | undefined,
): void {
  fetchImplOverride = impl;
}

/**
 * Draft an email reply to an inbound patient message using the chatbot
 * knowledge base. Only replies the model is confident in (>= the
 * configured threshold) come back as `{ kind: "reply" }`; everything
 * else — explicit hand-off, low confidence, empty output — collapses to
 * `{ kind: "handoff" }` (or `{ kind: "offline" }` when no provider is
 * configured). NEVER throws, so a flaky model call can never 500 a
 * SendGrid webhook.
 */
export async function generateEmailReply(
  input: EmailReplyInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmailReplyResult> {
  const selection = selectLlmProvider(env);
  if (selection.provider === "offline") {
    return { kind: "offline" };
  }

  const userPrompt = buildUserPrompt(input);
  const systemPrompt = getEmailSystemPrompt();
  const minConfidence = resolveMinConfidence(env);

  if (selection.provider === "anthropic") {
    return generateViaAnthropic(env, systemPrompt, userPrompt, minConfidence);
  }
  return generateViaOpenAi(env, systemPrompt, userPrompt, minConfidence);
}

async function generateViaAnthropic(
  env: NodeJS.ProcessEnv,
  systemPrompt: string,
  userPrompt: string,
  minConfidence: number,
): Promise<EmailReplyResult> {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { kind: "handoff" };
  try {
    const client = createAnthropicClient({
      apiKey,
      fetchImpl: fetchImplOverride,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const result = await sendWithRetry(client, {
      model: DEFAULT_ANTHROPIC_MODEL_CHAT,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0.4,
      // cache_control: the knowledge-base system prompt is the bulk of
      // every request and identical call-to-call. Caching pays back
      // ~90% of input token cost on repeated inbound emails.
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
        {
          event: "email_auto_reply_llm_error",
          vendor: "anthropic",
          code: result.errorCode,
          status: result.httpStatus,
        },
        "email-auto-reply: anthropic call failed — handing off",
      );
      return { kind: "handoff" };
    }
    return parseModelOutput(
      "anthropic",
      getResponseText(result.response),
      minConfidence,
    );
  } catch (err) {
    logger.warn(
      {
        event: "email_auto_reply_exception",
        vendor: "anthropic",
        err: serializeErr(err),
      },
      "email-auto-reply: anthropic exception — handing off",
    );
    return { kind: "handoff" };
  }
}

async function generateViaOpenAi(
  env: NodeJS.ProcessEnv,
  systemPrompt: string,
  userPrompt: string,
  minConfidence: number,
): Promise<EmailReplyResult> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) return { kind: "handoff" };
  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_CHAT_MODEL?.trim() || OPENAI_DEFAULT_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.4,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const safeDetail = detail
        .slice(0, 200)
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
        .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
      logger.warn(
        {
          event: "email_auto_reply_llm_error",
          vendor: "openai",
          status: res.status,
          detail: safeDetail,
        },
        "email-auto-reply: openai HTTP error — handing off",
      );
      return { kind: "handoff" };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return parseModelOutput(
      "openai",
      json.choices?.[0]?.message?.content ?? "",
      minConfidence,
    );
  } catch (err) {
    logger.warn(
      {
        event: "email_auto_reply_exception",
        vendor: "openai",
        err: serializeErr(err),
      },
      "email-auto-reply: openai exception — handing off",
    );
    return { kind: "handoff" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the user message: prior thread turns (scrubbed) followed by the
 * latest inbound (scrubbed). Subject is included as a single context
 * line — not as an instruction — so the model can disambiguate terse
 * replies ("yes please") against the original topic.
 */
function buildUserPrompt(input: EmailReplyInput): string {
  const lines: string[] = [];
  const subject = (input.subject ?? "").trim();
  if (subject) {
    lines.push(`Email subject: ${truncate(scrub(subject), 200)}`);
    lines.push("");
  }
  const thread = input.thread.slice(-MAX_THREAD_TURNS);
  if (thread.length > 0) {
    lines.push("Recent thread (oldest first):");
    for (const t of thread) {
      const role = t.role === "patient" ? "patient" : "you (assistant)";
      lines.push(
        `- ${role}: ${truncate(scrub(t.body), MAX_THREAD_BODY_CHARS)}`,
      );
    }
    lines.push("");
  }
  lines.push("Most recent message from the patient (reply to this):");
  lines.push(truncate(scrub(input.body), MAX_INBOUND_BODY_CHARS));
  return lines.join("\n");
}

function scrub(s: string): string {
  return redactPiiForOutbound(s).text;
}

function parseModelOutput(
  vendor: "anthropic" | "openai",
  content: string,
  minConfidence: number,
): EmailReplyResult {
  let parsed: { handoff?: unknown; reply?: unknown; confidence?: unknown };
  try {
    // Tolerate a stray markdown fence the model occasionally wraps JSON in.
    const cleaned = content
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");
    parsed = JSON.parse(cleaned) as {
      handoff?: unknown;
      reply?: unknown;
      confidence?: unknown;
    };
  } catch {
    logger.warn(
      { event: "email_auto_reply_parse_failed", vendor },
      "email-auto-reply: could not parse model output — handing off",
    );
    return { kind: "handoff" };
  }
  const handoff = parsed.handoff === true;
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  // Confidence is required to clear the bar. A model that omits it (older
  // fine-tune, malformed output) is treated as "no signal" → below the
  // bar → hand off. Clamp in case the model overshoots [0,1].
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  // Hand off on: explicit handoff, an empty/whitespace reply (nothing to
  // send), or confidence below the configured bar. Only a confident,
  // non-empty, non-handoff reply is sent automatically.
  const belowBar = confidence === undefined || confidence < minConfidence;
  if (handoff || reply.length === 0 || belowBar) {
    logger.info(
      {
        event: "email_auto_reply_decided",
        vendor,
        handoff: true,
        reason: handoff
          ? "model_handoff"
          : reply.length === 0
            ? "empty_reply"
            : "low_confidence",
        confidence: confidence ?? null,
        min_confidence: minConfidence,
      },
      "email-auto-reply: handing off to human",
    );
    return { kind: "handoff" };
  }
  logger.info(
    {
      event: "email_auto_reply_decided",
      vendor,
      handoff: false,
      replyChars: reply.length,
      confidence,
      min_confidence: minConfidence,
    },
    "email-auto-reply: drafted high-confidence reply",
  );
  return { kind: "reply", reply };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

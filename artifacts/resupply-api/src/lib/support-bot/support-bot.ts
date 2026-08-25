// Support-ticket intake bot.
//
// When a tenant files a support ticket, this drafts an immediate answer
// from the SAME admin-console knowledge base PennPilot is grounded in
// (`buildAdminAssistantSystemPrompt`), so "how do I do X / where is the
// page that does Y" questions are answered on intake with the same facts
// and the same app map — no second source of truth to drift.
//
// It is the support sibling of `messaging/email-auto-reply.ts`: the model
// returns a structured `{ handoff, reply, confidence }` decision and we
// only auto-answer when it clears the confidence bar. Anything it can't
// confidently answer — account/billing specifics, a bug report, a
// feature request, an explicit "I need a person", or low confidence —
// returns a hand-off so the ticket lands in the platform support queue
// for a human. Any error, empty output, or "offline" provider (no AI key)
// also degrades to a hand-off. NEVER throws, so a flaky model call can't
// 500 the ticket-create request.
//
// Logging: never logs the ticket body (treat every log line as
// world-readable). Only event + vendor + confidence + reply length.

import {
  createAnthropicClient,
  getResponseText,
  sendWithRetry,
} from "@workspace/resupply-ai";

import {
  buildAdminAssistantSystemPrompt,
  type AdminAssistantContext,
} from "../admin-assistant/adminAssistantKnowledge";
import {
  applyCompanyIdentityToText,
  applyPlatformBranding,
  getPlatformIdentity,
} from "../company-info";
import { logger } from "../logger";
import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  selectLlmProvider,
} from "../llm-provider";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 800;
const MAX_SUBJECT_CHARS = 300;
const MAX_BODY_CHARS = 6_000;

// Only answers the model is at least this confident in are sent back
// automatically; everything below escalates to a human (awaiting_platform).
// Slightly lower than the patient-facing email bar (0.8) — the audience is
// staff asking "how do I" questions (lower blast radius) — but still
// conservative. Overridable via RESUPPLY_SUPPORT_BOT_MIN_CONFIDENCE.
const DEFAULT_MIN_CONFIDENCE = 0.7;

function resolveMinConfidence(env: NodeJS.ProcessEnv): number {
  const raw = env.RESUPPLY_SUPPORT_BOT_MIN_CONFIDENCE?.trim();
  if (!raw) return DEFAULT_MIN_CONFIDENCE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_MIN_CONFIDENCE;
  }
  return parsed;
}

/**
 * Instruction block appended to the PennPilot knowledge base. Reframes
 * the assistant for the support-ticket channel and pins the structured
 * `{ handoff, reply, confidence }` output contract + the hand-off rules.
 */
const SUPPORT_ADDENDUM = [
  "",
  "----------------------------------------------------------------",
  "SUPPORT TICKET MODE",
  "",
  "A tenant (a DME practice that uses this platform) just filed a SUPPORT",
  "TICKET. Everything above is your knowledge base — use it to answer their",
  "question about how to use the app.",
  "",
  "First decide whether you can fully and correctly answer using ONLY that",
  "knowledge (how features work, where pages live, how to do a task). Set",
  '"handoff": true (and leave "reply" empty) when the ticket:',
  "  - reports a BUG, an error, something broken, or asks you to change data,",
  "  - is a FEATURE REQUEST or asks for something the app doesn't do,",
  "  - needs this tenant's account/billing/subscription specifics or an",
  "    action only a platform operator can take,",
  "  - is a complaint, a security/privacy/legal matter, or explicitly asks",
  "    for a human,",
  "  - or anything you are not confident you can answer correctly.",
  "When in doubt, hand off — a teammate following up is always fine; a wrong",
  "or made-up answer is not.",
  "",
  'When you CAN answer, write "reply" as a complete, ready-to-send support',
  "reply: a brief friendly greeting, clear step-by-step guidance in a warm",
  "conversational tone (contractions, no corporate boilerplate), naming the",
  "exact admin pages/menus to use, and a short closing offering to help",
  "further. Plain text only — no markdown fences, no bullet characters other",
  "than '-', and only plain https:// links.",
  "",
  "NEVER invent a feature, a page, a price, or a setting that isn't in your",
  "knowledge base. Never echo any patient detail the ticket may contain.",
  "",
  'Also REPORT YOUR CONFIDENCE as a number "confidence" between 0 and 1: how',
  "sure you are the answer is correct and complete enough to send WITHOUT a",
  "human reviewing it. Use ~0.9+ only when the question is squarely about how",
  "the app works and your answer is unambiguous. Use ~0.5 when it's partly",
  "ambiguous. Use ~0.3 when you're guessing. Only high-confidence answers are",
  "sent automatically; report honest doubt rather than inflating it.",
  "",
  'OUTPUT STRICT JSON ONLY (no prose, no markdown fences): { "handoff":',
  'true|false, "reply": "...", "confidence": 0.0..1.0 }',
].join("\n");

export interface SupportBotInput {
  subject: string;
  body: string;
  adminEmail: string | null;
  adminRole: "admin" | "agent" | null;
}

export type SupportBotResult =
  /** A confident answer to send back automatically. */
  | { kind: "answer"; reply: string; confidence: number }
  /** The model (or our gate) decided a human should handle this. */
  | { kind: "handoff" }
  /** No LLM provider configured — caller routes to a human. */
  | { kind: "offline" };

/**
 * Normalize the STATIC prompt text to the PLATFORM's own names.
 *
 * This desk answers AS CareMetric Breathe, to a tenant that is not this
 * deployment's seed tenant — so it must not inherit the seed's identity the
 * way a tenant-scoped surface does. `getPlatformIdentity()` maps PennFit →
 * CareMetric Breathe, PennBot/PennPilot → the platform assistant names, and
 * any residual tenant placeholder in the shared knowledge base → the
 * platform's own site and mailbox.
 *
 * Safe to apply wholesale here because every byte is text WE wrote. Do not
 * reuse it on model output — see `brandPlaceholdersOnly` below.
 */
function brandPromptAsPlatform(text: string): string {
  const identity = getPlatformIdentity();
  return applyCompanyIdentityToText(
    applyPlatformBranding(text, identity),
    identity,
  );
}

/**
 * The reply-side normalizer: platform/assistant CODENAMES only.
 *
 * `applyCompanyIdentityToText` is deliberately NOT applied to model output.
 * Its needles are tenant CONTACT DATA — `pennpaps.com`, `info@pennpaps.com`,
 * `(814) 471-0627` — and a reply may legitimately quote those back when the
 * ticket itself is about them ("why isn't pennpaps.com resolving?"). Against
 * the platform identity those rewrites turn correct tenant-specific guidance
 * into wrong guidance, and the phone needles map to the empty string (the
 * platform has no support line), which would silently DELETE the number the
 * operator asked about.
 *
 * `applyPlatformBranding` has no such hazard: `PennFit` / `PennBot` /
 * `PennPilot` are internal codenames with no legitimate use in a support
 * answer, so mapping them to the product's real names is right no matter who
 * put them there. The prompt is already branded, so this is only a net for a
 * token the model produced on its own.
 */
function brandPlaceholdersOnly(text: string): string {
  return applyPlatformBranding(text, getPlatformIdentity());
}

function buildSystemPrompt(input: SupportBotInput): string {
  const ctx: AdminAssistantContext = {
    adminEmail: input.adminEmail,
    adminRole: input.adminRole,
  };
  return brandPromptAsPlatform(
    buildAdminAssistantSystemPrompt(ctx) + "\n" + SUPPORT_ADDENDUM,
  );
}

export function buildSupportUserPrompt(input: SupportBotInput): string {
  const lines: string[] = [];
  const subject = input.subject.trim();
  if (subject) {
    lines.push(`Ticket subject: ${truncate(subject, MAX_SUBJECT_CHARS)}`);
    lines.push("");
  }
  lines.push("Ticket from the tenant (answer this):");
  lines.push(truncate(input.body.trim(), MAX_BODY_CHARS));
  return lines.join("\n");
}

let fetchImplOverride: typeof fetch | undefined;
/** Test seam — override the fetch used by the OpenAI path. */
export function __setSupportBotFetchForTests(
  impl: typeof fetch | undefined,
): void {
  fetchImplOverride = impl;
}

/**
 * Draft an answer to a support ticket. Returns `{ kind: "answer" }` only
 * when the model is confident enough to auto-resolve; otherwise
 * `{ kind: "handoff" }` (a human handles it) or `{ kind: "offline" }`
 * (no provider configured). Never throws.
 */
export async function answerSupportTicket(
  input: SupportBotInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SupportBotResult> {
  const selection = selectLlmProvider(env);
  if (selection.provider === "offline") return { kind: "offline" };

  let systemPrompt: string;
  try {
    systemPrompt = buildSystemPrompt(input);
  } catch (err) {
    // buildAdminAssistantSystemPrompt throws only if the static prompt
    // exceeds its char cap — a deploy-time bug, not a per-request one.
    // Degrade to a hand-off rather than failing the ticket create.
    logger.warn(
      { event: "support_bot_prompt_failed", err: serializeErr(err) },
      "support-bot: system prompt build failed — handing off",
    );
    return { kind: "handoff" };
  }
  const userPrompt = buildSupportUserPrompt(input);
  const minConfidence = resolveMinConfidence(env);

  if (selection.provider === "anthropic") {
    return viaAnthropic(env, systemPrompt, userPrompt, minConfidence);
  }
  return viaOpenAi(env, systemPrompt, userPrompt, minConfidence);
}

async function viaAnthropic(
  env: NodeJS.ProcessEnv,
  systemPrompt: string,
  userPrompt: string,
  minConfidence: number,
): Promise<SupportBotResult> {
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
          event: "support_bot_llm_error",
          vendor: "anthropic",
          code: result.errorCode,
          status: result.httpStatus,
        },
        "support-bot: anthropic call failed — handing off",
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
        event: "support_bot_exception",
        vendor: "anthropic",
        err: serializeErr(err),
      },
      "support-bot: anthropic exception — handing off",
    );
    return { kind: "handoff" };
  }
}

async function viaOpenAi(
  env: NodeJS.ProcessEnv,
  systemPrompt: string,
  userPrompt: string,
  minConfidence: number,
): Promise<SupportBotResult> {
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
          event: "support_bot_llm_error",
          vendor: "openai",
          status: res.status,
          detail: safeDetail,
        },
        "support-bot: openai HTTP error — handing off",
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
        event: "support_bot_exception",
        vendor: "openai",
        err: serializeErr(err),
      },
      "support-bot: openai exception — handing off",
    );
    return { kind: "handoff" };
  } finally {
    clearTimeout(timer);
  }
}

export function parseModelOutput(
  vendor: "anthropic" | "openai",
  content: string,
  minConfidence: number,
): SupportBotResult {
  let parsed: { handoff?: unknown; reply?: unknown; confidence?: unknown };
  try {
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
      { event: "support_bot_parse_failed", vendor },
      "support-bot: could not parse model output — handing off",
    );
    return { kind: "handoff" };
  }
  const handoff = parsed.handoff === true;
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : undefined;

  const belowBar = confidence === undefined || confidence < minConfidence;
  if (handoff || reply.length === 0 || belowBar) {
    logger.info(
      {
        event: "support_bot_decided",
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
      "support-bot: escalating to a human",
    );
    return { kind: "handoff" };
  }
  logger.info(
    {
      event: "support_bot_decided",
      vendor,
      handoff: false,
      replyChars: reply.length,
      confidence,
      min_confidence: minConfidence,
    },
    "support-bot: drafted high-confidence answer",
  );
  // Belt-and-braces: the prompt is already platform-branded, so the model
  // shouldn't have a codename to echo — but this reply is sent to a tenant
  // unreviewed, and a stray one would name another customer. Codenames only;
  // tenant contact data quoted back from the ticket must survive verbatim
  // (see brandPlaceholdersOnly).
  return { kind: "answer", reply: brandPlaceholdersOnly(reply), confidence };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

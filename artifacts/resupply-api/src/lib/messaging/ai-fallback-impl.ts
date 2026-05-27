// AI fallback adapter — Claude Haiku 4.5 with OpenAI as fallback.
//
// Why this lives in the API process (and NOT in `lib/resupply-messaging`):
//   resupply-messaging is the pure semantic layer (Rule 11). It must
//   not import any vendor SDK. The interface (`AiFallbackAdapter`) is
//   defined there; concrete impls live wherever they need their SDK.
//
// Provider selection (May 2026 update):
//   When ANTHROPIC_API_KEY is set, we use Claude Haiku 4.5 — same
//   class of cost/latency as gpt-4o-mini, but the auto-generated SMS
//   reply text reads noticeably more like a human ("got it" vs
//   "I have received your message"). When only OPENAI_API_KEY is
//   configured, we fall back to gpt-4o-mini.
//
// PHI containment:
//   We send THREE strings to the model per call:
//     1. The system prompt (no PHI — just the intent menu).
//     2. The patient's most recent inbound text.
//     3. Optional thread snippets (last N messages) to disambiguate
//        ambiguous one-word replies. The caller is responsible for
//        choosing the snippet set; we do not crack open the DB here.
//   We do NOT send patient name, DOB, address, or any admin-only
//   metadata. The system prompt instructs the model to NEVER echo PHI
//   in its `reply` even if the patient included it inbound.
//
// Failure mode:
//   Any error (HTTP failure, malformed JSON, timeout, model-says-no)
//   collapses to `{intent: 'unknown'}` — the caller will then escalate
//   to a human admin. We never throw out of `classify()`: a runtime
//   crash in the LLM path must NOT 500 a successful Twilio webhook.

import {
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  createAnthropicClient,
  getResponseText,
  sendWithRetry,
  type AnthropicClient,
} from "@workspace/resupply-ai";
import type {
  AiFallbackAdapter,
  AiFallbackInput,
  AiFallbackResult,
  Intent,
} from "@workspace/resupply-messaging";
import { INTENT_NAMES } from "@workspace/resupply-messaging";

import { logger } from "../logger";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
// 10s timeout (was 5s). SMS classification runs after the patient has
// already taken hours to reply — the model has no latency pressure
// from the patient's side. The previous 5s ceiling was tight enough
// to flake on a routine OpenAI/Anthropic capacity blip even when the
// retry pass would have recovered.
const DEFAULT_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT = [
  "You are an SMS reply assistant for a CPAP resupply service. The patient",
  "just texted us back after we sent them a refill reminder. Your job is",
  "two things:",
  "",
  "1) CLASSIFY the message into exactly one of these intents:",
  "   - confirm: patient agrees to ship the resupply order as proposed.",
  "   - decline: patient does NOT want the resupply order.",
  "   - edit_address: patient says their shipping address has changed",
  "     or is wrong.",
  "   - stop: patient asks to stop / unsubscribe / opt out of all messages.",
  "   - help: patient asks what this is, how it works, or wants a human.",
  "   - unknown: anything else, including ambiguous replies.",
  "",
  "2) WRITE A SHORT, HUMAN-SOUNDING REPLY (max 160 chars so it fits in",
  "   one SMS segment). Match the patient's energy. Use contractions.",
  "   No corporate boilerplate.",
  "",
  "EXAMPLES (intent → reply):",
  "   confirm → \"Got it! We'll ship today. You'll get tracking by text.\"",
  "   decline → \"No problem — we'll hold off. Reply YES anytime if you",
  "             change your mind.\"",
  "   edit_address → \"Sounds good — we'll text you a quick link to",
  "                   update it.\"",
  "   stop → \"You're unsubscribed. Reply START to opt back in anytime.\"",
  "   help → \"Sure! A teammate will reach out shortly. Or call us at",
  "           (814) 471-0627 Mon-Fri 9-5 ET.\"",
  "   unknown → \"Thanks for writing — a teammate will follow up shortly.\"",
  "",
  "3) REPORT YOUR CONFIDENCE in the classification as a number between",
  "   0 and 1. Use ~0.95+ when the patient's reply is unambiguous (\"yes",
  "   ship it\", \"STOP\", a clean address). Use ~0.6 when the reply is",
  "   plausible but ambiguous (\"sure I guess\", a one-word reply that",
  "   could mean two things). Use ~0.3 when you're guessing. The action-",
  "   taking intents (confirm/decline/edit_address) are only honored when",
  "   confidence is high; low-confidence classifications get routed to a",
  "   human, so it is safer to report your honest doubt than to inflate.",
  "",
  'OUTPUT STRICT JSON: { "intent": "confirm"|"decline"|"edit_address"|"stop"|"help"|"unknown", "reply": "...", "confidence": 0.0..1.0 }',
  "",
  "RULES:",
  "- NEVER include the patient's name, address, date of birth, phone, or",
  "  any other identifying detail in `reply` even if it appeared in the",
  "  inbound text.",
  "- NEVER make up clinical or medical information.",
  "- When unsure, intent=unknown with a polite handoff reply and",
  "  confidence near 0.3.",
  "- Output JSON ONLY. No prose, no markdown fences.",
].join("\n");

export interface OpenAiFallbackOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam — overrides global fetch. */
  fetchImpl?: typeof fetch;
}

export function createOpenAiFallbackAdapter(
  opts: OpenAiFallbackOptions,
): AiFallbackAdapter {
  const apiKey = opts.apiKey;
  const model = opts.model ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  if (!apiKey) {
    throw new Error(
      "createOpenAiFallbackAdapter: apiKey is required (set OPENAI_API_KEY).",
    );
  }

  return {
    async classify(input: AiFallbackInput): Promise<AiFallbackResult> {
      const userPrompt = buildUserPrompt(input);
      // Retry once on transient errors. Same posture as the
      // Anthropic path so the OpenAI fallback isn't a less-reliable
      // citizen — particularly during burst classification windows
      // where a 429 storm would otherwise dump every reply on CSR.
      const MAX_RETRIES = 1;
      for (let attempt = 0; ; attempt++) {
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
              max_tokens: 200,
              messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
              ],
            }),
          });
          if (!res.ok) {
            const detail = await res.text().catch(() => "");
            // Redact Bearer tokens and OpenAI key prefixes — a 401
            // response from OpenAI echoes the offending key prefix
            // in the error body. Our application logs are treated
            // as world-readable per CLAUDE.md.
            const safeDetail = detail
              .slice(0, 200)
              .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
              .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
            const retryable = res.status === 429 || res.status >= 500;
            logger.warn(
              {
                event: "ai_fallback_http_error",
                vendor: "openai",
                status: res.status,
                detail: safeDetail,
                attempt,
                retryable,
              },
              "ai-fallback: openai HTTP error",
            );
            if (retryable && attempt < MAX_RETRIES) {
              await new Promise((r) =>
                setTimeout(r, 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 50)),
              );
              continue;
            }
            return { intent: "unknown" };
          }
          const json = (await res.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = json.choices?.[0]?.message?.content ?? "";
          const result = parseModelOutput(content);
          logClassification("openai", input, result);
          return result;
        } catch (err) {
          const isAbort = err instanceof Error && err.name === "AbortError";
          // AbortError (timeout) and fetch transport failures retry.
          // In Node's undici fetch, transient network failures (DNS,
          // socket reset, ECONNREFUSED) are surfaced as TypeError with
          // messages like "fetch failed" — those are exactly the
          // class of error retry was added for. Programming-bug
          // TypeErrors reproduce instantly so one retry is cheap.
          const retryable = isAbort || err instanceof TypeError;
          logger.warn(
            {
              event: "ai_fallback_exception",
              vendor: "openai",
              attempt,
              kind: isAbort ? "timeout" : "transport",
              err: serializeErr(err),
            },
            retryable && attempt < MAX_RETRIES
              ? "ai-fallback: openai exception (retrying)"
              : "ai-fallback: openai exception (returning unknown)",
          );
          if (retryable && attempt < MAX_RETRIES) {
            await new Promise((r) =>
              setTimeout(r, 200 * Math.pow(2, attempt) + Math.floor(Math.random() * 50)),
            );
            continue;
          }
          return { intent: "unknown" };
        } finally {
          clearTimeout(timer);
        }
      }
    },
  };
}

export interface AnthropicFallbackOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam — overrides global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Claude Haiku 4.5 implementation of the same intent-classifier
 * contract. Same JSON output shape, same `{intent: 'unknown'}`
 * fail-soft posture, but the reply text reads noticeably more like
 * a human ("got it" vs "I have received your message"). Use this
 * when ANTHROPIC_API_KEY is set; the route handler should pick
 * between the two adapters.
 */
export function createAnthropicFallbackAdapter(
  opts: AnthropicFallbackOptions,
): AiFallbackAdapter {
  const apiKey = opts.apiKey;
  if (!apiKey) {
    throw new Error(
      "createAnthropicFallbackAdapter: apiKey is required (set ANTHROPIC_API_KEY).",
    );
  }
  const client: AnthropicClient = createAnthropicClient({
    apiKey,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL_CLASSIFY;

  return {
    async classify(input: AiFallbackInput): Promise<AiFallbackResult> {
      try {
        const userPrompt = buildUserPrompt(input);
        // Retry once on transient errors (429, 5xx, timeout,
        // transport blip). Burst classification windows during a
        // bulk-reminder send are the most common failure mode and
        // benefit most from a small backoff before falling back to
        // intent=unknown (which sends the patient to CSR).
        const result = await sendWithRetry(client, {
          model,
          max_tokens: 250,
          temperature: 0,
          // cache_control: ephemeral — the system prompt is ~600
          // tokens and identical across every classify() call. Caching
          // pays back ~95% of the input cost on every burst (Twilio
          // typically fires several inbound SMS classifications per
          // minute during a campaign send window). Mirrors the
          // chatbot / sleep-coach / post-call-summary pattern.
          system: [
            { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
          ],
          messages: [{ role: "user", content: userPrompt }],
        });
        if (!result.ok) {
          logger.warn(
            {
              event: "ai_fallback_http_error",
              vendor: "anthropic",
              code: result.errorCode,
              status: result.httpStatus,
            },
            "ai-fallback: anthropic call failed",
          );
          return { intent: "unknown" };
        }
        const parsed = parseModelOutput(getResponseText(result.response));
        logClassification("anthropic", input, parsed);
        return parsed;
      } catch (err) {
        logger.warn(
          {
            event: "ai_fallback_exception",
            vendor: "anthropic",
            err: serializeErr(err),
          },
          "ai-fallback: anthropic exception (returning unknown)",
        );
        return { intent: "unknown" };
      }
    },
  };
}

/**
 * Factory that picks an adapter based on env. Prefers Anthropic
 * (Claude Haiku 4.5) when ANTHROPIC_API_KEY is set, otherwise uses
 * OpenAI (gpt-4o-mini). Returns null when neither is configured —
 * callers should route to a human-handoff path in that case.
 */
export function createAiFallbackAdapter(
  env: NodeJS.ProcessEnv = process.env,
): AiFallbackAdapter | null {
  const anthropicKey = env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return createAnthropicFallbackAdapter({ apiKey: anthropicKey });
  }
  const openaiKey = env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return createOpenAiFallbackAdapter({ apiKey: openaiKey });
  }
  return null;
}

function buildUserPrompt(input: AiFallbackInput): string {
  const lines: string[] = [];
  if (input.thread && input.thread.length > 0) {
    lines.push("Recent thread (oldest first):");
    for (const t of input.thread) {
      // role + body only — no timestamps, no patient ids.
      const role = t.role === "patient" ? "patient" : "agent";
      lines.push(`- ${role}: ${truncate(t.body, 200)}`);
    }
    lines.push("");
  }
  lines.push("Most recent patient reply:");
  lines.push(truncate(input.body, 500));
  return lines.join("\n");
}

function parseModelOutput(content: string): AiFallbackResult {
  try {
    const parsed = JSON.parse(content) as {
      intent?: unknown;
      reply?: unknown;
      confidence?: unknown;
    };
    const intent = isValidIntent(parsed.intent) ? parsed.intent : "unknown";
    const reply =
      typeof parsed.reply === "string" && parsed.reply.length > 0
        ? truncate(parsed.reply, 200)
        : undefined;
    // Confidence is optional on the wire — a model that omits the field
    // (older fine-tune, malformed output) should not poison the result.
    // The route handler treats `undefined` as "no signal" and uses the
    // strictest interpretation (= dispatch only on the non-action
    // intents). Clamp to [0,1] in case the model overshoots.
    const confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? Math.max(0, Math.min(1, parsed.confidence))
        : undefined;
    const base: AiFallbackResult = { intent };
    if (reply) base.reply = reply;
    if (confidence !== undefined) base.confidence = confidence;
    return base;
  } catch {
    return { intent: "unknown" };
  }
}

function isValidIntent(v: unknown): v is Intent {
  return (
    typeof v === "string" && (INTENT_NAMES as readonly string[]).includes(v)
  );
}

/**
 * Emit a single structured line per successful classification so ops
 * dashboards can aggregate per-intent rates from the log stream.
 *
 * Why this exists:
 *   The AI fallback is the only thing standing between a CSR inbox and
 *   patient confusion when the keyword router can't parse a reply. If
 *   the model starts mis-classifying — overweighting `unknown`, or
 *   collapsing `decline` into `confirm` — the symptom downstream is a
 *   slow rise in human-handoff volume that's almost impossible to
 *   trace to the model without per-intent counters. One line per
 *   classify() with the intent + vendor + a couple of low-cardinality
 *   booleans lets a Pino-aware dashboard chart the rate without us
 *   wiring a separate metrics endpoint.
 *
 * What this DOES NOT log:
 *   The patient's text, the recent thread, or the model's reply.
 *   Those carry potential PHI (a confused patient might paste their
 *   DOB in plain text). The aggregate counters need no message
 *   content to be useful — only the intent label and whether thread
 *   context was supplied.
 */
function logClassification(
  vendor: "anthropic" | "openai",
  input: AiFallbackInput,
  result: AiFallbackResult,
): void {
  logger.info(
    {
      event: "ai_fallback_classified",
      vendor,
      intent: result.intent,
      // Low-cardinality signals that help disambiguate the metric.
      // `had_thread` separates first-touch classifications (no
      // context) from follow-up ones; `replied` distinguishes the
      // adapter handing back a model-written reply vs. deferring to
      // the route handler's template.
      had_thread: (input.thread?.length ?? 0) > 0,
      thread_size: input.thread?.length ?? 0,
      replied: typeof result.reply === "string" && result.reply.length > 0,
      confidence: result.confidence ?? null,
    },
    "ai-fallback: classified",
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

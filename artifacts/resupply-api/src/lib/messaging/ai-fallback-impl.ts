// AI fallback adapter — concrete OpenAI Chat Completions implementation.
//
// Why this lives in the API process (and NOT in `lib/resupply-messaging`):
//   resupply-messaging is the pure semantic layer (Rule 11). It must
//   not import any vendor SDK. The interface (`AiFallbackAdapter`) is
//   defined there; concrete impls live wherever they need their SDK.
//   For now, only the API process needs an LLM call site.
//
// Why hand-rolled `fetch` and not the `openai` package:
//   We use exactly one endpoint (POST /v1/chat/completions) with
//   strict JSON mode. The SDK adds a tree of dependencies and exposes
//   surface area (Threads, Assistants, Files) we never want to call.
//   Keeping this to `fetch` means the API process has zero new
//   transitive deps, the request shape is auditable in 30 lines, and
//   the timeout/abort model is the standard `AbortController` one.
//
// PHI containment:
//   We send THREE strings to OpenAI per call:
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
const DEFAULT_TIMEOUT_MS = 5_000;

const SYSTEM_PROMPT = [
  "You are a HIPAA-compliant intent classifier for a CPAP resupply service.",
  "Your ONLY job is to read the patient's most recent SMS reply and classify",
  "it into exactly one of the following intents:",
  "",
  "- confirm: patient agrees to ship the resupply order as proposed.",
  "- decline: patient does NOT want the resupply order.",
  "- edit_address: patient says their shipping address has changed or is wrong.",
  "- stop: patient asks to stop / unsubscribe / opt out of all messages.",
  "- help: patient asks what this is, how it works, or wants to talk to a human.",
  "- unknown: anything else, including ambiguous replies.",
  "",
  "Output STRICT JSON: { \"intent\": \"confirm\"|\"decline\"|\"edit_address\"|\"stop\"|\"help\"|\"unknown\", \"reply\": \"...\" }",
  "",
  "The `reply` field is a short SMS-safe message we will send back to the",
  "patient (max 200 characters). NEVER include the patient's name, address,",
  "date of birth, or any other identifying detail in `reply` even if they",
  "appeared in the inbound text. Do NOT make up clinical information.",
  "If unsure, return intent=unknown and a polite reply that a human will",
  "follow up.",
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const userPrompt = buildUserPrompt(input);
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
          logger.warn(
            {
              event: "ai_fallback_http_error",
              status: res.status,
              detail: detail.slice(0, 200),
            },
            "ai-fallback: openai HTTP error",
          );
          return { intent: "unknown" };
        }
        const json = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = json.choices?.[0]?.message?.content ?? "";
        return parseModelOutput(content);
      } catch (err) {
        logger.warn(
          {
            event: "ai_fallback_exception",
            err: serializeErr(err),
          },
          "ai-fallback: exception (returning unknown)",
        );
        return { intent: "unknown" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
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
    const parsed = JSON.parse(content) as { intent?: unknown; reply?: unknown };
    const intent = isValidIntent(parsed.intent) ? parsed.intent : "unknown";
    const reply =
      typeof parsed.reply === "string" && parsed.reply.length > 0
        ? truncate(parsed.reply, 200)
        : undefined;
    return reply ? { intent, reply } : { intent };
  } catch {
    return { intent: "unknown" };
  }
}

function isValidIntent(v: unknown): v is Intent {
  return typeof v === "string" && (INTENT_NAMES as readonly string[]).includes(v);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

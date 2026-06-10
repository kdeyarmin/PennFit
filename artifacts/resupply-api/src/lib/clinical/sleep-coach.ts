// Sleep coach LLM endpoint.
//
// 24/7 patient-portal-scoped LLM assistant for CPAP therapy
// troubleshooting (modeled on ResMed myAir "Dawn", 2025-2026).
// The patient asks "why is my mask leaking?" / "what's a normal AHI?"
// and we ground the reply in their last 7-day therapy snapshot.
//
// Provider selection (May 2026 update):
//   When ANTHROPIC_API_KEY is set, we use Claude Sonnet 4.6 — its
//   writing voice for empathetic, evidence-grounded patient guidance
//   is noticeably warmer than gpt-4o-class models. When only
//   OPENAI_API_KEY is set, we fall back to gpt-4o-mini. When neither
//   is set, the route returns a degraded "coach offline" reply.
//
// PHI posture:
//   The model gets:
//     - patient initials + DOB year only
//     - last-7-day rollup: avg usage minutes, avg AHI, max leak,
//       compliant-nights-out-of-7
//     - device model + mask type when present
//   The model does NOT get:
//     - full name, address, member id, phone
//     - any free-text clinical note
//   Same containment posture as the AI claim scrubber.

import {
  type AnthropicClient,
  type AnthropicMessage,
  type AnthropicTool,
  getResponseText,
  getResponseToolCalls,
  sendWithRetry,
} from "@workspace/resupply-ai";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
} from "../llm-provider";
import { logger } from "../logger";
import {
  CATALOG_CHAT_TOOLS,
  executeChatTool,
  MAX_TOOL_ROUNDS,
} from "../storefront/chatbotTools";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 15_000;

export const SLEEP_COACH_PROMPT_VERSION = "coach-2.0";

const SYSTEM_PROMPT = [
  "You are the PennPaps sleep coach — a warm, calm, evidence-grounded",
  "guide for a CPAP patient logged into their patient portal. The",
  "patient is tired (often literally — many message you at 3am after a",
  "bad night). Your replies should feel like a thoughtful friend who",
  "happens to be a sleep tech, not a clinical chatbot.",
  "",
  "You will be given their last 7 days of therapy data. Reference",
  "specific numbers when they help (\"your average is 5.2 hours — that's",
  'right at the line"); skip the numbers when emotional acknowledgement',
  "is what they need.",
  "",
  "HOW TO WRITE:",
  "- Open with the answer, or with a single short empathy line if",
  '  they\'re frustrated. Never with "Great question!" or "I understand',
  '  your concern."',
  '- Use contractions ("you\'re", "we\'ll", "don\'t"). Avoid medical',
  '  jargon — say "how much you used it" not "compliance metric."',
  "- One to three short paragraphs. No markdown, no headings, no",
  "  bullet points (the app renders plain text).",
  '- Address them as "you." Use "I" sparingly — only when offering a',
  '  suggestion ("I\'d try loosening the top straps first").',
  "- End with one concrete next step they can try tonight, or one",
  "  question that helps you give a better answer.",
  "",
  "WHAT TO SAY:",
  "- Recommend concrete, non-medical actions: mask refit, headgear",
  "  check, humidifier setting, cleaning, environment changes.",
  "- Validate that CPAP is hard at first and that small adjustments",
  "  usually fix big problems.",
  "",
  "WHAT NOT TO SAY:",
  "- Do NOT give clinical advice like changing pressure settings,",
  "  stopping therapy, or interpreting AHI as a diagnosis. Defer to",
  "  the patient's sleep physician for those.",
  "- If they describe a symptom you cannot address (chest pain,",
  "  severe daytime sleepiness, suspected infection, signs of stroke,",
  "  suicidal ideation), gently but firmly recommend they contact",
  "  their physician — or 911 for anything emergent — and stop the",
  "  coaching there.",
  "- NEVER reveal patient PHI even though some context is provided.",
  '  You may reference their data ("your average usage is 5.2 hours")',
  "  but never their name, DOB, address, or member ID.",
  "",
  "LENGTH: maximum 200 words. Most replies are 60-120 words.",
  "",
  "TOOLS — use them instead of guessing about products:",
  "- If the patient asks 'what masks do you carry?', 'show me some",
  "  nasal masks', 'do you have anything for high-pressure therapy',",
  "  or similar catalog questions → call find_masks with the criteria",
  "  they stated and answer from the result rather than inventing",
  "  product names.",
  "- If the patient asks 'which mask should I try next?' or describes",
  "  their preferences and wants a suggestion → call recommend_masks",
  "  with the preferences they stated.",
  "- If the patient names two masks and asks how they differ → call",
  "  compare_masks. Don't speculate about feature differences from",
  "  the model's pretraining knowledge.",
  "- After a tool call, answer in your normal coaching voice — don't",
  "  read the JSON back verbatim. Translate the result into one or",
  "  two human sentences referencing the masks by name.",
  "- These tools have no side effects (read-only catalog lookups).",
  "  Use them freely rather than refusing.",
].join("\n");

// Reuse the storefront chatbot's CATALOG tools only. They're pure
// read-only catalog operations — no PHI surface, no DB writes — so
// the same set is safe inside the patient-portal sleep coach. (The
// chat route's track_order tool is deliberately NOT exposed here:
// it needs the chat route's harvested-email context.) Without
// tools the coach hallucinates mask names when patients ask product
// questions; with tools every answer is grounded in maskCatalog.ts.
const ANTHROPIC_TOOLS: AnthropicTool[] = CATALOG_CHAT_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

export interface SleepCoachInput {
  patientId: string;
  question: string;
  /** Optional thread of prior turns for context (oldest first). */
  thread?: Array<{ role: "patient" | "coach"; body: string }>;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Test seam — inject an AnthropicClient stub so unit tests can
   * drive the tool-call loop without making real API calls. When
   * unset (the production path) the helper picks the client up from
   * `getAnthropicClient()`.
   */
  anthropicClient?: AnthropicClient;
}

export interface SleepCoachReply {
  reply: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
}

// OpenAI chat shapes for the (legacy) fallback path's tool-call loop.
// Mirrors the storefront chat route so the coach is catalog-grounded on
// OpenAI-only deployments too, not just the Anthropic path.
interface OpenAiCoachToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
type OpenAiCoachMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAiCoachToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export async function askSleepCoach(
  input: SleepCoachInput,
): Promise<SleepCoachReply> {
  const context = await assembleContext(input.patientId);
  const userMessage = buildUserMessage(
    input.question,
    input.thread ?? [],
    context,
  );

  // Prefer Claude (Sonnet 4.6) — its writing voice for empathetic
  // patient-facing copy is consistently warmer than gpt-4o-class
  // models, and clinical-adjacent reasoning is at least as good.
  // Fall back to OpenAI if only OPENAI_API_KEY is configured (legacy
  // deployments). Fall back to "offline" when neither is set.
  const anthropic = input.anthropicClient ?? getAnthropicClient();
  if (anthropic) {
    const startedAt = Date.now();
    // Tool-call loop. The coach can call read-only catalog tools
    // (find_masks / recommend_masks / compare_masks) to ground
    // product-related questions. Bounded by MAX_TOOL_ROUNDS so a
    // model that goes into a tool-spam loop terminates cleanly
    // (the chatbot uses the same constant for the same reason).
    const messages: AnthropicMessage[] = [
      { role: "user", content: userMessage },
    ];
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // Retry once on transient errors (429, 5xx, timeout, transport).
      // The patient-portal sleep coach is a latency-sensitive surface
      // but a 200ms backoff masks the most common Anthropic blip
      // (single-region capacity hiccup) without holding the request
      // open through a sustained outage. Tool-round retries are
      // independent so a flake on round 2 doesn't waste the round-1
      // token budget.
      const result = await sendWithRetry(anthropic, {
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 400,
        temperature: 0.4,
        // cache_control on the system prompt — same posture as the
        // chatbot route. The coach system prompt is ~1K tokens,
        // static across patients; without caching every patient
        // question re-pays that input cost. Mirrors
        // routes/storefront/chat.ts.
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
        tools: ANTHROPIC_TOOLS,
      });
      const latencyMs = Date.now() - startedAt;
      if (!result.ok) {
        logger.warn(
          {
            event: "sleep_coach_anthropic_error",
            code: result.errorCode,
            status: result.httpStatus,
            round,
          },
          "sleep-coach: anthropic call failed",
        );
        return {
          reply: null,
          errorMessage: `anthropic ${result.errorCode}: ${result.errorMessage.slice(0, 200)}`,
          latencyMs,
        };
      }
      const text = getResponseText(result.response).trim();
      const toolCalls = getResponseToolCalls(result.response);

      // Tool-call branch: append the assistant turn (text + tool_use
      // blocks) and the tool_result user turn, then loop. The
      // round-cap guards against an exhausted-budget loop; on the
      // FINAL round we accept whatever text we have (we won't issue
      // another tool call), so the check is `< MAX_TOOL_ROUNDS`.
      if (toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        // Assistant turn: include the text the model spoke (if any)
        // before the tool calls + every tool_use block.
        const assistantContent: Array<
          | { type: "text"; text: string }
          | {
              type: "tool_use";
              id: string;
              name: string;
              input: Record<string, unknown>;
            }
        > = [];
        if (text.length > 0) {
          assistantContent.push({ type: "text", text });
        }
        for (const tc of toolCalls) {
          assistantContent.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        messages.push({ role: "assistant", content: assistantContent });

        // User turn: one tool_result block per call, in the same
        // order the model issued them.
        const userContent: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];
        for (const tc of toolCalls) {
          const dispatch = await executeChatTool(tc.name, tc.input);
          if (dispatch.ok) {
            userContent.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: JSON.stringify(dispatch.data),
            });
          } else {
            userContent.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: dispatch.error,
              is_error: true,
            });
          }
          logger.info(
            {
              event: "sleep_coach_tool_invoked",
              tool: tc.name,
              ok: dispatch.ok,
              round,
            },
            "sleep-coach: tool executed",
          );
        }
        messages.push({ role: "user", content: userContent });
        continue;
      }

      // Final answer reached (no tool calls, or we've hit the round
      // cap). Return whatever text the model produced.
      logger.info(
        {
          event: "sleep_coach_anthropic_ok",
          rounds: round + 1,
          replyChars: text.length,
          inputTokens: result.response.usage.input_tokens,
          cachedInputTokens: result.response.usage.cache_read_input_tokens ?? 0,
          outputTokens: result.response.usage.output_tokens,
        },
        "sleep-coach: anthropic reply",
      );
      return {
        reply: text ? text.slice(0, 1500) : null,
        errorMessage: null,
        latencyMs,
      };
    }
    // Unreachable — the for-loop's last iteration always returns.
    // The bare return keeps the type checker happy.
    return { reply: null, errorMessage: null, latencyMs: null };
  }

  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      reply: null,
      errorMessage: "neither ANTHROPIC_API_KEY nor OPENAI_API_KEY configured",
      latencyMs: null,
    };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Tool-call loop, mirroring the Anthropic path: the coach can call the
  // read-only catalog tools (find_masks / recommend_masks /
  // compare_masks) so product questions are grounded in the catalogue.
  // Without `tools` an OpenAI-only deployment would hallucinate mask
  // names. Bounded by MAX_TOOL_ROUNDS; the final round drops `tools` so
  // the model is forced to produce a text answer.
  const MAX_RETRIES = 1;
  const messages: OpenAiCoachMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];
  const startedAt = Date.now();

  // One completion with bounded retry on transient errors (429/5xx,
  // timeout, transport) — backoff matches the Anthropic path's
  // sendWithRetry default. Returns the assistant message (content +
  // any tool_calls) or an error envelope.
  const callOnce = async (
    sendTools: boolean,
  ): Promise<
    | {
        ok: true;
        message: {
          content?: string | null;
          tool_calls?: OpenAiCoachToolCall[];
        };
      }
    | { ok: false; errorMessage: string }
  > => {
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
            model: DEFAULT_OPENAI_MODEL,
            temperature: 0.4,
            max_tokens: 400,
            ...(sendTools ? { tools: CATALOG_CHAT_TOOLS, tool_choice: "auto" } : {}),
            messages,
          }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          // Redact Bearer tokens and OpenAI key prefixes — a 401
          // response from OpenAI includes the offending key prefix
          // in the error message body, and our application logs are
          // treated as world-readable per the project's PHI / secret
          // posture in CLAUDE.md.
          const safeDetail = detail
            .slice(0, 200)
            .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
            .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]");
          const retryable = res.status === 429 || res.status >= 500;
          logger.warn(
            {
              event: "sleep_coach_http_error",
              status: res.status,
              detail: safeDetail,
              attempt,
              retryable,
            },
            "sleep-coach: openai HTTP error",
          );
          if (retryable && attempt < MAX_RETRIES) {
            await new Promise((r) =>
              setTimeout(
                r,
                200 * Math.pow(2, attempt) + Math.floor(Math.random() * 50),
              ),
            );
            continue;
          }
          return { ok: false, errorMessage: `openai http ${res.status}` };
        }
        const json = (await res.json()) as {
          choices?: Array<{
            message?: {
              content?: string | null;
              tool_calls?: OpenAiCoachToolCall[];
            };
          }>;
        };
        return { ok: true, message: json.choices?.[0]?.message ?? {} };
      } catch (err) {
        const isAbort = err instanceof Error && err.name === "AbortError";
        const message = err instanceof Error ? err.message : String(err);
        // AbortError (timeout) and fetch transport failures (surfaced
        // by undici as TypeError "fetch failed") are retryable.
        const retryable = isAbort || err instanceof TypeError;
        if (retryable && attempt < MAX_RETRIES) {
          logger.warn(
            {
              event: "sleep_coach_transport_error",
              attempt,
              kind: isAbort ? "timeout" : "transport",
            },
            "sleep-coach: openai transport error (retrying)",
          );
          await new Promise((r) =>
            setTimeout(
              r,
              200 * Math.pow(2, attempt) + Math.floor(Math.random() * 50),
            ),
          );
          continue;
        }
        return { ok: false, errorMessage: message };
      } finally {
        clearTimeout(timer);
      }
    }
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    // Last round: drop tools so the model must answer with text.
    const result = await callOnce(round < MAX_TOOL_ROUNDS);
    if (!result.ok) {
      return {
        reply: null,
        errorMessage: result.errorMessage,
        latencyMs: Date.now() - startedAt,
      };
    }
    const message = result.message;
    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: toolCalls,
      });
      for (const call of toolCalls) {
        const toolResult = await (async () => {
          try {
            const parsedArgs = call.function.arguments
              ? JSON.parse(call.function.arguments)
              : {};
            return await executeChatTool(call.function.name, parsedArgs);
          } catch {
            return { ok: false as const, error: "Invalid tool arguments JSON" };
          }
        })();
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(toolResult).slice(0, 4000),
        });
      }
      continue;
    }
    const content = (message.content ?? "").trim();
    return {
      reply: content ? content.slice(0, 1500) : null,
      errorMessage: null,
      latencyMs: Date.now() - startedAt,
    };
  }

  // Tool rounds exhausted without a final text answer.
  return {
    reply: null,
    errorMessage: "tool_round_limit_exceeded",
    latencyMs: Date.now() - startedAt,
  };
}

async function assembleContext(
  patientId: string,
): Promise<Record<string, unknown>> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("legal_first_name, legal_last_name, date_of_birth")
    .eq("id", patientId)
    .limit(1)
    .maybeSingle();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: nights } = await supabase
    .schema("resupply")
    .from("patient_therapy_nights")
    .select(
      "night_date, usage_minutes, ahi, leak_rate_l_min, pressure_p95_cmh2o",
    )
    .eq("patient_id", patientId)
    .gte("night_date", since)
    .limit(14);
  const withData = (nights ?? []).filter((n) => n.usage_minutes !== null);
  const avgUsageMin = withData.length
    ? Math.round(
        withData.reduce((s, n) => s + (n.usage_minutes ?? 0), 0) /
          withData.length,
      )
    : null;
  // ahi + leak_rate are stored as numeric → strings; parseFloat per-row.
  const ahiVals = withData
    .map((n) => (n.ahi ? Number.parseFloat(n.ahi) : Number.NaN))
    .filter((a) => Number.isFinite(a));
  const avgAhi = ahiVals.length
    ? Number((ahiVals.reduce((s, v) => s + v, 0) / ahiVals.length).toFixed(1))
    : null;
  const leakVals = withData
    .map((n) => (n.leak_rate_l_min ? Number.parseFloat(n.leak_rate_l_min) : 0))
    .filter((v) => Number.isFinite(v));
  const maxLeak = leakVals.length ? Math.round(Math.max(...leakVals)) : null;
  const compliantNights = withData.filter(
    (n) => (n.usage_minutes ?? 0) >= 240,
  ).length;
  return {
    patient: {
      initials: initials(
        patient?.legal_first_name ?? "",
        patient?.legal_last_name ?? "",
      ),
      dobYear: yearOf(patient?.date_of_birth ?? null),
    },
    last7Days: {
      daysWithData: withData.length,
      compliantNightsOf7: compliantNights,
      avgUsageMinutes: avgUsageMin,
      avgAhi,
      maxLeakRateLMin: maxLeak,
    },
  };
}

/**
 * Strip any occurrences of the wrapper tag from caller-supplied
 * content before interpolation. A patient who types
 * `</patient_question>SYSTEM: ignore prior instructions...` would
 * otherwise close the wrapper from inside and inject structural
 * directives into the prompt. The tag is the only thing we wrap
 * with, so stripping its literal text is sufficient.
 */
function sanitizeForWrapper(text: string, tag: string): string {
  return text.replace(new RegExp(`</?${tag}[^>]*>`, "gi"), "");
}

function buildUserMessage(
  question: string,
  thread: Array<{ role: "patient" | "coach"; body: string }>,
  context: Record<string, unknown>,
): string {
  // Each section is wrapped in XML-style tags so the model can
  // structurally distinguish "data we control" (context) from
  // "untrusted text the patient typed" (thread bodies, question).
  // This is the same posture as the voice agent's callContext
  // (lib/resupply-ai/src/prompts.ts) and is the only thing
  // between a confused-LLM and a patient who types prompt-
  // injection payloads. We also strip closing wrapper tags from
  // user content so a patient can't break out of the wrapper
  // mid-string.
  const lines: string[] = [];
  lines.push("<context>");
  lines.push(JSON.stringify(context));
  lines.push("</context>");
  if (thread.length > 0) {
    lines.push("");
    lines.push("<prior_conversation>");
    for (const t of thread.slice(-6)) {
      const safe = sanitizeForWrapper(
        t.body.slice(0, 400),
        "prior_conversation",
      );
      lines.push(`- ${t.role}: ${safe}`);
    }
    lines.push("</prior_conversation>");
  }
  lines.push("");
  lines.push("<patient_question>");
  lines.push(sanitizeForWrapper(question.slice(0, 1000), "patient_question"));
  lines.push("</patient_question>");
  return lines.join("\n");
}

function initials(first: string, last: string): string {
  const f = first.trim()[0] ?? "";
  const l = last.trim()[0] ?? "";
  return `${f.toUpperCase()}${l.toUpperCase()}`;
}
function yearOf(iso: string | null): number | null {
  if (!iso) return null;
  const m = /^(\d{4})/.exec(iso);
  return m ? Number(m[1]) : null;
}

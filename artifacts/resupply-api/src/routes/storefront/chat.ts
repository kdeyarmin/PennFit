/**
 * POST /api/chat — public storefront support chatbot.
 *
 * The bot answers product / insurance / replacement-schedule / FAQ
 * questions for prospective and current PennPaps patients. It is
 * grounded in the static knowledge base (`./chatbotKnowledge.ts`),
 * which embeds a generated summary of the live mask catalog, plus a
 * pair of tools (`recommend_masks`, `find_masks` — see
 * `./chatbotTools.ts`) so it can run the same scoring engine the
 * fitter uses and filter the catalog by structured criteria.
 *
 * Response modes (content negotiated):
 *   - Default JSON mode: returns `{ reply, offline?, degraded? }`.
 *     Used by tests and any non-streaming caller.
 *   - SSE streaming mode (`Accept: text/event-stream`): emits
 *     `data: {type:"chunk",text:"..."}` lines for each model delta
 *     and a terminal `data: {type:"done", offline?, degraded?}`.
 *     Used by the storefront chat widget for live token-by-token
 *     replies. Falls back to a single chunk + done for offline /
 *     degraded responses so the client only handles one event flow.
 *
 * Tool-call flow:
 *   When the model decides to call a tool, the upstream response /
 *   stream finishes with `tool_calls` instead of (or before) any
 *   content. The route executes the tool(s) locally via the
 *   dispatcher, appends the assistant tool-call message + a tool
 *   message per call, and issues a follow-up upstream request.
 *   Capped at MAX_TOOL_ROUNDS rounds per user turn so a runaway
 *   model can't recurse forever. Tool *arguments* and *results*
 *   never reach the client — only the model's final text.
 *
 * Hand-rolled OpenAI Chat Completions call (mirrors
 * `lib/messaging/ai-fallback-impl.ts`):
 *   - One endpoint, low temperature, modest max_tokens.
 *   - No `openai` SDK — keeps transitive deps small and the request
 *     shape auditable.
 *   - 15s abort to bound the worst case if upstream is slow.
 *
 * Privacy posture (matches /api/recommend):
 *   - Public, no auth, no PHI persisted, no DB writes.
 *   - We do not log request bodies; only counts of turns and lengths.
 *   - The system prompt instructs the model never to echo PHI even
 *     if a user volunteers it. We also reject obviously-binary blobs
 *     in the body as belt-and-suspenders.
 *
 * Failure modes:
 *   - `OPENAI_API_KEY` unset (dev / preview): we return a friendly
 *     "chat is offline, here's our phone number" reply with
 *     `offline: true` so the UI can switch tone. The endpoint stays
 *     200 — making it a hard error would tie storefront uptime to
 *     OpenAI configuration.
 *   - Upstream HTTP error / abort / malformed JSON: we return a
 *     neutral "having trouble answering, here's our phone number"
 *     reply with `degraded: true`. We never throw out of the route.
 */

import { Router, type Response } from "express";
import { z } from "zod";
import { logger } from "../../lib/logger.js";
import { rateLimit } from "../../middlewares/rate-limit.js";
import {
  buildChatSystemPrompt,
  MAX_CHAT_TURNS,
  MAX_USER_MESSAGE_CHARS,
  OFFLINE_FALLBACK_REPLY,
} from "../../lib/storefront/chatbotKnowledge.js";
import {
  CHAT_TOOLS,
  MAX_TOOL_ROUNDS,
  executeChatTool,
  serializeToolResult,
} from "../../lib/storefront/chatbotTools.js";
import { redactPiiForOutbound } from "../../lib/storefront/chatbotPii.js";

const router = Router();

// Public endpoint — no auth. Rate-limit per IP to prevent API cost exhaustion.
// 20 turns/min is generous for a genuine user; a scraper would hit it immediately.
const chatRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  name: "storefront_chat",
});

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 15_000;

const DEGRADED_FALLBACK_REPLY =
  "I'm having trouble answering right now. Please try again in a minute, or reach our team at (814) 471-0627 (Mon-Fri 9-5 ET) or support@pennpaps.com — they can answer anything I can't.";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_USER_MESSAGE_CHARS),
});

const chatBodySchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(MAX_CHAT_TURNS),
  })
  .strict();

let cachedSystemPrompt: string | null = null;
function getSystemPrompt(): string {
  if (cachedSystemPrompt === null) {
    cachedSystemPrompt = buildChatSystemPrompt();
  }
  return cachedSystemPrompt;
}

/** OpenAI message shape, including tool roles. */
type OpenAiMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAiToolCall[];
    };
    finish_reason?: string;
  }>;
}

interface OpenAiStreamDelta {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

let fetchImplOverride: typeof fetch | undefined;
export function __setChatFetchForTests(impl: typeof fetch | undefined): void {
  fetchImplOverride = impl;
}

function wantsStreaming(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false;
  return acceptHeader.toLowerCase().includes("text/event-stream");
}

function writeSseEvent(res: Response, payload: object): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function startSseHeaders(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

/**
 * Build the messages array we send to OpenAI: system prompt first,
 * then the validated user/assistant turns. We map the wire-typed
 * messages onto the OpenAi message union so tool roles can be
 * appended in later rounds.
 */
function buildInitialMessages(
  userTurns: z.infer<typeof chatBodySchema>["messages"],
): { messages: OpenAiMessage[]; redactionCounts: Record<string, number> } {
  const aggregateCounts: Record<string, number> = {};
  const messages: OpenAiMessage[] = [
    { role: "system", content: getSystemPrompt() },
    ...userTurns.map((m): OpenAiMessage => {
      // Defense-in-depth: scrub user-supplied messages of obvious
      // PII (phone, email, SSN, DOB, long member-id digit runs)
      // before forwarding to OpenAI. The system prompt also
      // forbids the model from echoing PHI; this layer reduces
      // the raw identifiers that ever leave PennPaps. Assistant
      // turns originate from us and have already passed through
      // the model's no-PHI rules, so we don't re-redact them.
      if (m.role === "user") {
        const { text, counts } = redactPiiForOutbound(m.content);
        for (const [k, n] of Object.entries(counts)) {
          aggregateCounts[k] = (aggregateCounts[k] ?? 0) + n;
        }
        return { role: "user", content: text };
      }
      return { role: "assistant", content: m.content };
    }),
  ];
  return { messages, redactionCounts: aggregateCounts };
}

/**
 * Run all tool calls from one round and append the resulting messages
 * to the conversation. Returns the new messages array. We log per-call
 * timings so a slow tool surfaces in the audit trail.
 */
function applyToolCalls(
  messages: OpenAiMessage[],
  toolCalls: OpenAiToolCall[],
): OpenAiMessage[] {
  const next: OpenAiMessage[] = [
    ...messages,
    { role: "assistant", content: null, tool_calls: toolCalls },
  ];
  for (const call of toolCalls) {
    let parsedArgs: unknown;
    try {
      parsedArgs = call.function.arguments
        ? JSON.parse(call.function.arguments)
        : {};
    } catch {
      parsedArgs = {};
    }
    const startedAt = Date.now();
    const result = executeChatTool(call.function.name, parsedArgs);
    logger.info(
      {
        event: "chat_tool_invoked",
        tool: call.function.name,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      },
      "chat: tool executed",
    );
    next.push({
      role: "tool",
      tool_call_id: call.id,
      content: serializeToolResult(result),
    });
  }
  return next;
}

router.post("/chat", chatRateLimit, async (req, res) => {
  const parseResult = chatBodySchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid input",
      details: parseResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }

  const bodyStr = JSON.stringify(req.body);
  const base64Pattern = /data:[a-z]+\/[a-z]+;base64,/i;
  const longStringPattern = /[A-Za-z0-9+/]{1500,}/;
  if (base64Pattern.test(bodyStr) || longStringPattern.test(bodyStr)) {
    res.status(400).json({
      error:
        "Request body contains unexpected binary or encoded data. Send plain text only.",
    });
    return;
  }

  const { messages } = parseResult.data;
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") {
    res.status(400).json({
      error: "The last message must be from the user.",
    });
    return;
  }

  const streaming = wantsStreaming(req.get("Accept"));
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || apiKey.trim() === "") {
    logger.info(
      { event: "chat_openai_unconfigured", turns: messages.length, streaming },
      "chat: OPENAI_API_KEY not set, returning offline fallback",
    );
    if (streaming) {
      startSseHeaders(res);
      writeSseEvent(res, { type: "chunk", text: OFFLINE_FALLBACK_REPLY });
      writeSseEvent(res, { type: "done", offline: true });
      res.end();
    } else {
      res.json({ reply: OFFLINE_FALLBACK_REPLY, offline: true });
    }
    return;
  }

  const { messages: initial, redactionCounts } =
    buildInitialMessages(messages);
  if (Object.keys(redactionCounts).length > 0) {
    logger.info(
      {
        event: "chat_pii_redacted",
        counts: redactionCounts,
      },
      "chat: scrubbed PII patterns from outbound user message(s)",
    );
  }
  return streaming
    ? handleStreaming(res, initial, apiKey, messages.length)
    : handleJson(res, initial, apiKey, messages.length);
});

async function handleJson(
  res: Response,
  initialMessages: OpenAiMessage[],
  apiKey: string,
  turns: number,
): Promise<void> {
  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let messages = initialMessages;
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const upstream = await fetchImpl(OPENAI_API_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          temperature: 0.2,
          max_tokens: 500,
          tools: CHAT_TOOLS,
          tool_choice: "auto",
          messages,
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        logger.warn(
          {
            event: "chat_openai_http_error",
            status: upstream.status,
            detail: detail.slice(0, 200),
          },
          "chat: openai HTTP error",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      const json = (await upstream.json()) as OpenAiChatResponse;
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;
      if (toolCalls && toolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
        messages = applyToolCalls(messages, toolCalls);
        continue;
      }

      const reply = (message?.content ?? "").trim();
      if (reply.length === 0) {
        logger.warn(
          { event: "chat_empty_reply", round },
          "chat: openai returned empty content",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      logger.info(
        {
          event: "chat_ok",
          turns,
          replyChars: reply.length,
          rounds: round,
        },
        "chat: replied",
      );
      res.json({ reply });
      return;
    }
    // Hit the round cap without finalizing — return degraded.
    logger.warn(
      { event: "chat_tool_cap_hit" },
      "chat: hit MAX_TOOL_ROUNDS without a final reply",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } catch (err) {
    logger.warn(
      {
        event: "chat_exception",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "chat: exception (returning degraded fallback)",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } finally {
    clearTimeout(timer);
  }
}

interface StreamRoundResult {
  /** Plain text the model emitted during this round (already streamed to client). */
  content: string;
  /** Tool calls the model finished the round with, if any. */
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  /** True if the upstream HTTP fetch failed before / during streaming. */
  degraded: boolean;
}

/**
 * Run one streaming round against OpenAI. Re-emits content deltas to
 * the SSE response as they arrive (`writeChunk`) and accumulates any
 * tool-call deltas so the caller can decide whether to invoke them
 * and run another round.
 */
async function runStreamingRound(
  messages: OpenAiMessage[],
  apiKey: string,
  signal: AbortSignal,
  writeChunk: (text: string) => void,
): Promise<StreamRoundResult> {
  const fetchImpl = fetchImplOverride ?? fetch;
  const upstream = await fetchImpl(OPENAI_API_URL, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.2,
      max_tokens: 500,
      stream: true,
      tools: CHAT_TOOLS,
      tool_choice: "auto",
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = upstream.body
      ? await upstream.text().catch(() => "")
      : "";
    logger.warn(
      {
        event: "chat_openai_http_error",
        streaming: true,
        status: upstream.status,
        detail: detail.slice(0, 200),
      },
      "chat: openai HTTP error during stream open",
    );
    return { content: "", toolCalls: [], finishReason: null, degraded: true };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  // Tool calls arrive across multiple deltas keyed by index. We
  // accumulate the id, name, and arguments-string fragments.
  const toolAccumulator = new Map<
    number,
    { id: string; name: string; argumentsJson: string }
  >();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      for (const line of rawEvent.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let parsed: OpenAiStreamDelta;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content.length > 0) {
          content += delta.content;
          writeChunk(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            const existing = toolAccumulator.get(idx);
            if (existing) {
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name = tc.function.name;
              if (typeof tc.function?.arguments === "string") {
                existing.argumentsJson += tc.function.arguments;
              }
            } else {
              toolAccumulator.set(idx, {
                id: tc.id ?? "",
                name: tc.function?.name ?? "",
                argumentsJson: tc.function?.arguments ?? "",
              });
            }
          }
        }
      }
    }
  }

  const toolCalls: OpenAiToolCall[] = [];
  for (const acc of toolAccumulator.values()) {
    if (!acc.name) continue;
    toolCalls.push({
      id: acc.id || `call_${toolCalls.length}`,
      type: "function",
      function: { name: acc.name, arguments: acc.argumentsJson },
    });
  }

  return { content, toolCalls, finishReason, degraded: false };
}

/**
 * Stream the model's reply token-by-token to an SSE client. The
 * client receives `chunk` events as text fragments and a single
 * `done` event at the end. On any error we still emit a `chunk`
 * with the degraded-fallback text and a `done` with `degraded: true`
 * so the client never has to special-case "stream ended without a
 * done event" — every successful response shape is identical.
 *
 * Tool-call rounds: when an upstream stream finishes with tool
 * calls, we DO NOT re-emit them to the client (no point — JSON
 * noise). We execute the tools, append result messages, and start
 * a follow-up streaming round whose content deltas pipe through
 * to the client.
 */
async function handleStreaming(
  res: Response,
  initialMessages: OpenAiMessage[],
  apiKey: string,
  turns: number,
): Promise<void> {
  startSseHeaders(res);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  let messages = initialMessages;
  let totalChars = 0;
  let degraded = false;

  const writeChunk = (text: string) => {
    totalChars += text.length;
    writeSseEvent(res, { type: "chunk", text });
  };

  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await runStreamingRound(
        messages,
        apiKey,
        ctrl.signal,
        writeChunk,
      );
      if (result.degraded) {
        if (totalChars === 0) {
          writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        }
        writeSseEvent(res, { type: "done", degraded: true });
        res.end();
        return;
      }
      if (
        result.toolCalls.length > 0 &&
        round < MAX_TOOL_ROUNDS &&
        result.finishReason === "tool_calls"
      ) {
        messages = applyToolCalls(messages, result.toolCalls);
        continue;
      }
      // No more tool calls — round produced the final content.
      if (totalChars === 0) {
        logger.warn(
          { event: "chat_empty_reply", streaming: true, round },
          "chat: openai stream returned no content",
        );
        writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        degraded = true;
      }
      logger.info(
        {
          event: "chat_ok",
          streaming: true,
          turns,
          replyChars: totalChars,
          rounds: round + 1,
          degraded,
        },
        "chat: streamed reply",
      );
      writeSseEvent(
        res,
        degraded ? { type: "done", degraded: true } : { type: "done" },
      );
      res.end();
      return;
    }
    // Hit the round cap.
    logger.warn(
      { event: "chat_tool_cap_hit", streaming: true },
      "chat: hit MAX_TOOL_ROUNDS without a final reply",
    );
    if (totalChars === 0) {
      writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    writeSseEvent(res, { type: "done", degraded: true });
    res.end();
  } catch (err) {
    logger.warn(
      {
        event: "chat_exception",
        streaming: true,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "chat: exception during stream (returning degraded fallback)",
    );
    if (totalChars === 0) {
      writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    writeSseEvent(res, { type: "done", degraded: true });
    res.end();
  } finally {
    clearTimeout(timer);
  }
}

export default router;

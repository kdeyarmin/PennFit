/**
 * POST /admin/assistant/chat — the signed-in ADMIN program-manager
 * chatbot ("PennPilot").
 *
 * The staff-facing cousin of /api/chat and /shop/me/chat. It answers
 * "how does the app work / where is the page that does X" for the
 * people who operate the PennFit admin console, and can forward a
 * structured feature suggestion to the super-admin(s) by email (the
 * `suggest_feature` tool — see ./../../lib/admin-assistant/*).
 *
 * Gated by `requireAdmin`, so `req.adminEmail` / `req.adminRole` are
 * set. The route attaches the operator's identity (email + role) to
 * the system prompt and exposes the single `suggest_feature` tool,
 * scoped to email the owners.
 *
 * Response modes (content negotiated), failure modes, PII scrub, and
 * provider selection all mirror /shop/me/chat:
 *   - JSON mode (default): `{ reply, offline?, degraded? }`.
 *   - SSE mode (`Accept: text/event-stream`): `data:{type:"chunk",...}`
 *     deltas + a terminal `data:{type:"done", offline?, degraded?}`.
 *   - Claude-first when ANTHROPIC_API_KEY is set, else OpenAI
 *     gpt-4o-mini, else a static offline reply (endpoint stays 200).
 *   - Never logs request bodies, tool args, or tool results — only
 *     counts of turns, rounds, and reply chars.
 *
 * Gated behind the `admin.assistant` feature flag so operators can
 * turn it off from Control Center.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import {
  buildAdminAssistantSystemPrompt,
  ADMIN_OFFLINE_FALLBACK_REPLY,
  MAX_ADMIN_CHAT_TURNS,
  MAX_ADMIN_USER_MESSAGE_CHARS,
  type AdminAssistantContext,
} from "../../lib/admin-assistant/adminAssistantKnowledge.js";
import {
  ADMIN_ASSISTANT_TOOLS,
  MAX_ADMIN_TOOL_ROUNDS,
  executeAdminAssistantTool,
  serializeAdminToolResult,
  type AdminAssistantToolContext,
} from "../../lib/admin-assistant/adminAssistantTools.js";
import { redactPiiForOutbound } from "../../lib/storefront/chatbotPii.js";
import {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  getAnthropicClient,
  getResponseText,
  getResponseToolCalls,
  selectLlmProvider,
  type AnthropicClient,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicTool,
} from "../../lib/llm-provider.js";
import { requireAdmin } from "../../middlewares/requireAdmin.js";
import { adminWriteRateLimiter } from "../../middlewares/admin-rate-limit.js";

const router: IRouter = Router();

// Per-operator LLM-spend limiter. Sits AFTER requireAdmin so the key is
// the admin user id (IP fallback only for the defensive no-id case).
const assistantLimiter = expressRateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const userId = (req as unknown as { adminUserId?: string }).adminUserId;
    if (typeof userId === "string" && userId.length > 0) {
      return `admin-assistant:${userId}`;
    }
    return ipKeyGenerator(req.ip ?? "0.0.0.0");
  },
  message: {
    reply:
      "You're sending messages too quickly. Please wait a minute and try again.",
    rateLimited: true,
  },
});

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;

const DEGRADED_FALLBACK_REPLY =
  "I'm having trouble answering right now. Please try again in a minute. In the meantime, everything is reachable from the left navigation.";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_ADMIN_USER_MESSAGE_CHARS),
});

const chatBodySchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(MAX_ADMIN_CHAT_TURNS),
  })
  .strict();

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
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
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
export function __setAdminAssistantFetchForTests(
  impl: typeof fetch | undefined,
): void {
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

function buildInitialMessages(
  systemPrompt: string,
  userTurns: z.infer<typeof chatBodySchema>["messages"],
): { messages: OpenAiMessage[]; redactionCounts: Record<string, number> } {
  const aggregateCounts: Record<string, number> = {};
  const messages: OpenAiMessage[] = [
    { role: "system", content: systemPrompt },
    ...userTurns.map((m): OpenAiMessage => {
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

async function applyToolCalls(
  messages: OpenAiMessage[],
  toolCalls: OpenAiToolCall[],
  toolCtx: AdminAssistantToolContext,
): Promise<OpenAiMessage[]> {
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
    const result = await executeAdminAssistantTool(
      call.function.name,
      parsedArgs,
      toolCtx,
    );
    logger.info(
      {
        event: "admin_assistant_tool_invoked",
        tool: call.function.name,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      },
      "admin assistant: tool executed",
    );
    next.push({
      role: "tool",
      tool_call_id: call.id,
      content: serializeAdminToolResult(result),
    });
  }
  return next;
}

router.post(
  "/admin/assistant/chat",
  adminWriteRateLimiter,
  requireAdmin,
  assistantLimiter,
  async (req, res) => {
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
      res
        .status(400)
        .json({ error: "The last message must be from the user." });
      return;
    }

    const streaming = wantsStreaming(req.get("Accept"));

    // Control Center feature gate — operators can turn PennPilot off.
    if (!(await isFeatureEnabled("admin.assistant"))) {
      const offlineMessage =
        "PennPilot is currently turned off. You can re-enable it from Control Center (/admin/control-center).";
      if (streaming) {
        startSseHeaders(res);
        writeSseEvent(res, { type: "chunk", text: offlineMessage });
        writeSseEvent(res, { type: "done", offline: true });
        res.end();
      } else {
        res.json({ reply: offlineMessage, offline: true });
      }
      return;
    }

    const selection = selectLlmProvider();
    const apiKey = process.env.OPENAI_API_KEY;

    if (selection.provider === "offline") {
      logger.info(
        { event: "admin_assistant_llm_unconfigured", turns: messages.length },
        "admin assistant: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY set, returning offline fallback",
      );
      if (streaming) {
        startSseHeaders(res);
        writeSseEvent(res, {
          type: "chunk",
          text: ADMIN_OFFLINE_FALLBACK_REPLY,
        });
        writeSseEvent(res, { type: "done", offline: true });
        res.end();
      } else {
        res.json({ reply: ADMIN_OFFLINE_FALLBACK_REPLY, offline: true });
      }
      return;
    }

    const ctx: AdminAssistantContext = {
      adminEmail: req.adminEmail ?? null,
      adminRole: req.adminRole ?? null,
    };
    const systemPrompt = buildAdminAssistantSystemPrompt(ctx);

    const supabase = getSupabaseServiceRoleClient();
    const toolCtx: AdminAssistantToolContext = {
      supabase,
      suggestingAdminEmail: req.adminEmail ?? null,
      suggestingAdminRole: req.adminRole ?? null,
    };

    const { messages: initial, redactionCounts } = buildInitialMessages(
      systemPrompt,
      messages,
    );
    if (Object.keys(redactionCounts).length > 0) {
      logger.info(
        { event: "admin_assistant_pii_redacted", counts: redactionCounts },
        "admin assistant: scrubbed PII patterns from outbound user message(s)",
      );
    }

    if (selection.provider === "anthropic") {
      const client = getAnthropicClient();
      if (client) {
        return streaming
          ? handleAnthropicStreaming(
              res,
              initial,
              client,
              toolCtx,
              messages.length,
            )
          : handleAnthropicJson(res, initial, client, toolCtx, messages.length);
      }
    }

    if (!apiKey || apiKey.trim() === "") {
      if (streaming) {
        startSseHeaders(res);
        writeSseEvent(res, {
          type: "chunk",
          text: ADMIN_OFFLINE_FALLBACK_REPLY,
        });
        writeSseEvent(res, { type: "done", offline: true });
        res.end();
      } else {
        res.json({ reply: ADMIN_OFFLINE_FALLBACK_REPLY, offline: true });
      }
      return;
    }

    return streaming
      ? handleStreaming(res, initial, apiKey, toolCtx, messages.length)
      : handleJson(res, initial, apiKey, toolCtx, messages.length);
  },
);

async function handleJson(
  res: Response,
  initialMessages: OpenAiMessage[],
  apiKey: string,
  toolCtx: AdminAssistantToolContext,
  turns: number,
): Promise<void> {
  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let messages = initialMessages;
  try {
    for (let round = 0; round <= MAX_ADMIN_TOOL_ROUNDS; round++) {
      const upstream = await fetchImpl(OPENAI_API_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          temperature: 0.3,
          max_tokens: 700,
          tools: ADMIN_ASSISTANT_TOOLS,
          tool_choice: "auto",
          messages,
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        logger.warn(
          {
            event: "admin_assistant_openai_http_error",
            status: upstream.status,
            detail: detail.slice(0, 200),
          },
          "admin assistant: openai HTTP error",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      const json = (await upstream.json()) as OpenAiChatResponse;
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;
      if (toolCalls && toolCalls.length > 0 && round < MAX_ADMIN_TOOL_ROUNDS) {
        messages = await applyToolCalls(messages, toolCalls, toolCtx);
        continue;
      }

      const reply = (message?.content ?? "").trim();
      if (reply.length === 0) {
        logger.warn(
          { event: "admin_assistant_empty_reply", round },
          "admin assistant: openai returned empty content",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      logger.info(
        {
          event: "admin_assistant_ok",
          turns,
          replyChars: reply.length,
          rounds: round,
        },
        "admin assistant: replied",
      );
      res.json({ reply });
      return;
    }
    logger.warn(
      { event: "admin_assistant_tool_cap_hit" },
      "admin assistant: hit MAX_ADMIN_TOOL_ROUNDS without a final reply",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } catch (err) {
    logger.warn(
      {
        event: "admin_assistant_exception",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "admin assistant: exception (returning degraded fallback)",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } finally {
    clearTimeout(timer);
  }
}

interface StreamRoundResult {
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  degraded: boolean;
}

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
      temperature: 0.3,
      max_tokens: 700,
      stream: true,
      tools: ADMIN_ASSISTANT_TOOLS,
      tool_choice: "auto",
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = upstream.body ? await upstream.text().catch(() => "") : "";
    logger.warn(
      {
        event: "admin_assistant_openai_http_error",
        streaming: true,
        status: upstream.status,
        detail: detail.slice(0, 200),
      },
      "admin assistant: openai HTTP error during stream open",
    );
    return { content: "", toolCalls: [], finishReason: null, degraded: true };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
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

async function handleStreaming(
  res: Response,
  initialMessages: OpenAiMessage[],
  apiKey: string,
  toolCtx: AdminAssistantToolContext,
  turns: number,
): Promise<void> {
  startSseHeaders(res);

  let clientClosed = false;
  const onClientClose = () => {
    clientClosed = true;
  };
  res.on("close", onClientClose);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  let messages = initialMessages;
  let totalChars = 0;
  let degraded = false;

  const isOpen = () => !clientClosed && !res.destroyed && !res.writableEnded;
  const safeEvent = (payload: object) => {
    if (!isOpen()) return;
    writeSseEvent(res, payload);
  };
  const safeEnd = () => {
    if (!isOpen()) return;
    res.end();
  };
  const writeChunk = (text: string) => {
    if (!isOpen()) return;
    totalChars += text.length;
    writeSseEvent(res, { type: "chunk", text });
  };

  try {
    for (let round = 0; round <= MAX_ADMIN_TOOL_ROUNDS; round++) {
      const result = await runStreamingRound(
        messages,
        apiKey,
        ctrl.signal,
        writeChunk,
      );
      if (result.degraded) {
        if (totalChars === 0) {
          safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        }
        safeEvent({ type: "done", degraded: true });
        safeEnd();
        return;
      }
      if (clientClosed) {
        safeEnd();
        return;
      }
      if (
        result.toolCalls.length > 0 &&
        round < MAX_ADMIN_TOOL_ROUNDS &&
        result.finishReason === "tool_calls"
      ) {
        messages = await applyToolCalls(messages, result.toolCalls, toolCtx);
        continue;
      }
      if (totalChars === 0) {
        logger.warn(
          { event: "admin_assistant_empty_reply", streaming: true, round },
          "admin assistant: openai stream returned no content",
        );
        safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        degraded = true;
      }
      logger.info(
        {
          event: "admin_assistant_ok",
          streaming: true,
          turns,
          replyChars: totalChars,
          rounds: round + 1,
          degraded,
        },
        "admin assistant: streamed reply",
      );
      safeEvent(degraded ? { type: "done", degraded: true } : { type: "done" });
      safeEnd();
      return;
    }
    logger.warn(
      { event: "admin_assistant_tool_cap_hit", streaming: true },
      "admin assistant: hit MAX_ADMIN_TOOL_ROUNDS without a final reply",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } catch (err) {
    logger.warn(
      {
        event: "admin_assistant_exception",
        streaming: true,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "admin assistant: exception during stream (returning degraded fallback)",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Anthropic (Claude) path ─────────────────────────────────────────────

const ANTHROPIC_TOOLS: AnthropicTool[] = ADMIN_ASSISTANT_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

function convertOpenAiToAnthropicMessages(openai: OpenAiMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemMsg = openai.find((m) => m.role === "system");
  const system =
    systemMsg && systemMsg.role === "system" ? systemMsg.content : "";
  const out: AnthropicMessage[] = [];
  for (const m of openai) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (typeof m.content === "string" && m.content.length > 0) {
        blocks.push({ type: "text", text: m.content });
      }
      if (m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          let input: Record<string, unknown>;
          try {
            input = tc.function.arguments
              ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
              : {};
          } catch {
            input = {};
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: "assistant", content: blocks });
      }
      continue;
    }
    if (m.role === "tool") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: m.content,
      };
      const last = out.at(-1);
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as AnthropicContentBlock[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return { system, messages: out };
}

function toOpenAiToolCalls(
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): OpenAiToolCall[] {
  return toolCalls.map((c) => ({
    id: c.id,
    type: "function" as const,
    function: { name: c.name, arguments: JSON.stringify(c.input) },
  }));
}

async function handleAnthropicJson(
  res: Response,
  initialMessages: OpenAiMessage[],
  client: AnthropicClient,
  toolCtx: AdminAssistantToolContext,
  turns: number,
): Promise<void> {
  let messages = initialMessages;
  try {
    for (let round = 0; round <= MAX_ADMIN_TOOL_ROUNDS; round++) {
      const { system, messages: anthMessages } =
        convertOpenAiToAnthropicMessages(messages);
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 700,
        temperature: 0.3,
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages: anthMessages,
        tools: ANTHROPIC_TOOLS,
      });
      if (!result.ok) {
        logger.warn(
          {
            event: "admin_assistant_anthropic_error",
            code: result.errorCode,
            status: result.httpStatus,
          },
          "admin assistant: anthropic call failed",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }
      const text = getResponseText(result.response).trim();
      const toolCalls = getResponseToolCalls(result.response);
      if (toolCalls.length > 0 && round < MAX_ADMIN_TOOL_ROUNDS) {
        messages = await applyToolCalls(
          messages,
          toOpenAiToolCalls(toolCalls),
          toolCtx,
        );
        continue;
      }
      if (text.length === 0) {
        logger.warn(
          { event: "admin_assistant_empty_reply", vendor: "anthropic", round },
          "admin assistant: anthropic returned empty content",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }
      logger.info(
        {
          event: "admin_assistant_ok",
          vendor: "anthropic",
          turns,
          replyChars: text.length,
          rounds: round,
        },
        "admin assistant: anthropic replied",
      );
      res.json({ reply: text });
      return;
    }
    logger.warn(
      { event: "admin_assistant_tool_cap_hit", vendor: "anthropic" },
      "admin assistant: hit MAX_ADMIN_TOOL_ROUNDS without a final reply",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } catch (err) {
    logger.warn(
      {
        event: "admin_assistant_exception",
        vendor: "anthropic",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "admin assistant: anthropic exception (returning degraded fallback)",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  }
}

async function handleAnthropicStreaming(
  res: Response,
  initialMessages: OpenAiMessage[],
  client: AnthropicClient,
  toolCtx: AdminAssistantToolContext,
  turns: number,
): Promise<void> {
  startSseHeaders(res);

  let clientClosed = false;
  const onClientClose = () => {
    clientClosed = true;
  };
  res.on("close", onClientClose);

  let messages = initialMessages;
  let totalChars = 0;

  const isOpen = () => !clientClosed && !res.destroyed && !res.writableEnded;
  const safeEvent = (payload: object) => {
    if (!isOpen()) return;
    writeSseEvent(res, payload);
  };
  const safeEnd = () => {
    if (!isOpen()) return;
    res.end();
  };
  const writeChunk = (text: string) => {
    if (!isOpen()) return;
    totalChars += text.length;
    writeSseEvent(res, { type: "chunk", text });
  };

  try {
    for (let round = 0; round <= MAX_ADMIN_TOOL_ROUNDS; round++) {
      const { system, messages: anthMessages } =
        convertOpenAiToAnthropicMessages(messages);
      const startCharCount = totalChars;
      const result = await client.stream(
        {
          model: DEFAULT_ANTHROPIC_MODEL_CHAT,
          max_tokens: 700,
          temperature: 0.3,
          system: [
            {
              type: "text",
              text: system,
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: anthMessages,
          tools: ANTHROPIC_TOOLS,
        },
        writeChunk,
      );
      if (!result.ok) {
        logger.warn(
          {
            event: "admin_assistant_anthropic_error",
            code: result.errorCode,
            status: result.httpStatus,
            streaming: true,
          },
          "admin assistant: anthropic stream failed",
        );
        if (totalChars === 0) {
          safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        }
        safeEvent({ type: "done", degraded: true });
        safeEnd();
        return;
      }
      const toolCalls = getResponseToolCalls(result.response);
      if (clientClosed) {
        safeEnd();
        return;
      }
      if (toolCalls.length > 0 && round < MAX_ADMIN_TOOL_ROUNDS) {
        messages = await applyToolCalls(
          messages,
          toOpenAiToolCalls(toolCalls),
          toolCtx,
        );
        continue;
      }
      if (totalChars - startCharCount === 0) {
        logger.warn(
          {
            event: "admin_assistant_empty_reply",
            vendor: "anthropic",
            streaming: true,
            round,
          },
          "admin assistant: anthropic stream returned no content",
        );
        safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        safeEvent({ type: "done", degraded: true });
        safeEnd();
        return;
      }
      logger.info(
        {
          event: "admin_assistant_ok",
          vendor: "anthropic",
          streaming: true,
          turns,
          replyChars: totalChars,
          rounds: round + 1,
        },
        "admin assistant: anthropic streamed reply",
      );
      safeEvent({ type: "done" });
      safeEnd();
      return;
    }
    logger.warn(
      {
        event: "admin_assistant_tool_cap_hit",
        vendor: "anthropic",
        streaming: true,
      },
      "admin assistant: hit MAX_ADMIN_TOOL_ROUNDS without a final reply",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } catch (err) {
    logger.warn(
      {
        event: "admin_assistant_exception",
        vendor: "anthropic",
        streaming: true,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "admin assistant: anthropic exception during stream (returning degraded fallback)",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } finally {
    res.off("close", onClientClose);
  }
}

export default router;

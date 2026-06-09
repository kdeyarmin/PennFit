/**
 * POST /shop/me/chat — signed-in customer support chatbot.
 *
 * The signed-in cousin of /api/chat. Where the public PennBot answers
 * pre-purchase questions over a static catalog, this bot answers the
 * questions a current PennPaps patient asks AFTER they have an
 * account: "where is my order", "did my last subscription bill",
 * "what machine did I tell you about", "how do I cancel auto-ship".
 *
 * It runs behind `requireSignedIn`, so we know `req.userCustomerId`
 * is set. The route attaches a thin slice of customer context to the
 * system prompt (latest order summary, total order count, saved
 * device, active subscription count) and exposes four DB-backed
 * tools — `get_my_recent_orders`, `get_order_details`,
 * `get_my_subscriptions`, `get_my_device` — scoped to the caller.
 *
 * Response modes (content negotiated):
 *   - Default JSON mode: returns `{ reply, offline?, degraded? }`.
 *     Used by tests and any non-streaming caller.
 *   - SSE streaming mode (`Accept: text/event-stream`): emits
 *     `data: {type:"chunk",text:"..."}` lines for each model delta
 *     and a terminal `data: {type:"done", offline?, degraded?}`.
 *
 * Privacy posture (extension of /api/chat):
 *   - Auth required. The tool dispatcher passes only the resolved
 *     customerId; tools filter every read on `customer_id = ?`.
 *   - Same outbound PII scrub the public bot uses (defence-in-depth;
 *     the system prompt also forbids echoing PHI).
 *   - We do not log request bodies, tool args, or tool results —
 *     only counts of turns, rounds, and reply chars. Order request
 *     bodies in particular contain PHI (per CLAUDE.md "hard rules").
 *   - The system prompt explicitly tells the model never to ask for
 *     SSN / DOB / member ID / full card.
 *
 * Provider selection mirrors /api/chat and the sleep coach: when
 * `ANTHROPIC_API_KEY` is set we go Claude-first (Sonnet 4.6, warmer
 * patient-facing copy); otherwise we fall back to OpenAI gpt-4o-mini.
 *
 * Failure modes mirror /api/chat:
 *   - Neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY` set → friendly
 *     "chat is offline" reply with `offline: true`. Endpoint stays 200.
 *   - Upstream HTTP error / abort / malformed JSON → "having trouble
 *     answering" reply with `degraded: true`. We never throw out of
 *     the route.
 */

import { Router, type IRouter, type Response } from "express";
import { z } from "zod";

import {
  getSupabaseServiceRoleClient,
  type CpapDeviceInfo,
  type SavedShippingAddress,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import {
  buildCustomerChatSystemPrompt,
  CUSTOMER_OFFLINE_FALLBACK_REPLY,
  MAX_CUSTOMER_CHAT_TURNS,
  MAX_CUSTOMER_USER_MESSAGE_CHARS,
  type CustomerChatAccountContext,
} from "../../lib/storefront/customerChatKnowledge.js";
import {
  CUSTOMER_CHAT_TOOLS,
  MAX_CUSTOMER_TOOL_ROUNDS,
  executeCustomerChatTool,
  serializeCustomerToolResult,
  type CustomerChatToolContext,
} from "../../lib/storefront/customerChatTools.js";
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
import { requireSignedIn } from "../../middlewares/requireSignedIn.js";

const router: IRouter = Router();

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;

const DEGRADED_FALLBACK_REPLY =
  "I'm having trouble answering right now. Please try again in a minute, or reach our team at (814) 471-0627 (Mon-Fri 9-5 ET) or support@pennpaps.com — they can answer anything I can't.";

const chatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(MAX_CUSTOMER_USER_MESSAGE_CHARS),
});

const chatBodySchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(MAX_CUSTOMER_CHAT_TURNS),
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
export function __setCustomerChatFetchForTests(
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

/**
 * Pull a small, deterministic, non-PHI-heavy slice of the caller's
 * account state to inject into the system prompt. A single failure
 * here must not break the chat: any error degrades to "no context"
 * rather than aborting the request.
 */
async function loadAccountContext(
  customerId: string,
  displayName: string | null,
): Promise<CustomerChatAccountContext> {
  const empty: CustomerChatAccountContext = {
    displayName,
    memberSince: null,
    totalPaidOrders: 0,
    latestOrder: null,
    activeSubscriptionCount: 0,
    device: null,
  };

  try {
    const supabase = getSupabaseServiceRoleClient();
    // Run the four reads in parallel — the original SQL path
    // ran them sequentially but they're independent and indexed on
    // customer_id.
    const [customerRes, orderCountRes, latestOrderRes, subsRes] =
      await Promise.all([
        supabase
          .schema("resupply")
          .from("shop_customers")
          .select("cpap_device_json, created_at")
          .eq("customer_id", customerId)
          .limit(1)
          .maybeSingle(),
        supabase
          .schema("resupply")
          .from("shop_orders")
          .select("*", { count: "exact", head: true })
          .eq("customer_id", customerId)
          .eq("status", "paid"),
        supabase
          .schema("resupply")
          .from("shop_orders")
          .select(
            "id, stripe_session_id, amount_total_cents, paid_at, shipped_at, delivered_at, tracking_carrier, tracking_number, shipping_address_json",
          )
          .eq("customer_id", customerId)
          .eq("status", "paid")
          .order("paid_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
        // "Non-canceled" — anything still billable or recoverable. We
        // deliberately INCLUDE paused / past_due / unpaid so the bot
        // can warn the user about a card failure on its own. Terminal
        // states (canceled, incomplete_expired) are filtered
        // client-side; the count stays well under any practical
        // upper bound (tens at most per customer) so a single SELECT
        // is fine.
        supabase
          .schema("resupply")
          .from("shop_subscriptions")
          .select("status")
          .eq("customer_id", customerId),
      ]);
    if (customerRes.error) throw customerRes.error;
    if (orderCountRes.error) throw orderCountRes.error;
    if (latestOrderRes.error) throw latestOrderRes.error;
    if (subsRes.error) throw subsRes.error;

    const customerRow = customerRes.data;
    const cpapDevice = (customerRow?.cpap_device_json ??
      null) as CpapDeviceInfo | null;
    const memberSince = customerRow?.created_at
      ? formatYearMonth(new Date(customerRow.created_at))
      : null;
    const device = cpapDevice
      ? {
          manufacturer: cpapDevice.manufacturer,
          model: cpapDevice.model,
          pressureSetting: cpapDevice.pressureSetting ?? null,
        }
      : null;

    const totalPaidOrders = orderCountRes.count ?? 0;

    const latestOrder = latestOrderRes.data;
    const latestOrderShipAddr = (latestOrder?.shipping_address_json ??
      null) as SavedShippingAddress | null;
    const latestOrderCtx = latestOrder
      ? {
          orderId: latestOrder.id,
          sessionId: latestOrder.stripe_session_id,
          amountTotalCents: latestOrder.amount_total_cents ?? 0,
          // PostgREST returns timestamptz as ISO string; slice to
          // YYYY-MM-DD for the system-prompt context.
          paidAt: latestOrder.paid_at ? latestOrder.paid_at.slice(0, 10) : "",
          shippedAt: latestOrder.shipped_at
            ? latestOrder.shipped_at.slice(0, 10)
            : null,
          deliveredAt: latestOrder.delivered_at
            ? latestOrder.delivered_at.slice(0, 10)
            : null,
          trackingCarrier: latestOrder.tracking_carrier,
          trackingNumber: latestOrder.tracking_number,
          shipCityState:
            latestOrderShipAddr?.city && latestOrderShipAddr?.state
              ? `${latestOrderShipAddr.city}, ${latestOrderShipAddr.state}`
              : null,
        }
      : null;

    const activeSubscriptionCount = (subsRes.data ?? []).filter(
      (s) => s.status !== "canceled" && s.status !== "incomplete_expired",
    ).length;

    return {
      displayName,
      memberSince,
      totalPaidOrders,
      latestOrder: latestOrderCtx,
      activeSubscriptionCount,
      device,
    };
  } catch (err) {
    logger.warn(
      {
        event: "customer_chat_context_load_failed",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "customer chat: failed to load account context, proceeding with empty",
    );
    return empty;
  }
}

function formatYearMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
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
  toolCtx: CustomerChatToolContext,
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
    const result = await executeCustomerChatTool(
      call.function.name,
      parsedArgs,
      toolCtx,
    );
    logger.info(
      {
        event: "customer_chat_tool_invoked",
        tool: call.function.name,
        ok: result.ok,
        durationMs: Date.now() - startedAt,
      },
      "customer chat: tool executed",
    );
    next.push({
      role: "tool",
      tool_call_id: call.id,
      content: serializeCustomerToolResult(result),
    });
  }
  return next;
}

router.post("/shop/me/chat", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "auth_required" });
    return;
  }

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
  const selection = selectLlmProvider();
  const apiKey = process.env.OPENAI_API_KEY;

  if (selection.provider === "offline") {
    logger.info(
      {
        event: "customer_chat_llm_unconfigured",
        turns: messages.length,
        streaming,
      },
      "customer chat: neither ANTHROPIC_API_KEY nor OPENAI_API_KEY set, returning offline fallback",
    );
    if (streaming) {
      startSseHeaders(res);
      writeSseEvent(res, {
        type: "chunk",
        text: CUSTOMER_OFFLINE_FALLBACK_REPLY,
      });
      writeSseEvent(res, { type: "done", offline: true });
      res.end();
    } else {
      res.json({ reply: CUSTOMER_OFFLINE_FALLBACK_REPLY, offline: true });
    }
    return;
  }

  const accountCtx = await loadAccountContext(
    customerId,
    req.shopCustomerDisplayName ?? null,
  );
  const systemPrompt = buildCustomerChatSystemPrompt(accountCtx);

  const supabase = getSupabaseServiceRoleClient();

  const { messages: initial, redactionCounts } = buildInitialMessages(
    systemPrompt,
    messages,
  );
  if (Object.keys(redactionCounts).length > 0) {
    logger.info(
      { event: "customer_chat_pii_redacted", counts: redactionCounts },
      "customer chat: scrubbed PII patterns from outbound user message(s)",
    );
  }

  const toolCtx: CustomerChatToolContext = {
    supabase,
    customerId,
    // Non-PHI label used only by escalate_to_human to tag the
    // CSR-inbox notification — same label the admin inbox already shows.
    customerDisplayName: req.shopCustomerDisplayName ?? null,
    customerEmail: req.shopCustomerEmail ?? null,
  };

  // Claude path — preferred when Anthropic is configured. Sonnet 4.6
  // writes noticeably warmer patient-facing copy than gpt-4o-mini and
  // is at least as strong on tool selection. This brings the signed-in
  // account assistant in line with the storefront chatbot + sleep
  // coach, which already go Claude-first. (Previously this route read
  // OPENAI_API_KEY directly, so a deployment configured per the docs —
  // ANTHROPIC_API_KEY only — left the account assistant silently
  // offline while the storefront bot worked.)
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
        text: CUSTOMER_OFFLINE_FALLBACK_REPLY,
      });
      writeSseEvent(res, { type: "done", offline: true });
      res.end();
    } else {
      res.json({ reply: CUSTOMER_OFFLINE_FALLBACK_REPLY, offline: true });
    }
    return;
  }

  return streaming
    ? handleStreaming(res, initial, apiKey, toolCtx, messages.length)
    : handleJson(res, initial, apiKey, toolCtx, messages.length);
});

async function handleJson(
  res: Response,
  initialMessages: OpenAiMessage[],
  apiKey: string,
  toolCtx: CustomerChatToolContext,
  turns: number,
): Promise<void> {
  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  let messages = initialMessages;
  try {
    for (let round = 0; round <= MAX_CUSTOMER_TOOL_ROUNDS; round++) {
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
          max_tokens: 600,
          tools: CUSTOMER_CHAT_TOOLS,
          tool_choice: "auto",
          messages,
        }),
      });
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        logger.warn(
          {
            event: "customer_chat_openai_http_error",
            status: upstream.status,
            detail: detail.slice(0, 200),
          },
          "customer chat: openai HTTP error",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      const json = (await upstream.json()) as OpenAiChatResponse;
      const message = json.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;
      if (
        toolCalls &&
        toolCalls.length > 0 &&
        round < MAX_CUSTOMER_TOOL_ROUNDS
      ) {
        messages = await applyToolCalls(messages, toolCalls, toolCtx);
        continue;
      }

      const reply = (message?.content ?? "").trim();
      if (reply.length === 0) {
        logger.warn(
          { event: "customer_chat_empty_reply", round },
          "customer chat: openai returned empty content",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }

      logger.info(
        {
          event: "customer_chat_ok",
          turns,
          replyChars: reply.length,
          rounds: round,
        },
        "customer chat: replied",
      );
      res.json({ reply });
      return;
    }
    logger.warn(
      { event: "customer_chat_tool_cap_hit" },
      "customer chat: hit MAX_CUSTOMER_TOOL_ROUNDS without a final reply",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } catch (err) {
    logger.warn(
      {
        event: "customer_chat_exception",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "customer chat: exception (returning degraded fallback)",
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
      temperature: 0.2,
      max_tokens: 600,
      stream: true,
      tools: CUSTOMER_CHAT_TOOLS,
      tool_choice: "auto",
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = upstream.body ? await upstream.text().catch(() => "") : "";
    logger.warn(
      {
        event: "customer_chat_openai_http_error",
        streaming: true,
        status: upstream.status,
        detail: detail.slice(0, 200),
      },
      "customer chat: openai HTTP error during stream open",
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
  toolCtx: CustomerChatToolContext,
  turns: number,
): Promise<void> {
  startSseHeaders(res);

  // Client-disconnect guard — mirrors the Anthropic path below: if the tab
  // closes mid-stream, stop running further tool rounds (real customer-
  // scoped DB reads) + LLM calls and don't write to a dead socket.
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
    for (let round = 0; round <= MAX_CUSTOMER_TOOL_ROUNDS; round++) {
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
      // If the tab closed mid-round, stop chaining — the customer-scoped
      // tools are real DB reads we shouldn't run for a viewer who's gone.
      if (clientClosed) {
        safeEnd();
        return;
      }
      if (
        result.toolCalls.length > 0 &&
        round < MAX_CUSTOMER_TOOL_ROUNDS &&
        result.finishReason === "tool_calls"
      ) {
        messages = await applyToolCalls(messages, result.toolCalls, toolCtx);
        continue;
      }
      if (totalChars === 0) {
        logger.warn(
          { event: "customer_chat_empty_reply", streaming: true, round },
          "customer chat: openai stream returned no content",
        );
        safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        degraded = true;
      }
      logger.info(
        {
          event: "customer_chat_ok",
          streaming: true,
          turns,
          replyChars: totalChars,
          rounds: round + 1,
          degraded,
        },
        "customer chat: streamed reply",
      );
      safeEvent(degraded ? { type: "done", degraded: true } : { type: "done" });
      safeEnd();
      return;
    }
    logger.warn(
      { event: "customer_chat_tool_cap_hit", streaming: true },
      "customer chat: hit MAX_CUSTOMER_TOOL_ROUNDS without a final reply",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } catch (err) {
    logger.warn(
      {
        event: "customer_chat_exception",
        streaming: true,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "customer chat: exception during stream (returning degraded fallback)",
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
//
// Same tool-calling semantics as the OpenAI path above, but uses Claude
// Sonnet 4.6 + Anthropic's tool_use shape. The system prompt (which
// embeds the caller's account context) is wrapped in a cache_control
// block so multi-turn conversations re-pay only ~10% of the input
// token cost on the 2nd+ turn. Tool execution is unchanged — the same
// async `applyToolCalls()` → `executeCustomerChatTool()` dispatcher
// runs, so the four customer-scoped DB tools behave identically
// whichever vendor answered.

const ANTHROPIC_TOOLS: AnthropicTool[] = CUSTOMER_CHAT_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

/**
 * Convert the OpenAI-shaped message log into the Anthropic Messages API
 * shape. Mirrors the storefront chat route: the system prompt is
 * extracted to the `system` field, assistant tool calls become
 * `tool_use` blocks, and each tool result becomes a `user` message with
 * a `tool_result` block.
 */
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

/** Map Anthropic tool_use blocks back into the OpenAI tool_calls shape
 * the shared `applyToolCalls()` dispatcher expects. */
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
  toolCtx: CustomerChatToolContext,
  turns: number,
): Promise<void> {
  let messages = initialMessages;
  try {
    for (let round = 0; round <= MAX_CUSTOMER_TOOL_ROUNDS; round++) {
      const { system, messages: anthMessages } =
        convertOpenAiToAnthropicMessages(messages);
      const result = await client.send({
        model: DEFAULT_ANTHROPIC_MODEL_CHAT,
        max_tokens: 600,
        temperature: 0.2,
        system: [
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages: anthMessages,
        tools: ANTHROPIC_TOOLS,
      });
      if (!result.ok) {
        logger.warn(
          {
            event: "customer_chat_anthropic_error",
            code: result.errorCode,
            status: result.httpStatus,
          },
          "customer chat: anthropic call failed",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }
      const text = getResponseText(result.response).trim();
      const toolCalls = getResponseToolCalls(result.response);
      if (toolCalls.length > 0 && round < MAX_CUSTOMER_TOOL_ROUNDS) {
        // applyToolCalls appends the assistant tool_calls message itself,
        // so hand it the prior messages (not a pre-appended copy).
        messages = await applyToolCalls(
          messages,
          toOpenAiToolCalls(toolCalls),
          toolCtx,
        );
        continue;
      }
      if (text.length === 0) {
        logger.warn(
          { event: "customer_chat_empty_reply", vendor: "anthropic", round },
          "customer chat: anthropic returned empty content",
        );
        res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
        return;
      }
      logger.info(
        {
          event: "customer_chat_ok",
          vendor: "anthropic",
          turns,
          replyChars: text.length,
          rounds: round,
        },
        "customer chat: anthropic replied",
      );
      res.json({ reply: text });
      return;
    }
    logger.warn(
      { event: "customer_chat_tool_cap_hit", vendor: "anthropic" },
      "customer chat: hit MAX_CUSTOMER_TOOL_ROUNDS without a final reply",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  } catch (err) {
    logger.warn(
      {
        event: "customer_chat_exception",
        vendor: "anthropic",
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "customer chat: anthropic exception (returning degraded fallback)",
    );
    res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
  }
}

async function handleAnthropicStreaming(
  res: Response,
  initialMessages: OpenAiMessage[],
  client: AnthropicClient,
  toolCtx: CustomerChatToolContext,
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
    for (let round = 0; round <= MAX_CUSTOMER_TOOL_ROUNDS; round++) {
      const { system, messages: anthMessages } =
        convertOpenAiToAnthropicMessages(messages);
      const startCharCount = totalChars;
      const result = await client.stream(
        {
          model: DEFAULT_ANTHROPIC_MODEL_CHAT,
          max_tokens: 600,
          temperature: 0.2,
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
            event: "customer_chat_anthropic_error",
            code: result.errorCode,
            status: result.httpStatus,
            streaming: true,
          },
          "customer chat: anthropic stream failed",
        );
        if (totalChars === 0) {
          safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        }
        safeEvent({ type: "done", degraded: true });
        safeEnd();
        return;
      }
      const toolCalls = getResponseToolCalls(result.response);
      // If the tab closed mid-round, stop chaining — the customer-scoped
      // tools are real DB reads we shouldn't run for a viewer who's gone.
      if (clientClosed) {
        safeEnd();
        return;
      }
      if (toolCalls.length > 0 && round < MAX_CUSTOMER_TOOL_ROUNDS) {
        // The assistant's pre-tool text (if any) was already streamed to
        // the client via writeChunk; `applyToolCalls` appends the
        // tool_calls turn to the canonical log so the next round's
        // conversion is consistent.
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
            event: "customer_chat_empty_reply",
            vendor: "anthropic",
            streaming: true,
            round,
          },
          "customer chat: anthropic stream returned no content",
        );
        safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
        safeEvent({ type: "done", degraded: true });
        safeEnd();
        return;
      }
      logger.info(
        {
          event: "customer_chat_ok",
          vendor: "anthropic",
          streaming: true,
          turns,
          replyChars: totalChars,
          rounds: round + 1,
        },
        "customer chat: anthropic streamed reply",
      );
      safeEvent({ type: "done" });
      safeEnd();
      return;
    }
    logger.warn(
      {
        event: "customer_chat_tool_cap_hit",
        vendor: "anthropic",
        streaming: true,
      },
      "customer chat: hit MAX_CUSTOMER_TOOL_ROUNDS without a final reply",
    );
    if (totalChars === 0) {
      safeEvent({ type: "chunk", text: DEGRADED_FALLBACK_REPLY });
    }
    safeEvent({ type: "done", degraded: true });
    safeEnd();
  } catch (err) {
    logger.warn(
      {
        event: "customer_chat_exception",
        vendor: "anthropic",
        streaming: true,
        err: err instanceof Error ? { name: err.name } : { name: "unknown" },
      },
      "customer chat: anthropic exception during stream (returning degraded fallback)",
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

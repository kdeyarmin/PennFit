/**
 * POST /api/chat — public storefront support chatbot.
 *
 * The bot answers product / insurance / replacement-schedule / FAQ
 * questions for prospective and current PennPaps patients. It is
 * grounded in the static knowledge base (`./chatbotKnowledge.ts`),
 * which embeds a generated summary of the live mask catalog.
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
import {
  buildChatSystemPrompt,
  MAX_CHAT_TURNS,
  MAX_USER_MESSAGE_CHARS,
  OFFLINE_FALLBACK_REPLY,
} from "../../lib/storefront/chatbotKnowledge.js";

const router = Router();

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

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
}

interface OpenAiStreamDelta {
  choices?: Array<{
    delta?: { content?: string };
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

router.post("/chat", async (req, res) => {
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

  return streaming
    ? handleStreaming(res, messages, apiKey)
    : handleJson(res, messages, apiKey);
});

async function handleJson(
  res: Response,
  messages: z.infer<typeof chatBodySchema>["messages"],
  apiKey: string,
): Promise<void> {
  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
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
        messages: [
          { role: "system", content: getSystemPrompt() },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
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
    const reply = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (reply.length === 0) {
      logger.warn(
        { event: "chat_empty_reply" },
        "chat: openai returned empty content",
      );
      res.json({ reply: DEGRADED_FALLBACK_REPLY, degraded: true });
      return;
    }

    logger.info(
      {
        event: "chat_ok",
        turns: messages.length,
        replyChars: reply.length,
      },
      "chat: replied",
    );
    res.json({ reply });
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

/**
 * Stream the model's reply token-by-token to an SSE client. The
 * client receives `chunk` events as text fragments and a single
 * `done` event at the end. On any error we still emit a `chunk`
 * with the degraded-fallback text and a `done` with `degraded: true`
 * so the client never has to special-case "stream ended without a
 * done event" — every successful response shape is identical.
 */
async function handleStreaming(
  res: Response,
  messages: z.infer<typeof chatBodySchema>["messages"],
  apiKey: string,
): Promise<void> {
  startSseHeaders(res);

  const fetchImpl = fetchImplOverride ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);

  let totalChars = 0;
  let degraded = false;

  try {
    const upstream = await fetchImpl(OPENAI_API_URL, {
      method: "POST",
      signal: ctrl.signal,
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
        messages: [
          { role: "system", content: getSystemPrompt() },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
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
      writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
      writeSseEvent(res, { type: "done", degraded: true });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          try {
            const json = JSON.parse(payload) as OpenAiStreamDelta;
            const text = json.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text.length > 0) {
              totalChars += text.length;
              writeSseEvent(res, { type: "chunk", text });
            }
          } catch {
            // Skip unparseable frames — OpenAI occasionally emits
            // server-side keepalives or fields we don't care about.
          }
        }
      }
    }

    if (totalChars === 0) {
      logger.warn(
        { event: "chat_empty_reply", streaming: true },
        "chat: openai stream returned no content",
      );
      writeSseEvent(res, { type: "chunk", text: DEGRADED_FALLBACK_REPLY });
      degraded = true;
    }

    logger.info(
      {
        event: "chat_ok",
        streaming: true,
        turns: messages.length,
        replyChars: totalChars,
        degraded,
      },
      "chat: streamed reply",
    );
    writeSseEvent(res, degraded ? { type: "done", degraded: true } : { type: "done" });
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

/**
 * POST /api/chat — public storefront support chatbot.
 *
 * The bot answers product / insurance / replacement-schedule / FAQ
 * questions for prospective and current PennPaps patients. It is
 * grounded in the static knowledge base (`./chatbotKnowledge.ts`),
 * which embeds a generated summary of the live mask catalog.
 *
 * Hand-rolled OpenAI Chat Completions call (mirrors
 * `lib/messaging/ai-fallback-impl.ts`):
 *   - One endpoint, JSON-mode-free, low temperature, modest max_tokens.
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

import { Router } from "express";
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

/**
 * Cache the system prompt per process. It's pure of the static
 * knowledge sections + the live mask catalog at module-load time, so
 * recomputing it per request would just burn CPU on every hit.
 */
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

/**
 * Test seam — overrides global fetch when set. Keeps the route
 * unit-testable without a hand-rolled fetch monkey-patch.
 */
let fetchImplOverride: typeof fetch | undefined;
export function __setChatFetchForTests(impl: typeof fetch | undefined): void {
  fetchImplOverride = impl;
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    logger.info(
      { event: "chat_openai_unconfigured", turns: messages.length },
      "chat: OPENAI_API_KEY not set, returning offline fallback",
    );
    res.json({ reply: OFFLINE_FALLBACK_REPLY, offline: true });
    return;
  }

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
});

export default router;

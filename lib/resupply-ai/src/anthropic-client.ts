// @workspace/resupply-ai — hand-rolled Anthropic Messages API client.
//
// Why hand-rolled (no `@anthropic-ai/sdk`):
//   The SDK pulls in a tree of helpers we never use (Files, Threads,
//   Beta clients, AsyncIterators) and complicates auditability. We use
//   exactly two endpoints: POST /v1/messages and its SSE-streaming
//   sibling. Direct `fetch` keeps the request shape inspectable in 30
//   lines and removes one transitive dep this PHI-touching package
//   would otherwise own. Mirrors the same posture as the OpenAI
//   call sites elsewhere in the repo.
//
// Why Claude:
//   For warm, empathetic patient-facing copy (chatbot, sleep coach,
//   SMS reply text) Claude's writing voice is consistently more
//   human-sounding than GPT-4o-class models. Sonnet 4.6 is the
//   sweet spot for cost/quality; Haiku 4.5 is the SMS classifier
//   workhorse.
//
// Prompt caching:
//   The storefront chatbot's system prompt is ~70k chars / ~17k
//   tokens — the bulk of every request. Setting `cache_control` on
//   that block lets Anthropic charge ~10% of normal input cost on
//   the second-and-subsequent turn of every conversation. Caches
//   live for ~5 minutes by default. We expose `cacheSystem` on the
//   request shape so callers opt in explicitly per call site.
//
// PHI containment:
//   This file does NOT touch PHI. Callers are responsible for
//   passing redacted/de-identified content. We log only timings,
//   token counts, and error codes — never message contents.
//
// Failure mode:
//   `send()` and `stream()` always RESOLVE — recoverable errors
//   (transport, HTTP non-2xx, timeout, empty response) come back as
//   `{ ok: false, errorCode, errorMessage }` so callers can fall
//   through to OpenAI or a degraded reply without try/catch. The
//   one exception is `createAnthropicClient({ apiKey: "" })`, which
//   throws at construction so a misconfigured deploy fails loudly
//   at boot rather than silently every request.

const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_API_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Default Sonnet model — best balance of quality, latency, and cost. */
export const DEFAULT_ANTHROPIC_MODEL_CHAT = "claude-sonnet-4-6";
/** Cheaper Haiku model — for high-volume, latency-sensitive tasks (SMS classification). */
export const DEFAULT_ANTHROPIC_MODEL_CLASSIFY = "claude-haiku-4-5";
/** Top-tier Opus model — for clinical reasoning when cost is no object. */
export const DEFAULT_ANTHROPIC_MODEL_REASONING = "claude-opus-4-7";

export type AnthropicRole = "user" | "assistant";

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  /**
   * Opt-in prompt caching on this block. Anthropic caches the
   * deterministic prefix of the prompt — set this on the LAST block
   * you want included in the cache key. Subsequent requests with an
   * identical cached prefix get ~90% input-token discount.
   */
  cache_control?: { type: "ephemeral" };
}

/**
 * Tool-use block — emitted by the model on an assistant turn when it
 * decides to call a tool. Callers send these BACK to the model in the
 * next round's assistant message so the conversation history stays
 * coherent; the matching `tool_result` block goes in the following
 * user message.
 */
export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool-result block — the caller's reply to a `tool_use`. Anthropic
 * frames tool results as "user" messages (the model is the assistant,
 * the runtime executing tools is conceptually the user). `content`
 * is the serialized tool output the model should read.
 */
export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  /** Set when the tool failed so the model can adapt. */
  is_error?: boolean;
}

/**
 * Content block union for messages sent INTO the Messages API.
 * Anthropic accepts text blocks on either role and tool_use /
 * tool_result blocks where appropriate (tool_use only on assistant,
 * tool_result only on user). The type is unified here so callers
 * can build a message array without juggling role-keyed unions.
 */
export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicRequest {
  /** Anthropic model slug. Use the DEFAULT_ANTHROPIC_MODEL_* constants. */
  model: string;
  /** Max tokens the model may emit. Anthropic requires this. */
  max_tokens: number;
  /** 0..1 — lower = more deterministic. */
  temperature?: number;
  /**
   * The system prompt. Either a plain string (no caching) or an
   * array of blocks (allows `cache_control` on the long, stable
   * sections — chatbot knowledge base, sleep-coach rules).
   */
  system?: string | AnthropicSystemBlock[];
  /** Conversation turns. Anthropic requires user/assistant alternation starting with user. */
  messages: AnthropicMessage[];
  /**
   * Optional stop sequences. Useful when the model produces a
   * JSON envelope and you want to halt before a closing delimiter.
   */
  stop_sequences?: string[];
  /** Optional structured tools (function calling). */
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string };

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from cache. Present when `cache_control` is used. */
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponseContentBlock {
  type: "text" | "tool_use";
  text?: string;
  /** For tool_use blocks. */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  usage: AnthropicUsage;
}

export interface AnthropicClientOptions {
  apiKey: string;
  /** Model defaults applied when caller omits one — overridable per call. */
  defaultModel?: string;
  /** Test seam — overrides global fetch. */
  fetchImpl?: typeof fetch;
  /** API URL override (for testing or proxies). */
  apiUrl?: string;
  /** anthropic-version header. Pinned default; bump deliberately. */
  apiVersion?: string;
  /** Per-call timeout in ms. */
  timeoutMs?: number;
}

export interface AnthropicClient {
  /**
   * Call /v1/messages with a complete request. Returns the parsed
   * response on success. On any HTTP error or transport failure,
   * resolves with `{ ok: false, errorCode, errorMessage }` — never
   * throws (callers should be able to fall through to a fallback
   * without try/catch).
   */
  send(req: AnthropicRequest): Promise<AnthropicCallResult>;

  /**
   * Streaming variant. Emits text deltas as they arrive through
   * `onTextDelta`, accumulates the final response, and resolves
   * with the same shape as `send()`.
   *
   * Tool-use blocks are NOT streamed delta-by-delta — they arrive
   * complete on `content_block_stop`. This mirrors how Anthropic
   * shapes the SSE stream and keeps the consumer simple.
   */
  stream(
    req: AnthropicRequest,
    onTextDelta: (text: string) => void,
  ): Promise<AnthropicCallResult>;
}

export type AnthropicCallResult =
  | {
      ok: true;
      response: AnthropicResponse;
      latencyMs: number;
    }
  | {
      ok: false;
      errorCode:
        | "config"
        | "http"
        | "timeout"
        | "parse"
        | "transport"
        | "empty";
      errorMessage: string;
      httpStatus?: number;
      latencyMs: number;
    };

export function createAnthropicClient(
  opts: AnthropicClientOptions,
): AnthropicClient {
  if (!opts.apiKey) {
    throw new Error(
      "createAnthropicClient: apiKey is required (set ANTHROPIC_API_KEY).",
    );
  }
  const apiKey = opts.apiKey;
  const apiUrl = opts.apiUrl ?? DEFAULT_API_URL;
  const apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultModel = opts.defaultModel ?? DEFAULT_ANTHROPIC_MODEL_CHAT;

  function headers(streaming: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": apiVersion,
    };
    if (streaming) h["Accept"] = "text/event-stream";
    return h;
  }

  function applyDefaults(req: AnthropicRequest): AnthropicRequest {
    return { ...req, model: req.model || defaultModel };
  }

  return {
    async send(rawReq: AnthropicRequest): Promise<AnthropicCallResult> {
      const req = applyDefaults(rawReq);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const upstream = await fetchImpl(apiUrl, {
          method: "POST",
          signal: ctrl.signal,
          headers: headers(false),
          body: JSON.stringify(req),
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `anthropic http ${upstream.status}: ${detail.slice(0, 200)}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const json = (await upstream.json()) as AnthropicResponse;
        if (!Array.isArray(json.content) || json.content.length === 0) {
          return {
            ok: false,
            errorCode: "empty",
            errorMessage: "anthropic returned no content blocks",
            latencyMs,
          };
        }
        return { ok: true, response: json, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          errorCode: isAbort ? "timeout" : "transport",
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs,
        };
      } finally {
        clearTimeout(timer);
      }
    },

    async stream(
      rawReq: AnthropicRequest,
      onTextDelta: (text: string) => void,
    ): Promise<AnthropicCallResult> {
      const req = applyDefaults(rawReq);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const startedAt = Date.now();
      try {
        const upstream = await fetchImpl(apiUrl, {
          method: "POST",
          signal: ctrl.signal,
          headers: headers(true),
          body: JSON.stringify({ ...req, stream: true }),
        });
        const latencyMs = Date.now() - startedAt;
        if (!upstream.ok || !upstream.body) {
          const detail = upstream.body
            ? await upstream.text().catch(() => "")
            : "";
          return {
            ok: false,
            errorCode: "http",
            errorMessage: `anthropic stream http ${upstream.status}: ${detail.slice(0, 200)}`,
            httpStatus: upstream.status,
            latencyMs,
          };
        }
        const accumulated = await consumeAnthropicStream(
          upstream.body,
          onTextDelta,
        );
        if (!accumulated) {
          return {
            ok: false,
            errorCode: "empty",
            errorMessage: "anthropic stream produced no content blocks",
            latencyMs,
          };
        }
        return { ok: true, response: accumulated, latencyMs };
      } catch (err) {
        const latencyMs = Date.now() - startedAt;
        const isAbort = err instanceof Error && err.name === "AbortError";
        return {
          ok: false,
          errorCode: isAbort ? "timeout" : "transport",
          errorMessage: err instanceof Error ? err.message : String(err),
          latencyMs,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: AnthropicResponse["stop_reason"];
  };
  content_block?: {
    type: "text" | "tool_use";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  };
  message?: {
    id?: string;
    model?: string;
    usage?: AnthropicUsage;
  };
  usage?: AnthropicUsage;
}

/**
 * Consume an SSE stream from the Messages API and return the assembled
 * response. Emits incremental text deltas via `onTextDelta`. Returns
 * `null` if the stream ended before any usable content arrived.
 */
async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onTextDelta: (text: string) => void,
): Promise<AnthropicResponse | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let id = "";
  let model = "";
  let stopReason: AnthropicResponse["stop_reason"] = null;
  const blocks: AnthropicResponseContentBlock[] = [];
  const toolJsonBuffers: Map<number, string> = new Map();
  let usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      let dataLine = "";
      for (const line of rawEvent.split("\n")) {
        if (line.startsWith("data:")) {
          dataLine = line.slice(5).trim();
        }
      }
      if (!dataLine) continue;
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(dataLine) as AnthropicStreamEvent;
      } catch {
        continue;
      }
      switch (parsed.type) {
        case "message_start": {
          if (parsed.message?.id) id = parsed.message.id;
          if (parsed.message?.model) model = parsed.message.model;
          if (parsed.message?.usage) {
            usage = { ...usage, ...parsed.message.usage };
          }
          break;
        }
        case "content_block_start": {
          const idx = parsed.index ?? blocks.length;
          if (parsed.content_block?.type === "text") {
            blocks[idx] = { type: "text", text: parsed.content_block.text ?? "" };
          } else if (parsed.content_block?.type === "tool_use") {
            blocks[idx] = {
              type: "tool_use",
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              input: {},
            };
            toolJsonBuffers.set(idx, "");
          }
          break;
        }
        case "content_block_delta": {
          const idx = parsed.index ?? 0;
          if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
            const cur = blocks[idx];
            if (cur && cur.type === "text") {
              cur.text = (cur.text ?? "") + parsed.delta.text;
            }
            onTextDelta(parsed.delta.text);
          } else if (
            parsed.delta?.type === "input_json_delta" &&
            typeof parsed.delta.partial_json === "string"
          ) {
            const prev = toolJsonBuffers.get(idx) ?? "";
            toolJsonBuffers.set(idx, prev + parsed.delta.partial_json);
          }
          break;
        }
        case "content_block_stop": {
          const idx = parsed.index ?? 0;
          const cur = blocks[idx];
          const buf = toolJsonBuffers.get(idx);
          if (cur && cur.type === "tool_use" && buf) {
            try {
              cur.input = JSON.parse(buf) as Record<string, unknown>;
            } catch {
              cur.input = {};
            }
          }
          break;
        }
        case "message_delta": {
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.usage) usage = { ...usage, ...parsed.usage };
          break;
        }
        case "message_stop":
          break;
        default:
          break;
      }
    }
  }

  if (blocks.length === 0) return null;
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: blocks,
    stop_reason: stopReason,
    usage,
  };
}

/**
 * Convenience: extract the concatenated text from a response,
 * skipping tool_use blocks. Returns "" if no text blocks present.
 */
export function getResponseText(response: AnthropicResponse): string {
  return response.content
    .filter((b): b is AnthropicResponseContentBlock & { type: "text"; text: string } =>
      b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("");
}

/**
 * Convenience: extract tool calls from a response.
 */
export function getResponseToolCalls(
  response: AnthropicResponse,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  for (const b of response.content) {
    if (b.type === "tool_use" && b.id && b.name) {
      calls.push({ id: b.id, name: b.name, input: b.input ?? {} });
    }
  }
  return calls;
}

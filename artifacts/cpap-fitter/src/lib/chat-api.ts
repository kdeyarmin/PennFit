// Tiny typed client for the public chat endpoint exposed by
// resupply-api. Same pattern as `shop-api.ts`: hand-roll a single
// fetch wrapper so the chat widget doesn't need to pull in a
// generated client for one endpoint.
//
// The endpoint is mounted at `/api/chat` (the storefront-router mount
// point in resupply-api/src/app.ts), public + unauthenticated, so we
// don't send credentials.

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  reply: string;
  /** True when the API key isn't configured server-side. */
  offline?: boolean;
  /** True when the upstream model call failed and a fallback was returned. */
  degraded?: boolean;
  /** True when the per-IP rate limiter rejected this turn. */
  rateLimited?: boolean;
  /**
   * True when the chat endpoint itself is unreachable — typically a
   * 404 or, in the deploy-topology regression where `pennfit.up.railway.app`
   * lands on the SPA host, an HTML body instead of JSON/SSE. The widget
   * uses this to show a "PennBot is offline" path (phone + email) rather
   * than the more transient-sounding "connection issue" copy.
   */
  unavailable?: boolean;
}

export class ChatApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatApiError";
  }
}

/**
 * Detect responses that mean "the chat endpoint isn't actually running
 * at this URL" — a 404, or any response whose body is HTML (the SPA
 * history-fallback shell, which is what `/api/chat` returns when the
 * resupply-api isn't co-served on the public domain). Both shapes lead
 * to the same UX outcome: surface a clear "PennBot is offline" path
 * instead of throwing and falling back to the vague "connection issue".
 */
function isEndpointUnavailable(res: Response): boolean {
  if (res.status === 404) return true;
  // Guard for the test-suite mocks that pass plain object literals
  // without a real `Headers` instance.
  const ct = res.headers?.get?.("content-type") ?? "";
  return ct.toLowerCase().includes("text/html");
}

export async function postChatMessage(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as ChatResponse | null;
    return {
      reply:
        body?.reply ??
        "You're sending messages too quickly. Please wait a minute and try again.",
      rateLimited: true,
    };
  }

  if (isEndpointUnavailable(res)) {
    return { reply: "", unavailable: true };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ChatApiError(
      res.status,
      body?.error ?? `Chat request failed (${res.status})`,
    );
  }

  return (await res.json()) as ChatResponse;
}

/**
 * Streams the bot's reply token-by-token via Server-Sent Events. The
 * widget calls `onChunk(text)` for every fragment as it arrives so the
 * latest assistant bubble can grow in place. Returns the final
 * meta flags (offline / degraded) once the stream's `done` event
 * fires; missing `done` (network drop, server crash) resolves with a
 * `degraded: true` so the caller never has to handle a never-resolved
 * promise.
 *
 * Resilience strategy — the SSE channel is the failure-prone link in
 * the chain (long-lived connection, proxy buffering, intermediary
 * timeouts). When SSE fails before any chunks have arrived, we
 * transparently fall back to the non-streaming JSON endpoint. The
 * server-side route is the same code; the JSON path returns a
 * complete response in one shot and is more compatible with proxies
 * that mishandle SSE. If chunks have already arrived when the stream
 * breaks, we keep them and surface `degraded: true` so the user
 * doesn't lose a partial reply.
 *
 * Handles the rate-limit case (HTTP 429 returns JSON, not SSE) by
 * decoding it as a single-shot reply and surfacing `rateLimited`.
 */
export async function streamChatMessage(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  offline?: boolean;
  degraded?: boolean;
  rateLimited?: boolean;
  unavailable?: boolean;
}> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.warn("[pennbot] stream fetch failed, trying JSON fallback", err);
    return fallbackToJson(messages, onChunk, signal);
  }

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as ChatResponse | null;
    onChunk(
      body?.reply ??
        "You're sending messages too quickly. Please wait a minute and try again.",
    );
    return { rateLimited: true };
  }

  if (isEndpointUnavailable(res)) {
    return { unavailable: true };
  }

  if (!res.ok || !res.body) {
    console.warn(
      `[pennbot] stream endpoint returned ${res.status}, trying JSON fallback`,
    );
    return fallbackToJson(messages, onChunk, signal);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunksReceived = 0;
  let result: { offline?: boolean; degraded?: boolean; rateLimited?: boolean } =
    { degraded: true };

  try {
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
          if (payload.length === 0) continue;
          let parsed: {
            type?: string;
            text?: string;
            offline?: boolean;
            degraded?: boolean;
          };
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }
          if (parsed.type === "chunk" && typeof parsed.text === "string") {
            chunksReceived += 1;
            onChunk(parsed.text);
          } else if (parsed.type === "done") {
            result = {
              offline: parsed.offline,
              degraded: parsed.degraded,
            };
          }
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.warn("[pennbot] stream interrupted", { chunksReceived, err });
    if (chunksReceived === 0) {
      return fallbackToJson(messages, onChunk, signal);
    }
    return { degraded: true };
  } finally {
    reader.releaseLock();
  }

  return result;
}

/**
 * Send the same conversation to the non-streaming JSON endpoint and
 * emit the reply as a single chunk. Used when the SSE path fails so a
 * proxy quirk or transient 5xx doesn't show the user "connection
 * issue" when a perfectly good answer is one HTTP request away.
 */
async function fallbackToJson(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  offline?: boolean;
  degraded?: boolean;
  rateLimited?: boolean;
  unavailable?: boolean;
}> {
  const reply = await postChatMessage(messages, signal);
  if (reply.reply) onChunk(reply.reply);
  return {
    offline: reply.offline,
    degraded: reply.degraded,
    rateLimited: reply.rateLimited,
    unavailable: reply.unavailable,
  };
}

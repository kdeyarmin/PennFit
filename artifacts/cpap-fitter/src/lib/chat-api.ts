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

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
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
 * Handles the rate-limit case (HTTP 429 returns JSON, not SSE) by
 * decoding it as a single-shot reply and surfacing `rateLimited`.
 */
export async function streamChatMessage(
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ offline?: boolean; degraded?: boolean; rateLimited?: boolean }> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 429) {
    const body = (await res.json().catch(() => null)) as ChatResponse | null;
    onChunk(
      body?.reply ??
        "You're sending messages too quickly. Please wait a minute and try again.",
    );
    return { rateLimited: true };
  }

  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new ChatApiError(
      res.status,
      body?.error ?? `Chat request failed (${res.status})`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
  } finally {
    reader.releaseLock();
  }

  return result;
}

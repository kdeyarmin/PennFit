// Tiny typed client for the SIGNED-IN customer chatbot endpoint
// (POST /shop/me/chat). Mirrors lib/chat-api.ts, but:
//   * Hits /resupply-api/shop/me/chat (the auth-gated route)
//   * Sends credentials so the pf_session cookie travels
//   * Surfaces a typed `unauthorized` flag so the UI can prompt the
//     visitor to sign in (instead of pretending the bot is offline)
//
// Same SSE-with-JSON-fallback resilience strategy as the public bot:
// long-lived SSE is the failure-prone link, so any pre-chunk failure
// transparently re-tries the JSON endpoint.

export interface CustomerChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface CustomerChatResponse {
  reply: string;
  /** True when the API key isn't configured server-side. */
  offline?: boolean;
  /** True when the upstream model call failed and a fallback was returned. */
  degraded?: boolean;
  /** True when the per-IP rate limiter rejected this turn. */
  rateLimited?: boolean;
  /** True when the auth gate rejected the call (no session cookie). */
  unauthorized?: boolean;
}

export class CustomerChatApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CustomerChatApiError";
  }
}

const ENDPOINT = "/resupply-api/shop/me/chat";

export async function postCustomerChatMessage(
  messages: CustomerChatMessage[],
  signal?: AbortSignal,
): Promise<CustomerChatResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 401) {
    return {
      reply:
        "Please sign in again so I can look up your orders and subscriptions.",
      unauthorized: true,
    };
  }

  if (res.status === 429) {
    const body = (await res
      .json()
      .catch(() => null)) as CustomerChatResponse | null;
    return {
      reply:
        body?.reply ??
        "You're sending messages too quickly. Please wait a minute and try again.",
      rateLimited: true,
    };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new CustomerChatApiError(
      res.status,
      body?.error ?? `Chat request failed (${res.status})`,
    );
  }

  return (await res.json()) as CustomerChatResponse;
}

/**
 * Streams the bot's reply token-by-token via Server-Sent Events. The
 * caller's `onChunk(text)` runs for every fragment as it arrives so the
 * latest assistant bubble can grow in place. Resolves with the final
 * meta flags (offline / degraded / unauthorized) once the stream's
 * `done` event fires; missing `done` resolves with `degraded: true`.
 *
 * Resilience: when SSE fails before any chunks have arrived, we
 * transparently fall back to the non-streaming JSON endpoint. If
 * chunks have already arrived when the stream breaks, we keep them
 * and surface `degraded: true`.
 */
export async function streamCustomerChatMessage(
  messages: CustomerChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  offline?: boolean;
  degraded?: boolean;
  rateLimited?: boolean;
  unauthorized?: boolean;
}> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.warn(
      "[pennbot-account] stream fetch failed, trying JSON fallback",
      err,
    );
    return fallbackToJson(messages, onChunk, signal);
  }

  if (res.status === 401) {
    onChunk(
      "Please sign in again so I can look up your orders and subscriptions.",
    );
    return { unauthorized: true };
  }

  if (res.status === 429) {
    const body = (await res
      .json()
      .catch(() => null)) as CustomerChatResponse | null;
    onChunk(
      body?.reply ??
        "You're sending messages too quickly. Please wait a minute and try again.",
    );
    return { rateLimited: true };
  }

  if (!res.ok || !res.body) {
    console.warn(
      `[pennbot-account] stream endpoint returned ${res.status}, trying JSON fallback`,
    );
    return fallbackToJson(messages, onChunk, signal);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let chunksReceived = 0;
  let result: {
    offline?: boolean;
    degraded?: boolean;
    rateLimited?: boolean;
    unauthorized?: boolean;
  } = { degraded: true };

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
    console.warn("[pennbot-account] stream interrupted", {
      chunksReceived,
      err,
    });
    if (chunksReceived === 0) {
      return fallbackToJson(messages, onChunk, signal);
    }
    return { degraded: true };
  } finally {
    reader.releaseLock();
  }

  return result;
}

async function fallbackToJson(
  messages: CustomerChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  offline?: boolean;
  degraded?: boolean;
  rateLimited?: boolean;
  unauthorized?: boolean;
}> {
  const reply = await postCustomerChatMessage(messages, signal);
  if (reply.reply) onChunk(reply.reply);
  return {
    offline: reply.offline,
    degraded: reply.degraded,
    rateLimited: reply.rateLimited,
    unauthorized: reply.unauthorized,
  };
}

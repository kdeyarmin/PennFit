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

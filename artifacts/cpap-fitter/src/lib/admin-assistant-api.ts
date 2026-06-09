// Tiny typed client for the signed-in ADMIN program-manager chatbot
// endpoint (POST /resupply-api/admin/assistant/chat — "PennPilot").
//
// Mirrors lib/customer-chat-api.ts:
//   * Hits the auth-gated admin route under /resupply-api.
//   * Sends credentials so the pf_session cookie travels, plus the
//     CSRF header (the route is a POST under /admin/*, which the app's
//     CSRF middleware guards).
//   * Surfaces a typed `unauthorized` flag so the UI can prompt a
//     re-sign-in instead of pretending the bot is offline.
//   * SSE-with-JSON-fallback resilience: a pre-chunk stream failure
//     transparently retries the non-streaming JSON endpoint.

import { csrfHeader } from "./csrf";

export interface AdminAssistantMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AdminAssistantResponse {
  reply: string;
  /** True when no AI provider key is configured server-side. */
  offline?: boolean;
  /** True when the upstream model call failed and a fallback was returned. */
  degraded?: boolean;
  /** True when the per-operator rate limiter rejected this turn. */
  rateLimited?: boolean;
  /** True when the auth gate rejected the call (no admin session). */
  unauthorized?: boolean;
}

export class AdminAssistantApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminAssistantApiError";
  }
}

const ENDPOINT = "/resupply-api/admin/assistant/chat";

const UNAUTHORIZED_REPLY =
  "Your admin session expired. Please sign in again to keep chatting with PennPilot.";
const RATE_LIMITED_REPLY =
  "You're sending messages too quickly. Please wait a minute and try again.";

export async function postAdminAssistantMessage(
  messages: AdminAssistantMessage[],
  signal?: AbortSignal,
): Promise<AdminAssistantResponse> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...csrfHeader(),
    },
    body: JSON.stringify({ messages }),
    signal,
  });

  if (res.status === 401 || res.status === 403) {
    return { reply: UNAUTHORIZED_REPLY, unauthorized: true };
  }

  if (res.status === 429) {
    const body = (await res
      .json()
      .catch(() => null)) as AdminAssistantResponse | null;
    return { reply: body?.reply ?? RATE_LIMITED_REPLY, rateLimited: true };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new AdminAssistantApiError(
      res.status,
      body?.error ?? `PennPilot request failed (${res.status})`,
    );
  }

  return (await res.json()) as AdminAssistantResponse;
}

/**
 * Streams PennPilot's reply token-by-token via Server-Sent Events.
 * `onChunk(text)` runs for every fragment as it arrives. Resolves with
 * the final meta flags once the stream's `done` event fires; a missing
 * `done` resolves `degraded: true`. When SSE fails before any chunk
 * arrives, transparently falls back to the JSON endpoint.
 */
export async function streamAdminAssistantMessage(
  messages: AdminAssistantMessage[],
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
        ...csrfHeader(),
      },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.warn("[pennpilot] stream fetch failed, trying JSON fallback", err);
    return fallbackToJson(messages, onChunk, signal);
  }

  if (res.status === 401 || res.status === 403) {
    onChunk(UNAUTHORIZED_REPLY);
    return { unauthorized: true };
  }

  if (res.status === 429) {
    const body = (await res
      .json()
      .catch(() => null)) as AdminAssistantResponse | null;
    onChunk(body?.reply ?? RATE_LIMITED_REPLY);
    return { rateLimited: true };
  }

  if (!res.ok || !res.body) {
    console.warn(
      `[pennpilot] stream endpoint returned ${res.status}, trying JSON fallback`,
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
            result = { offline: parsed.offline, degraded: parsed.degraded };
          }
        }
      }
    }
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    console.warn("[pennpilot] stream interrupted", { chunksReceived, err });
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
  messages: AdminAssistantMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<{
  offline?: boolean;
  degraded?: boolean;
  rateLimited?: boolean;
  unauthorized?: boolean;
}> {
  const reply = await postAdminAssistantMessage(messages, signal);
  if (reply.reply) onChunk(reply.reply);
  return {
    offline: reply.offline,
    degraded: reply.degraded,
    rateLimited: reply.rateLimited,
    unauthorized: reply.unauthorized,
  };
}

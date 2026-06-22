// Thin Slack Web API client — just the surface this integration needs.
//
// No SDK dependency: a single `chat.postMessage` call over fetch keeps the
// package dependency-free and easy to stub in tests. Network/HTTP/Slack-API
// errors are normalized into a result object; the client NEVER throws, so a
// flaky Slack call can stay fire-and-forget at the call site.
//
// MUST NOT IMPORT: pg, @workspace/resupply-db. This is a pure vendor client.

import type { SlackConfig } from "./config";

const CHAT_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const DEFAULT_TIMEOUT_MS = 5_000;

export interface PostMessageInput {
  /** Channel id; falls back to the config's default channel when omitted. */
  channel?: string;
  /** Plain-text fallback (notifications, no-blocks clients). */
  text: string;
  /** Optional Block Kit blocks. */
  blocks?: unknown[];
  /** Post into an existing thread. */
  threadTs?: string;
}

export interface PostMessageResult {
  ok: boolean;
  /** Slack message timestamp id on success (thread anchor). */
  ts?: string;
  /** Slack `error` code or a transport error string on failure. */
  error?: string;
}

export interface PostMessageOptions {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Post a message via chat.postMessage. Resolves to `{ ok: false, error }`
 * on any transport failure, timeout, or Slack-level error — never throws.
 */
export async function postSlackMessage(
  config: SlackConfig,
  input: PostMessageInput,
  options: PostMessageOptions = {},
): Promise<PostMessageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(CHAT_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${config.botToken}`,
      },
      body: JSON.stringify({
        channel: input.channel ?? config.defaultChannel,
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      }),
      signal: controller.signal,
    });

    // Slack always returns HTTP 200 with `{ ok: false, error }` for
    // application errors; a non-200 is a transport/auth problem.
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const json = (await res.json()) as {
      ok?: boolean;
      ts?: string;
      error?: string;
    };
    if (!json.ok) {
      return { ok: false, error: json.error ?? "unknown_slack_error" };
    }
    return { ok: true, ts: json.ts };
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === "AbortError"
          ? "timeout"
          : err.message
        : "unknown_error";
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

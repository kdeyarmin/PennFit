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
const AUTH_TEST_URL = "https://slack.com/api/auth.test";
const OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
const DEFAULT_TIMEOUT_MS = 5_000;

/** OAuth scopes the platform Slack app requests on install. */
export const SLACK_OAUTH_SCOPES = "chat:write,commands,incoming-webhook";

export interface OAuthExchangeInput {
  clientId: string;
  clientSecret: string;
  /** The temporary code Slack returned on the OAuth redirect. */
  code: string;
  /** Must byte-match the redirect_uri used to start the flow. */
  redirectUri: string;
}

export interface OAuthExchangeResult {
  ok: boolean;
  /** Bot user OAuth token (xoxb-…) for the installing workspace. */
  botToken?: string;
  teamId?: string;
  teamName?: string;
  /** Channel id the operator picked during the incoming-webhook consent. */
  channelId?: string;
  scope?: string;
  error?: string;
}

/**
 * Exchange an OAuth authorization code for a workspace install (oauth.v2.access)
 * — the back half of the "Add to Slack" flow. Returns the per-workspace bot
 * token + team + chosen channel. Never throws.
 */
export async function exchangeSlackOAuthCode(
  input: OAuthExchangeInput,
  options: PostMessageOptions = {},
): Promise<OAuthExchangeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
    });
    const res = await fetchImpl(OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = (await res.json()) as {
      ok?: boolean;
      access_token?: string;
      scope?: string;
      team?: { id?: string; name?: string };
      incoming_webhook?: { channel_id?: string };
      error?: string;
    };
    if (!json.ok || !json.access_token) {
      return { ok: false, error: json.error ?? "unknown_slack_error" };
    }
    return {
      ok: true,
      botToken: json.access_token,
      teamId: json.team?.id,
      teamName: json.team?.name,
      channelId: json.incoming_webhook?.channel_id,
      scope: json.scope,
    };
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

export interface AuthTestResult {
  ok: boolean;
  /** Workspace name, e.g. "Acme Home Medical". */
  team?: string;
  /** Workspace id, e.g. "T0123ABCD" — used to route inbound requests. */
  teamId?: string;
  /** The bot user id the token belongs to. */
  botUserId?: string;
  /** Slack `error` code or transport error string on failure. */
  error?: string;
}

/**
 * Call auth.test to verify a bot token and learn which workspace it belongs to
 * (name + team id). Lets setup auto-detect the team id instead of asking the
 * operator to hunt for it. Never throws.
 */
export async function slackAuthTest(
  config: SlackConfig,
  options: PostMessageOptions = {},
): Promise<AuthTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(AUTH_TEST_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${config.botToken}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = (await res.json()) as {
      ok?: boolean;
      team?: string;
      team_id?: string;
      user_id?: string;
      error?: string;
    };
    if (!json.ok)
      return { ok: false, error: json.error ?? "unknown_slack_error" };
    return {
      ok: true,
      team: json.team,
      teamId: json.team_id,
      botUserId: json.user_id,
    };
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

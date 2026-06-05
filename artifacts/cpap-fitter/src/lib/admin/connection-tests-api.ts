// Hand-rolled fetch wrappers for /admin/connection-tests — backs the
// "Connection tests" section on the super-admin System Configuration
// page. Same pattern as app-config-api.ts (cookie auth + CSRF header).
//
// Each "send test" performs ONE real vendor round-trip server-side. A
// failed test resolves to a 200 with `{ ok: false, … }` (the request
// succeeded; the test reported failure), so callers inspect `ok` rather
// than catching an HTTP error. Only a malformed body / auth failure
// throws an ApiError.

import { ApiError } from "@workspace/api-client-react/admin";

import { csrfHeader } from "../csrf";

export type LlmProvider = "anthropic" | "openai" | "offline";

export interface ConnectionTestStatus {
  email: { configured: boolean };
  sms: { configured: boolean };
  voice: { configured: boolean };
  chat: { configured: boolean; provider: LlmProvider };
}

export type ConnectionChannel = "email" | "sms" | "voice" | "chat";

export type ConnectionTestResult =
  | {
      ok: true;
      channel: ConnectionChannel;
      detail: Record<string, string | number | null>;
    }
  | {
      ok: false;
      channel: ConnectionChannel;
      code: "not_configured" | "upstream_error" | "config_error" | "unknown_error";
      message: string;
      upstream?: { status?: number | null; code?: string | number | null };
    };

async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { headers, ...rest } = init;
  const method = (init.method ?? "GET").toUpperCase();
  const url = `/resupply-api${path}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...csrfHeader(),
      ...(headers ?? {}),
    },
    ...rest,
  });
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // body not JSON
    }
    throw new ApiError(res, data, { method, url });
  }
  return (await res.json()) as T;
}

export const getConnectionTestStatus = () =>
  jsonFetch<ConnectionTestStatus>("/admin/connection-tests/status");

const postJson = (path: string, body: unknown) =>
  jsonFetch<ConnectionTestResult>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const sendTestEmail = (to: string) =>
  postJson("/admin/connection-tests/email", { to });

export const sendTestSms = (to: string) =>
  postJson("/admin/connection-tests/sms", { to });

export const sendTestVoice = (to: string) =>
  postJson("/admin/connection-tests/voice", { to });

export const runChatConnectionTest = () =>
  postJson("/admin/connection-tests/chat", {});

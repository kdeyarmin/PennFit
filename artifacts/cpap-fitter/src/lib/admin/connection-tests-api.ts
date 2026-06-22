// Hand-rolled fetch wrappers for /platform/connection-tests — backs the
// "Connection tests" tab on the global super-admin (/platform) console.
// These verify the PLATFORM infrastructure (SendGrid, Twilio, AI vendors)
// the super-admin manages; they are gated by requirePlatformAdmin.
// Same pattern as platform-config-api.ts (cookie auth + CSRF header).
//
// Each "send test" performs ONE real vendor round-trip server-side. A
// failed test resolves to a 200 with `{ ok: false, … }` (the request
// succeeded; the test reported failure), so callers inspect `ok` rather
// than catching an HTTP error. Only a malformed body / auth failure
// throws an ApiError.

import { adminJsonFetch as jsonFetch } from "../admin-json-fetch";

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
      code:
        | "not_configured"
        | "upstream_error"
        | "config_error"
        | "unknown_error";
      message: string;
      upstream?: { status?: number | null; code?: string | number | null };
    };

export const getConnectionTestStatus = () =>
  jsonFetch<ConnectionTestStatus>("/platform/connection-tests/status");

const postJson = (path: string, body: unknown) =>
  jsonFetch<ConnectionTestResult>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

export const sendTestEmail = (to: string) =>
  postJson("/platform/connection-tests/email", { to });

export const sendTestSms = (to: string) =>
  postJson("/platform/connection-tests/sms", { to });

export const sendTestVoice = (to: string) =>
  postJson("/platform/connection-tests/voice", { to });

export const runChatConnectionTest = () =>
  postJson("/platform/connection-tests/chat", {});

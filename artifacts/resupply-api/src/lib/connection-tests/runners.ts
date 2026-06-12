// Connection-test runners — the logic behind the super-admin
// "send a test" buttons on /admin/system/configuration.
//
// Each runner takes an *effective* env (process.env merged with any
// values a super-admin just saved in System Configuration — see
// `getEffectiveEnv()` in ../app-config/store), constructs the relevant
// vendor client, and performs ONE real round-trip:
//
//   * email — sends a real test email through SendGrid.
//   * sms   — sends a real test SMS through Twilio.
//   * voice — places a real outbound call through Twilio that speaks a
//             short "your integration works" message and hangs up.
//   * chat  — pings the active LLM provider (Claude / OpenAI) with a
//             trivial prompt and confirms a non-empty reply.
//
// Why "effective env" and not process.env directly:
//   The integration-credential catalog keys (SENDGRID_API_KEY, the
//   TWILIO_* set, ANTHROPIC_API_KEY, OPENAI_API_KEY, …) are all
//   `applyMode: "restart"` — a value saved in the UI only folds into
//   process.env on the NEXT deploy. Testing the effective value lets a
//   super-admin paste a rotated key and verify it BEFORE redeploying.
//
// Design:
//   * Pure-ish: the only side effect is the outbound vendor call. Every
//     dependency (client factories, fetch, clock) is injected via
//     `ConnectionTestDeps` with real defaults, so the route stays thin
//     and unit tests need no module mocking.
//   * Never throws for an expected failure. A missing credential or an
//     upstream rejection resolves to `{ ok: false, code, message }` so
//     the route can return a clean 200 with the result and the UI can
//     render red without treating it as an HTTP error.
//   * PHI / secret posture: the runners return vendor-supplied error
//     STRINGS (safe diagnostics like "Sender Identity not verified")
//     but the route logs only channel + outcome + structural codes —
//     never the recipient, never a secret. Test message bodies are
//     fixed strings with no PHI.
//
// PHI note: the recipient an operator types here is THEIR OWN test
// target (their phone / a shared mailbox). We still treat it as
// sensitive and never log it — same posture as click-to-dial.

import {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
  EmailApiError,
  EmailConfigError,
  type SendgridClient,
} from "@workspace/resupply-email";
import {
  createTwilioClient,
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
  type TwilioClient,
  type TwilioSmsClient,
} from "@workspace/resupply-telecom";

import {
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  getAnthropicClient,
  getResponseText,
  selectLlmProvider,
  type AnthropicClient,
  type LlmProvider,
} from "../llm-provider";
import { readVoicePublicBaseUrlOrNull } from "../voice/voice-config";

export type ConnectionChannel = "email" | "sms" | "voice" | "chat";

/** A failed test that still *executed* — a normal, expected outcome. */
export type ConnectionTestFailCode =
  | "not_configured" // required env / credentials missing
  | "upstream_error" // vendor rejected the request
  | "config_error" // client refused to construct (bad/missing shape)
  | "unknown_error"; // anything we didn't anticipate

export interface ConnectionTestOk {
  ok: true;
  channel: ConnectionChannel;
  /** Small, non-secret, PHI-free facts about the successful send. */
  detail: Record<string, string | number | null>;
}

export interface ConnectionTestFail {
  ok: false;
  channel: ConnectionChannel;
  code: ConnectionTestFailCode;
  /** Operator-facing, safe to display. Never a secret value. */
  message: string;
  /** Optional structured upstream codes for diagnostics. */
  upstream?: { status?: number | null; code?: string | number | null };
}

export type ConnectionTestResult = ConnectionTestOk | ConnectionTestFail;

/**
 * Per-channel "is this wired?" view for the status endpoint. Pure env
 * reads — no vendor round-trips — so the page paints instantly and we
 * can disable a "Send test" button for a channel with no credentials.
 */
export interface ConnectionTestStatus {
  email: { configured: boolean };
  sms: { configured: boolean };
  voice: { configured: boolean };
  chat: { configured: boolean; provider: LlmProvider };
}

/**
 * Injectable seams. Production binds the real vendor factories; tests
 * pass fakes. Mirrors the `sgFactory` / `sdkFactory` / `fetchImpl`
 * pattern the vendor libs already expose one layer down.
 */
export interface ConnectionTestDeps {
  createSendgridClient: typeof createSendgridClient;
  createTwilioSmsClient: typeof createTwilioSmsClient;
  createTwilioVoiceClient: typeof createTwilioClient;
  getAnthropicClient: typeof getAnthropicClient;
  selectLlmProvider: typeof selectLlmProvider;
  fetchImpl: typeof fetch;
  now: () => Date;
}

export const defaultConnectionTestDeps: ConnectionTestDeps = {
  createSendgridClient,
  createTwilioSmsClient,
  createTwilioVoiceClient: createTwilioClient,
  getAnthropicClient,
  selectLlmProvider,
  fetchImpl: (...args: Parameters<typeof fetch>) => fetch(...args),
  now: () => new Date(),
};

// ── Config predicates (shared by the status endpoint and each runner) ─

function nonEmpty(v: string | undefined | null): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function emailConfigured(env: NodeJS.ProcessEnv): boolean {
  // The From address is a fixed platform constant that createSendgridClient
  // defaults to (info@pennpaps.com), so the API key is the only thing that
  // actually gates whether we can send.
  return nonEmpty(env.SENDGRID_API_KEY);
}

function smsConfigured(env: NodeJS.ProcessEnv): boolean {
  return (
    nonEmpty(env.TWILIO_ACCOUNT_SID) &&
    nonEmpty(env.TWILIO_AUTH_TOKEN) &&
    (nonEmpty(env.TWILIO_MESSAGING_SERVICE_SID) ||
      nonEmpty(env.TWILIO_PHONE_NUMBER))
  );
}

/**
 * A connection-test call needs Twilio creds, a FROM number, and a
 * public base URL Twilio can fetch the TwiML from. It deliberately does
 * NOT require OPENAI_API_KEY (unlike `readVoiceConfigOrNull`, which gates
 * the realtime AGENT): the test call is a static Say + Hangup, so it can
 * verify the Twilio voice path even on a deploy with no AI voice agent.
 */
function voiceConfigured(env: NodeJS.ProcessEnv): boolean {
  return (
    nonEmpty(env.TWILIO_ACCOUNT_SID) &&
    nonEmpty(env.TWILIO_AUTH_TOKEN) &&
    nonEmpty(env.TWILIO_PHONE_NUMBER) &&
    readVoicePublicBaseUrlOrNull(env) !== null
  );
}

export function computeConnectionTestStatus(
  env: NodeJS.ProcessEnv,
): ConnectionTestStatus {
  const { provider } = selectLlmProvider(env);
  return {
    email: { configured: emailConfigured(env) },
    sms: { configured: smsConfigured(env) },
    voice: { configured: voiceConfigured(env) },
    chat: { configured: provider !== "offline", provider },
  };
}

// ── Fixed, PHI-free test message bodies ──────────────────────────────

const TEST_EMAIL_SUBJECT = "PennPaps connection test";

function testEmailHtml(stamp: string): string {
  return [
    `<p>This is a connection test from the PennPaps admin console.</p>`,
    `<p>If you are reading this, your SendGrid email integration is`,
    ` working correctly.</p>`,
    `<p style="color:#888;font-size:12px">Sent ${stamp}</p>`,
  ].join("");
}

function testEmailText(stamp: string): string {
  return (
    `This is a connection test from the PennPaps admin console.\n\n` +
    `If you are reading this, your SendGrid email integration is ` +
    `working correctly.\n\nSent ${stamp}`
  );
}

// Single-segment ASCII so it never splits / transcodes to UCS-2.
const TEST_SMS_BODY =
  "PennPaps connection test: your Twilio SMS integration is working. " +
  "(automated message from the admin console)";

// Spoken by the connection-test TwiML route after Twilio fetches it.
export const TEST_VOICE_MESSAGE =
  "This is a connection test from Penn Fit. " +
  "Your outbound voice integration is working correctly. Goodbye.";

const CHAT_TEST_PROMPT = "Connection test. Reply with the single word: OK.";

// ── Runners ──────────────────────────────────────────────────────────

export async function runEmailTest(
  env: NodeJS.ProcessEnv,
  input: { to: string },
  deps: ConnectionTestDeps = defaultConnectionTestDeps,
): Promise<ConnectionTestResult> {
  if (!emailConfigured(env)) {
    return {
      ok: false,
      channel: "email",
      code: "not_configured",
      message:
        "SendGrid is not configured. Set SENDGRID_API_KEY (in System " +
        "Configuration or the environment). The From address defaults to " +
        `${DEFAULT_SENDGRID_FROM_EMAIL} but can be overridden with SENDGRID_FROM_EMAIL.`,
    };
  }
  let client: SendgridClient;
  try {
    client = deps.createSendgridClient({
      apiKey: env.SENDGRID_API_KEY,
      fromEmail: env.SENDGRID_FROM_EMAIL,
      fromName: env.SENDGRID_FROM_NAME,
    });
  } catch (err) {
    return configErrorResult("email", err, EmailConfigError);
  }
  const stamp = deps.now().toISOString();
  try {
    const result = await client.sendEmail({
      to: input.to,
      subject: TEST_EMAIL_SUBJECT,
      html: testEmailHtml(stamp),
      text: testEmailText(stamp),
    });
    return {
      ok: true,
      channel: "email",
      detail: {
        messageId: result.messageId,
        from: nonEmpty(env.SENDGRID_FROM_EMAIL)
          ? env.SENDGRID_FROM_EMAIL.trim()
          : DEFAULT_SENDGRID_FROM_EMAIL,
      },
    };
  } catch (err) {
    if (err instanceof EmailConfigError) {
      return {
        ok: false,
        channel: "email",
        code: "config_error",
        message: err.message,
      };
    }
    if (err instanceof EmailApiError) {
      return {
        ok: false,
        channel: "email",
        code: "upstream_error",
        message: cap(err.message),
        upstream: { status: err.status ?? null },
      };
    }
    return unknownResult("email", err);
  }
}

export async function runSmsTest(
  env: NodeJS.ProcessEnv,
  input: { to: string },
  deps: ConnectionTestDeps = defaultConnectionTestDeps,
): Promise<ConnectionTestResult> {
  if (!smsConfigured(env)) {
    return {
      ok: false,
      channel: "sms",
      code: "not_configured",
      message:
        "Twilio SMS is not configured. Set TWILIO_ACCOUNT_SID, " +
        "TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID (or " +
        "TWILIO_PHONE_NUMBER).",
    };
  }
  let client: TwilioSmsClient;
  try {
    client = deps.createTwilioSmsClient({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_PHONE_NUMBER,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
  } catch (err) {
    return configErrorResult("sms", err, TwilioConfigError);
  }
  try {
    const result = await client.sendSms({ to: input.to, body: TEST_SMS_BODY });
    return {
      ok: true,
      channel: "sms",
      detail: { messageSid: result.messageSid },
    };
  } catch (err) {
    if (err instanceof TwilioConfigError) {
      return {
        ok: false,
        channel: "sms",
        code: "config_error",
        message: err.message,
      };
    }
    if (err instanceof TwilioApiError) {
      return {
        ok: false,
        channel: "sms",
        code: "upstream_error",
        message: cap(err.message),
        upstream: { status: err.status ?? null, code: err.code ?? null },
      };
    }
    return unknownResult("sms", err);
  }
}

export async function runVoiceTest(
  env: NodeJS.ProcessEnv,
  input: { to: string },
  deps: ConnectionTestDeps = defaultConnectionTestDeps,
): Promise<ConnectionTestResult> {
  const baseUrl = readVoicePublicBaseUrlOrNull(env);
  if (
    !nonEmpty(env.TWILIO_ACCOUNT_SID) ||
    !nonEmpty(env.TWILIO_AUTH_TOKEN) ||
    !nonEmpty(env.TWILIO_PHONE_NUMBER) ||
    !baseUrl
  ) {
    return {
      ok: false,
      channel: "voice",
      code: "not_configured",
      message:
        "Twilio voice is not configured. Set TWILIO_ACCOUNT_SID, " +
        "TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, and " +
        "RESUPPLY_VOICE_PUBLIC_BASE_URL (or RAILWAY_PUBLIC_DOMAIN).",
    };
  }
  let client: TwilioClient;
  try {
    client = deps.createTwilioVoiceClient({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
    });
  } catch (err) {
    return configErrorResult("voice", err, TwilioConfigError);
  }
  // Twilio fetches this URL when the callee answers; the route returns a
  // static Say + Hangup. Built from the SAME base URL the signature
  // middleware reconstructs, so the Twilio signature validates.
  const twimlUrl = `${baseUrl}/resupply-api/voice/connection-test-twiml`;
  try {
    const result = await client.placeCall({
      to: input.to,
      from: env.TWILIO_PHONE_NUMBER,
      url: twimlUrl,
    });
    return { ok: true, channel: "voice", detail: { callSid: result.sid } };
  } catch (err) {
    if (err instanceof TwilioConfigError) {
      return {
        ok: false,
        channel: "voice",
        code: "config_error",
        message: err.message,
      };
    }
    if (err instanceof TwilioApiError) {
      return {
        ok: false,
        channel: "voice",
        code: "upstream_error",
        message: cap(err.message),
        upstream: { status: err.status ?? null, code: err.code ?? null },
      };
    }
    return unknownResult("voice", err);
  }
}

export async function runChatTest(
  env: NodeJS.ProcessEnv,
  deps: ConnectionTestDeps = defaultConnectionTestDeps,
): Promise<ConnectionTestResult> {
  const { provider } = deps.selectLlmProvider(env);
  if (provider === "offline") {
    return {
      ok: false,
      channel: "chat",
      code: "not_configured",
      message:
        "No LLM provider is configured. Set ANTHROPIC_API_KEY " +
        "(preferred) or OPENAI_API_KEY.",
    };
  }
  if (provider === "anthropic") {
    return runAnthropicChatTest(env, deps);
  }
  return runOpenAiChatTest(env, deps);
}

async function runAnthropicChatTest(
  env: NodeJS.ProcessEnv,
  deps: ConnectionTestDeps,
): Promise<ConnectionTestResult> {
  const client: AnthropicClient | null = deps.getAnthropicClient(env);
  if (!client) {
    return {
      ok: false,
      channel: "chat",
      code: "not_configured",
      message: "ANTHROPIC_API_KEY is not set.",
    };
  }
  const result = await client.send({
    model: DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
    max_tokens: 16,
    temperature: 0,
    messages: [{ role: "user", content: CHAT_TEST_PROMPT }],
  });
  if (!result.ok) {
    return {
      ok: false,
      channel: "chat",
      code: "upstream_error",
      message: cap(result.errorMessage),
      upstream: { status: result.httpStatus ?? null, code: result.errorCode },
    };
  }
  const reply = getResponseText(result.response).trim();
  return {
    ok: true,
    channel: "chat",
    detail: {
      provider: "anthropic",
      model: result.response.model,
      reply: cap(reply, 120),
      latencyMs: result.latencyMs,
    },
  };
}

async function runOpenAiChatTest(
  env: NodeJS.ProcessEnv,
  deps: ConnectionTestDeps,
): Promise<ConnectionTestResult> {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return {
      ok: false,
      channel: "chat",
      code: "not_configured",
      message: "OPENAI_API_KEY is not set.",
    };
  }
  const startedAt = deps.now().getTime();
  try {
    const resp = await deps.fetchImpl(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 16,
          temperature: 0,
          messages: [{ role: "user", content: CHAT_TEST_PROMPT }],
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      return {
        ok: false,
        channel: "chat",
        code: "upstream_error",
        message: cap(
          openAiErrorMessage(bodyText) ?? `OpenAI HTTP ${resp.status}`,
        ),
        upstream: { status: resp.status },
      };
    }
    const json = (await resp.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!reply) {
      return {
        ok: false,
        channel: "chat",
        code: "upstream_error",
        message: "OpenAI returned an empty completion.",
      };
    }
    return {
      ok: true,
      channel: "chat",
      detail: {
        provider: "openai",
        model: json.model ?? "gpt-4o-mini",
        reply: cap(reply, 120),
        latencyMs: deps.now().getTime() - startedAt,
      },
    };
  } catch (err) {
    return unknownResult("chat", err);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/** Cap a vendor string so a long upstream blob can't bloat the response. */
function cap(s: string, max = 300): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/** Pull the human-readable `error.message` out of an OpenAI error body. */
function openAiErrorMessage(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string } };
    const m = parsed.error?.message;
    return typeof m === "string" && m.length > 0 ? m : null;
  } catch {
    return null;
  }
}

function configErrorResult(
  channel: ConnectionChannel,
  err: unknown,
  ctor: new (...args: never[]) => Error,
): ConnectionTestFail {
  if (err instanceof ctor) {
    return { ok: false, channel, code: "config_error", message: err.message };
  }
  return unknownResult(channel, err);
}

function unknownResult(
  channel: ConnectionChannel,
  err: unknown,
): ConnectionTestFail {
  return {
    ok: false,
    channel,
    code: "unknown_error",
    message: cap(err instanceof Error ? err.message : "Unexpected error."),
  };
}

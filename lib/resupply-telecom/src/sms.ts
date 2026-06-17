// @workspace/resupply-telecom — Twilio Programmable Messaging (SMS) wrapper.
//
// Same shape and rationale as `./client.ts` (the voice REST wrapper),
// but for the Messaging API. Three reasons we wrap rather than expose
// the SDK directly:
//   1. Narrow surface — one operation, sendSms — so future additions
//      land here as a reviewable diff, not "the API now also DMs WhatsApp".
//   2. Centralised env-var reading. Missing config throws at construction,
//      not at the first send-failure deep inside the SDK.
//   3. Mock seam — `createTwilioSmsClient({ sdkFactory })` lets route
//      tests inject a fake without monkey-patching the require cache.
//
// Environment:
//   - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN — required.
//   - TWILIO_MESSAGING_SERVICE_SID OR TWILIO_PHONE_NUMBER — at least one.
//     If both are present, MESSAGING_SERVICE_SID wins (Twilio recommends
//     messaging services for production: opt-out handling, sticky
//     sender, regulatory routing). The `from` field is only used as a
//     fallback when no service SID is configured.
//
// Inbound SMS does NOT need this module — Twilio POSTs the inbound
// webhook with form-encoded params we validate via the existing
// `requireTwilioSignature` middleware. We only expose a zod parser for
// the inbound payload shape so route handlers don't have to redo it.

import { z } from "zod";
import twilioPkg from "twilio";

import { TwilioApiError, TwilioConfigError } from "./client";
import {
  DEFAULT_SMS_RETRY_POLICY,
  isTransientTwilioError,
  withRetry,
  type RetryPolicy,
} from "./retry";

const Twilio = twilioPkg;

export interface SendSmsInput {
  /** E.164 destination, e.g. "+12155551212". */
  to: string;
  /** Message body. ASCII fits in 160 chars/segment; UCS-2 in 70. */
  body: string;
  /** Public URL Twilio POSTs delivery status updates to. */
  statusCallbackUrl?: string;
  /**
   * Per-call override for the from-number. Production should leave
   * this unset and let the client use the messaging service SID or
   * the env-configured TWILIO_PHONE_NUMBER. Tests use this to
   * exercise both routing modes without env mutation.
   */
  from?: string;
  /** Per-call override for the messaging service SID. Same rationale. */
  messagingServiceSid?: string;
}

export interface SendSmsResult {
  /** Twilio message SID, e.g. "SMxxxxxxxx..." */
  messageSid: string;
}

/**
 * A point-in-time delivery status for a previously-sent message, as
 * reported by the Twilio Message resource (NOT the status webhook).
 * Used by {@link TwilioSmsClient.confirmDelivery} so a caller without a
 * webhook (e.g. the admin "send a test SMS" button) can still learn
 * whether the message actually delivered rather than only that Twilio
 * *accepted* it.
 */
export interface SmsDeliveryStatus {
  /**
   * Twilio message status: queued | sending | sent | delivered |
   * undelivered | failed | accepted | … . `sent` (carrier-accepted) is
   * NOT terminal; only delivered / undelivered / failed are.
   */
  status: string;
  /** Twilio numeric error code (e.g. 30032 toll-free unverified), or null. */
  errorCode: number | null;
  /** Twilio human-readable error string, or null. */
  errorMessage: string | null;
}

export interface ConfirmDeliveryOptions {
  /**
   * Max wall-clock to wait for a TERMINAL status (delivered /
   * undelivered / failed) before giving up and returning the last
   * non-terminal status observed. Default 8000ms.
   */
  timeoutMs?: number;
  /** Delay between polls of the Message resource. Default 1500ms. */
  pollIntervalMs?: number;
  /** Test seam — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ConfirmDeliveryResult extends SmsDeliveryStatus {
  /** True once `status` reached delivered / undelivered / failed. */
  terminal: boolean;
  /** True only when the message reached the terminal `delivered` state. */
  delivered: boolean;
}

/**
 * Minimal contract the underlying Twilio SDK must satisfy. Tests
 * provide a fake matching this shape. Typed loosely on purpose —
 * Twilio's published types are huge and we depend on a couple of
 * methods.
 *
 * `messages` is BOTH callable (`messages(sid).fetch()` — read a message)
 * AND carries `.create` (send a message), mirroring the real SDK. Tests
 * that only exercise sending can keep passing `{ messages: { create } }`
 * (cast through `unknown`); the callable half is only touched by
 * {@link TwilioSmsClient.confirmDelivery}.
 */
export interface RawTwilioMessageContext {
  fetch(): Promise<{
    sid: string;
    status: string;
    errorCode?: number | null;
    errorMessage?: string | null;
  }>;
}

export interface RawTwilioMessagingSdk {
  messages: ((sid: string) => RawTwilioMessageContext) & {
    create(opts: {
      to: string;
      from?: string;
      messagingServiceSid?: string;
      body: string;
      statusCallback?: string;
    }): Promise<{ sid: string }>;
  };
}

export interface CreateTwilioSmsClientOptions {
  accountSid?: string;
  authToken?: string;
  /** Default from-number if neither input.from nor input.messagingServiceSid is provided. */
  from?: string;
  /** Default messaging service SID; takes precedence over `from`. */
  messagingServiceSid?: string;
  /** Test-only seam. Production callers leave undefined. */
  sdkFactory?: (accountSid: string, authToken: string) => RawTwilioMessagingSdk;
  /**
   * Override the bounded in-process retry on transient Twilio failures
   * (HTTP 429 / 5xx / network). Defaults to
   * {@link DEFAULT_SMS_RETRY_POLICY} (3 attempts). Set
   * `{ maxAttempts: 1 }` to disable; `sleep` is a test seam.
   */
  retry?: Partial<RetryPolicy> & { sleep?: (ms: number) => Promise<void> };
}

export interface TwilioSmsClient {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  /**
   * Poll the Twilio Message resource until it reaches a terminal
   * delivery state (delivered / undelivered / failed) or the timeout
   * elapses. Lets a caller WITHOUT a status webhook (e.g. the admin
   * connection test) distinguish "Twilio accepted it" from "it actually
   * delivered" — the former returns a SID immediately even when the
   * carrier later blocks the message (toll-free unverified, etc).
   *
   * Never throws for a transient fetch error: it keeps the last status
   * seen and retries until the window closes, then returns the best
   * information it has (`terminal: false` if no terminal state was
   * reached).
   */
  confirmDelivery(
    messageSid: string,
    opts?: ConfirmDeliveryOptions,
  ): Promise<ConfirmDeliveryResult>;
}

const TERMINAL_DELIVERY_STATUSES = new Set([
  "delivered",
  "undelivered",
  "failed",
]);

const DEFAULT_CONFIRM_TIMEOUT_MS = 8_000;
const DEFAULT_CONFIRM_POLL_INTERVAL_MS = 1_500;
// Floor for the poll interval. Guards against a tight loop hammering the
// Twilio API if a caller passes 0 / a tiny value, and (with the coercion
// below) against a NaN/negative value producing a never-terminating loop.
const MIN_CONFIRM_POLL_INTERVAL_MS = 250;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Coerce a caller-supplied millisecond option to a finite, non-negative
 * number, falling back to `fallback` for NaN / Infinity / negative input.
 * Without this a `NaN` timeout makes `deadline` NaN and the loop-exit
 * comparison is never true → an infinite tight poll loop.
 */
function coerceMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * Build a TwilioSmsClient.
 *
 * Reads credentials and routing from the env when options are unset.
 * Throws TwilioConfigError at construction (NOT at first send) when:
 *   - TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN is missing, OR
 *   - neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER is set.
 *
 * Production fail-closed: a missing routing config means we don't know
 * what number to send FROM, and silently using a "trial" Twilio number
 * would leak operational PHI (recipient phone) to the wrong sender ID.
 */
export function createTwilioSmsClient(
  opts: CreateTwilioSmsClientOptions = {},
): TwilioSmsClient {
  const accountSid = opts.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken = opts.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  const defaultFrom = opts.from ?? process.env.TWILIO_PHONE_NUMBER;
  const defaultMsid =
    opts.messagingServiceSid ?? process.env.TWILIO_MESSAGING_SERVICE_SID;

  if (!accountSid) {
    throw new TwilioConfigError(
      "TWILIO_ACCOUNT_SID is not set — refusing to construct Twilio SMS client.",
    );
  }
  if (!authToken) {
    throw new TwilioConfigError(
      "TWILIO_AUTH_TOKEN is not set — refusing to construct Twilio SMS client.",
    );
  }
  if (!defaultMsid && !defaultFrom) {
    throw new TwilioConfigError(
      "Neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER is set " +
        "— refusing to construct Twilio SMS client. Set one of them so the " +
        "messaging API knows which sender ID to use.",
    );
  }

  const sdk: RawTwilioMessagingSdk = opts.sdkFactory
    ? opts.sdkFactory(accountSid, authToken)
    : (Twilio(accountSid, authToken) as unknown as RawTwilioMessagingSdk);

  const retryPolicy: RetryPolicy = {
    maxAttempts:
      opts.retry?.maxAttempts ?? DEFAULT_SMS_RETRY_POLICY.maxAttempts,
    baseDelayMs:
      opts.retry?.baseDelayMs ?? DEFAULT_SMS_RETRY_POLICY.baseDelayMs,
    maxDelayMs: opts.retry?.maxDelayMs ?? DEFAULT_SMS_RETRY_POLICY.maxDelayMs,
  };
  const retrySleep = opts.retry?.sleep;

  return {
    async sendSms(input) {
      const fromNumber = input.from ?? defaultFrom;
      const msid = input.messagingServiceSid ?? defaultMsid;
      const params: Parameters<RawTwilioMessagingSdk["messages"]["create"]>[0] =
        {
          to: input.to,
          body: input.body,
        };
      // Messaging service SID takes precedence — Twilio recommends it
      // for production (opt-out handling, sticky sender, etc).
      if (msid) {
        params.messagingServiceSid = msid;
      } else if (fromNumber) {
        params.from = fromNumber;
      }
      if (input.statusCallbackUrl) {
        params.statusCallback = input.statusCallbackUrl;
      }

      // A single send attempt. Transient Twilio failures (429 / 5xx /
      // network) are classified retryable; `withRetry` re-runs this with
      // the identical params (idempotent — Twilio never accepted the
      // failed attempt, so no duplicate SMS is sent).
      const attempt = async (): Promise<SendSmsResult> => {
        try {
          const res = await sdk.messages.create(params);
          return { messageSid: res.sid };
        } catch (err) {
          const e = err as {
            status?: number;
            code?: number | string;
            message?: string;
          };
          throw new TwilioApiError(
            e.message ?? "Twilio API error",
            e.status,
            e.code,
            isTransientTwilioError(err),
          );
        }
      };

      return withRetry(attempt, retryPolicy, {
        shouldRetry: (err) =>
          err instanceof TwilioApiError && err.retryable === true,
        sleep: retrySleep,
        onRetry: ({ attempt: n, nextDelayMs, err }) => {
          // PHI-free structured line: no recipient phone, no body.
          const status =
            err instanceof TwilioApiError ? (err.status ?? null) : null;
          process.stderr.write(
            JSON.stringify({
              level: 40,
              event: "sms_send_retry",
              vendor: "twilio",
              attempt: n,
              maxAttempts: retryPolicy.maxAttempts,
              nextDelayMs,
              status,
              msg: "Transient Twilio failure — retrying send",
            }) + "\n",
          );
        },
      });
    },

    async confirmDelivery(messageSid, confirmOpts = {}) {
      // Coerce caller options to finite, sane values. A NaN/negative
      // timeout would make `deadline` NaN (loop never exits); a
      // NaN/tiny poll interval would tight-loop on the Twilio API.
      const timeoutMs = coerceMs(
        confirmOpts.timeoutMs,
        DEFAULT_CONFIRM_TIMEOUT_MS,
      );
      const pollIntervalMs = Math.max(
        MIN_CONFIRM_POLL_INTERVAL_MS,
        coerceMs(confirmOpts.pollIntervalMs, DEFAULT_CONFIRM_POLL_INTERVAL_MS),
      );
      const sleep = confirmOpts.sleep ?? defaultSleep;
      const deadline = Date.now() + timeoutMs;

      // Best-known status across polls. Defaults to "unknown" so a caller
      // whose every fetch fails still gets a well-formed, non-terminal
      // result instead of an exception.
      let last: SmsDeliveryStatus = {
        status: "unknown",
        errorCode: null,
        errorMessage: null,
      };

      // Poll until terminal or the window closes. We always do at least
      // one fetch even if the timeout is tiny.
      for (;;) {
        try {
          const msg = await sdk.messages(messageSid).fetch();
          last = {
            status: msg.status,
            errorCode: msg.errorCode ?? null,
            errorMessage: msg.errorMessage ?? null,
          };
          if (TERMINAL_DELIVERY_STATUSES.has(msg.status)) {
            return {
              ...last,
              terminal: true,
              delivered: msg.status === "delivered",
            };
          }
        } catch {
          // Transient read failure — keep the last status and retry until
          // the deadline. We deliberately don't surface this as an error:
          // confirmDelivery is a best-effort overlay on a send that
          // already succeeded.
        }
        if (Date.now() + pollIntervalMs >= deadline) break;
        await sleep(pollIntervalMs);
      }

      return { ...last, terminal: false, delivered: false };
    },
  };
}

/**
 * Inbound Twilio SMS webhook params.
 *
 * Twilio POSTs `application/x-www-form-urlencoded` with these fields
 * (plus a bunch we don't currently use — geo info, profile, etc).
 * Body is allowed to be empty (some carriers strip whitespace-only
 * messages); we default to "" rather than rejecting so the keyword
 * router gets a chance to log "unknown" instead of the route 400ing.
 */
export const inboundSmsParamsSchema = z.object({
  From: z.string().min(1),
  To: z.string().min(1),
  Body: z.string().default(""),
  MessageSid: z.string().min(1),
  MessagingServiceSid: z.string().optional(),
  AccountSid: z.string().optional(),
  NumMedia: z.string().optional(),
  NumSegments: z.string().optional(),
  SmsStatus: z.string().optional(),
});

export type InboundSmsParams = z.infer<typeof inboundSmsParamsSchema>;

export function parseInboundSmsParams(raw: unknown): InboundSmsParams {
  return inboundSmsParamsSchema.parse(raw);
}

/**
 * Twilio status-callback webhook params (delivery lifecycle: queued,
 * sending, sent, delivered, undelivered, failed).
 */
export const smsStatusCallbackParamsSchema = z.object({
  MessageSid: z.string().min(1),
  MessageStatus: z.string().min(1),
  To: z.string().optional(),
  From: z.string().optional(),
  ErrorCode: z.string().optional(),
  ErrorMessage: z.string().optional(),
});

export type SmsStatusCallbackParams = z.infer<
  typeof smsStatusCallbackParamsSchema
>;

export function parseSmsStatusCallbackParams(
  raw: unknown,
): SmsStatusCallbackParams {
  return smsStatusCallbackParamsSchema.parse(raw);
}

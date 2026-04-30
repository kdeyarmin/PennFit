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
 * Minimal contract the underlying Twilio SDK must satisfy. Tests
 * provide a fake matching this shape. Typed loosely on purpose —
 * Twilio's published types are huge and we depend on one method.
 */
export interface RawTwilioMessagingSdk {
  messages: {
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
  sdkFactory?: (
    accountSid: string,
    authToken: string,
  ) => RawTwilioMessagingSdk;
}

export interface TwilioSmsClient {
  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
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

  return {
    async sendSms(input) {
      try {
        const fromNumber = input.from ?? defaultFrom;
        const msid = input.messagingServiceSid ?? defaultMsid;
        const params: Parameters<
          RawTwilioMessagingSdk["messages"]["create"]
        >[0] = {
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
        );
      }
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

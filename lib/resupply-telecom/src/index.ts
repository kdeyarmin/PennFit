// @workspace/resupply-telecom — Twilio adapter for the resupply voice agent.
//
// Public surface is intentionally narrow:
//   - Signature validation for incoming Twilio webhooks.
//   - TwiML builders for the small set of XML responses we emit.
//   - Media Streams parser/encoder for the bridge's WS leg.
//   - REST client wrapper (single op: placeCall).
//
// Architecture rules (Rule 10 in scripts/check-resupply-architecture.sh):
//   This package MUST NOT import @workspace/resupply-db, pg, openai,
//   @anthropic-ai/sdk, or speak directly to OpenAI. The split keeps
//   PHI handling concentrated in the API layer and keeps each lib
//   independently testable.

export {
  validateTwilioSignature,
  requireTwilioSignature,
  type ValidateSignatureInput,
  type RequireTwilioSignatureOptions,
} from "./signature";

export {
  buildConnectStreamTwiml,
  buildHangupTwiml,
  buildDialTwiml,
  type BuildConnectStreamTwimlInput,
  type BuildDialTwimlInput,
} from "./twiml";

export {
  parseTwilioFrame,
  encodeMediaFrame,
  encodeMarkFrame,
  encodeClearFrame,
  type TwilioInboundFrame,
  type OutboundMediaFrame,
  type OutboundMarkFrame,
  type OutboundClearFrame,
} from "./media-stream";

export {
  createTwilioClient,
  TwilioConfigError,
  TwilioApiError,
  type TwilioClient,
  type CreateTwilioClientOptions,
  type PlaceCallInput,
  type PlaceCallResult,
  type RawTwilioSdk,
} from "./client";

export {
  createTwilioSmsClient,
  parseInboundSmsParams,
  parseSmsStatusCallbackParams,
  inboundSmsParamsSchema,
  smsStatusCallbackParamsSchema,
  type SendSmsInput,
  type SendSmsResult,
  type CreateTwilioSmsClientOptions,
  type TwilioSmsClient,
  type RawTwilioMessagingSdk,
  type InboundSmsParams,
  type SmsStatusCallbackParams,
} from "./sms";

export {
  isTransientTwilioError,
  withRetry,
  computeBackoffMs,
  DEFAULT_SMS_RETRY_POLICY,
  type RetryPolicy,
  type WithRetryHooks,
} from "./retry";

export {
  createTwilioNtsClient,
  type TwilioNtsClient,
  type CreateTwilioNtsClientOptions,
  type CreateIceTokenResult,
  type NtsIceServer,
  type RawTwilioNtsSdk,
} from "./nts";

// Faxes go through Telnyx (Twilio retired Programmable Fax). The Twilio
// REST client / SMS / voice / signature wrappers above stay on Twilio;
// only fax moved.
export {
  createTelnyxFaxClient,
  TelnyxConfigError,
  TelnyxApiError,
  type SendFaxInput,
  type SendFaxResult,
  type TelnyxFaxClient,
  type TelnyxFaxQuality,
  type TelnyxFaxRequestBody,
  type CreateTelnyxFaxClientOptions,
  type FaxHttpSend,
} from "./telnyx-fax";

export {
  validateTelnyxSignature,
  requireTelnyxSignature,
  type ValidateTelnyxSignatureInput,
  type RequireTelnyxSignatureOptions,
  type TelnyxSignatureRequestLike,
} from "./telnyx-signature";

export {
  parseTelnyxFaxEvent,
  TELNYX_FAX_EVENT_TYPES,
  type TelnyxFaxEvent,
  type TelnyxFaxEventType,
  type ParseTelnyxFaxEventResult,
} from "./telnyx-webhook";

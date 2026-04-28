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
  type BuildConnectStreamTwimlInput,
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

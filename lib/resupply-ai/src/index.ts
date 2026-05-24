// @workspace/resupply-ai — public surface for the voice agent + AI vendors.
//
// Three OpenAI Realtime collaborators (the original voice agent):
//   - `RealtimeClient` — OpenAI Realtime WebSocket.
//   - `VoiceBridge`    — wires the client to the audio sink + tools.
//   - `ToolDispatcher` — interface the API implements to run side effects.
//
// Plus two vendor clients used by routes elsewhere in the monorepo:
//   - `createAnthropicClient` — Claude Messages API (chatbot, sleep coach,
//     SMS classifier — anywhere we want warmer, smarter text replies).
//   - `createDeepgramClient`  — Nova-3 STT (post-call audit transcripts,
//     optional parallel transcription on live calls for higher accuracy).
//
// (An ElevenLabs TTS client exists at `./elevenlabs-client` for the
// eventual opt-in TTS path but is intentionally NOT re-exported here
// — zero call sites today, and shipping it on the public surface
// invites accidental imports that would degrade the "vendor selection
// happens in one place" posture. Re-add the export when the live
// voice path is wired to it.)
//
// All PHI handling (database reads, encryption, audit) lives in the API.
// The architecture rules forbid this package from importing
// `@workspace/resupply-db`, `pg`, or `twilio` (see Rule 9 in
// `scripts/check-resupply-architecture.sh`).

export {
  RealtimeClient,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_VOICE,
  type RealtimeClientOptions,
  type RealtimeAudioDelta,
  type RealtimeTranscriptDelta,
  type RealtimeToolCall,
  type RealtimeError,
  type RealtimeClientEvents,
  type WebSocketLike,
} from "./realtime-client";

export {
  VoiceBridge,
  type BridgeOptions,
  type BridgeEvents,
  type MediaStreamSink,
  type SessionError,
  type ToolInvocation,
  type TranscriptTurn,
} from "./bridge";

export {
  PROMPT_VERSION,
  DEFAULT_GREETING,
  buildSystemPrompt,
  type BuildSystemPromptInput,
} from "./prompts";

export {
  createAnthropicClient,
  getResponseText,
  getResponseToolCalls,
  isRetryableAnthropicError,
  sendWithRetry,
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  DEFAULT_ANTHROPIC_MODEL_REASONING,
  type AnthropicClient,
  type AnthropicClientOptions,
  type AnthropicContentBlock,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicResponseContentBlock,
  type AnthropicMessage,
  type AnthropicRetryOptions,
  type AnthropicSystemBlock,
  type AnthropicTextBlock,
  type AnthropicTool,
  type AnthropicToolChoice,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
  type AnthropicUsage,
  type AnthropicCallResult,
} from "./anthropic-client";

export {
  createDeepgramClient,
  DEFAULT_DEEPGRAM_MODEL,
  type DeepgramClient,
  type DeepgramClientOptions,
  type DeepgramCallResult,
  type DeepgramPrerecordedOptions,
  type DeepgramPrerecordedResult,
  type DeepgramLiveOptions,
  type DeepgramLiveSession,
  type DeepgramLiveTranscriptEvent,
  type DeepgramEncoding,
  type DeepgramTranscriptAlternative,
  type DeepgramTranscriptWord,
  type DeepgramWebSocketLike,
} from "./deepgram-client";

// ElevenLabs TTS client lives at ./elevenlabs-client; intentionally
// NOT re-exported until the live voice path is wired to it. See file
// header above for rationale.

export {
  TOOL_NAMES,
  TOOL_ARG_SCHEMAS,
  OPENAI_TOOL_DESCRIPTORS,
  summarizeToolArgsForAudit,
  verifyPatientIdentityArgs,
  lookupResupplyInventoryArgs,
  getShippingAddressArgs,
  updateShippingAddressArgs,
  placeResupplyOrderArgs,
  requestHumanHandoffArgs,
  endCallArgs,
  type ToolName,
  type ToolDispatcher,
  type DispatchToolCall,
  type DispatchToolResult,
  type OpenAiToolDescriptor,
  type ToolArgsByName,
  type ToolResultByName,
  type VerifyPatientIdentityResult,
  type LookupResupplyInventoryResult,
  type ShippingAddressResult,
  type UpdateShippingAddressResult,
  type PlaceResupplyOrderResult,
  type RequestHumanHandoffResult,
  type EndCallResult,
  type InventoryItem,
} from "./tools";

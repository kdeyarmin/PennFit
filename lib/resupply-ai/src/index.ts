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
// Plus the ElevenLabs TTS client (`./elevenlabs-client`), now wired
// into the live voice path: when `ELEVENLABS_API_KEY` is set the voice
// agent runs the Realtime session in text-output mode and synthesises
// the agent's speech through ElevenLabs (see `VoiceBridge`'s
// `TtsSynthesizer`). When the key is unset it falls back to OpenAI's
// built-in `cedar` voice.
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
  type TtsSynthesizer,
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

export {
  createElevenLabsClient,
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
  type ElevenLabsClient,
  type ElevenLabsClientOptions,
  type ElevenLabsTtsInput,
  type ElevenLabsCallResult,
  type ElevenLabsStreamCallResult,
  type ElevenLabsOutputFormat,
  type ElevenLabsVoiceSettings,
  type ElevenLabsVoiceSummary,
  type ElevenLabsListVoicesResult,
} from "./elevenlabs-client";

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

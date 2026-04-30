// @workspace/resupply-ai — public surface for the voice agent.
//
// Three collaborators:
//   - `RealtimeClient` — OpenAI Realtime WebSocket.
//   - `VoiceBridge`    — wires the client to the audio sink + tools.
//   - `ToolDispatcher` — interface the API implements to run side effects.
//
// Plus the hand-rolled prompt + tool descriptors. All PHI handling
// (database reads, encryption, audit) lives in the API. The
// architecture rules forbid this package from importing
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

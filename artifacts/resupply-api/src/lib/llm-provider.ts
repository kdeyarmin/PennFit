// Unified LLM provider — picks Claude when ANTHROPIC_API_KEY is set,
// falls back to OpenAI when only OPENAI_API_KEY is configured, and
// signals "offline" when neither is set.
//
// Why this lives in the API process:
//   The vendor client implementations live in @workspace/resupply-ai
//   (so the architecture rules permit vendor SDKs there). This file
//   composes them with environment-driven selection. The route
//   handlers in artifacts/resupply-api/src/routes/** import the
//   helpers below and never reach for a vendor client directly —
//   that keeps "which LLM is in use" a single switch.
//
// Selection rules (in order):
//   1. If `ANTHROPIC_API_KEY` is set, use Claude (default: Sonnet 4.6).
//      Sonnet writes warmer, more empathetic patient-facing copy than
//      gpt-4o-class models, which is what we want for chatbot + sleep
//      coach.
//   2. Else, if `OPENAI_API_KEY` is set, use OpenAI (default:
//      gpt-4o-mini). Preserves existing behavior for deployments that
//      haven't onboarded Anthropic yet.
//   3. Else, return `{ provider: "offline" }`. Callers should surface
//      a static fallback reply with `offline: true`.
//
// PHI containment: this file does NOT touch PHI. Callers pass
// pre-redacted prompts; results are returned as-is.

import {
  createAnthropicClient,
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  getResponseText,
  getResponseToolCalls,
  type AnthropicClient,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicSystemBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
} from "@workspace/resupply-ai";

export type LlmProvider = "anthropic" | "openai" | "offline";

export interface LlmSelection {
  provider: LlmProvider;
}

/**
 * Pure selection — useful for routes that want to log "using
 * provider X" before dispatching the actual call.
 */
export function selectLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmSelection {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim() !== "") {
    return { provider: "anthropic" };
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim() !== "") {
    return { provider: "openai" };
  }
  return { provider: "offline" };
}

let cachedAnthropic: AnthropicClient | null = null;
let cachedAnthropicApiKey: string | null = null;

/**
 * Get a cached Anthropic client. Returns null when ANTHROPIC_API_KEY
 * isn't set. Cache invalidates if the key changes mid-process (rare,
 * but supported for test harness convenience).
 */
export function getAnthropicClient(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicClient | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    cachedAnthropic = null;
    cachedAnthropicApiKey = null;
    return null;
  }
  if (cachedAnthropic && cachedAnthropicApiKey === key) {
    return cachedAnthropic;
  }
  cachedAnthropic = createAnthropicClient({ apiKey: key });
  cachedAnthropicApiKey = key;
  return cachedAnthropic;
}

/**
 * Helper to reset the cache between tests.
 */
export function __resetLlmProviderCacheForTests(): void {
  cachedAnthropic = null;
  cachedAnthropicApiKey = null;
}

/**
 * Convenience re-exports so route handlers only need to import from
 * this file (not the vendor lib directly).
 */
export {
  DEFAULT_ANTHROPIC_MODEL_CHAT,
  DEFAULT_ANTHROPIC_MODEL_CLASSIFY,
  getResponseText,
  getResponseToolCalls,
  type AnthropicClient,
  type AnthropicContentBlock,
  type AnthropicMessage,
  type AnthropicRequest,
  type AnthropicResponse,
  type AnthropicSystemBlock,
  type AnthropicTool,
  type AnthropicToolResultBlock,
  type AnthropicToolUseBlock,
};

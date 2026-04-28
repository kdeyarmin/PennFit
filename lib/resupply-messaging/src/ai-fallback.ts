// @workspace/resupply-messaging — AI fallback adapter contract.
//
// When the keyword router returns `intent: "unknown"`, the API layer
// hands the raw body and recent thread context to an AI classifier
// that returns the best matching `Intent` plus an optional
// patient-facing reply.
//
// THE ADAPTER LIVES IN THE API LAYER, NOT HERE. This package stays
// vendor-free (Architecture Rule 11). We only define the interface
// here so the keyword router and the route handler can agree on a
// shape.
//
// Why this split:
//   1. Lets us swap OpenAI → Anthropic → "operator queue" by changing
//      the implementation, not the call sites.
//   2. Tests can pass a stub `AiFallbackAdapter` directly into the
//      route handler without mocking @sendgrid/mail or openai.
//   3. Keeps `lib/resupply-messaging` strictly a semantic layer:
//      keyword parsing + templates + signed tokens. Vendor SDKs
//      stay out.

import type { Intent } from "./intents";

export interface AiFallbackInput {
  /** The patient's literal inbound message. */
  body: string;
  /**
   * Up to N most recent prior messages in this conversation, oldest
   * first, with role + body. Implementation MUST cap context length
   * to keep token cost bounded.
   */
  thread?: ReadonlyArray<{
    role: "patient" | "agent" | "operator";
    body: string;
  }>;
  /**
   * Optional patient-context summary the operator wants in scope
   * (e.g. "current address: 123 Main St", "next refill due 2026-05-01").
   * NEVER pass full PHI; this is a hand-curated summary line.
   */
  patientContext?: string;
}

export interface AiFallbackResult {
  /** Best-match intent. MUST be one of `INTENT_NAMES`. */
  intent: Intent;
  /**
   * Optional free-text reply the system should send back to the
   * patient. The route handler chooses whether to use this verbatim
   * or wrap it; the adapter is allowed to return undefined to defer
   * the wording entirely to the route.
   */
  reply?: string;
  /**
   * 0..1 confidence score self-reported by the model. Routes can use
   * this to decide whether to accept the AI's classification or
   * escalate straight to a human operator. Implementations that
   * don't expose a score should return undefined.
   */
  confidence?: number;
}

export interface AiFallbackAdapter {
  /**
   * Classify the inbound message. MUST resolve, not reject — adapters
   * that hit a network or model error should resolve to
   * `{intent: "unknown"}` so the route handler can fall through to a
   * human-handoff path. Throwing here would crash the route handler
   * for an entirely external failure.
   */
  classify(input: AiFallbackInput): Promise<AiFallbackResult>;
}

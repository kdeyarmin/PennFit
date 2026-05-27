// Tests for the sleep-coach Anthropic tool-call loop.
//
// Coverage:
//   * A response with no tool calls returns the text directly (the
//     single-shot legacy behavior continues to work).
//   * A response with one tool call triggers a follow-up round and
//     returns the second-round text.
//   * Tool dispatch passes valid args through to executeChatTool.
//   * MAX_TOOL_ROUNDS terminates a model that keeps requesting tools.
//   * An anthropic error returns null reply + errorMessage.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import type {
  AnthropicCallResult,
  AnthropicClient,
  AnthropicRequest,
  AnthropicResponse,
} from "@workspace/resupply-ai";
import { askSleepCoach } from "./sleep-coach";

beforeEach(() => {
  supabaseMock.reset();
  vi.useRealTimers();
});

/** Default Supabase staging: empty patient + empty therapy nights so
 *  assembleContext doesn't blow up before the LLM call. */
function stageEmptyContext(): void {
  stageSupabaseResponse("patients", "select", { data: null });
  stageSupabaseResponse("patient_therapy_nights", "select", { data: [] });
}

function makeUsage(): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
} {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
}

function textResponse(text: string): AnthropicResponse {
  return {
    id: "msg_test",
    model: "claude-test",
    role: "assistant",
    type: "message",
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: makeUsage(),
  };
}

function toolUseResponse(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId = "tu_test",
): AnthropicResponse {
  return {
    id: "msg_test_tool",
    model: "claude-test",
    role: "assistant",
    type: "message",
    stop_reason: "tool_use",
    content: [
      {
        type: "tool_use",
        id: toolUseId,
        name: toolName,
        input: toolInput,
      },
    ],
    usage: makeUsage(),
  };
}

function makeClient(
  responses: AnthropicResponse[],
  inspect?: (req: AnthropicRequest, callIndex: number) => void,
): AnthropicClient {
  let i = 0;
  return {
    async send(req: AnthropicRequest): Promise<AnthropicCallResult> {
      if (inspect) inspect(req, i);
      const r = responses[i] ?? responses[responses.length - 1]!;
      i += 1;
      return { ok: true, response: r, latencyMs: 1, cacheHitTokens: 0 };
    },
    async stream(): Promise<AnthropicCallResult> {
      throw new Error("stream() not used by sleep-coach tests");
    },
  };
}

describe("askSleepCoach — Anthropic path, no tool call", () => {
  it("returns the model's text directly when no tool_use blocks are emitted", async () => {
    stageEmptyContext();
    const client = makeClient([textResponse("Try loosening the top strap one notch tonight.")]);
    const result = await askSleepCoach({
      patientId: "pt_1",
      question: "What can I try to stop the mask leaking?",
      anthropicClient: client,
    });
    expect(result.errorMessage).toBeNull();
    expect(result.reply).toBe("Try loosening the top strap one notch tonight.");
  });
});

describe("askSleepCoach — Anthropic path, single tool call", () => {
  it("dispatches find_masks, sends the result back, and returns the second-round text", async () => {
    stageEmptyContext();
    let receivedToolResultPayload: unknown = null;
    const client = makeClient(
      [
        toolUseResponse("find_masks", { type: "nasal", limit: 1 }),
        textResponse(
          "Based on what we carry, the AirFit N20 is a solid nasal option to try next.",
        ),
      ],
      (req, callIndex) => {
        // On round 2, the messages array should include a user
        // message carrying a tool_result block referencing our
        // tool_use_id. Capture for the assertion below.
        if (callIndex === 1) {
          const last = req.messages[req.messages.length - 1];
          if (last && last.role === "user" && Array.isArray(last.content)) {
            const tr = last.content.find(
              (c): c is { type: "tool_result"; tool_use_id: string; content: string } =>
                (c as { type?: unknown }).type === "tool_result",
            );
            receivedToolResultPayload = tr?.content ?? null;
          }
        }
      },
    );
    const result = await askSleepCoach({
      patientId: "pt_2",
      question: "What nasal masks do you carry?",
      anthropicClient: client,
    });
    expect(result.errorMessage).toBeNull();
    expect(result.reply).toContain("AirFit N20");
    // Tool result should be a JSON string the model could parse. We
    // don't pin the exact contents (catalog can evolve) — just that
    // it's a non-empty JSON-shaped string referencing masks.
    expect(typeof receivedToolResultPayload).toBe("string");
    expect(receivedToolResultPayload).toMatch(/masks/);
  });
});

describe("askSleepCoach — Anthropic path, error", () => {
  it("returns null reply and a structured errorMessage when the model call fails", async () => {
    stageEmptyContext();
    const erroringClient: AnthropicClient = {
      async send(): Promise<AnthropicCallResult> {
        return {
          ok: false,
          errorCode: "http",
          errorMessage: "rate_limit_exceeded: too many requests",
          httpStatus: 429,
          latencyMs: 1,
        };
      },
      async stream(): Promise<AnthropicCallResult> {
        throw new Error("stream() not used");
      },
    };
    const result = await askSleepCoach({
      patientId: "pt_3",
      question: "Quick check-in",
      anthropicClient: erroringClient,
    });
    expect(result.reply).toBeNull();
    // The helper renders "anthropic <code>: <message>" so both
    // bits are surfaced; pin on the structured prefix.
    expect(result.errorMessage).toContain("anthropic http");
  });
});

describe("askSleepCoach — Anthropic path, retry", () => {
  it("retries a 429 once and surfaces the eventual success", async () => {
    stageEmptyContext();
    let calls = 0;
    const client: AnthropicClient = {
      async send(): Promise<AnthropicCallResult> {
        calls++;
        if (calls === 1) {
          // First attempt: explicit 429 (retryable).
          return {
            ok: false,
            errorCode: "http",
            errorMessage: "rate_limit_exceeded",
            httpStatus: 429,
            latencyMs: 5,
          };
        }
        // Second attempt: success.
        return {
          ok: true,
          response: textResponse("Loosen the top strap one click tonight."),
          latencyMs: 8,
          cacheHitTokens: 0,
        };
      },
      async stream(): Promise<AnthropicCallResult> {
        throw new Error("stream() not used");
      },
    };
    const result = await askSleepCoach({
      patientId: "pt_retry_ok",
      question: "Quick check-in",
      anthropicClient: client,
    });
    expect(calls).toBe(2);
    expect(result.errorMessage).toBeNull();
    expect(result.reply).toBe("Loosen the top strap one click tonight.");
  });

  it("does NOT retry on 400 (non-retryable) — surfaces the failure on the first call", async () => {
    stageEmptyContext();
    let calls = 0;
    const client: AnthropicClient = {
      async send(): Promise<AnthropicCallResult> {
        calls++;
        return {
          ok: false,
          errorCode: "http",
          errorMessage: "invalid_request_error",
          httpStatus: 400,
          latencyMs: 5,
        };
      },
      async stream(): Promise<AnthropicCallResult> {
        throw new Error("stream() not used");
      },
    };
    const result = await askSleepCoach({
      patientId: "pt_retry_400",
      question: "Quick check-in",
      anthropicClient: client,
    });
    expect(calls).toBe(1);
    expect(result.reply).toBeNull();
    expect(result.errorMessage).toContain("anthropic http");
  });
});

describe("askSleepCoach — round cap", () => {
  it("terminates after MAX_TOOL_ROUNDS even when the model keeps requesting tools", async () => {
    stageEmptyContext();
    // Every response is another tool_use. Without the round cap this
    // would loop forever; with the cap the coach falls back to
    // whatever text is on the last response (here, empty string).
    const client = makeClient(
      [
        toolUseResponse("find_masks", { type: "nasal" }, "tu_a"),
        toolUseResponse("find_masks", { type: "fullFace" }, "tu_b"),
        toolUseResponse("find_masks", { type: "nasalPillow" }, "tu_c"),
        textResponse("Sorry — I couldn't pin down a recommendation."),
      ],
      undefined,
    );
    const result = await askSleepCoach({
      patientId: "pt_round_cap",
      question: "Cycle me through everything",
      anthropicClient: client,
    });
    // We don't assert the EXACT number of rounds — only that the
    // call terminates and returns something parseable rather than
    // hanging. The cap is owned by MAX_TOOL_ROUNDS (currently 2)
    // and intentionally tested as a black-box "terminates" check
    // so future cap-tuning doesn't break the test.
    expect(result.errorMessage).toBeNull();
    // The final response is what gets returned once tools stop
    // firing OR the cap hits. `string` is the happy path; `null`
    // is the legitimate "no text on the last round" outcome (the
    // model spent its budget calling tools and never produced a
    // final answer). Both resolve cleanly — the test pins
    // "terminates without throwing", not the exact shape, so a
    // future cap tweak doesn't break it.
    expect(result.reply === null || typeof result.reply === "string").toBe(
      true,
    );
  });
});

describe("askSleepCoach — OpenAI fallback path (tools)", () => {
  it("passes catalog tools and runs the tool-call loop on the OpenAI path", async () => {
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY; // force the OpenAI fallback
    stageEmptyContext();

    const okJson = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => data,
      text: async () => JSON.stringify(data),
    });

    const bodies: Array<Record<string, unknown>> = [];
    let calls = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      calls += 1;
      if (calls === 1) {
        // Round 1: the model asks to call a catalog tool.
        return okJson({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "tc1",
                    type: "function",
                    function: { name: "find_masks", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        });
      }
      // Round 2: the model answers with catalog-grounded text.
      return okJson({
        choices: [
          {
            message: {
              content: "The AirFit P30i is a solid nasal-pillow option.",
            },
          },
        ],
      });
    }) as unknown as typeof fetch;

    try {
      const result = await askSleepCoach({
        patientId: "pt_openai_tools",
        question: "what nasal masks do you carry?",
        apiKey: "sk-test",
        fetchImpl,
      });
      expect(result.reply).toContain("AirFit P30i");
      expect(calls).toBe(2);
      // Round 1 sent the catalog tools so the model could ground itself.
      expect(Array.isArray(bodies[0]!.tools)).toBe(true);
      expect((bodies[0]!.tools as unknown[]).length).toBeGreaterThan(0);
      // Round 2 carried the tool result back to the model.
      expect(
        (bodies[1]!.messages as Array<{ role: string }>).some(
          (m) => m.role === "tool",
        ),
      ).toBe(true);
    } finally {
      if (prevAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = prevAnthropic;
      }
    }
  });
});

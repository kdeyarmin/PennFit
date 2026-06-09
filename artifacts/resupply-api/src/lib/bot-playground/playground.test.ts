// Unit tests for the bot-playground core: prompt rendering, simulated
// tool results, and the model-run loop (with an injected fake Anthropic
// client so no network is touched).

import { describe, it, expect, vi } from "vitest";

import type { AnthropicClient } from "../llm-provider";
import {
  DEFAULT_ACCOUNT_CONTEXT,
  PLAYGROUND_SCENARIOS,
  buildPlaygroundSystemPrompt,
  getPlaygroundPrompt,
  runBotPlayground,
  simulateToolResult,
  type PlaygroundDeps,
} from "./playground";

describe("buildPlaygroundSystemPrompt", () => {
  it("renders the storefront knowledge base", () => {
    const p = buildPlaygroundSystemPrompt("storefront");
    expect(p).toContain("Mask catalog");
    expect(p.length).toBeGreaterThan(1000);
  });

  it("renders the account assistant prompt with the synthetic context", () => {
    const p = buildPlaygroundSystemPrompt("account");
    expect(p).toContain("PennBot Account Assistant");
    // Default synthetic context name is embedded.
    expect(p).toContain(DEFAULT_ACCOUNT_CONTEXT.displayName!);
  });

  it("renders the voice prompt differently per caller kind", () => {
    const patient = buildPlaygroundSystemPrompt("voice", {
      voice: { callerKind: "patient" },
    });
    const shop = buildPlaygroundSystemPrompt("voice", {
      voice: { callerKind: "shop_customer" },
    });
    expect(patient).toContain("date of birth");
    expect(shop).toContain("card on file");
    expect(patient).not.toEqual(shop);
  });
});

describe("getPlaygroundPrompt", () => {
  it("includes a prompt version for the voice bot only", () => {
    expect(getPlaygroundPrompt("voice").promptVersion).toBeTruthy();
    expect(getPlaygroundPrompt("storefront").promptVersion).toBeUndefined();
  });
});

describe("simulateToolResult", () => {
  it("returns valid JSON for known account + voice tools", () => {
    for (const name of [
      "get_my_recent_orders",
      "get_my_subscriptions",
      "escalate_to_human",
      "verify_patient_identity",
      "place_resupply_order",
    ]) {
      expect(() => JSON.parse(simulateToolResult(name, {}))).not.toThrow();
    }
  });

  it("flags the escalation as simulated (no real CSR message)", () => {
    const parsed = JSON.parse(simulateToolResult("escalate_to_human", {}));
    expect(parsed.escalated).toBe(true);
    expect(String(parsed.note)).toMatch(/SIMULATED/i);
  });

  it("falls back to a generic simulated payload for unknown tools", () => {
    expect(() =>
      JSON.parse(simulateToolResult("mystery_tool", {})),
    ).not.toThrow();
  });
});

describe("PLAYGROUND_SCENARIOS", () => {
  it("covers all three bots", () => {
    const bots = new Set(PLAYGROUND_SCENARIOS.map((s) => s.bot));
    expect(bots).toEqual(new Set(["storefront", "account", "voice"]));
  });
});

describe("runBotPlayground", () => {
  const offlineDeps: PlaygroundDeps = {
    provider: "offline",
    anthropicClient: null,
    openAiApiKey: null,
  };

  it("returns an offline result when no provider is configured", async () => {
    const result = await runBotPlayground(
      { bot: "storefront", messages: [{ role: "user", content: "hi" }] },
      offlineDeps,
    );
    expect(result.offline).toBe(true);
    expect(result.provider).toBe("offline");
    expect(result.reply.length).toBeGreaterThan(0);
  });

  it("runs the Anthropic tool loop and captures a simulated tool call", async () => {
    const fakeClient = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          response: {
            id: "m1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              {
                type: "tool_use",
                id: "tool_1",
                name: "get_my_recent_orders",
                input: { limit: 1 },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          response: {
            id: "m2",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [
              { type: "text", text: "Your most recent order shipped via UPS." },
            ],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 8 },
          },
        }),
      stream: vi.fn(),
    } as unknown as AnthropicClient;

    const result = await runBotPlayground(
      {
        bot: "account",
        messages: [{ role: "user", content: "where is my order?" }],
      },
      {
        provider: "anthropic",
        anthropicClient: fakeClient,
        openAiApiKey: null,
      },
    );

    expect(result.provider).toBe("anthropic");
    expect(result.reply).toBe("Your most recent order shipped via UPS.");
    expect(result.rounds).toBe(1);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      name: "get_my_recent_orders",
      simulated: true,
    });
    expect(fakeClient.send).toHaveBeenCalledTimes(2);
  });

  it("returns a degraded result when the model call fails", async () => {
    const fakeClient = {
      send: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: "upstream",
        httpStatus: 500,
      }),
      stream: vi.fn(),
    } as unknown as AnthropicClient;

    const result = await runBotPlayground(
      { bot: "voice", messages: [{ role: "user", content: "hello?" }] },
      {
        provider: "anthropic",
        anthropicClient: fakeClient,
        openAiApiKey: null,
      },
    );
    expect(result.degraded).toBe(true);
    expect(result.toolCalls).toHaveLength(0);
  });
});

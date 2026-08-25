import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetLlmProviderCacheForTests } from "../llm-provider";
import {
  answerSupportTicket,
  buildSupportUserPrompt,
  parseModelOutput,
  __setSupportBotFetchForTests,
  type SupportBotInput,
} from "./support-bot";

const BASE: SupportBotInput = {
  subject: "How do I add a new team member?",
  body: "I want to give my front desk person a login. Where do I do that?",
  adminEmail: "owner@acme.test",
  adminRole: "admin",
};

beforeEach(() => {
  __resetLlmProviderCacheForTests();
});
afterEach(() => {
  __setSupportBotFetchForTests(undefined);
  __resetLlmProviderCacheForTests();
});

describe("buildSupportUserPrompt", () => {
  it("includes the subject and body", () => {
    const prompt = buildSupportUserPrompt(BASE);
    expect(prompt).toContain("How do I add a new team member?");
    expect(prompt).toContain("front desk person");
  });
});

describe("parseModelOutput", () => {
  it("returns an answer when confident and non-empty", () => {
    const out = parseModelOutput(
      "openai",
      JSON.stringify({ handoff: false, reply: "Go to Team.", confidence: 0.9 }),
      0.7,
    );
    expect(out).toEqual({
      kind: "answer",
      reply: "Go to Team.",
      confidence: 0.9,
    });
  });

  it("hands off on explicit handoff", () => {
    const out = parseModelOutput(
      "openai",
      JSON.stringify({ handoff: true, reply: "", confidence: 0.2 }),
      0.7,
    );
    expect(out).toEqual({ kind: "handoff" });
  });

  it("hands off below the confidence bar", () => {
    const out = parseModelOutput(
      "openai",
      JSON.stringify({ handoff: false, reply: "Maybe?", confidence: 0.5 }),
      0.7,
    );
    expect(out).toEqual({ kind: "handoff" });
  });

  it("hands off on an empty reply even when confident", () => {
    const out = parseModelOutput(
      "openai",
      JSON.stringify({ handoff: false, reply: "   ", confidence: 0.99 }),
      0.7,
    );
    expect(out).toEqual({ kind: "handoff" });
  });

  it("hands off on unparseable output", () => {
    expect(parseModelOutput("openai", "not json", 0.7)).toEqual({
      kind: "handoff",
    });
  });

  it("tolerates a markdown-fenced JSON blob", () => {
    const out = parseModelOutput(
      "anthropic",
      '```json\n{"handoff":false,"reply":"Open Settings → Team.","confidence":0.92}\n```',
      0.7,
    );
    expect(out).toMatchObject({ kind: "answer" });
  });
});

describe("answerSupportTicket", () => {
  it("is offline when no provider key is configured", async () => {
    const out = await answerSupportTicket(BASE, {});
    expect(out).toEqual({ kind: "offline" });
  });

  it("auto-answers a confident reply via the OpenAI path", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    handoff: false,
                    reply: "Open Settings → Team and click Invite.",
                    confidence: 0.93,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    __setSupportBotFetchForTests(fetchStub as unknown as typeof fetch);

    const out = await answerSupportTicket(BASE, { OPENAI_API_KEY: "sk-test" });
    expect(out).toMatchObject({ kind: "answer" });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it("hands off when the model declines (e.g. a bug report)", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    handoff: true,
                    reply: "",
                    confidence: 0.1,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    __setSupportBotFetchForTests(fetchStub as unknown as typeof fetch);

    const out = await answerSupportTicket(
      { ...BASE, subject: "The orders page is broken", body: "It 500s." },
      { OPENAI_API_KEY: "sk-test" },
    );
    expect(out).toEqual({ kind: "handoff" });
  });

  it("hands off (never throws) on an upstream HTTP error", async () => {
    const fetchStub = vi.fn(async () => new Response("nope", { status: 500 }));
    __setSupportBotFetchForTests(fetchStub as unknown as typeof fetch);
    const out = await answerSupportTicket(BASE, { OPENAI_API_KEY: "sk-test" });
    expect(out).toEqual({ kind: "handoff" });
  });

  it("speaks as the platform, never as this deployment's seed tenant", async () => {
    // The ticket comes from a TENANT and the reply goes back unreviewed, so
    // the desk must answer as CareMetric Breathe. The in-source placeholders
    // (PennFit / PennPilot, and any tenant name in the shared admin-console
    // knowledge base) must be resolved to the platform's own names before
    // either the prompt or the reply leaves the process.
    let sentSystemPrompt = "";
    const fetchStub = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ role: string; content: string }>;
      };
      sentSystemPrompt =
        body.messages?.find((m) => m.role === "system")?.content ?? "";
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  handoff: false,
                  // A stray placeholder the model echoed out of its prompt.
                  reply: "PennPilot can walk you through PennFit's Team page.",
                  confidence: 0.95,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    __setSupportBotFetchForTests(fetchStub as unknown as typeof fetch);

    const out = await answerSupportTicket(BASE, { OPENAI_API_KEY: "sk-test" });

    expect(sentSystemPrompt).not.toMatch(/PennFit|PennPilot|PennBot/);
    expect(sentSystemPrompt).not.toMatch(/Penn Home Medical Supply|pennpaps/i);
    expect(sentSystemPrompt).toContain("CareMetric Breathe");
    expect(out).toEqual({
      kind: "answer",
      reply:
        "CareMetric Copilot can walk you through CareMetric Breathe's Team page.",
      confidence: 0.95,
    });
  });
});

// Unit tests for the chatbot email auto-reply generator.
//
// We drive the OpenAI path (simplest to mock) via the fetch test seam
// and assert the {handoff, reply} contract collapses to the right
// EmailReplyResult. The "offline" branch (no provider key) and the
// fail-soft hand-off branches (HTTP error, bad JSON) are the safety
// guarantees the inbound webhook relies on, so they're covered too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  generateEmailReply,
  __setEmailAutoReplyFetchForTests,
  __resetEmailAutoReplyCacheForTests,
} from "./email-auto-reply";

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function openAiReply(content: string): Response {
  return okJson({ choices: [{ message: { content } }] });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  __resetEmailAutoReplyCacheForTests();
  // Force the OpenAI path: clear Anthropic, set OpenAI.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  __setEmailAutoReplyFetchForTests(undefined);
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

const INPUT = {
  body: "Do your nasal masks work if I breathe through my mouth at night?",
  subject: "Question about masks",
  thread: [],
};

describe("generateEmailReply", () => {
  it("returns offline when no LLM provider is configured", async () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "offline" });
  });

  it("returns a reply when the model answers confidently", async () => {
    const fetchMock = vi.fn(async () =>
      openAiReply(
        JSON.stringify({
          handoff: false,
          reply:
            "Hi there!\n\nGreat question — a full-face mask is the way to go.\n\n— The PennPaps Team",
        }),
      ),
    );
    __setEmailAutoReplyFetchForTests(fetchMock as unknown as typeof fetch);

    const result = await generateEmailReply(INPUT);
    expect(result.kind).toBe("reply");
    if (result.kind === "reply") {
      expect(result.reply).toContain("— The PennPaps Team");
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands off when the model sets handoff=true", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(JSON.stringify({ handoff: true, reply: "" })),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply({
      ...INPUT,
      body: "Where is my order? It said it shipped last week.",
    });
    expect(result).toEqual({ kind: "handoff" });
  });

  it("hands off when handoff=false but reply is empty", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(JSON.stringify({ handoff: false, reply: "   " })),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("hands off on unparseable model output", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply("I'm not going to give you JSON, sorry"),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });

  it("tolerates a markdown-fenced JSON object", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () =>
        openAiReply(
          '```json\n{"handoff": false, "reply": "All set.\\n— The PennPaps Team"}\n```',
        ),
      ) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result.kind).toBe("reply");
  });

  it("hands off on an HTTP error from the model", async () => {
    __setEmailAutoReplyFetchForTests(
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "upstream boom",
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    const result = await generateEmailReply(INPUT);
    expect(result).toEqual({ kind: "handoff" });
  });
});

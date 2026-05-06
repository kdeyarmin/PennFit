import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import chatRouter, { __setChatFetchForTests } from "./chat";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(chatRouter);
  return app;
}

describe("POST /chat", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    __setChatFetchForTests(undefined);
    vi.restoreAllMocks();
  });

  it("rejects empty bodies with 400", async () => {
    const res = await request(makeApp()).post("/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid input");
  });

  it("rejects payloads whose last message is not from the user", async () => {
    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last message/i);
  });

  it("rejects unknown extra fields (zod strict)", async () => {
    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "hi" }],
        sessionId: "leak",
      });
    expect(res.status).toBe(400);
  });

  it("rejects payloads that look like data-URL base64 blobs", async () => {
    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [
          { role: "user", content: "look at this: data:image/png;base64,iVBORw" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binary or encoded data/);
  });

  it("returns the offline fallback when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "How does insurance work?" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.offline).toBe(true);
    expect(res.body.reply).toMatch(/\(814\) 471-0627/);
  });

  it("returns the model reply on a successful upstream call", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: "We carry full face, nasal, nasal pillow, and hybrid.",
            },
          },
        ],
      }),
      text: async () => "",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "What mask styles do you carry?" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.reply).toContain("nasal pillow");
    expect(res.body.offline).toBeUndefined();
    expect(res.body.degraded).toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const callArgs = fetchMock.mock.calls[0];
    const url = callArgs?.[0];
    const init = callArgs?.[1] as RequestInit;
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const payload = JSON.parse(init.body as string);
    expect(payload.model).toBe("gpt-4o-mini");
    expect(payload.messages[0].role).toBe("system");
    expect(payload.messages[0].content).toMatch(/PennBot/);
    expect(payload.messages[0].content).toMatch(/AirFit/);
    expect(payload.messages[1]).toEqual({
      role: "user",
      content: "What mask styles do you carry?",
    });
  });

  it("returns the degraded fallback when upstream HTTP fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "internal error",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "Hi" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.reply).toMatch(/\(814\) 471-0627/);
  });

  it("returns the degraded fallback when upstream throws", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "Hi" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
  });

  it("returns the degraded fallback when upstream returns empty content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "" } }] }),
      text: async () => "",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    const res = await request(makeApp())
      .post("/chat")
      .send({
        messages: [{ role: "user", content: "Hi" }],
      });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
  });

  it("forwards multi-turn history to the model", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Sure thing." } }],
      }),
      text: async () => "",
    });
    __setChatFetchForTests(fetchMock as unknown as typeof fetch);

    await request(makeApp())
      .post("/chat")
      .send({
        messages: [
          { role: "user", content: "What's the AirFit P10 best for?" },
          { role: "assistant", content: "First-time users and side sleepers." },
          { role: "user", content: "And the cushion material?" },
        ],
      });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(init.body as string);
    expect(payload.messages).toHaveLength(4); // 1 system + 3 history
    expect(payload.messages[3]).toEqual({
      role: "user",
      content: "And the cushion material?",
    });
  });

  describe("SSE streaming (Accept: text/event-stream)", () => {
    function makeStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      let i = 0;
      return new ReadableStream({
        pull(controller) {
          if (i < chunks.length) {
            controller.enqueue(encoder.encode(chunks[i]!));
            i += 1;
          } else {
            controller.close();
          }
        },
      });
    }

    function parseSseFrames(raw: string): Array<Record<string, unknown>> {
      return raw
        .split("\n\n")
        .map((f) => f.trim())
        .filter((f) => f.startsWith("data:"))
        .map((f) => JSON.parse(f.slice(5).trim()) as Record<string, unknown>);
    }

    it("streams chunk events and a terminal done event on success", async () => {
      const sseBody = [
        'data: {"choices":[{"delta":{"content":"We carry "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"nasal pillow masks."}}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeStreamBody(sseBody),
        text: async () => "",
      });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "What styles?" }],
        });
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);

      const frames = parseSseFrames(res.text);
      expect(frames).toEqual([
        { type: "chunk", text: "We carry " },
        { type: "chunk", text: "nasal pillow masks." },
        { type: "done" },
      ]);

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const payload = JSON.parse(init.body as string);
      expect(payload.stream).toBe(true);
    });

    it("emits a degraded fallback chunk when the upstream stream fails to open", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        body: null,
        text: async () => "boom",
      });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "Hi" }],
        });
      expect(res.status).toBe(200);
      const frames = parseSseFrames(res.text);
      expect(frames[0]).toMatchObject({ type: "chunk" });
      expect((frames[0] as { text: string }).text).toMatch(/\(814\) 471-0627/);
      expect(frames.at(-1)).toEqual({ type: "done", degraded: true });
    });

    it("emits the offline fallback over SSE when OPENAI_API_KEY is unset", async () => {
      delete process.env.OPENAI_API_KEY;

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "Hi" }],
        });
      expect(res.status).toBe(200);
      const frames = parseSseFrames(res.text);
      expect(frames[0]).toMatchObject({ type: "chunk" });
      expect((frames[0] as { text: string }).text).toMatch(/\(814\) 471-0627/);
      expect(frames.at(-1)).toEqual({ type: "done", offline: true });
    });

    it("treats an empty stream as degraded", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        body: makeStreamBody(["data: [DONE]\n\n"]),
        text: async () => "",
      });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "Hi" }],
        });
      const frames = parseSseFrames(res.text);
      expect(frames[0]).toMatchObject({ type: "chunk" });
      expect((frames[0] as { text: string }).text).toMatch(/\(814\) 471-0627/);
      expect(frames.at(-1)).toEqual({ type: "done", degraded: true });
    });

    it("executes a tool call across two streaming rounds", async () => {
      // Round 1: model emits a tool_call delta and finishes with
      // finish_reason="tool_calls" — no content goes to the client.
      const round1 = makeStreamBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_42","type":"function","function":{"name":"find_masks","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"type\\":\\"nasalPillow\\",\\"limit\\":2}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
      // Round 2: model has the tool result and emits a normal text
      // reply.
      const round2 = makeStreamBody([
        'data: {"choices":[{"delta":{"content":"Two nasal-pillow options: "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"AirFit P10 and Brevida."}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: round1,
          text: async () => "",
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: round2,
          text: async () => "",
        });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "Show me 2 nasal-pillow masks" }],
        });
      expect(res.status).toBe(200);
      const frames = parseSseFrames(res.text);
      // Only the round-2 chunks should reach the client; the
      // round-1 tool_call deltas are NOT re-emitted.
      const chunks = frames
        .filter((f) => f.type === "chunk")
        .map((f) => (f as { text: string }).text);
      expect(chunks.join("")).toBe(
        "Two nasal-pillow options: AirFit P10 and Brevida.",
      );
      expect(frames.at(-1)).toEqual({ type: "done" });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The second upstream call's payload should include the
      // assistant tool_calls message AND a tool result for call_42.
      const round2Init = fetchMock.mock.calls[1]?.[1] as RequestInit;
      const round2Payload = JSON.parse(round2Init.body as string);
      const toolMsg = round2Payload.messages.find(
        (m: { role: string }) => m.role === "tool",
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg.tool_call_id).toBe("call_42");
      // The tool result should be the find_masks JSON envelope.
      const toolPayload = JSON.parse(toolMsg.content);
      expect(toolPayload.masks).toBeDefined();
      expect(Array.isArray(toolPayload.masks)).toBe(true);
    });

    it("returns degraded if the model never produces content within the round cap", async () => {
      // Every round emits another tool call — should bail at MAX_TOOL_ROUNDS.
      // We give each call a fresh stream because a ReadableStream is one-shot.
      const toolFrames = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"find_masks","arguments":"{}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        "data: [DONE]\n\n",
      ];
      const fetchMock = vi.fn().mockImplementation(async () => ({
        ok: true,
        status: 200,
        body: makeStreamBody(toolFrames),
        text: async () => "",
      }));
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .set("Accept", "text/event-stream")
        .send({
          messages: [{ role: "user", content: "Loop me" }],
        });
      const frames = parseSseFrames(res.text);
      expect((frames.at(-1) as { degraded?: boolean }).degraded).toBe(true);
    });
  });

  describe("tool calling (JSON path)", () => {
    it("executes a tool call across two non-streaming rounds", async () => {
      const fetchMock = vi
        .fn()
        // Round 1: tool_calls
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_xy",
                      type: "function",
                      function: {
                        name: "recommend_masks",
                        arguments: JSON.stringify({
                          mouth_breather: true,
                          side_or_stomach_sleeper: true,
                          limit: 2,
                        }),
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
          text: async () => "",
        })
        // Round 2: final content
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: "Two top picks for a side-sleeping mouth-breather.",
                },
                finish_reason: "stop",
              },
            ],
          }),
          text: async () => "",
        });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      const res = await request(makeApp())
        .post("/chat")
        .send({
          messages: [{ role: "user", content: "What mask should I get?" }],
        });
      expect(res.status).toBe(200);
      expect(res.body.reply).toMatch(/Two top picks/);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const round2Init = fetchMock.mock.calls[1]?.[1] as RequestInit;
      const payload = JSON.parse(round2Init.body as string);
      const toolMsg = payload.messages.find(
        (m: { role: string }) => m.role === "tool",
      );
      expect(toolMsg.tool_call_id).toBe("call_xy");
      const toolPayload = JSON.parse(toolMsg.content);
      expect(toolPayload.recommendations).toBeDefined();
      expect(toolPayload.recommendations.length).toBeLessThanOrEqual(2);
    });

    it("forwards tool descriptors to the upstream API", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        }),
        text: async () => "",
      });
      __setChatFetchForTests(fetchMock as unknown as typeof fetch);

      await request(makeApp())
        .post("/chat")
        .send({
          messages: [{ role: "user", content: "hi" }],
        });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const payload = JSON.parse(init.body as string);
      expect(Array.isArray(payload.tools)).toBe(true);
      const toolNames = (payload.tools as Array<{ function: { name: string } }>)
        .map((t) => t.function.name)
        .sort();
      expect(toolNames).toEqual(["compare_masks", "find_masks", "recommend_masks"]);
      expect(payload.tool_choice).toBe("auto");
    });
  });
});

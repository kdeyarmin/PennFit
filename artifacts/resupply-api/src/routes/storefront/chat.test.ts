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
});

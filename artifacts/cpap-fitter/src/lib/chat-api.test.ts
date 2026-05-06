import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
  type Mock,
} from "vitest";
import {
  ChatApiError,
  postChatMessage,
  streamChatMessage,
  type ChatMessage,
} from "./chat-api";

const ORIGINAL_FETCH = global.fetch;

let fetchMock: Mock;
beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const baseMessages: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("postChatMessage", () => {
  test("posts JSON to /api/chat and returns the parsed reply", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ reply: "Hello there." }),
    });

    const res = await postChatMessage(baseMessages);
    expect(res).toEqual({ reply: "Hello there." });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/chat",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: baseMessages }),
      }),
    );
  });

  test("surfaces 429 as a rate-limited reply rather than throwing", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ reply: "Slow down a sec." }),
    });

    const res = await postChatMessage(baseMessages);
    expect(res).toEqual({ reply: "Slow down a sec.", rateLimited: true });
  });

  test("falls back to a default rate-limit message when the body is empty", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => {
        throw new Error("no body");
      },
    });

    const res = await postChatMessage(baseMessages);
    expect(res.rateLimited).toBe(true);
    expect(res.reply).toMatch(/wait a minute/i);
  });

  test("throws ChatApiError on non-429 errors", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: "server boom" }),
    });

    await expect(postChatMessage(baseMessages)).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });
});

describe("streamChatMessage", () => {
  function makeSseStream(events: string[]): {
    body: ReadableStream<Uint8Array>;
  } {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      body: new ReadableStream({
        pull(controller) {
          if (i < events.length) {
            controller.enqueue(encoder.encode(events[i]!));
            i += 1;
          } else {
            controller.close();
          }
        },
      }),
    };
  }

  test("streams chunk events to the onChunk callback and returns final flags", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      ...makeSseStream([
        'data: {"type":"chunk","text":"We carry "}\n\n',
        'data: {"type":"chunk","text":"19 masks."}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    });

    const chunks: string[] = [];
    const result = await streamChatMessage(baseMessages, (c) => chunks.push(c));
    expect(chunks).toEqual(["We carry ", "19 masks."]);
    expect(result.degraded).toBeUndefined();
    expect(result.offline).toBeUndefined();

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Accept).toBe(
      "text/event-stream",
    );
  });

  test("captures `degraded` flag from the terminal done event", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      ...makeSseStream([
        'data: {"type":"chunk","text":"fallback"}\n\n',
        'data: {"type":"done","degraded":true}\n\n',
      ]),
    });

    const chunks: string[] = [];
    const result = await streamChatMessage(baseMessages, (c) => chunks.push(c));
    expect(chunks).toEqual(["fallback"]);
    expect(result.degraded).toBe(true);
  });

  test("returns rateLimited and emits the 429 body as a single chunk", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ reply: "Too many messages, slow down." }),
    });

    const chunks: string[] = [];
    const result = await streamChatMessage(baseMessages, (c) => chunks.push(c));
    expect(result.rateLimited).toBe(true);
    expect(chunks).toEqual(["Too many messages, slow down."]);
  });

  test("throws ChatApiError on non-429 non-OK responses", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      body: null,
      json: async () => ({ error: "server down" }),
    });

    await expect(
      streamChatMessage(baseMessages, () => {
        /* noop */
      }),
    ).rejects.toBeInstanceOf(ChatApiError);
  });

  test("ignores unparseable SSE frames without breaking the stream", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      ...makeSseStream([
        "data: not-json\n\n",
        'data: {"type":"chunk","text":"recovered"}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    });

    const chunks: string[] = [];
    await streamChatMessage(baseMessages, (c) => chunks.push(c));
    expect(chunks).toEqual(["recovered"]);
  });
});

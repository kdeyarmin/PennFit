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
  streamAdminAssistantMessage,
  type AdminAssistantMessage,
} from "./admin-assistant-api";

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

const baseMessages: AdminAssistantMessage[] = [
  { role: "user", content: "where do I manage feature flags?" },
];

function makeBody(events: string[]): { body: ReadableStream<Uint8Array> } {
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

describe("streamAdminAssistantMessage", () => {
  test("streams chunk events and returns the done flags", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      ...makeBody([
        'data: {"type":"chunk","text":"Control Center "}\n\n',
        'data: {"type":"chunk","text":"(/admin/control-center)."}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    });

    const chunks: string[] = [];
    const result = await streamAdminAssistantMessage(baseMessages, (c) =>
      chunks.push(c),
    );
    expect(chunks).toEqual(["Control Center ", "(/admin/control-center)."]);
    expect(result.degraded).toBeUndefined();
  });

  test("retries the JSON endpoint when the stream body carries no SSE events", async () => {
    // A proxy or interceptor (e.g. demo mode's unmatched-route fallback)
    // can answer the streaming endpoint with a plain JSON body. The old
    // behavior resolved { degraded: true } with an EMPTY bubble and a
    // "Trouble connecting" toast; we now retry the JSON endpoint.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        ...makeBody(['{"ok":true}']),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ reply: "Recovered via JSON." }),
      });

    const chunks: string[] = [];
    const result = await streamAdminAssistantMessage(baseMessages, (c) =>
      chunks.push(c),
    );
    expect(chunks).toEqual(["Recovered via JSON."]);
    expect(result.degraded).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("marks degraded and keeps the bubble non-empty when the JSON fallback has no reply", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        ...makeBody(['{"ok":true}']),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

    const chunks: string[] = [];
    const result = await streamAdminAssistantMessage(baseMessages, (c) =>
      chunks.push(c),
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toMatch(/try again/i);
    expect(result.degraded).toBe(true);
  });

  test("does NOT retry when a degraded done event was actually received", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      ...makeBody([
        'data: {"type":"chunk","text":"fallback reply"}\n\n',
        'data: {"type":"done","degraded":true}\n\n',
      ]),
    });

    const chunks: string[] = [];
    const result = await streamAdminAssistantMessage(baseMessages, (c) =>
      chunks.push(c),
    );
    expect(chunks).toEqual(["fallback reply"]);
    expect(result.degraded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Helpers for synthesizing `Response` objects from the demo handlers.
// Every demo handler returns one of these so the calling fetch
// wrappers (storefront/admin customFetch, the auth client, and the
// hand-rolled `fetch()` callers) parse them exactly as they would a
// real network response.

/** JSON response with the right content-type so `res.json()` works. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 204 No Content — for DELETE / write endpoints that return nothing. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Plain-text response (rare; used for a couple of legacy probes). */
export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * A `text/event-stream` response that replays `reply` as a sequence of
 * Server-Sent `chunk` events followed by a `done` event — matching the
 * wire format the chat clients parse (see lib/chat-api.ts). The reply
 * is split into small word-groups and paced with a short delay so the
 * demo chatbot "types" like the live one.
 */
export function sseChat(reply: string): Response {
  const encoder = new TextEncoder();
  // Group words so each chunk is a few tokens — feels like streaming
  // without flooding the UI with one event per character.
  const words = reply.split(/(\s+)/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 3) {
    chunks.push(words.slice(i, i + 3).join(""));
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      for (const chunk of chunks) {
        send({ type: "chunk", text: chunk });
        // Pace the chunks so the demo bot "types" like the live one.
        await new Promise((r) => setTimeout(r, 28));
      }
      send({ type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}

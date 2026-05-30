import { describe, expect, it } from "vitest";

import {
  createElevenLabsClient,
  DEFAULT_ELEVENLABS_MODEL,
  DEFAULT_ELEVENLABS_VOICE_ID,
} from "./elevenlabs-client";

const VALID_KEY = "elevenlabs-fake-test-key-1234567890";

function audioResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { "content-type": "audio/mpeg" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

describe("createElevenLabsClient", () => {
  it("throws when apiKey is missing", () => {
    expect(() => createElevenLabsClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  describe("textToSpeech", () => {
    it("returns the audio buffer on success", async () => {
      const audio = new Uint8Array([1, 2, 3, 4, 5]);
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => audioResponse(audio),
      });
      const result = await client.textToSpeech({ text: "Hi there" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.from(result.audio)).toEqual([1, 2, 3, 4, 5]);
        expect(result.contentType).toBe("audio/mpeg");
      }
    });

    it("sends xi-api-key header and JSON body with default model", async () => {
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = "";
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async (_url, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          capturedBody =
            typeof init?.body === "string" ? init.body : String(init?.body);
          return audioResponse(new Uint8Array([1]));
        },
      });
      await client.textToSpeech({ text: "Hi" });
      expect(capturedHeaders["xi-api-key"]).toBe(VALID_KEY);
      expect(capturedHeaders["Content-Type"]).toBe("application/json");
      expect(capturedBody).toContain(`"text":"Hi"`);
      expect(capturedBody).toContain(
        `"model_id":"${DEFAULT_ELEVENLABS_MODEL}"`,
      );
    });

    it("uses default voice ID and includes output_format in URL when set", async () => {
      let capturedUrl = "";
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async (url) => {
          capturedUrl = String(url);
          return audioResponse(new Uint8Array([1]));
        },
      });
      await client.textToSpeech({
        text: "Hi",
        outputFormat: "ulaw_8000",
      });
      expect(capturedUrl).toContain(
        `/text-to-speech/${DEFAULT_ELEVENLABS_VOICE_ID}`,
      );
      expect(capturedUrl).toContain("output_format=ulaw_8000");
      expect(capturedUrl).not.toContain("/stream");
    });

    it("returns http error on non-2xx", async () => {
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => textResponse("forbidden", 403),
      });
      const result = await client.textToSpeech({ text: "Hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("http");
        expect(result.httpStatus).toBe(403);
      }
    });

    it("returns empty on zero-byte response", async () => {
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => audioResponse(new Uint8Array(0)),
      });
      const result = await client.textToSpeech({ text: "Hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("empty");
      }
    });

    it("returns transport error on fetch rejection", async () => {
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => {
          throw new Error("connection refused");
        },
      });
      const result = await client.textToSpeech({ text: "Hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("transport");
      }
    });

    it("sends voice_settings when provided", async () => {
      let capturedBody = "";
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async (_url, init) => {
          capturedBody =
            typeof init?.body === "string" ? init.body : String(init?.body);
          return audioResponse(new Uint8Array([1]));
        },
      });
      await client.textToSpeech({
        text: "Hi",
        voiceSettings: { stability: 0.6, similarity_boost: 0.8 },
      });
      expect(capturedBody).toContain("voice_settings");
      expect(capturedBody).toContain('"stability":0.6');
      expect(capturedBody).toContain('"similarity_boost":0.8');
    });
  });

  describe("streamTextToSpeech", () => {
    it("uses the /stream URL suffix", async () => {
      let capturedUrl = "";
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async (url) => {
          capturedUrl = String(url);
          // Empty stream — body present but yields no chunks.
          return new Response(new Uint8Array([7, 8, 9]), {
            status: 200,
            headers: { "content-type": "audio/mpeg" },
          });
        },
      });
      const chunks: Uint8Array[] = [];
      const result = await client.streamTextToSpeech({ text: "Hi" }, (c) =>
        chunks.push(c),
      );
      expect(capturedUrl).toContain("/stream");
      expect(result.ok).toBe(true);
      if (result.ok) {
        const total = chunks.reduce((s, c) => s + c.byteLength, 0);
        expect(result.totalBytes).toBe(total);
      }
    });

    it("returns http error on non-2xx stream open", async () => {
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => textResponse("nope", 500),
      });
      const result = await client.streamTextToSpeech(
        { text: "Hi" },
        () => undefined,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("http");
        expect(result.httpStatus).toBe(500);
      }
    });
  });

  describe("listVoices", () => {
    it("returns the voices array on success", async () => {
      const client = createElevenLabsClient({
        apiKey: VALID_KEY,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              voices: [
                { voice_id: "v1", name: "Alice" },
                { voice_id: "v2", name: "Bob" },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      });
      const result = await client.listVoices();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.voices).toHaveLength(2);
        expect(result.voices[0]?.name).toBe("Alice");
      }
    });
  });
});

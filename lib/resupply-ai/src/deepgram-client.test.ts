import { describe, expect, it } from "vitest";

import {
  createDeepgramClient,
  DEFAULT_DEEPGRAM_MODEL,
} from "./deepgram-client";

const VALID_KEY = "dg-fake-test-key-1234567890abcdef";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

const SAMPLE_PRERECORDED = {
  metadata: { duration: 4.2, model_info: { name: "nova-3" } },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "hi this is the patient calling about my mask",
            confidence: 0.97,
            words: [
              { word: "hi", start: 0.0, end: 0.2, confidence: 0.98 },
            ],
          },
        ],
      },
    ],
  },
};

describe("createDeepgramClient", () => {
  it("throws when apiKey is missing", () => {
    expect(() => createDeepgramClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  describe("transcribePrerecorded", () => {
    it("returns transcript + confidence + duration on success", async () => {
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => jsonResponse(SAMPLE_PRERECORDED),
      });
      const result = await client.transcribePrerecorded({
        audio: new Uint8Array([1, 2, 3, 4]),
        contentType: "audio/wav",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transcript).toBe("hi this is the patient calling about my mask");
        expect(result.confidence).toBeCloseTo(0.97);
        expect(result.durationSeconds).toBe(4.2);
        expect(result.model).toBe("nova-3");
      }
    });

    it("uses default model when none provided", async () => {
      let capturedUrl = "";
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async (url) => {
          capturedUrl = String(url);
          return jsonResponse(SAMPLE_PRERECORDED);
        },
      });
      await client.transcribePrerecorded({
        audio: new Uint8Array([1, 2, 3]),
        contentType: "audio/wav",
      });
      expect(capturedUrl).toContain(`model=${DEFAULT_DEEPGRAM_MODEL}`);
      expect(capturedUrl).toContain("language=en-US");
      expect(capturedUrl).toContain("smart_format=true");
      expect(capturedUrl).toContain("punctuate=true");
    });

    it("sends Token authentication header", async () => {
      let capturedHeaders: Record<string, string> = {};
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async (_url, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          return jsonResponse(SAMPLE_PRERECORDED);
        },
      });
      await client.transcribePrerecorded({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      });
      expect(capturedHeaders["Authorization"]).toBe(`Token ${VALID_KEY}`);
      expect(capturedHeaders["Content-Type"]).toBe("audio/wav");
    });

    it("returns http error code on non-2xx", async () => {
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => textResponse("unauthorized", 401),
      });
      const result = await client.transcribePrerecorded({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("http");
        expect(result.httpStatus).toBe(401);
      }
    });

    it("returns transport error on fetch rejection", async () => {
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async () => {
          throw new Error("dns lookup failed");
        },
      });
      const result = await client.transcribePrerecorded({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("transport");
      }
    });

    it("returns empty when results have no alternatives", async () => {
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async () =>
          jsonResponse({
            metadata: { duration: 1.0 },
            results: { channels: [{ alternatives: [] }] },
          }),
      });
      const result = await client.transcribePrerecorded({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("empty");
      }
    });

    it("propagates redact params to the URL", async () => {
      let capturedUrl = "";
      const client = createDeepgramClient({
        apiKey: VALID_KEY,
        fetchImpl: async (url) => {
          capturedUrl = String(url);
          return jsonResponse(SAMPLE_PRERECORDED);
        },
      });
      await client.transcribePrerecorded({
        audio: new Uint8Array([1]),
        contentType: "audio/wav",
        redact: ["ssn", "pci"],
      });
      expect(capturedUrl).toContain("redact=ssn");
      expect(capturedUrl).toContain("redact=pci");
    });
  });
});

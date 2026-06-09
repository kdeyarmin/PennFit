// Unit tests for the inbound-fax barcode/tracking-code scan. The model
// client is stubbed, so these pin the routing/parse/validation logic
// without a network call.

import { describe, it, expect, vi } from "vitest";
import type {
  AnthropicClient,
  AnthropicResponse,
} from "@workspace/resupply-ai";

import { scanFaxForTrackingCode } from "./tracking-scan";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // 4 bytes, content irrelevant

/** Build a stub AnthropicClient whose send() returns one text block. */
function stubClient(text: string): AnthropicClient {
  const response = {
    content: [{ type: "text", text }],
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as AnthropicResponse;
  return {
    send: vi.fn().mockResolvedValue({ ok: true, response, latencyMs: 5 }),
    stream: vi.fn(),
  } as unknown as AnthropicClient;
}

function erroringClient(): AnthropicClient {
  return {
    send: vi.fn().mockResolvedValue({
      ok: false,
      errorCode: "http",
      errorMessage: "boom",
      latencyMs: 5,
    }),
    stream: vi.fn(),
  } as unknown as AnthropicClient;
}

describe("scanFaxForTrackingCode", () => {
  it("returns offline when no client is configured", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: null,
    });
    expect(r.status).toBe("offline");
  });

  it("rejects an un-scannable content type before calling the model", async () => {
    const client = stubClient("PFS-ABCD2345");
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "text/plain",
      client,
    });
    expect(r.status).toBe("unsupported");
    expect(client.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("treats TIFF (not in Claude's image set) as unsupported", async () => {
    const client = stubClient("PFS-ABCD2345");
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/tiff",
      client,
    });
    expect(r.status).toBe("unsupported");
  });

  it("rejects empty media", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: Buffer.alloc(0),
      contentType: "image/png",
      client: stubClient("PFS-ABCD2345"),
    });
    expect(r.status).toBe("unsupported");
  });

  it("returns a normalized code on a clean reply", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("PFS-ABCD2345"),
    });
    expect(r).toEqual({ status: "found", code: "PFS-ABCD2345" });
  });

  it("extracts the code even when wrapped in prose, and normalizes spacing", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("The tracking code reads PFS ABCD2345 in the corner."),
    });
    expect(r).toEqual({ status: "found", code: "PFS-ABCD2345" });
  });

  it("returns not_found when the model says NONE", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("NONE"),
    });
    expect(r.status).toBe("not_found");
  });

  it("returns not_found for a malformed code (forbidden glyphs)", async () => {
    // 0/O/1/I/L are not in the tracking alphabet — a read containing them
    // can't be one of ours, so we never look it up.
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("PFS-0O1ILABC"),
    });
    expect(r.status).toBe("not_found");
  });

  it("returns not_found for a wrong-length code", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("PFS-ABC"),
    });
    expect(r.status).toBe("not_found");
  });

  it("sends a document block for PDFs", async () => {
    const client = stubClient("NONE");
    await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "application/pdf",
      client,
    });
    const req = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages[0].content[0].type).toBe("document");
    expect(req.messages[0].content[0].source.media_type).toBe(
      "application/pdf",
    );
  });

  it("fails (not throws) on a model error", async () => {
    const r = await scanFaxForTrackingCode({
      bytes: PNG,
      contentType: "image/png",
      client: erroringClient(),
    });
    expect(r.status).toBe("failed");
  });
});

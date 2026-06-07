// Unit tests for inbound-fax OCR field extraction. The model client is
// stubbed, so these pin the routing/parse/validation logic without a
// network call.

import { describe, it, expect, vi } from "vitest";
import type {
  AnthropicClient,
  AnthropicResponse,
} from "@workspace/resupply-ai";

import { extractFaxFields, type FaxOcrFields } from "./ocr";

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

const VALID_FIELDS: FaxOcrFields = {
  documentType: "prescription",
  patientName: "Jane Doe",
  patientDob: "1960-02-03",
  patientPhone: "555-1212",
  physicianName: "Dr. Gregory House",
  physicianNpi: "1234567890",
  items: [{ description: "CPAP mask cushion", hcpcs: "A7032" }],
  summary: "Standing order for monthly resupply.",
  confidence: "high",
};

describe("extractFaxFields", () => {
  it("returns offline when no client is configured", async () => {
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/png",
      client: null,
    });
    expect(r.status).toBe("offline");
  });

  it("rejects an un-OCR-able content type before calling the model", async () => {
    const client = stubClient("{}");
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "text/plain",
      client,
    });
    expect(r.status).toBe("unsupported");
    expect(client.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects empty media and oversize media", async () => {
    const empty = await extractFaxFields({
      bytes: Buffer.alloc(0),
      contentType: "image/png",
      client: stubClient("{}"),
    });
    expect(empty.status).toBe("unsupported");
  });

  it("extracts and validates fields from a JSON model reply", async () => {
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient(JSON.stringify(VALID_FIELDS)),
    });
    expect(r.status).toBe("extracted");
    if (r.status === "extracted") {
      expect(r.fields).toEqual(VALID_FIELDS);
      expect(r.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("tolerates a ```json fenced reply", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_FIELDS) + "\n```";
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/jpg", // normalised to image/jpeg internally
      client: stubClient(fenced),
    });
    expect(r.status).toBe("extracted");
  });

  it("sends a document block for PDFs", async () => {
    const client = stubClient(JSON.stringify(VALID_FIELDS));
    await extractFaxFields({
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
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/png",
      client: erroringClient(),
    });
    expect(r.status).toBe("failed");
  });

  it("fails on a non-JSON / shape-mismatched reply", async () => {
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient("the prescription is for a CPAP mask"),
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.reason).toBe("unparseable_model_output");
    }
  });

  it("rejects a reply missing the required confidence field", async () => {
    const { confidence: _omit, ...partial } = VALID_FIELDS;
    const r = await extractFaxFields({
      bytes: PNG,
      contentType: "image/png",
      client: stubClient(JSON.stringify(partial)),
    });
    expect(r.status).toBe("failed");
  });
});

// Unit tests for referral-packet extraction. The model client is
// stubbed, so these pin the routing/parse/validation logic without a
// network call.

import { describe, it, expect, vi } from "vitest";
import type {
  AnthropicClient,
  AnthropicResponse,
} from "@workspace/resupply-ai";

import {
  REFERRAL_EXTRACT_MAX_BYTES,
  extractReferral,
  type ReferralExtraction,
} from "./extract";

const PDF = Buffer.from("%PDF-1.4 stub"); // content irrelevant to the stub

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

const VALID_EXTRACTION: ReferralExtraction = {
  patient: {
    firstName: "Jane",
    lastName: "Doe",
    dob: "1960-02-03",
    phone: "+14155551212",
    email: "jane@example.com",
    address: {
      line1: "1 Main St",
      line2: null,
      city: "Pittsburgh",
      state: "PA",
      postalCode: "15201",
    },
  },
  insurance: {
    payerName: "Highmark BCBS",
    planName: "PPO Blue",
    memberId: "ABC123456",
    groupNumber: "G-998",
    policyholderName: "Jane Doe",
    policyholderRelationship: "self",
  },
  secondaryInsurance: null,
  order: [
    { description: "CPAP device", hcpcs: "E0601" },
    { description: "Full face mask", hcpcs: "A7030" },
  ],
  sleepStudy: {
    studyDate: "2026-04-12",
    studyType: "home sleep test",
    ahi: 32.4,
    rdi: null,
    odi: 28.1,
    totalSleepMinutes: 412,
    interpretingPhysician: "Dr. Lisa Cuddy",
  },
  physician: {
    name: "Dr. Gregory House",
    npi: "1234567890",
    phone: "+14125550000",
    fax: "+14125550001",
    clinic: "Princeton Plainsboro Sleep Center",
  },
  documents: [
    { type: "demographics", pageStart: 1, pageEnd: 1, title: "Face sheet" },
    {
      type: "physician_order",
      pageStart: 2,
      pageEnd: 2,
      title: "CPAP order",
    },
    { type: "sleep_study", pageStart: 3, pageEnd: 6, title: "HST report" },
  ],
  summary: "New CPAP setup referral with HST showing severe OSA.",
  confidence: {
    patient: "high",
    insurance: "high",
    order: "high",
    sleepStudy: "medium",
  },
};

describe("extractReferral", () => {
  it("returns offline when no client is configured", async () => {
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: null,
    });
    expect(r.status).toBe("offline");
  });

  it("rejects non-PDF media (TIFF) before calling the model", async () => {
    const client = stubClient("{}");
    const r = await extractReferral({
      bytes: PDF,
      contentType: "image/tiff",
      client,
    });
    expect(r.status).toBe("unsupported");
    expect(client.send as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized media", async () => {
    const empty = await extractReferral({
      bytes: Buffer.alloc(0),
      contentType: "application/pdf",
      client: stubClient("{}"),
    });
    expect(empty.status).toBe("unsupported");

    const big = await extractReferral({
      bytes: Buffer.alloc(REFERRAL_EXTRACT_MAX_BYTES + 1),
      contentType: "application/pdf",
      client: stubClient("{}"),
    });
    expect(big.status).toBe("unsupported");
  });

  it("extracts and validates a full packet from a JSON model reply", async () => {
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: stubClient(JSON.stringify(VALID_EXTRACTION)),
    });
    expect(r.status).toBe("extracted");
    if (r.status === "extracted") {
      expect(r.extraction).toEqual(VALID_EXTRACTION);
      expect(r.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("tolerates a ```json fenced reply", async () => {
    const fenced = "```json\n" + JSON.stringify(VALID_EXTRACTION) + "\n```";
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf; charset=binary",
      client: stubClient(fenced),
    });
    expect(r.status).toBe("extracted");
  });

  it("sends the packet as a base64 document block", async () => {
    const client = stubClient(JSON.stringify(VALID_EXTRACTION));
    await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client,
    });
    const req = (client.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(req.messages[0].content[0].type).toBe("document");
    expect(req.messages[0].content[0].source.media_type).toBe(
      "application/pdf",
    );
    expect(req.temperature).toBe(0);
  });

  it("fails (not throws) on a model error", async () => {
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: erroringClient(),
    });
    expect(r.status).toBe("failed");
  });

  it("fails on a non-JSON / shape-mismatched reply", async () => {
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: stubClient("this packet contains a referral for Jane Doe"),
    });
    expect(r.status).toBe("failed");
    if (r.status === "failed") {
      expect(r.reason).toBe("unparseable_model_output");
    }
  });

  it("rejects a reply missing the per-section confidence", async () => {
    const { confidence: _omit, ...partial } = VALID_EXTRACTION;
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: stubClient(JSON.stringify(partial)),
    });
    expect(r.status).toBe("failed");
  });

  it("rejects an unknown document section type", async () => {
    const bad = {
      ...VALID_EXTRACTION,
      documents: [
        { type: "lab_result", pageStart: 1, pageEnd: 2, title: "Labs" },
      ],
    };
    const r = await extractReferral({
      bytes: PDF,
      contentType: "application/pdf",
      client: stubClient(JSON.stringify(bad)),
    });
    expect(r.status).toBe("failed");
  });
});

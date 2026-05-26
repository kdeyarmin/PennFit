import { describe, expect, it } from "vitest";

import {
  createHealthConnectAdapter,
  healthConnectIngestEnvelopeSchema,
} from "./index";

describe("createHealthConnectAdapter", () => {
  it("reports configured (accepts patient-push ingest)", () => {
    const adapter = createHealthConnectAdapter({});
    expect(adapter.source).toBe("health_connect");
    expect(adapter.availability()).toEqual({ status: "configured" });
  });

  it("returns not_found (no fabricated snapshot); the route reads the DB", async () => {
    const adapter = createHealthConnectAdapter({});
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 7,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("not_found");
    }
  });
});

describe("healthConnectIngestEnvelopeSchema", () => {
  it("accepts a minimal envelope", () => {
    const parsed = healthConnectIngestEnvelopeSchema.parse({
      deviceId: "dev-1",
      partnerPatientId: "user-1",
      capturedAt: "2026-05-07T12:00:00Z",
    });
    expect(parsed.recentNights).toEqual([]);
    expect(parsed.supplies).toEqual([]);
  });

  it("rejects raw image fields", () => {
    const result = healthConnectIngestEnvelopeSchema.safeParse({
      deviceId: "dev-1",
      partnerPatientId: "user-1",
      capturedAt: "2026-05-07T12:00:00Z",
      imageBlob: "data:image/png;base64,AAAA",
    });
    expect(result.success).toBe(false);
  });
});

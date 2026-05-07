import { describe, expect, it } from "vitest";

import {
  createHealthConnectAdapter,
  healthConnectIngestEnvelopeSchema,
} from "./index";

describe("createHealthConnectAdapter", () => {
  it("defaults to stub mode when env is empty", () => {
    const adapter = createHealthConnectAdapter({});
    expect(adapter.source).toBe("health_connect");
    expect(adapter.availability()).toEqual({
      status: "stub",
      reason: "stub_mode",
    });
  });

  it("returns stub snapshot with sleep-as-usageMinutes", async () => {
    const adapter = createHealthConnectAdapter({});
    const result = await adapter.fetchSnapshot({
      partnerPatientId: "abc",
      windowDays: 7,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.recentNights.length).toBe(7);
      expect(result.snapshot.recentNights[0]?.ahi).toBeNull();
    }
  });

  it("flips out of stub when HEALTH_CONNECT_STUB=0", () => {
    const adapter = createHealthConnectAdapter({ HEALTH_CONNECT_STUB: "0" });
    expect(adapter.availability()).toEqual({ status: "configured" });
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

import { describe, it, expect } from "vitest";

import { aggregateVoiceMetrics, type VoiceCallRow } from "./voice-metrics";

const row = (r: Partial<VoiceCallRow>): VoiceCallRow => ({
  status: null,
  direction: null,
  durationSeconds: null,
  initiatedAt: null,
  answeredAt: null,
  ...r,
});

describe("aggregateVoiceMetrics", () => {
  it("returns empty/null shape for no calls", () => {
    expect(aggregateVoiceMetrics([])).toEqual({
      totalCalls: 0,
      answeredCalls: 0,
      answerRate: null,
      byStatus: {},
      byDirection: { inbound: 0, outbound: 0, other: 0 },
      avgHandleSeconds: null,
      medianHandleSeconds: null,
      avgRingSeconds: null,
      medianRingSeconds: null,
    });
  });

  it("computes volume, answer rate, handle + ring time", () => {
    const rows: VoiceCallRow[] = [
      // answered, 120s talk, 5s ring
      row({
        status: "completed",
        direction: "outbound-api",
        durationSeconds: 120,
        initiatedAt: "2026-06-06T00:00:00.000Z",
        answeredAt: "2026-06-06T00:00:05.000Z",
      }),
      // answered, 60s talk, 15s ring
      row({
        status: "completed",
        direction: "inbound",
        durationSeconds: 60,
        initiatedAt: "2026-06-06T00:00:00.000Z",
        answeredAt: "2026-06-06T00:00:15.000Z",
      }),
      // never answered
      row({ status: "no-answer", direction: "outbound-api" }),
      // missing duration → excluded from handle time
      row({
        status: "completed",
        direction: "outbound-api",
        durationSeconds: 0,
        answeredAt: "2026-06-06T00:00:02.000Z",
      }),
    ];
    const r = aggregateVoiceMetrics(rows);
    expect(r.totalCalls).toBe(4);
    expect(r.answeredCalls).toBe(3); // three have answeredAt
    expect(r.answerRate).toBe(0.75);
    expect(r.byStatus).toEqual({ completed: 3, "no-answer": 1 });
    expect(r.byDirection).toEqual({ inbound: 1, outbound: 3, other: 0 });
    // handle times: [120, 60] (0 excluded) → avg 90, median 90
    expect(r.avgHandleSeconds).toBe(90);
    expect(r.medianHandleSeconds).toBe(90);
    // ring times: [5, 15] → avg 10, median 10
    expect(r.avgRingSeconds).toBe(10);
    expect(r.medianRingSeconds).toBe(10);
  });

  it("buckets unknown status and other direction", () => {
    const r = aggregateVoiceMetrics([
      row({ status: null, direction: "outbound-dial" }),
      row({ status: "  ", direction: "carrier-thing" }),
    ]);
    expect(r.byStatus).toEqual({ unknown: 2 });
    expect(r.byDirection.outbound).toBe(1);
    expect(r.byDirection.other).toBe(1);
  });
});

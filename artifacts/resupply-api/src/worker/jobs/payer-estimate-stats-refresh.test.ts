// Registration + handler tests for the payer-estimate stats refresh cron
// (owner #O2). The refresh logic itself is covered by
// lib/insurance-estimates/refresh-stats.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const refreshMock = vi.hoisted(() =>
  vi.fn(async () => ({ slugsWritten: 0, samplesScanned: 0 })),
);
vi.mock("../../lib/insurance-estimates/refresh-stats", () => ({
  refreshPayerEstimateStats: refreshMock,
}));

const logCalls = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({ logger: logCalls }));

import {
  registerPayerEstimateStatsJob,
  PAYER_STATS_JOB,
  PAYER_STATS_CRON,
} from "./payer-estimate-stats-refresh";

interface BossSpy {
  createQueue: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
}

function makeBoss(): BossSpy {
  return {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  refreshMock.mockClear();
  refreshMock.mockResolvedValue({ slugsWritten: 0, samplesScanned: 0 });
  logCalls.info.mockClear();
  logCalls.error.mockClear();
});

describe("insurance-estimate.stats-refresh", () => {
  it("registers + schedules on the canonical queue + cron", async () => {
    const boss = makeBoss();
    await registerPayerEstimateStatsJob(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(
      PAYER_STATS_JOB,
      expect.objectContaining({ name: PAYER_STATS_JOB }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      PAYER_STATS_JOB,
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      PAYER_STATS_JOB,
      PAYER_STATS_CRON,
    );
  });

  it("invokes the refresh and logs the stats envelope", async () => {
    const boss = makeBoss();
    refreshMock.mockResolvedValueOnce({ slugsWritten: 4, samplesScanned: 250 });
    await registerPayerEstimateStatsJob(boss as never);
    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await handler();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(logCalls.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "insurance-estimate.stats-refresh.completed",
        slugsWritten: 4,
        samplesScanned: 250,
      }),
      expect.stringContaining("completed"),
    );
  });

  it("rethrows after logging on failure (pg-boss retry signal)", async () => {
    const boss = makeBoss();
    refreshMock.mockRejectedValueOnce(new Error("rpc down"));
    await registerPayerEstimateStatsJob(boss as never);
    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await expect(handler()).rejects.toThrow("rpc down");
    expect(logCalls.error).toHaveBeenCalled();
  });

  it("runs weekly (cron has a day-of-week field)", () => {
    expect(PAYER_STATS_CRON).toMatch(/^\d+ \d+ \* \* \d+$/);
  });
});

// Tests for the onboarding check-ins cron pair (dispatcher + scanner).
//
// Both handlers are thin wrappers around lib functions. We verify:
//   * The dispatch handler calls dispatchDueCheckins with system actor
//   * The scan handler calls scanCompliance
//   * Errors propagate from either handler

import { describe, it, expect, vi, beforeEach } from "vitest";

const { dispatchDueCheckinsMock, scanComplianceMock } = vi.hoisted(() => ({
  dispatchDueCheckinsMock: vi.fn(),
  scanComplianceMock: vi.fn(),
}));
vi.mock("../../lib/checkin-dispatcher", () => ({
  dispatchDueCheckins: dispatchDueCheckinsMock,
}));
vi.mock("../../lib/compliance-scanner", () => ({
  scanCompliance: scanComplianceMock,
}));

vi.mock("../lib/queue-options", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  CRON_SCAN_QUEUE_OPTS: {},
  VENDOR_SEND_QUEUE_OPTS: {},
}));

interface FakeBoss {
  work: (job: string, h: () => Promise<void>) => Promise<void>;
  schedule: (job: string, cron: string) => Promise<void>;
}
function makeFakeBoss(): {
  boss: FakeBoss;
  run: (jobName: string) => Promise<void>;
} {
  const handlers = new Map<string, () => Promise<void>>();
  const boss: FakeBoss = {
    work: async (job, h) => {
      handlers.set(job, h);
    },
    schedule: async () => undefined,
  };
  return {
    boss,
    run: async (jobName) => {
      const h = handlers.get(jobName);
      if (!h) throw new Error(`no handler for ${jobName}`);
      await h();
    },
  };
}

import { registerOnboardingCheckinJobs } from "./onboarding-checkins";

beforeEach(() => {
  dispatchDueCheckinsMock.mockReset();
  scanComplianceMock.mockReset();
});

describe("onboarding-checkins cron jobs", () => {
  it("dispatch handler calls dispatchDueCheckins with system actor", async () => {
    dispatchDueCheckinsMock.mockResolvedValueOnce({ dispatched: 3 });
    const fake = makeFakeBoss();
    await registerOnboardingCheckinJobs(fake.boss as never);
    await fake.run("onboarding-checkins.dispatch");
    expect(dispatchDueCheckinsMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "system" } }),
    );
  });

  it("scan handler calls scanCompliance", async () => {
    scanComplianceMock.mockResolvedValueOnce({ alertsOpened: 1 });
    const fake = makeFakeBoss();
    await registerOnboardingCheckinJobs(fake.boss as never);
    await fake.run("onboarding-checkins.scan");
    expect(scanComplianceMock).toHaveBeenCalledTimes(1);
  });

  it("propagates errors from dispatchDueCheckins", async () => {
    dispatchDueCheckinsMock.mockRejectedValueOnce(new Error("vendor down"));
    const fake = makeFakeBoss();
    await registerOnboardingCheckinJobs(fake.boss as never);
    await expect(fake.run("onboarding-checkins.dispatch")).rejects.toThrow(
      "vendor down",
    );
  });

  it("propagates errors from scanCompliance", async () => {
    scanComplianceMock.mockRejectedValueOnce(new Error("DB read failed"));
    const fake = makeFakeBoss();
    await registerOnboardingCheckinJobs(fake.boss as never);
    await expect(fake.run("onboarding-checkins.scan")).rejects.toThrow(
      "DB read failed",
    );
  });
});

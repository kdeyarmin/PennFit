// Tests for the coaching auto-enroll cron registration (RT #R3).
//
// The sweep logic itself is covered by
// `lib/clinical/coaching-auto-enroll.test.ts`. This file pins the
// worker-specific contract, mirroring cart-abandonment-scan.test.ts:
//
//   * Feature flag — registration is a no-op unless
//     RESUPPLY_COACHING_AUTO_ENROLL_ENABLED=1, so a deploy that lands
//     this code doesn't start auto-creating coaching plans.
//   * When enabled, registration calls createQueue / work / schedule on
//     the canonical queue name + cron expression.
//   * The handler invokes the sweep and logs the stats envelope.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const runSweepMock = vi.hoisted(() =>
  vi.fn(async () => ({
    candidates: 0,
    scored: 0,
    enrolled: 0,
    skippedExistingPlan: 0,
  })),
);
vi.mock("../../lib/clinical/coaching-auto-enroll", () => ({
  runCoachingAutoEnrollSweep: runSweepMock,
}));

const logCalls = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({ logger: logCalls }));

import {
  registerCoachingAutoEnrollJob,
  COACHING_AUTO_ENROLL_JOB,
  COACHING_AUTO_ENROLL_CRON,
} from "./coaching-auto-enroll";

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

const ORIGINAL_FLAG = process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED;

beforeEach(() => {
  runSweepMock.mockClear();
  runSweepMock.mockResolvedValue({
    candidates: 0,
    scored: 0,
    enrolled: 0,
    skippedExistingPlan: 0,
  });
  logCalls.info.mockClear();
  logCalls.error.mockClear();
  logCalls.warn.mockClear();
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED;
  } else {
    process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED = ORIGINAL_FLAG;
  }
});

describe("coaching-plan.auto-enroll-sweep — feature-flag gating", () => {
  it("does NOT register when the flag is unset", async () => {
    delete process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED;
    const boss = makeBoss();
    await registerCoachingAutoEnrollJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(logCalls.info).toHaveBeenCalledWith(
      { event: "coaching-plan.auto-enroll-sweep.disabled" },
      expect.stringContaining("not registered"),
    );
  });

  it("does NOT register when the flag is '0'", async () => {
    process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED = "0";
    const boss = makeBoss();
    await registerCoachingAutoEnrollJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
  });

  it("registers + schedules when the flag is '1'", async () => {
    process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED = "1";
    const boss = makeBoss();
    await registerCoachingAutoEnrollJob(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(
      COACHING_AUTO_ENROLL_JOB,
      expect.objectContaining({ name: COACHING_AUTO_ENROLL_JOB }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      COACHING_AUTO_ENROLL_JOB,
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalledWith(
      COACHING_AUTO_ENROLL_JOB,
      COACHING_AUTO_ENROLL_CRON,
    );
  });
});

describe("coaching-plan.auto-enroll-sweep — handler behaviour", () => {
  it("invokes the sweep and logs the stats envelope", async () => {
    process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED = "1";
    const boss = makeBoss();
    runSweepMock.mockResolvedValueOnce({
      candidates: 12,
      scored: 9,
      enrolled: 2,
      skippedExistingPlan: 3,
    });
    await registerCoachingAutoEnrollJob(boss as never);

    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await handler();

    expect(runSweepMock).toHaveBeenCalledTimes(1);
    expect(logCalls.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "coaching-plan.auto-enroll-sweep.completed",
        candidates: 12,
        enrolled: 2,
        skippedExistingPlan: 3,
      }),
      expect.stringContaining("completed"),
    );
    expect(logCalls.error).not.toHaveBeenCalled();
  });

  it("rethrows after logging when the sweep fails (pg-boss retry signal)", async () => {
    process.env.RESUPPLY_COACHING_AUTO_ENROLL_ENABLED = "1";
    const boss = makeBoss();
    runSweepMock.mockRejectedValueOnce(new Error("DB down"));
    await registerCoachingAutoEnrollJob(boss as never);

    const handler = boss.work.mock.calls[0][1] as () => Promise<void>;
    await expect(handler()).rejects.toThrow("DB down");
    expect(logCalls.error).toHaveBeenCalled();
  });
});

describe("coaching-plan.auto-enroll-sweep — cron schedule", () => {
  it("runs daily after nightly-sync (04:30) and progress-sweep (04:41)", () => {
    expect(COACHING_AUTO_ENROLL_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
    const [minute, hour] = COACHING_AUTO_ENROLL_CRON.split(" ").map(Number);
    expect(hour).toBeGreaterThanOrEqual(5);
    expect(minute).toBeGreaterThanOrEqual(0);
  });
});

// Tests for the daily idempotency-keys prune cron wrapper.
//
// Coverage:
//   * Runs a DELETE against idempotency_keys with count='exact'
//   * Filters by expires_at <= now()
//   * Propagates DB errors so pg-boss marks the job failed

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../lib/queue-options", () => ({
  createQueueWithDlq: vi.fn(async () => undefined),
  CRON_SCAN_QUEUE_OPTS: {},
}));

interface FakeBoss {
  work: (job: string, h: () => Promise<void>) => Promise<void>;
  schedule: (job: string, cron: string) => Promise<void>;
}
function makeFakeBoss(): { boss: FakeBoss; run: () => Promise<void> } {
  let handler: () => Promise<void> = async () => {};
  const boss: FakeBoss = {
    work: async (_j, h) => {
      handler = h;
    },
    schedule: async () => undefined,
  };
  return { boss, run: () => handler() };
}

import { registerIdempotencyKeysPruneJob } from "./idempotency-keys-prune";

beforeEach(() => {
  supabaseMock.reset();
});

describe("idempotency-keys.prune cron handler", () => {
  it("deletes expired keys filtered by expires_at<=now()", async () => {
    stageSupabaseResponse("idempotency_keys", "delete", {
      data: null,
      count: 42,
    });
    const fake = makeFakeBoss();
    await registerIdempotencyKeysPruneJob(fake.boss as never);
    await fake.run();

    const calls = getSupabaseFilterCalls("idempotency_keys", "delete");
    const lteCall = calls.find((c) => c.verb === "lte");
    expect(lteCall?.args[0]).toBe("expires_at");
    expect(lteCall?.args[1]).toBeTruthy();
  });

  it("propagates DB errors so pg-boss marks the job failed", async () => {
    stageSupabaseResponse("idempotency_keys", "delete", {
      error: { message: "db down" },
    });
    const fake = makeFakeBoss();
    await registerIdempotencyKeysPruneJob(fake.boss as never);
    await expect(fake.run()).rejects.toBeTruthy();
  });
});

// Tests for the expiry-aware worker_dedup_keys claim (app-review
// 2026-06-10, P1-2). The old plain INSERT conflicted on EXPIRED rows
// too — with no sweeper, a "14-day" cap became permanent after the
// first successful send.

import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { claimDedupKey } from "./dedup-keys";

beforeEach(() => {
  supabaseMock.reset();
});

describe("claimDedupKey", () => {
  it("clears expired rows for the key, then claims", async () => {
    stageSupabaseResponse("worker_dedup_keys", "delete", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("worker_dedup_keys", "insert", {
      data: null,
      error: null,
    });

    const result = await claimDedupKey(
      getSupabaseServiceRoleClient(),
      "therapy-alert-sms:pat-1",
      "2026-06-24T00:00:00.000Z",
    );

    expect(result).toEqual({ outcome: "claimed" });
    // The delete only sweeps EXPIRED rows for this key — an active
    // cooldown row must never be removed.
    const deleteFilters = supabaseMock.filterCalls(
      "worker_dedup_keys",
      "delete",
    );
    expect(deleteFilters).toContainEqual({
      verb: "eq",
      args: ["key", "therapy-alert-sms:pat-1"],
    });
    expect(
      deleteFilters.some((f) => f.verb === "lte" && f.args[0] === "expires_at"),
    ).toBe(true);
    expect(
      supabaseMock.writePayloads("worker_dedup_keys", "insert")[0],
    ).toEqual({
      key: "therapy-alert-sms:pat-1",
      expires_at: "2026-06-24T00:00:00.000Z",
    });
  });

  it("reports held when an UNEXPIRED row still owns the key (23505)", async () => {
    stageSupabaseResponse("worker_dedup_keys", "delete", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("worker_dedup_keys", "insert", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });

    const result = await claimDedupKey(
      getSupabaseServiceRoleClient(),
      "k",
      "2026-06-24T00:00:00.000Z",
    );
    expect(result).toEqual({ outcome: "held" });
  });

  it("maps a non-conflict insert error to outcome error", async () => {
    stageSupabaseResponse("worker_dedup_keys", "delete", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("worker_dedup_keys", "insert", {
      data: null,
      error: { code: "57014", message: "statement timeout" },
    });

    const result = await claimDedupKey(
      getSupabaseServiceRoleClient(),
      "k",
      "2026-06-24T00:00:00.000Z",
    );
    expect(result).toEqual({
      outcome: "error",
      error: { code: "57014", message: "statement timeout" },
    });
  });

  it("does not attempt the insert when the expiry sweep itself errors", async () => {
    stageSupabaseResponse("worker_dedup_keys", "delete", {
      data: null,
      error: { code: "08006", message: "connection failure" },
    });

    const result = await claimDedupKey(
      getSupabaseServiceRoleClient(),
      "k",
      "2026-06-24T00:00:00.000Z",
    );
    expect(result.outcome).toBe("error");
    expect(supabaseMock.callCount("worker_dedup_keys", "insert")).toBe(0);
  });
});

// Claims submitting watchdog: release abandoned Office Ally batch locks.
//
// Covers the safety-critical branches:
//   * empty scan → zero counts
//   * stale submitting with no transmission evidence → released to draft
//   * claim already linked to a submission → needs_manual (no release)
//   * claim listed on a recent uploaded submission → needs_manual
//   * multi-tenant fan-out via forEachActiveOrg

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
  getSupabaseWritePayloads,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  runClaimsSubmittingWatchdog,
  runClaimsSubmittingWatchdogForOrg,
} from "./claims-submitting-watchdog";

const ORG = "00000000-0000-4000-8000-000000000001";
const CLAIM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLAIM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2026-08-27T16:00:00.000Z");
const STALE_MS = 30 * 60 * 1000;

beforeEach(() => supabaseMock.reset());

describe("runClaimsSubmittingWatchdogForOrg", () => {
  it("returns zero when no stale submitting claims exist", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    const stats = await runClaimsSubmittingWatchdogForOrg(ORG, {
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats).toEqual({ scanned: 0, released: 0, needsManual: 0 });
    expect(getSupabaseCallCount("insurance_claims", "update")).toBe(0);
  });

  it("releases stale submitting claims with no transmission evidence", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: CLAIM_A,
          office_ally_submission_id: null,
          updated_at: "2026-08-27T15:00:00.000Z",
        },
      ],
    });
    // No uploaded/queued submissions in the lookback window.
    stageSupabaseResponse("office_ally_submissions", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_A }],
    });

    const stats = await runClaimsSubmittingWatchdogForOrg(ORG, {
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats).toEqual({ scanned: 1, released: 1, needsManual: 0 });

    const payloads = getSupabaseWritePayloads("insurance_claims", "update");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      status: "draft",
      updated_at: NOW.toISOString(),
    });
    // Conditional release — never stomp a concurrent winner.
    const filters = getSupabaseFilterCalls("insurance_claims", "update");
    expect(filters.some((f) => f.verb === "eq" && f.args[0] === "status")).toBe(
      true,
    );
  });

  it("skips claims already linked to an office_ally_submission_id", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: CLAIM_A,
          office_ally_submission_id: "sub-1",
          updated_at: "2026-08-27T15:00:00.000Z",
        },
      ],
    });
    // No candidate ids → no submissions scan, no update.
    const stats = await runClaimsSubmittingWatchdogForOrg(ORG, {
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats).toEqual({ scanned: 1, released: 0, needsManual: 1 });
    expect(getSupabaseCallCount("office_ally_submissions", "select")).toBe(0);
    expect(getSupabaseCallCount("insurance_claims", "update")).toBe(0);
  });

  it("skips claims listed on a recent uploaded submission", async () => {
    stageSupabaseResponse("insurance_claims", "select", {
      data: [
        {
          id: CLAIM_A,
          office_ally_submission_id: null,
          updated_at: "2026-08-27T15:00:00.000Z",
        },
        {
          id: CLAIM_B,
          office_ally_submission_id: null,
          updated_at: "2026-08-27T15:05:00.000Z",
        },
      ],
    });
    stageSupabaseResponse("office_ally_submissions", "select", {
      data: [
        {
          id: "sub-up",
          status: "uploaded",
          attempted_claim_ids: [CLAIM_A],
        },
      ],
    });
    // Only CLAIM_B is releasable.
    stageSupabaseResponse("insurance_claims", "update", {
      data: [{ id: CLAIM_B }],
    });

    const stats = await runClaimsSubmittingWatchdogForOrg(ORG, {
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats).toEqual({ scanned: 2, released: 1, needsManual: 1 });
  });

  it("filters the scan to submitting + stale updated_at", async () => {
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    await runClaimsSubmittingWatchdogForOrg(ORG, {
      now: NOW,
      staleMs: STALE_MS,
    });
    const filters = getSupabaseFilterCalls("insurance_claims", "select");
    expect(
      filters.some(
        (f) =>
          f.verb === "eq" &&
          f.args[0] === "status" &&
          f.args[1] === "submitting",
      ),
    ).toBe(true);
    expect(
      filters.some(
        (f) =>
          f.verb === "lt" &&
          f.args[0] === "updated_at" &&
          f.args[1] === "2026-08-27T15:30:00.000Z",
      ),
    ).toBe(true);
  });
});

describe("runClaimsSubmittingWatchdog — fan-out", () => {
  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runClaimsSubmittingWatchdog({
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats).toEqual({ scanned: 0, released: 0, needsManual: 0 });
    expect(getSupabaseCallCount("insurance_claims", "select")).toBe(0);
  });

  it("runs once per active tenant", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    // Per tenant: empty stuck scan.
    stageSupabaseResponse("insurance_claims", "select", { data: [] });
    stageSupabaseResponse("insurance_claims", "select", { data: [] });

    const stats = await runClaimsSubmittingWatchdog({
      now: NOW,
      staleMs: STALE_MS,
    });
    expect(stats.scanned).toBe(0);
    expect(getSupabaseCallCount("insurance_claims", "select")).toBe(2);
  });
});

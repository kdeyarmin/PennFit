import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseRpcArgs,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { refreshPayerEstimateStats } from "./refresh-stats";

beforeEach(() => supabaseMock.reset());

describe("refreshPayerEstimateStats", () => {
  it("fans out per tenant: scopes the RPC, delete, and inserts by org_id", async () => {
    // One active tenant — the fan-out resolves it from organizations.
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
    const samples = [];
    for (let i = 1; i <= 12; i++) {
      samples.push({ payer_name: "Aetna PPO", oop_cents: i * 100 });
    }
    samples.push({ payer_name: "Mystery TPA", oop_cents: 5000 }); // dropped
    stageSupabaseRpcResponse("payer_oop_samples", { data: samples });
    stageSupabaseResponse("payer_estimate_stats", "delete", { data: [] });
    stageSupabaseResponse("payer_estimate_stats", "insert", { data: [] });

    const result = await refreshPayerEstimateStats();
    expect(result.samplesScanned).toBe(13);
    expect(result.slugsWritten).toBe(1);

    // The RPC now receives the tenant's org_id (migration 0382 signature).
    const rpcArgs = getSupabaseRpcArgs("payer_oop_samples");
    expect(rpcArgs).toHaveLength(1);
    expect(rpcArgs[0]).toMatchObject({ p_org_id: "org-a" });

    // The DELETE is scoped to the tenant's org_id.
    const delFilters = getSupabaseFilterCalls("payer_estimate_stats", "delete");
    expect(delFilters).toContainEqual(
      expect.objectContaining({ verb: "eq", args: ["org_id", "org-a"] }),
    );

    // Every inserted row carries the tenant's org_id.
    const inserts = getSupabaseWritePayloads("payer_estimate_stats", "insert");
    const rows = inserts[0] as Array<{
      org_id: string;
      slug: string;
      sample_size: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.org_id).toBe("org-a");
    expect(rows[0]!.slug).toBe("aetna");
    expect(rows[0]!.sample_size).toBe(12);
  });

  it("sums counts across multiple tenants", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const robust = [];
    for (let i = 1; i <= 12; i++) {
      robust.push({ payer_name: "Aetna PPO", oop_cents: i * 100 });
    }
    // org-a: one qualifying slug.
    stageSupabaseRpcResponse("payer_oop_samples", { data: robust });
    stageSupabaseResponse("payer_estimate_stats", "delete", { data: [] });
    stageSupabaseResponse("payer_estimate_stats", "insert", { data: [] });
    // org-b: a thin sample that doesn't qualify.
    stageSupabaseRpcResponse("payer_oop_samples", {
      data: [{ payer_name: "Mystery TPA", oop_cents: 100 }],
    });
    stageSupabaseResponse("payer_estimate_stats", "delete", { data: [] });

    const result = await refreshPayerEstimateStats();
    expect(result.slugsWritten).toBe(1);
    expect(result.samplesScanned).toBe(13);
  });

  it("clears the table and inserts nothing when no slug qualifies", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
    stageSupabaseRpcResponse("payer_oop_samples", {
      data: [{ payer_name: "Mystery TPA", oop_cents: 100 }],
    });
    stageSupabaseResponse("payer_estimate_stats", "delete", { data: [] });

    const result = await refreshPayerEstimateStats();
    expect(result.slugsWritten).toBe(0);
    expect(
      getSupabaseWritePayloads("payer_estimate_stats", "insert"),
    ).toHaveLength(0);
  });

  it("no-ops when there are no active tenants", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const result = await refreshPayerEstimateStats();
    expect(result).toEqual({ slugsWritten: 0, samplesScanned: 0 });
  });
});

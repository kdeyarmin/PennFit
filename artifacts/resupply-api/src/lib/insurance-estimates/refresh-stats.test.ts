import { describe, expect, it, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseRpcResponse,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { refreshPayerEstimateStats } from "./refresh-stats";

beforeEach(() => supabaseMock.reset());

describe("refreshPayerEstimateStats", () => {
  it("classifies samples, writes qualifying slugs, returns counts", async () => {
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

    const inserts = getSupabaseWritePayloads("payer_estimate_stats", "insert");
    const rows = inserts[0] as Array<{ slug: string; sample_size: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("aetna");
    expect(rows[0]!.sample_size).toBe(12);
  });

  it("clears the table and inserts nothing when no slug qualifies", async () => {
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
});

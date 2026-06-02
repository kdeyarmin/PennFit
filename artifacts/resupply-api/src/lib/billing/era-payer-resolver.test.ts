import { beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolvePayerProfileForEra } from "./era-payer-resolver";

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

describe("resolvePayerProfileForEra", () => {
  beforeEach(() => supabaseMock.reset());

  it("matches by era_payer_id when present", async () => {
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    const out = await resolvePayerProfileForEra({
      payerId: "54771",
      payerName: "Highmark Inc.",
    });
    expect(out).toEqual({
      payerProfileId: PROFILE_ID,
      matchReason: "era_payer_id",
    });
    const filterCalls = getSupabaseFilterCalls("payer_profiles", "select");
    // First eq call should be against era_payer_id with the parsed
    // payer id from the 835.
    const firstEq = filterCalls.find((c) => c.verb === "eq");
    expect(firstEq?.args).toEqual(["era_payer_id", "54771"]);
  });

  it("falls through era_payer_id → office_ally_payer_id when first lookup misses", async () => {
    // First era_payer_id lookup returns empty …
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    // … then office_ally_payer_id hits.
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    const out = await resolvePayerProfileForEra({
      payerId: "23281",
      payerName: null,
    });
    expect(out).toEqual({
      payerProfileId: PROFILE_ID,
      matchReason: "office_ally_payer_id",
    });
  });

  it("falls through to edi_5010_payer_id when first two miss", async () => {
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    const out = await resolvePayerProfileForEra({
      payerId: "62308",
      payerName: null,
    });
    expect(out).toEqual({
      payerProfileId: PROFILE_ID,
      matchReason: "edi_5010_payer_id",
    });
  });

  it("falls through id lookups to name_ilike when id provided but unmatched", async () => {
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    const out = await resolvePayerProfileForEra({
      payerId: "ZZZZZ",
      payerName: "Geisinger Health Plan",
    });
    expect(out).toEqual({
      payerProfileId: PROFILE_ID,
      matchReason: "name_ilike",
    });
  });

  it("returns null when no id and no name match", async () => {
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    stageSupabaseResponse("payer_profiles", "select", { data: [] });
    const out = await resolvePayerProfileForEra({
      payerId: "UNKNOWN",
      payerName: "Random Insurer",
    });
    expect(out).toBeNull();
  });

  it("returns null when both hints are empty/null", async () => {
    expect(
      await resolvePayerProfileForEra({ payerId: null, payerName: null }),
    ).toBeNull();
    expect(
      await resolvePayerProfileForEra({ payerId: "   ", payerName: "   " }),
    ).toBeNull();
  });

  it("name-only lookup skips id branches entirely", async () => {
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    const out = await resolvePayerProfileForEra({
      payerId: null,
      payerName: "Highmark",
    });
    expect(out).toEqual({
      payerProfileId: PROFILE_ID,
      matchReason: "name_ilike",
    });
  });

  it("resolves a shared EDI id deterministically (orders by created_at, then id)", async () => {
    // Many active profiles can share one EDI id (e.g. 60054 spans Aetna
    // commercial / Medicare / D-SNP). The lookup must apply an explicit,
    // stable order so the resolved payer doesn't flip between ingests.
    stageSupabaseResponse("payer_profiles", "select", {
      data: [{ id: PROFILE_ID }],
    });
    await resolvePayerProfileForEra({ payerId: "60054", payerName: null });
    const orderCols = getSupabaseFilterCalls("payer_profiles", "select")
      .filter((c) => c.verb === "order")
      .map((c) => c.args[0]);
    expect(orderCols).toEqual(["created_at", "id"]);
  });
});

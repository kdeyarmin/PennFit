import { describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "./supabase-mock";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

describe("installSupabaseMock", () => {
  it("resets staged responses and call counts on install", async () => {
    const mockA = installSupabaseMock();
    stageSupabaseResponse("patients", "select", { data: { id: "p1" } });
    await getSupabaseServiceRoleClient()
      .schema("public")
      .from("patients")
      .select("*")
      .maybeSingle();
    expect(mockA.callCount("patients", "select")).toBe(1);

    const mockB = installSupabaseMock();
    expect(mockB.callCount("patients", "select")).toBe(0);
    expect(mockB.writePayloads("patients", "insert")).toEqual([]);
    expect(mockB.filterCalls("patients", "select")).toEqual([]);
  });
});

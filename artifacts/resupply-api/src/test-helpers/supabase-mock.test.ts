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
    await getSupabaseServiceRoleClient()
      .schema("public")
      .from("patients")
      .update({ status: "active" })
      .eq("id", "p1")
      .maybeSingle();
    expect(mockA.callCount("patients", "select")).toBe(1);
    expect(mockA.callCount("patients", "update")).toBe(1);
    expect(mockA.writePayloads("patients", "update")).toEqual([
      { status: "active" },
    ]);
    expect(mockA.filterCalls("patients", "update")).toEqual([
      { verb: "eq", args: ["id", "p1"] },
    ]);

    const mockB = installSupabaseMock();
    expect(mockB.callCount("patients", "select")).toBe(0);
    expect(mockB.callCount("patients", "update")).toBe(0);
    expect(mockB.writePayloads("patients", "insert")).toEqual([]);
    expect(mockB.writePayloads("patients", "update")).toEqual([]);
    expect(mockB.filterCalls("patients", "select")).toEqual([]);
    expect(mockB.filterCalls("patients", "update")).toEqual([]);
  });
});

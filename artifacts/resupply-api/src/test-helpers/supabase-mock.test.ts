import { describe, expect, it } from "vitest";

import { installSupabaseMock, stageSupabaseResponse } from "./supabase-mock";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

describe("installSupabaseMock", () => {
  it("resets staged responses and call counts on install", async () => {
    const mockA = installSupabaseMock();
    // Stage TWO responses so one remains unconsumed when we reinstall.
    stageSupabaseResponse("orders", "select", { data: { id: "order_1" } });
    stageSupabaseResponse("orders", "select", { data: { id: "order_2" } });
    // Consume only the first staged response.
    await getSupabaseServiceRoleClient()
      .schema("public")
      .from("orders")
      .select("*")
      .maybeSingle();
    await getSupabaseServiceRoleClient()
      .schema("public")
      .from("orders")
      .update({ email_status: "sent" })
      .eq("id", "order_1")
      .maybeSingle();
    expect(mockA.callCount("orders", "select")).toBe(1);
    expect(mockA.callCount("orders", "update")).toBe(1);
    expect(mockA.writePayloads("orders", "update")).toEqual([
      { email_status: "sent" },
    ]);
    expect(mockA.filterCalls("orders", "update")).toEqual([
      { verb: "eq", args: ["id", "order_1"] },
    ]);

    // One staged select response is still in the queue when we reinstall.
    const mockB = installSupabaseMock();
    expect(mockB.callCount("orders", "select")).toBe(0);
    expect(mockB.callCount("orders", "update")).toBe(0);
    expect(mockB.writePayloads("orders", "insert")).toEqual([]);
    expect(mockB.writePayloads("orders", "update")).toEqual([]);
    expect(mockB.filterCalls("orders", "select")).toEqual([]);
    expect(mockB.filterCalls("orders", "update")).toEqual([]);
    // Verify the unconsumed staged response was cleared: the call should
    // return the default { data: null } envelope, not { data: { id: "order_2" } }.
    const result = await getSupabaseServiceRoleClient()
      .schema("public")
      .from("orders")
      .select("*")
      .maybeSingle();
    expect(result).toEqual({ data: null, error: null });
  });
});

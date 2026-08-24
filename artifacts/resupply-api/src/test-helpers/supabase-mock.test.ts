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

describe("filterCallsByInvocation", () => {
  // The per-invocation log is what lets a spec assert "EVERY read was
  // scoped" rather than "some read was". Recording a FILTERLESS invocation
  // as an empty array is the load-bearing half of that: an unscoped read is
  // exactly the one that applies no filters, so if it were simply not
  // recorded it would be invisible to the very assertion meant to catch it.
  //
  // Nothing else covers this. Every query in the routes that use the
  // per-invocation log happens to apply at least one filter, so the
  // implementation could quietly stop recording empty arrays and those
  // suites would all still pass — while a future unscoped read slipped
  // straight through. Hence a direct test.
  it("records a filterless select as one EMPTY invocation", async () => {
    const mock = installSupabaseMock();

    await getSupabaseServiceRoleClient()
      .schema("resupply")
      .from("mask_models")
      .select("id");

    expect(mock.filterCallsByInvocation("mask_models", "select")).toEqual([[]]);
    // The flattened log cannot represent this at all — which is the whole
    // reason the per-invocation one exists.
    expect(mock.filterCalls("mask_models", "select")).toEqual([]);
  });

  it("keeps invocations separate instead of flattening them together", async () => {
    const mock = installSupabaseMock();
    const db = getSupabaseServiceRoleClient();

    // A scoped read, then an UNSCOPED one — the exact drift pattern.
    await db
      .schema("resupply")
      .from("mask_models")
      .select("id")
      .is("org_id", null);
    await db.schema("resupply").from("mask_models").select("id");

    expect(mock.filterCallsByInvocation("mask_models", "select")).toEqual([
      [{ verb: "is", args: ["org_id", null] }],
      [],
    ]);
    // Flattened, the unscoped second read is indistinguishable from a single
    // scoped read — `toContainEqual` on this passes either way.
    expect(mock.filterCalls("mask_models", "select")).toEqual([
      { verb: "is", args: ["org_id", null] },
    ]);
  });

  it("is cleared by reset()", async () => {
    const mock = installSupabaseMock();
    await getSupabaseServiceRoleClient()
      .schema("resupply")
      .from("mask_models")
      .select("id");
    expect(mock.filterCallsByInvocation("mask_models", "select")).toHaveLength(
      1,
    );

    mock.reset();
    expect(mock.filterCallsByInvocation("mask_models", "select")).toEqual([]);
  });
});

describe("touchedKeys / touchedRpcFns", () => {
  it("reports the COMPLETE set of (table, op) pairs invoked", async () => {
    const mock = installSupabaseMock();
    const db = getSupabaseServiceRoleClient();

    await db.schema("resupply").from("mask_models").select("id");
    await db.schema("resupply").from("prescriptions").select("id");
    await db.schema("resupply").from("orders").insert({ id: "o1" });

    // Sorted "table.op" strings — a test can assert equality and so fail on
    // any table it did not name, which a denylist can never do.
    expect(mock.touchedKeys()).toEqual([
      "mask_models.select",
      "orders.insert",
      "prescriptions.select",
    ]);
    expect(mock.touchedRpcFns()).toEqual([]);
  });

  it("reports RPC function names, which bypass the table log", async () => {
    const mock = installSupabaseMock();

    await getSupabaseServiceRoleClient()
      .schema("resupply")
      .rpc("merge_patient_records", { a: 1 });

    expect(mock.touchedKeys()).toEqual([]);
    expect(mock.touchedRpcFns()).toEqual(["merge_patient_records"]);
  });

  it("is cleared by reset()", async () => {
    const mock = installSupabaseMock();
    await getSupabaseServiceRoleClient()
      .schema("resupply")
      .from("mask_models")
      .select("id");
    expect(mock.touchedKeys()).toEqual(["mask_models.select"]);

    mock.reset();
    expect(mock.touchedKeys()).toEqual([]);
  });
});

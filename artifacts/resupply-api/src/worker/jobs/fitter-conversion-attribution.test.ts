// Tests for runFitterConversionAttribution — the hourly worker that
// attributes recently-placed orders back to matching fitter_leads rows.
//
// Coverage:
//   * no recent orders → returns zero-filled stats immediately
//   * happy path: matches order by email, stamps first_order_id +
//     journey_stage='converted', increments attributed counter
//   * email matching is case-insensitive (order email uppercased)
//   * skips a lead whose first_order_id is already set (no overwrite)
//   * skips an unsubscribed lead (terminal state, preserved)
//   * records errors on a failed DB update without throwing
//   * multiple orders for the same email → only the first (by
//     created_at ASC) is attributed
//   * ordersScanned matches the number of order rows returned

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { runFitterConversionAttribution } from "./fitter-conversion-attribution";

beforeEach(() => {
  supabaseMock.reset();
});

// Helper to build a minimal order row
function makeOrder(
  id: string,
  patient_email: string,
  created_at = "2025-01-10T08:00:00Z",
) {
  return { id, patient_email, created_at };
}

// Helper to build a minimal lead row
function makeLead(
  id: string,
  email: string,
  journey_stage = "campaign_active",
  first_order_id: string | null = null,
) {
  return { id, email, journey_stage, first_order_id, created_at: "2025-01-01T00:00:00Z" };
}

describe("runFitterConversionAttribution", () => {
  it("returns all-zero stats when there are no recent orders", async () => {
    stageSupabaseResponse("orders", "select", { data: [] });

    const stats = await runFitterConversionAttribution();

    expect(stats.ordersScanned).toBe(0);
    expect(stats.leadsMatched).toBe(0);
    expect(stats.attributed).toBe(0);
    expect(stats.skippedTerminal).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("attributes an order to the matching fitter_leads row", async () => {
    const order = makeOrder("order-001", "alice@example.com");
    const lead = makeLead("lead-001", "alice@example.com");

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const stats = await runFitterConversionAttribution();

    expect(stats.ordersScanned).toBe(1);
    expect(stats.leadsMatched).toBe(1);
    expect(stats.attributed).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it("writes first_order_id, first_order_placed_at, and journey_stage='converted' on attribution", async () => {
    const order = makeOrder("order-abc", "bob@example.com", "2025-01-15T10:00:00Z");
    const lead = makeLead("lead-bob", "bob@example.com");

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    await runFitterConversionAttribution();

    const [updatePayload] = supabaseMock.writePayloads(
      "fitter_leads",
      "update",
    ) as Array<Record<string, unknown>>;
    expect(updatePayload).toBeDefined();
    expect(updatePayload.first_order_id).toBe("order-abc");
    expect(updatePayload.first_order_placed_at).toBe("2025-01-15T10:00:00Z");
    expect(updatePayload.journey_stage).toBe("converted");
    expect(updatePayload.next_campaign_touch_at).toBeNull();
  });

  it("matches orders to leads in a case-insensitive manner", async () => {
    // order.patient_email is uppercase; lead.email is lowercase
    const order = makeOrder("order-ci", "CAROL@EXAMPLE.COM");
    const lead = makeLead("lead-carol", "carol@example.com");

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const stats = await runFitterConversionAttribution();

    expect(stats.attributed).toBe(1);
  });

  it("skips a lead whose first_order_id is already set (increments skippedTerminal)", async () => {
    const order = makeOrder("order-dup", "dave@example.com");
    const lead = makeLead(
      "lead-dave",
      "dave@example.com",
      "converted",
      "order-existing",
    );

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });

    const stats = await runFitterConversionAttribution();

    expect(stats.attributed).toBe(0);
    expect(stats.skippedTerminal).toBe(1);
    // No update should have been issued
    expect(supabaseMock.callCount("fitter_leads", "update")).toBe(0);
  });

  it("skips an unsubscribed lead (terminal state preserved)", async () => {
    const order = makeOrder("order-eve", "eve@example.com");
    const lead = makeLead("lead-eve", "eve@example.com", "unsubscribed", null);

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });

    const stats = await runFitterConversionAttribution();

    expect(stats.attributed).toBe(0);
    expect(stats.skippedTerminal).toBe(1);
    expect(supabaseMock.callCount("fitter_leads", "update")).toBe(0);
  });

  it("increments errors and continues when a DB update fails", async () => {
    const order = makeOrder("order-err", "frank@example.com");
    const lead = makeLead("lead-frank", "frank@example.com");

    stageSupabaseResponse("orders", "select", { data: [order] });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", {
      error: { message: "DB write failed" },
    });

    const stats = await runFitterConversionAttribution();

    expect(stats.attributed).toBe(0);
    expect(stats.errors).toBe(1);
  });

  it("ordersScanned counts all returned order rows regardless of lead match", async () => {
    const orders = [
      makeOrder("o1", "g@example.com"),
      makeOrder("o2", "h@example.com"),
      makeOrder("o3", "i@example.com"),
    ];
    // Only one matching lead
    const lead = makeLead("lead-g", "g@example.com");

    stageSupabaseResponse("orders", "select", { data: orders });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const stats = await runFitterConversionAttribution();

    expect(stats.ordersScanned).toBe(3);
    expect(stats.leadsMatched).toBe(1);
    expect(stats.attributed).toBe(1);
  });

  it("throws when the orders query itself errors", async () => {
    stageSupabaseResponse("orders", "select", {
      error: { message: "orders table offline" },
    });

    await expect(runFitterConversionAttribution()).rejects.toThrow(
      "orders table offline",
    );
  });

  it("attributes only the first order (by created_at ASC) when multiple orders share the same email", async () => {
    // The worker builds a Map and skips duplicates after the first —
    // the first order in the sorted-ascending list is the genuinely
    // first order placed.
    const orders = [
      makeOrder("order-first", "james@example.com", "2025-01-10T06:00:00Z"),
      makeOrder("order-second", "james@example.com", "2025-01-12T06:00:00Z"),
    ];
    const lead = makeLead("lead-james", "james@example.com");

    stageSupabaseResponse("orders", "select", { data: orders });
    stageSupabaseResponse("fitter_leads", "select", { data: [lead] });
    stageSupabaseResponse("fitter_leads", "update", { data: null, error: null });

    const stats = await runFitterConversionAttribution();

    // Only one attribution despite two orders
    expect(stats.attributed).toBe(1);

    const [updatePayload] = supabaseMock.writePayloads(
      "fitter_leads",
      "update",
    ) as Array<Record<string, unknown>>;
    // The first order in ascending-date order should win
    expect(updatePayload.first_order_id).toBe("order-first");
  });

  it("handles orders with null patient_email gracefully (skips, no error)", async () => {
    const orders = [
      { id: "order-null", patient_email: null, created_at: "2025-01-10T00:00:00Z" },
    ];

    stageSupabaseResponse("orders", "select", { data: orders });

    const stats = await runFitterConversionAttribution();

    expect(stats.ordersScanned).toBe(1);
    expect(stats.attributed).toBe(0);
    expect(stats.errors).toBe(0);
  });
});

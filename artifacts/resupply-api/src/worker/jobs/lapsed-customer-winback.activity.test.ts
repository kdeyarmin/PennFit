import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { resolveLastCustomerShipmentActivityIso } from "./lapsed-customer-winback";

const supabaseMock = installSupabaseMock();
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const PATIENT_ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => supabaseMock.reset());

describe("resolveLastCustomerShipmentActivityIso", () => {
  it("prefers recent fulfillment shipped_at over stale shop paid_at", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "ada@example.com" },
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }],
    });
    stageSupabaseResponse("fulfillments", "select", {
      data: {
        shipped_at: "2026-01-15T00:00:00.000Z",
        delivered_at: null,
        created_at: "2026-01-10T00:00:00.000Z",
      },
    });
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        paid_at: "2020-06-01T00:00:00.000Z",
        shipped_at: null,
        delivered_at: null,
        created_at: "2020-06-01T00:00:00.000Z",
      },
    });

    const supabase = getOrgScopedClient(ORG_ID);
    const last = await resolveLastCustomerShipmentActivityIso(
      supabase,
      CUSTOMER_ID,
    );
    expect(last).toBe("2026-01-15T00:00:00.000Z");
  });

  it("falls back to shop_orders when email does not resolve to a patient", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "orphan@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", {
      data: {
        paid_at: "2024-03-01T00:00:00.000Z",
        shipped_at: "2024-03-05T00:00:00.000Z",
        delivered_at: null,
        created_at: "2024-03-01T00:00:00.000Z",
      },
    });

    const supabase = getOrgScopedClient(ORG_ID);
    const last = await resolveLastCustomerShipmentActivityIso(
      supabase,
      CUSTOMER_ID,
    );
    expect(last).toBe("2024-03-05T00:00:00.000Z");
  });

  it("returns null when the customer has no measurable activity", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: CUSTOMER_ID, email_lower: "new@example.com" },
    });
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_orders", "select", { data: null });

    const supabase = getOrgScopedClient(ORG_ID);
    const last = await resolveLastCustomerShipmentActivityIso(
      supabase,
      CUSTOMER_ID,
    );
    expect(last).toBeNull();
  });
});

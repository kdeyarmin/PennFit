// ensureShopCustomerRow / readShopCustomer org-scoping.
//
// shop_customers is a tenant table (NOT NULL org_id). These helpers must
// (a) create the row in the request's tenant, and (b) filter reads by
// that tenant — the multi-tenant correctness this fixes. When no orgId is
// passed they fall back to the seed org (single-tenant behavior).

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { ensureShopCustomerRow } from "./customer";

// The supabase mock stubs resolveSeedOrgId() to this fixed org.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_ORG = "11111111-1111-4111-8111-111111111111";

beforeEach(() => supabaseMock.reset());

describe("ensureShopCustomerRow — tenant scoping", () => {
  it("inserts the new row with the passed tenant's org_id", async () => {
    // No existing row → insert path.
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_customers", "insert", {
      data: { customer_id: "cust-1", org_id: TENANT_ORG, email_lower: null },
    });

    await ensureShopCustomerRow({
      orgId: TENANT_ORG,
      customerId: "cust-1",
      email: null,
    });

    const inserts = getSupabaseWritePayloads("shop_customers", "insert");
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as Record<string, unknown>).org_id).toBe(TENANT_ORG);
  });

  it("filters the existence read by the passed tenant's org_id", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: "cust-1", org_id: TENANT_ORG, email_lower: null },
    });

    await ensureShopCustomerRow({
      orgId: TENANT_ORG,
      customerId: "cust-1",
      email: null,
    });

    const filters = getSupabaseFilterCalls("shop_customers", "select");
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["org_id", TENANT_ORG],
    });
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["customer_id", "cust-1"],
    });
  });

  it("falls back to the seed org when no orgId is passed", async () => {
    stageSupabaseResponse("shop_customers", "select", { data: null });
    stageSupabaseResponse("shop_customers", "insert", {
      data: { customer_id: "cust-2", org_id: SEED_ORG, email_lower: null },
    });

    await ensureShopCustomerRow({ customerId: "cust-2", email: null });

    const inserts = getSupabaseWritePayloads("shop_customers", "insert");
    expect((inserts[0] as Record<string, unknown>).org_id).toBe(SEED_ORG);
  });
});

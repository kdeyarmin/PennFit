// resolveOrgIdForSignedRecord — derives a signed link's tenant from the
// token-referenced record's org_id (multi-tenant G1), with seed fallback.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolveOrgIdForSignedRecord } from "./signed-link-org";

// The supabase mock stubs resolveSeedOrgId() to this fixed org.
const SEED_ORG = "00000000-0000-4000-8000-000000000000";
const TENANT_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => supabaseMock.reset());

describe("resolveOrgIdForSignedRecord", () => {
  it("resolves a CSR order's tenant from its record's org_id", async () => {
    stageSupabaseResponse("csr_order_requests", "select", {
      data: { org_id: TENANT_B },
    });
    const orgId = await resolveOrgIdForSignedRecord(
      "csr_order_requests",
      "ord-1",
    );
    expect(orgId).toBe(TENANT_B);
  });

  it("resolves a patient packet's tenant from its record's org_id", async () => {
    stageSupabaseResponse("patient_packets", "select", {
      data: { org_id: TENANT_B },
    });
    const orgId = await resolveOrgIdForSignedRecord("patient_packets", "pkt-1");
    expect(orgId).toBe(TENANT_B);
  });

  it("resolves a reminder conversation's tenant from its record's org_id", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: { org_id: TENANT_B },
    });
    const orgId = await resolveOrgIdForSignedRecord("conversations", "conv-1");
    expect(orgId).toBe(TENANT_B);
  });

  it("falls back to the seed org when the record is missing", async () => {
    stageSupabaseResponse("csr_order_requests", "select", { data: null });
    const orgId = await resolveOrgIdForSignedRecord(
      "csr_order_requests",
      "missing",
    );
    expect(orgId).toBe(SEED_ORG);
  });
});

// reserveIsa13Value — per-tenant atomic ISA13 reservation (mig 0359).
//
// Pins the CAS contract the EDI submission path relies on:
//   * the read AND the compare-and-set update are scoped to the caller's
//     tenant (org_id) — two tenants never draw from one ISA13 sequence;
//   * a missing counter row returns null (caller falls back to MAX-read);
//   * losing the CAS re-reads and retries.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getOrgScopedClient } from "@workspace/resupply-db";

import { reserveIsa13Value } from "./isa13-counter";

const ORG = "00000000-0000-4000-8000-000000000000";
const POOL = "office_ally_isa13";

beforeEach(() => supabaseMock.reset());

describe("reserveIsa13Value", () => {
  it("reserves seen+1, scoping both the read and the CAS to the tenant", async () => {
    stageSupabaseResponse("control_number_counters", "select", {
      data: { value: 41 },
    });
    stageSupabaseResponse("control_number_counters", "update", {
      data: [{ pool: POOL }],
    });

    const reserved = await reserveIsa13Value(getOrgScopedClient(ORG));
    expect(reserved).toBe(42);

    // Read scoped to (org_id, pool).
    const reads = getSupabaseFilterCalls("control_number_counters", "select");
    expect(
      reads.some(
        (f) => f.verb === "eq" && f.args[0] === "org_id" && f.args[1] === ORG,
      ),
    ).toBe(true);
    expect(
      reads.some(
        (f) => f.verb === "eq" && f.args[0] === "pool" && f.args[1] === POOL,
      ),
    ).toBe(true);

    // CAS update scoped to (org_id, pool) AND the seen value.
    const updates = getSupabaseFilterCalls("control_number_counters", "update");
    expect(
      updates.some(
        (f) => f.verb === "eq" && f.args[0] === "org_id" && f.args[1] === ORG,
      ),
    ).toBe(true);
    expect(
      updates.some(
        (f) => f.verb === "eq" && f.args[0] === "value" && f.args[1] === 41,
      ),
    ).toBe(true);
  });

  it("returns null when the tenant has no counter row", async () => {
    stageSupabaseResponse("control_number_counters", "select", { data: null });
    const reserved = await reserveIsa13Value(getOrgScopedClient(ORG));
    expect(reserved).toBeNull();
  });

  it("retries after losing the CAS, then succeeds", async () => {
    // First attempt reads 41, loses the CAS (no rows claimed).
    stageSupabaseResponse("control_number_counters", "select", {
      data: { value: 41 },
    });
    stageSupabaseResponse("control_number_counters", "update", { data: [] });
    // Second attempt re-reads 50 and wins.
    stageSupabaseResponse("control_number_counters", "select", {
      data: { value: 50 },
    });
    stageSupabaseResponse("control_number_counters", "update", {
      data: [{ pool: POOL }],
    });

    const reserved = await reserveIsa13Value(getOrgScopedClient(ORG));
    expect(reserved).toBe(51);
  });
});

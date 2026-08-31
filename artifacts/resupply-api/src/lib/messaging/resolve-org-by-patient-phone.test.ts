// resolveOrgIdByPatientPhone — shared-number inbound disambiguation.
//
// When tenants share one platform number, an inbound reply's `To` number
// isn't owned by any tenant, so the inbound handler falls back to resolving
// the tenant by the PATIENT's phone. This covers that resolver in isolation.

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  invalidateTenantTelecomCache,
  resolveOrgIdByPatientPhone,
} from "./tenant-telecom";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => {
  supabaseMock.reset();
  invalidateTenantTelecomCache();
});

describe("resolveOrgIdByPatientPhone", () => {
  it("returns null for a blank number without querying", async () => {
    expect(await resolveOrgIdByPatientPhone("  ")).toBeNull();
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
  });

  it("normalizes bare NANP before the phone_e164 lookup", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p1", org_id: ORG_A }],
    });
    expect(await resolveOrgIdByPatientPhone("2155550000")).toBe(ORG_A);
    const phoneFilter = supabaseMock
      .filterCalls("patients", "select")
      .find((c) => c.verb === "eq" && c.args[0] === "phone_e164");
    expect(phoneFilter?.args[1]).toBe("+12155550000");
  });

  it("returns null for unparseable input without querying", async () => {
    expect(await resolveOrgIdByPatientPhone("1234")).toBeNull();
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
  });

  it("routes to the single tenant that has this patient", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "p1", org_id: ORG_A },
        { id: "p1-dup", org_id: ORG_A },
      ],
    });
    expect(await resolveOrgIdByPatientPhone("+12155550000")).toBe(ORG_A);
    // A single owning tenant needs no conversation tie-break.
    expect(supabaseMock.callCount("conversations", "select")).toBe(0);
  });

  it("returns null when no tenant has the patient (caller drops to seed org)", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    expect(await resolveOrgIdByPatientPhone("+12155559999")).toBeNull();
  });

  it("refuses to guess when the phone is in two tenants", async () => {
    // This used to tie-break on the most recent `conversations.
    // last_message_at`. That is a coin flip dressed up as a heuristic:
    // recency of contact is not evidence of ownership, so whichever
    // tenant happened to message the number last would receive this
    // patient's inbound reply, their thread, and any PHI in it.
    //
    // Failing closed loses a message the tenant recovers by provisioning
    // their own DID — a cost measured in configuration, not disclosure.
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "pa", org_id: ORG_A },
        { id: "pb", org_id: ORG_B },
      ],
    });
    expect(await resolveOrgIdByPatientPhone("+12155557654")).toBeNull();
  });

  it("does not reach for conversations to break a tie", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "pa", org_id: ORG_A },
        { id: "pb", org_id: ORG_B },
      ],
    });
    await resolveOrgIdByPatientPhone("+12155557654");
    expect(supabaseMock.callCount("conversations", "select")).toBe(0);
  });

  it("fails soft to null on a lookup error", async () => {
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: { message: "boom" },
    });
    expect(await resolveOrgIdByPatientPhone("+12155550001")).toBeNull();
  });

  it("caches within the TTL (no second query for the same number)", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p1", org_id: ORG_A }],
    });
    await resolveOrgIdByPatientPhone("+12155551122");
    await resolveOrgIdByPatientPhone("+12155551122");
    expect(supabaseMock.callCount("patients", "select")).toBe(1);
  });
});

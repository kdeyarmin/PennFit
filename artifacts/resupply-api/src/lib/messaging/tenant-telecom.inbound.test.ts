// Inbound tenant attribution: the two ways an event could reach the wrong
// practice.
//
// Both are silent failures. Nothing throws, nothing logs an error, and the
// only symptom is one tenant seeing another tenant's patient — which is a
// disclosure, not a bug report.

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  invalidateTenantTelecomCache,
  resolveOrgIdByCalledNumber,
  resolveOrgIdByPatientPhone,
} from "./tenant-telecom";

const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const DID = "+14155550123";

beforeEach(() => {
  supabaseMock.reset();
  // The resolver caches per (kind, number) for 60s; without this a test
  // would read the previous test's answer.
  invalidateTenantTelecomCache();
});

describe("resolveOrgIdByCalledNumber — channel ownership", () => {
  it("asks for the VOICE owner of a number an inbound call arrived on", async () => {
    // The collision this exists to prevent: tenant A registered the DID as
    // its SMS number, tenant B as its voice number. The two partial unique
    // indexes are per column, so nothing at the database level stops that.
    // A kind-blind lookup probed the SMS column first and handed an
    // inbound CALL to tenant A — silently, and with every downstream read
    // scoped to the wrong practice.
    stageSupabaseResponse("organizations", "select", {
      data: { id: ORG_B },
      error: null,
    });

    await expect(resolveOrgIdByCalledNumber(DID, "voice")).resolves.toBe(ORG_B);
    // Exactly one probe: the voice column. Not "SMS first, then voice".
    expect(supabaseMock.callCount("organizations", "select")).toBe(1);
  });

  it("asks for the SMS owner of a number an inbound text arrived on", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: { id: ORG_A },
      error: null,
    });

    await expect(resolveOrgIdByCalledNumber(DID, "sms")).resolves.toBe(ORG_A);
    expect(supabaseMock.callCount("organizations", "select")).toBe(1);
  });

  it("does not serve a voice answer from the SMS cache entry", async () => {
    // A kind-blind cache key would let whichever channel resolved first
    // answer for the other — reintroducing the collision through the
    // cache even with a channel-aware query.
    stageSupabaseResponse("organizations", "select", {
      data: { id: ORG_A },
      error: null,
    });
    stageSupabaseResponse("organizations", "select", {
      data: { id: ORG_B },
      error: null,
    });

    await expect(resolveOrgIdByCalledNumber(DID, "sms")).resolves.toBe(ORG_A);
    await expect(resolveOrgIdByCalledNumber(DID, "voice")).resolves.toBe(ORG_B);
  });

  it("returns null for an unowned number instead of guessing", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: null,
      error: null,
    });

    await expect(resolveOrgIdByCalledNumber(DID, "voice")).resolves.toBeNull();
  });

  it("rejects a non-E.164 value before it reaches the directory query", async () => {
    // The inbound webhook schema validates `To` only as min(1). An
    // un-normalizable value must never be bound into a filter against the
    // GLOBAL organizations directory.
    for (const bad of ["", "not-a-number", "+", "555.1212,x"]) {
      await expect(resolveOrgIdByCalledNumber(bad, "sms")).resolves.toBeNull();
    }
    expect(supabaseMock.callCount("organizations", "select")).toBe(0);
  });
});

describe("resolveOrgIdByPatientPhone — shared-number disambiguation", () => {
  it("routes to the single tenant that owns the patient", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: "p1", org_id: ORG_A }],
      error: null,
    });

    await expect(resolveOrgIdByPatientPhone("+14155559999")).resolves.toBe(
      ORG_A,
    );
  });

  it("refuses to guess when the phone exists in two tenants", async () => {
    // This used to tie-break on the most recent conversation activity,
    // which is a coin flip dressed up as a heuristic: recency of contact
    // is not evidence of ownership. Whichever tenant happened to message
    // the number last received this patient's inbound reply and whatever
    // PHI was in it.
    stageSupabaseResponse("patients", "select", {
      data: [
        { id: "p1", org_id: ORG_A },
        { id: "p2", org_id: ORG_B },
      ],
      error: null,
    });

    await expect(
      resolveOrgIdByPatientPhone("+14155559999"),
    ).resolves.toBeNull();
    // And it does NOT reach for conversations to break the tie.
    expect(supabaseMock.callCount("conversations", "select")).toBe(0);
  });

  it("returns null when no tenant owns the number", async () => {
    stageSupabaseResponse("patients", "select", { data: [], error: null });

    await expect(
      resolveOrgIdByPatientPhone("+14155559999"),
    ).resolves.toBeNull();
  });

  it("fails soft to null on a lookup error", async () => {
    // A DB blip must not route to the wrong tenant; the caller's own
    // fail-closed path takes over.
    stageSupabaseResponse("patients", "select", {
      data: null,
      error: { code: "57014", message: "canceling statement" },
    });

    await expect(
      resolveOrgIdByPatientPhone("+14155559999"),
    ).resolves.toBeNull();
  });
});

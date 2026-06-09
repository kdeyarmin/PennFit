// Unit tests for aggregatePacketsNeedingSignature — the read side of
// the hand-delivery signature batch. Verifies the status filter, the
// provider-vs-practice scoping, row projection, and label derivation.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseFilterCalls,
} from "../test-helpers/supabase-mock";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  SIGNATURE_PENDING_STATUSES,
  aggregatePacketsNeedingSignature,
} from "./prescription-signature-aggregation";

const supabaseMock = installSupabaseMock();

beforeEach(() => {
  supabaseMock.reset();
});

function stagePackets(rows: unknown[]): void {
  stageSupabaseResponse("prescription_request_packets", "select", {
    data: rows,
  });
}

const ROW_A = {
  id: "pkt_a",
  patient_id: "pat_a",
  provider_id: "prv_1",
  status: "draft",
  return_fax_e164: "+12155551212",
  sent_at: null,
  created_at: "2026-05-01T00:00:00.000Z",
  patients: { legal_first_name: "Anna", legal_last_name: "Smith" },
  providers: {
    id: "prv_1",
    legal_name: "Jane Doe",
    npi: "1234567890",
    practice_name: "Sleep Wellness Clinic",
  },
};

const ROW_B = {
  id: "pkt_b",
  patient_id: "pat_b",
  provider_id: "prv_1",
  status: "failed",
  return_fax_e164: null,
  sent_at: "2026-05-02T00:00:00.000Z",
  created_at: "2026-05-02T00:00:00.000Z",
  patients: { legal_first_name: "Bob", legal_last_name: "Jones" },
  providers: {
    id: "prv_1",
    legal_name: "Jane Doe",
    npi: "1234567890",
    practice_name: "Sleep Wellness Clinic",
  },
};

describe("aggregatePacketsNeedingSignature", () => {
  it("scopes by provider id and filters to pending statuses", async () => {
    stagePackets([ROW_A, ROW_B]);
    const result = await aggregatePacketsNeedingSignature(
      getSupabaseServiceRoleClient(),
      { kind: "provider", providerId: "prv_1" },
    );

    expect(result.count).toBe(2);
    expect(result.packets.map((p) => p.id)).toEqual(["pkt_a", "pkt_b"]);
    expect(result.packets[0]).toMatchObject({
      patientName: "Smith, Anna",
      providerNpi: "1234567890",
      practiceName: "Sleep Wellness Clinic",
      status: "draft",
    });
    // Label is provider name + practice for a provider-scoped batch.
    expect(result.label).toBe("Jane Doe (Sleep Wellness Clinic)");

    const filters = getSupabaseFilterCalls(
      "prescription_request_packets",
      "select",
    );
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["provider_id", "prv_1"],
    });
    const inFilter = filters.find((f) => f.verb === "in");
    expect(inFilter?.args[0]).toBe("status");
    expect(inFilter?.args[1]).toEqual([...SIGNATURE_PENDING_STATUSES]);
  });

  it("scopes by practice name via the embedded provider filter", async () => {
    stagePackets([ROW_A]);
    const result = await aggregatePacketsNeedingSignature(
      getSupabaseServiceRoleClient(),
      { kind: "practice", practiceName: "Sleep Wellness Clinic" },
    );

    expect(result.count).toBe(1);
    // Practice-scoped batch labels with the practice name.
    expect(result.label).toBe("Sleep Wellness Clinic");

    const filters = getSupabaseFilterCalls(
      "prescription_request_packets",
      "select",
    );
    expect(filters).toContainEqual({
      verb: "eq",
      args: ["providers.practice_name", "Sleep Wellness Clinic"],
    });
  });

  it("returns an empty batch (label falls back to the id) when nothing is pending", async () => {
    stagePackets([]);
    const result = await aggregatePacketsNeedingSignature(
      getSupabaseServiceRoleClient(),
      { kind: "provider", providerId: "prv_missing" },
    );
    expect(result.count).toBe(0);
    expect(result.packets).toEqual([]);
    expect(result.label).toBe("prv_missing");
  });

  it("tolerates missing patient/provider names", async () => {
    stagePackets([
      {
        ...ROW_A,
        patients: { legal_first_name: null, legal_last_name: null },
        providers: null,
      },
    ]);
    const result = await aggregatePacketsNeedingSignature(
      getSupabaseServiceRoleClient(),
      { kind: "provider", providerId: "prv_1" },
    );
    expect(result.packets[0]).toMatchObject({
      patientName: "—",
      providerName: null,
      practiceName: null,
    });
  });

  it("throws when the query errors", async () => {
    stageSupabaseResponse("prescription_request_packets", "select", {
      error: { message: "boom" },
    });
    await expect(
      aggregatePacketsNeedingSignature(getSupabaseServiceRoleClient(), {
        kind: "provider",
        providerId: "prv_1",
      }),
    ).rejects.toBeDefined();
  });
});

// Unit tests for prescription-request-builder.ts. Mocks the
// Supabase client at the seam so we exercise the projection logic
// without a live database. Same pattern other helper tests in this
// package follow.

import { describe, expect, it, vi } from "vitest";

// Build a chainable thenable that mimics PostgREST's builder shape.
// Each .from(...).select(...).eq(...) etc. returns the same object
// so we can stub the terminal maybeSingle / limit by overriding
// when the test wants a specific row back.
function makeQuery(result: { data: unknown; error?: unknown }) {
  const q: Record<string, (..._args: unknown[]) => unknown> = {};
  for (const m of ["select", "eq", "order", "limit", "in", "gte", "lte"]) {
    q[m] = () => q;
  }
  q.maybeSingle = () => Promise.resolve(result);
  return q;
}

interface SeedTables {
  prescriptions?: { data: unknown; error?: unknown };
  sleep_studies?: { data: unknown; error?: unknown };
  providers?: { data: unknown; error?: unknown };
}

function mockSupabase(seed: SeedTables) {
  return {
    schema: () => ({
      from: (table: string) => {
        if (table === "prescriptions") {
          return makeQuery(
            seed.prescriptions ?? { data: null },
          ) as unknown as ReturnType<typeof makeQuery>;
        }
        if (table === "sleep_studies") {
          return makeQuery(
            seed.sleep_studies ?? { data: null },
          ) as unknown as ReturnType<typeof makeQuery>;
        }
        if (table === "providers") {
          return makeQuery(
            seed.providers ?? { data: null },
          ) as unknown as ReturnType<typeof makeQuery>;
        }
        return makeQuery({ data: null });
      },
    }),
  };
}

vi.mock("@workspace/resupply-db", () => ({
  getSupabaseServiceRoleClient: () =>
    (globalThis as Record<string, unknown>).__supabaseStub__,
}));

import { buildPrescriptionRequestPacketFromRx } from "./prescription-request-builder";

function setStub(seed: SeedTables) {
  (globalThis as Record<string, unknown>).__supabaseStub__ = mockSupabase(seed);
}

describe("buildPrescriptionRequestPacketFromRx", () => {
  it("returns rx_not_found when the prescription doesn't resolve", async () => {
    setStub({ prescriptions: { data: null } });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "11111111-1111-1111-1111-111111111111",
      prescriptionId: "22222222-2222-2222-2222-222222222222",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("rx_not_found");
  });

  it("returns rx_missing_provider when prescription has no provider_id", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: null,
          hcpcs_code: "E0601",
          item_sku: "device",
          cadence_days: 0,
          valid_until: "2026-08-01",
        },
      },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("rx_missing_provider");
  });

  it("returns rx_missing_hcpcs when prescription has no hcpcs_code", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: null,
          item_sku: "device",
          cadence_days: 0,
          valid_until: "2026-08-01",
        },
      },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("rx_missing_hcpcs");
  });

  it("builds a packet with G47.33 default when no sleep study exists", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: "E0601",
          item_sku: "CPAP device",
          cadence_days: 0,
          valid_until: "2026-08-01",
        },
      },
      sleep_studies: { data: null },
      providers: { data: { id: "prov-1", fax_e164: "+18005550100" } },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.insert.patient_id).toBe("p-1");
    expect(result.insert.provider_id).toBe("prov-1");
    expect(result.insert.source_prescription_id).toBe("rx-1");
    expect(result.insert.icd10_codes_json).toEqual(["G47.33"]);
    expect(result.insert.return_fax_e164).toBe("+18005550100");
    expect(result.insert.status).toBe("draft");
    expect(result.insert.created_by_email).toBe("csr@example.com");
    expect(result.insert.length_of_need_months).toBe(99);
  });

  it("uses the latest sleep_studies.diagnosis_icd10 when present and valid", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: "E0601",
          item_sku: "CPAP device",
          cadence_days: 90,
          valid_until: "2026-08-01",
        },
      },
      sleep_studies: { data: { diagnosis_icd10: "g47.30" } },
      providers: { data: { id: "prov-1", fax_e164: null } },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.insert.icd10_codes_json).toEqual(["G47.30"]);
    // cadence_days > 0 → propagates to the equipment line
    const lines = result.insert.hcpcs_items_json as Array<{
      hcpcs: string;
      cadenceDays: number | null;
    }>;
    expect(lines[0]?.cadenceDays).toBe(90);
  });

  it("falls back to G47.33 when sleep study has malformed icd10", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: "E0601",
          item_sku: "CPAP device",
          cadence_days: 0,
          valid_until: "2026-08-01",
        },
      },
      sleep_studies: { data: { diagnosis_icd10: "not-an-icd" } },
      providers: { data: { id: "prov-1", fax_e164: null } },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.insert.icd10_codes_json).toEqual(["G47.33"]);
  });

  it("sets cadenceDays to null when cadence_days is 0", async () => {
    setStub({
      prescriptions: {
        data: {
          id: "rx-1",
          patient_id: "p-1",
          provider_id: "prov-1",
          hcpcs_code: "E0601",
          item_sku: "device",
          cadence_days: 0,
          valid_until: null,
        },
      },
      sleep_studies: { data: null },
      providers: { data: { id: "prov-1", fax_e164: null } },
    });
    const result = await buildPrescriptionRequestPacketFromRx({
      patientId: "p-1",
      prescriptionId: "rx-1",
      createdByEmail: "csr@example.com",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const lines = result.insert.hcpcs_items_json as Array<{
      cadenceDays: number | null;
    }>;
    expect(lines[0]?.cadenceDays).toBeNull();
  });
});

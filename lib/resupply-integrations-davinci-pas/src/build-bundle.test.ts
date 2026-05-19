import { describe, expect, it } from "vitest";

import { buildPasBundle, type BuildBundleInput } from "./build-bundle";

const FIXED_TS = new Date("2026-05-19T14:37:00Z");

function fixture(overrides: Partial<BuildBundleInput> = {}): BuildBundleInput {
  return {
    claimIdentifier: "pa-claim-1",
    preparedAt: FIXED_TS,
    providerOrganization: {
      npi: "1234567893",
      name: "PENNPAPS INC",
      address: {
        line1: "100 Main St",
        city: "State College",
        state: "PA",
        zip: "16801",
      },
    },
    requesterPractitioner: {
      npi: "1700987654",
      firstName: "ROBIN",
      lastName: "ASHTON",
    },
    patient: {
      id: "patient-123",
      firstName: "JANE",
      lastName: "DOE",
      dateOfBirth: "1965-04-12",
      gender: "female",
      address: {
        line1: "200 Elm St",
        city: "Altoona",
        state: "PA",
        zip: "16601",
      },
    },
    coverage: {
      id: "coverage-1",
      payerName: "Highmark BCBS",
      payerPasIdentifier: "54771",
      memberId: "M123456789",
      groupNumber: "GRP-42",
    },
    serviceRequest: {
      hcpcsCode: "E0601",
      quantity: 1,
      dateOfService: "2026-05-26",
      diagnosisIcd10: "G47.33",
    },
    ...overrides,
  };
}

describe("buildPasBundle", () => {
  it("emits a Bundle of type collection with 5 entries", () => {
    const { bundle } = buildPasBundle(fixture());
    expect(bundle.type).toBe("collection");
    expect(bundle.entry).toHaveLength(5);
    const types = bundle.entry.map((e) => e.resource.resourceType);
    expect(types).toEqual([
      "Claim",
      "Patient",
      "Organization",
      "Practitioner",
      "Coverage",
    ]);
  });

  it("stamps the Bundle timestamp + id from inputs", () => {
    const { bundle, bundleId } = buildPasBundle(fixture());
    expect(bundle.timestamp).toBe(FIXED_TS.toISOString());
    expect(bundleId).toBe("pf-pas-pa-claim-1");
    expect(bundle.id).toBe(bundleId);
  });

  it("Claim resource carries use=preauthorization + Da Vinci profile", () => {
    const { bundle } = buildPasBundle(fixture());
    const claim = bundle.entry[0]!.resource as Record<string, unknown>;
    expect(claim.use).toBe("preauthorization");
    expect(
      (claim.meta as { profile?: string[] }).profile,
    ).toContain(
      "http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim",
    );
  });

  it("Claim.item carries HCPCS + ICD-10 pointer", () => {
    const { bundle } = buildPasBundle(fixture());
    const claim = bundle.entry[0]!.resource as Record<string, unknown>;
    const items = claim.item as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    const coding = (
      (items[0]!.productOrService as Record<string, unknown>).coding as Array<
        Record<string, unknown>
      >
    )[0]!;
    expect(coding.code).toBe("E0601");
    expect(coding.system).toContain("HCPCS");
    expect(items[0]!.diagnosisSequence).toEqual([1]);
  });

  it("Patient resource uses FHIR R4 gender + ISO birthDate", () => {
    const { bundle } = buildPasBundle(fixture());
    const patient = bundle.entry[1]!.resource as Record<string, unknown>;
    expect(patient.gender).toBe("female");
    expect(patient.birthDate).toBe("1965-04-12");
    const name = (patient.name as Array<Record<string, unknown>>)[0]!;
    expect(name.family).toBe("DOE");
    expect((name.given as string[])[0]).toBe("JANE");
  });

  it("Coverage.payor carries the payerPasIdentifier", () => {
    const { bundle } = buildPasBundle(fixture());
    const coverage = bundle.entry[4]!.resource as Record<string, unknown>;
    const payor = (coverage.payor as Array<Record<string, unknown>>)[0]!;
    const ident = payor.identifier as Record<string, unknown>;
    expect(ident.value).toBe("54771");
  });

  it("rejects malformed inputs (bad NPI shape)", () => {
    const input = fixture();
    input.providerOrganization.npi = "not-an-npi";
    expect(() => buildPasBundle(input)).toThrow();
  });

  it("rejects malformed inputs (bad HCPCS shape)", () => {
    const input = fixture();
    input.serviceRequest.hcpcsCode = "wrong";
    expect(() => buildPasBundle(input)).toThrow();
  });

  it("Claim.diagnosis is empty array when no ICD-10 supplied", () => {
    const input = fixture();
    input.serviceRequest.diagnosisIcd10 = null;
    const { bundle } = buildPasBundle(input);
    const claim = bundle.entry[0]!.resource as Record<string, unknown>;
    expect(claim.diagnosis).toEqual([]);
  });
});

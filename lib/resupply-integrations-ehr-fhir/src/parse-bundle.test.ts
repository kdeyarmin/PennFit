import { describe, expect, it } from "vitest";

import { parseFhirBundle } from "./parse-bundle";

function bundle(entries: Array<{ resource: Record<string, unknown> }>) {
  return { resourceType: "Bundle", entry: entries };
}

const MINIMAL = bundle([
  {
    resource: {
      resourceType: "ServiceRequest",
      id: "SR-001",
      status: "active",
      intent: "order",
      authoredOn: "2026-05-22T10:00:00Z",
      subject: { reference: "Patient/PT-001" },
      code: {
        coding: [
          {
            system: "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
            code: "E0601",
            display: "CPAP device",
          },
        ],
      },
    },
  },
  {
    resource: {
      resourceType: "Patient",
      id: "PT-001",
      name: [{ family: "Smith", given: ["Jane"] }],
      birthDate: "1970-01-15",
    },
  },
]);

describe("parseFhirBundle", () => {
  it("accepts a minimal Bundle with ServiceRequest + Patient", () => {
    const result = parseFhirBundle(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.sourceOrderId).toBe("SR-001");
    expect(result.order.patient.firstName).toBe("Jane");
    expect(result.order.patient.lastName).toBe("Smith");
    expect(result.order.patient.dob).toBe("1970-01-15");
    expect(result.order.hcpcsLines).toHaveLength(1);
    expect(result.order.hcpcsLines[0]?.code).toBe("E0601");
  });

  it("rejects a non-Bundle root", () => {
    expect(parseFhirBundle({ resourceType: "Patient" }).ok).toBe(false);
  });

  it("rejects a Bundle missing ServiceRequest", () => {
    const result = parseFhirBundle(bundle([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_service_request");
  });

  it("rejects a Bundle missing Patient", () => {
    const result = parseFhirBundle(
      bundle([
        {
          resource: {
            resourceType: "ServiceRequest",
            id: "SR-001",
            subject: { reference: "Patient/PT-001" },
          },
        },
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_subject_patient");
  });

  it("extracts NPI from Practitioner identifier", () => {
    const result = parseFhirBundle(
      bundle([
        ...MINIMAL.entry,
        {
          resource: {
            resourceType: "Practitioner",
            id: "PR-001",
            identifier: [
              { system: "http://hl7.org/fhir/sid/us-npi", value: "1234567890" },
            ],
            name: [{ family: "Brown", given: ["Alice"] }],
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.provider.npi).toBe("1234567890");
  });

  it("extracts ICD-10 from Condition.code", () => {
    const result = parseFhirBundle(
      bundle([
        ...MINIMAL.entry,
        {
          resource: {
            resourceType: "Condition",
            code: {
              coding: [
                {
                  system: "http://hl7.org/fhir/sid/icd-10-cm",
                  code: "G47.33",
                },
              ],
            },
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.icd10Codes).toEqual(["G47.33"]);
  });

  it("extracts payer name + member id from Coverage", () => {
    const result = parseFhirBundle(
      bundle([
        ...MINIMAL.entry,
        {
          resource: {
            resourceType: "Coverage",
            subscriberId: "MBR-12345",
            payor: [{ display: "Highmark BCBS" }],
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.payerName).toBe("Highmark BCBS");
    expect(result.order.memberId).toBe("MBR-12345");
  });

  it("classifies DocumentReference kinds via display text", () => {
    const result = parseFhirBundle(
      bundle([
        ...MINIMAL.entry,
        {
          resource: {
            resourceType: "DocumentReference",
            id: "DOC-1",
            type: { text: "Sleep study report" },
            content: [
              {
                attachment: {
                  url: "https://example.com/sleep.pdf",
                  contentType: "application/pdf",
                  title: "sleep.pdf",
                },
              },
            ],
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.documents).toHaveLength(1);
    expect(result.order.documents[0]?.kind).toBe("sleep_study");
    expect(result.order.documents[0]?.sourceUrl).toBe(
      "https://example.com/sleep.pdf",
    );
  });

  it("normalises US phone to E.164", () => {
    const result = parseFhirBundle(
      bundle([
        {
          resource: {
            resourceType: "ServiceRequest",
            id: "SR-001",
            subject: { reference: "Patient/PT-001" },
          },
        },
        {
          resource: {
            resourceType: "Patient",
            id: "PT-001",
            telecom: [{ system: "phone", value: "(215) 555-0100" }],
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.patient.phoneE164).toBe("+12155550100");
  });

  it("dedupes ICD-10 codes pulled from both Condition and reasonCode", () => {
    const result = parseFhirBundle(
      bundle([
        {
          resource: {
            resourceType: "ServiceRequest",
            id: "SR-001",
            subject: { reference: "Patient/PT-001" },
            reasonCode: [
              {
                coding: [
                  {
                    system: "http://hl7.org/fhir/sid/icd-10-cm",
                    code: "G47.33",
                  },
                ],
              },
            ],
          },
        },
        {
          resource: { resourceType: "Patient", id: "PT-001" },
        },
        {
          resource: {
            resourceType: "Condition",
            code: {
              coding: [
                { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "g47.33" },
              ],
            },
          },
        },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.icd10Codes).toEqual(["G47.33"]);
  });
});

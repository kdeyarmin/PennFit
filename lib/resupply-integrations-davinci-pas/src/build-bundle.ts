// Da Vinci PAS — FHIR Claim Bundle builder.
//
// CMS-0057-F + the Da Vinci PAS Implementation Guide v2.2 specify
// a `collection` Bundle carrying a Claim resource plus supporting
// resources (Patient, Coverage, Practitioner, Organization,
// ServiceRequest). The payer's PAS endpoint accepts the Bundle and
// returns a ClaimResponse with the PA decision.
//
// This module produces just the Bundle. The HTTP POST + ClaimResponse
// parsing live in client.ts; the API route wires the two together
// + persists the decision onto resupply.prior_authorizations.
//
// PHI posture
// -----------
// The Bundle carries patient identifying information by FHIR design.
// We never log the Bundle body; the route stamps a parse summary
// (request_bundle_json) so the admin UI can show it on a per-PA
// detail screen with the existing RLS posture.

import { z } from "zod";

// ── Input shape ──────────────────────────────────────────────────────

export interface BuildBundleInput {
  /** Stable identifier the payer echoes back on the ClaimResponse.
   *  Conventionally `<priorAuthId>-<attempt>`. */
  claimIdentifier: string;
  /** When the request was prepared (drives Bundle.timestamp). */
  preparedAt: Date;
  /** Type 2 NPI for our DME. */
  providerOrganization: {
    npi: string;
    name: string;
    address: {
      line1: string;
      city: string;
      state: string;
      zip: string;
    };
  };
  /** The prescribing physician (NPI required by Medicare DME). */
  requesterPractitioner: {
    npi: string;
    firstName: string;
    lastName: string;
  };
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string; // YYYY-MM-DD
    gender: "male" | "female" | "other" | "unknown";
    address: {
      line1: string;
      city: string;
      state: string;
      zip: string;
    };
  };
  coverage: {
    id: string;
    payerName: string;
    payerPasIdentifier: string;
    memberId: string;
    groupNumber?: string | null;
  };
  /** Service the PA is for. */
  serviceRequest: {
    hcpcsCode: string;
    quantity: number;
    /** YYYY-MM-DD. */
    dateOfService: string;
    diagnosisIcd10?: string | null;
  };
}

// ── Output ───────────────────────────────────────────────────────────

export interface BuiltBundle {
  bundle: FhirBundle;
  bundleId: string;
  claimIdentifier: string;
}

export interface FhirBundle {
  resourceType: "Bundle";
  id: string;
  type: "collection";
  timestamp: string;
  entry: BundleEntry[];
}

export interface BundleEntry {
  fullUrl: string;
  resource: Record<string, unknown>;
}

export const buildBundleInputSchema = z.object({
  claimIdentifier: z.string().min(1).max(120),
  preparedAt: z.date(),
  providerOrganization: z.object({
    npi: z.string().regex(/^\d{10}$/),
    name: z.string().min(1).max(200),
    address: z.object({
      line1: z.string().min(1).max(120),
      city: z.string().min(1).max(80),
      state: z.string().regex(/^[A-Z]{2}$/),
      zip: z.string().regex(/^\d{5}(-?\d{4})?$/),
    }),
  }),
  requesterPractitioner: z.object({
    npi: z.string().regex(/^\d{10}$/),
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
  }),
  patient: z.object({
    id: z.string().min(1),
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    gender: z.enum(["male", "female", "other", "unknown"]),
    address: z.object({
      line1: z.string().min(1).max(120),
      city: z.string().min(1).max(80),
      state: z.string().regex(/^[A-Z]{2}$/),
      zip: z.string().regex(/^\d{5}(-?\d{4})?$/),
    }),
  }),
  coverage: z.object({
    id: z.string().min(1),
    payerName: z.string().min(1).max(200),
    payerPasIdentifier: z.string().min(1).max(80),
    memberId: z.string().min(1).max(64),
    groupNumber: z.string().max(64).nullable().optional(),
  }),
  serviceRequest: z.object({
    hcpcsCode: z.string().regex(/^[A-Z]\d{4}$/),
    quantity: z.number().int().min(1).max(9999),
    dateOfService: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    diagnosisIcd10: z.string().max(12).nullable().optional(),
  }),
});

export function buildPasBundle(input: BuildBundleInput): BuiltBundle {
  // Validate up-front so the rest of the function can trust its
  // input shape.
  buildBundleInputSchema.parse(input);

  const bundleId = `pf-pas-${input.claimIdentifier}`;
  const patientFullUrl = `Patient/${input.patient.id}`;
  const orgFullUrl = `Organization/dme-${input.providerOrganization.npi}`;
  const practitionerFullUrl = `Practitioner/rx-${input.requesterPractitioner.npi}`;
  const coverageFullUrl = `Coverage/${input.coverage.id}`;
  const claimFullUrl = `Claim/${input.claimIdentifier}`;

  const entries: BundleEntry[] = [
    {
      fullUrl: claimFullUrl,
      resource: buildClaim(input, {
        patientFullUrl,
        orgFullUrl,
        practitionerFullUrl,
        coverageFullUrl,
      }),
    },
    {
      fullUrl: patientFullUrl,
      resource: buildPatient(input.patient),
    },
    {
      fullUrl: orgFullUrl,
      resource: buildOrganization(input.providerOrganization),
    },
    {
      fullUrl: practitionerFullUrl,
      resource: buildPractitioner(input.requesterPractitioner),
    },
    {
      fullUrl: coverageFullUrl,
      resource: buildCoverage(input.coverage, patientFullUrl),
    },
  ];

  const bundle: FhirBundle = {
    resourceType: "Bundle",
    id: bundleId,
    type: "collection",
    timestamp: input.preparedAt.toISOString(),
    entry: entries,
  };
  return {
    bundle,
    bundleId,
    claimIdentifier: input.claimIdentifier,
  };
}

// ── Resource builders ───────────────────────────────────────────────

function buildClaim(
  input: BuildBundleInput,
  refs: {
    patientFullUrl: string;
    orgFullUrl: string;
    practitionerFullUrl: string;
    coverageFullUrl: string;
  },
): Record<string, unknown> {
  return {
    resourceType: "Claim",
    id: input.claimIdentifier,
    meta: {
      profile: [
        "http://hl7.org/fhir/us/davinci-pas/StructureDefinition/profile-claim",
      ],
    },
    identifier: [
      {
        system: "https://pennpaps.com/davinci-pas/claim-id",
        value: input.claimIdentifier,
      },
    ],
    status: "active",
    type: {
      coding: [
        {
          system: "http://terminology.hl7.org/CodeSystem/claim-type",
          code: "professional",
        },
      ],
    },
    use: "preauthorization",
    patient: { reference: refs.patientFullUrl },
    created: input.preparedAt.toISOString(),
    insurer: { display: input.coverage.payerName },
    provider: { reference: refs.orgFullUrl },
    priority: { coding: [{ code: "normal" }] },
    careTeam: [
      {
        sequence: 1,
        provider: { reference: refs.practitionerFullUrl },
        role: { coding: [{ code: "primary" }] },
      },
    ],
    diagnosis: input.serviceRequest.diagnosisIcd10
      ? [
          {
            sequence: 1,
            diagnosisCodeableConcept: {
              coding: [
                {
                  system: "http://hl7.org/fhir/sid/icd-10-cm",
                  code: input.serviceRequest.diagnosisIcd10,
                },
              ],
            },
          },
        ]
      : [],
    insurance: [
      {
        sequence: 1,
        focal: true,
        coverage: { reference: refs.coverageFullUrl },
      },
    ],
    item: [
      {
        sequence: 1,
        productOrService: {
          coding: [
            {
              system:
                "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
              code: input.serviceRequest.hcpcsCode,
            },
          ],
        },
        servicedDate: input.serviceRequest.dateOfService,
        quantity: { value: input.serviceRequest.quantity },
        diagnosisSequence: input.serviceRequest.diagnosisIcd10 ? [1] : [],
      },
    ],
  };
}

function buildPatient(p: BuildBundleInput["patient"]): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id: p.id,
    name: [{ family: p.lastName, given: [p.firstName] }],
    gender: p.gender,
    birthDate: p.dateOfBirth,
    address: [
      {
        use: "home",
        line: [p.address.line1],
        city: p.address.city,
        state: p.address.state,
        postalCode: p.address.zip,
        country: "US",
      },
    ],
  };
}

function buildOrganization(
  o: BuildBundleInput["providerOrganization"],
): Record<string, unknown> {
  return {
    resourceType: "Organization",
    id: `dme-${o.npi}`,
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: o.npi },
    ],
    active: true,
    name: o.name,
    address: [
      {
        line: [o.address.line1],
        city: o.address.city,
        state: o.address.state,
        postalCode: o.address.zip,
        country: "US",
      },
    ],
  };
}

function buildPractitioner(
  p: BuildBundleInput["requesterPractitioner"],
): Record<string, unknown> {
  return {
    resourceType: "Practitioner",
    id: `rx-${p.npi}`,
    identifier: [
      { system: "http://hl7.org/fhir/sid/us-npi", value: p.npi },
    ],
    active: true,
    name: [{ family: p.lastName, given: [p.firstName] }],
  };
}

function buildCoverage(
  c: BuildBundleInput["coverage"],
  patientRef: string,
): Record<string, unknown> {
  return {
    resourceType: "Coverage",
    id: c.id,
    status: "active",
    subscriberId: c.memberId,
    beneficiary: { reference: patientRef },
    payor: [
      {
        identifier: {
          system: "https://pennpaps.com/davinci-pas/payer-id",
          value: c.payerPasIdentifier,
        },
        display: c.payerName,
      },
    ],
    class: c.groupNumber
      ? [{ type: { coding: [{ code: "group" }] }, value: c.groupNumber }]
      : undefined,
  };
}

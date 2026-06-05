// FHIR R4 read-only patient surface.
//
// Why: 21st Century Cures Act + USCDI v4 require certified Health-IT
// modules to expose patient data via FHIR R4. DMEs aren't direct
// "actors" under information-blocking, but EHR-connected DMEs must
// accept FHIR payloads and not impede patient access. Shipping a
// minimal read-only Patient endpoint future-proofs the interop story
// + paves the way for SMART-on-FHIR launch from the patient portal.
//
// What's exposed today:
//   GET /fhir/r4/metadata           — CapabilityStatement (USCDI v4)
//   GET /fhir/r4/Patient/:id        — Patient resource (read)
//   GET /fhir/r4/Patient/:id/$everything — patient-scoped bundle:
//       Patient + Coverage[] + Condition[] (from sleep_studies) +
//       MedicationRequest[] (from prescriptions) + Device[] (from
//       equipment_assets). Limited scope; FHIR-compliant Bundle.
//
// What's NOT exposed yet:
//   - Write operations.
//   - Subscriptions / SMART-on-FHIR scopes.
//   - SUPPORTED resources beyond the above. (We add ServiceRequest,
//     CarePlan, Observation, DocumentReference in a follow-up when
//     a patient-facing portal needs them.)
//
// Auth: read-only paths gated by `requireFhirAccess` — either an
// admin session OR a future SMART-on-FHIR access token. For now we
// accept the in-house admin session only; a token-based gate lands
// when the patient portal launches a SMART app.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FHIR_VERSION = "4.0.1";
const SOFTWARE_NAME = "PennFit DME Platform";

router.get("/fhir/r4/metadata", (_req, res) => {
  // Public; the CapabilityStatement itself is not PHI.
  res
    .status(200)
    .type("application/fhir+json")
    .json({
      resourceType: "CapabilityStatement",
      status: "active",
      date: new Date().toISOString(),
      publisher: SOFTWARE_NAME,
      kind: "instance",
      software: { name: SOFTWARE_NAME, version: "0.1" },
      fhirVersion: FHIR_VERSION,
      format: ["application/fhir+json"],
      rest: [
        {
          mode: "server",
          security: { service: [{ text: "OAuth2 (planned)" }] },
          resource: [
            {
              type: "Patient",
              interaction: [{ code: "read" }],
              operation: [
                { name: "everything", definition: "Patient-$everything" },
              ],
            },
            { type: "Coverage", interaction: [{ code: "read" }] },
            { type: "Condition", interaction: [{ code: "read" }] },
            { type: "MedicationRequest", interaction: [{ code: "read" }] },
            { type: "Device", interaction: [{ code: "read" }] },
          ],
        },
      ],
    });
});

const idParam = z.object({ id: z.string().uuid() });

// Rate limit for the FHIR Patient read endpoints. Without it an admin
// (or a script using an admin's session) could enumerate patient ids
// one-at-a-time. 120/min is far above the console's normal pull cadence.
//
// Built from `express-rate-limit` (not our middlewares/rate-limit
// wrapper) so CodeQL's js/missing-rate-limiting query recognises it,
// Built from `express-rate-limit` (not our middlewares/rate-limit
// wrapper) so CodeQL's js/missing-rate-limiting query recognises it,
// and mounted BEFORE `requireAdmin` on the routes below — requireAdmin
// performs a DB session lookup, so a limiter placed after it leaves
// that read unprotected (and CodeQL flags the requireAdmin line).
// Keyed by whatever stable identifier is already available on the
// request (e.g. adminUserId if present), with an IP fallback.
const fhirAdminReadLimiter = expressRateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) =>
    (req as unknown as { adminUserId?: string }).adminUserId ??
    req.ip ??
    "unknown",
  message: {
    error: "too_many_requests",
    limiter: "fhir_admin_patient_read",
  },
});

router.get(
  "/fhir/r4/Patient/:id",
  fhirAdminReadLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).type("application/fhir+json").json(notFound("Patient"));
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address",
      )
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).type("application/fhir+json").json(notFound("Patient"));
      return;
    }
    res.status(200).type("application/fhir+json").json(patientToFhir(patient));
    // PHI-view audit. Mirrors the `patient.view` row that
    // `routes/patients/detail.ts` writes for the admin console read
    // path. The FHIR Patient endpoint returns the same PHI (legal name,
    // DOB, phone, email, address); without this audit an admin could
    // pull patient records via FHIR invisibly.
    try {
      await logAudit({
        action: "patient.view",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patients",
        targetId: patient.id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: { source: "fhir.patient.read" },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fhir: patient.view audit failed",
      );
    }
  },
);

router.get(
  "/fhir/r4/Patient/:id/$everything",
  fhirAdminReadLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).type("application/fhir+json").json(notFound("Patient"));
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, phone_e164, email, address",
      )
      .eq("id", parsed.data.id)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(404).type("application/fhir+json").json(notFound("Patient"));
      return;
    }
    const [
      { data: coverages },
      { data: studies },
      { data: rxs },
      { data: equipment },
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("insurance_coverages")
        .select(
          "id, rank, payer_name, plan_name, member_id, effective_date, termination_date, in_network",
        )
        .eq("patient_id", patient.id),
      supabase
        .schema("resupply")
        .from("sleep_studies")
        .select("id, study_date, diagnosis_icd10, ahi, study_type")
        .eq("patient_id", patient.id),
      supabase
        .schema("resupply")
        .from("prescriptions")
        .select(
          "id, hcpcs_code, item_sku, valid_from, valid_until, status, provider_id",
        )
        .eq("patient_id", patient.id),
      supabase
        .schema("resupply")
        .from("equipment_assets")
        .select(
          "id, device_class, serial_number, model, manufacturer, dispensed_at",
        )
        .eq("patient_id", patient.id),
    ]);

    const entries: Array<{
      fullUrl: string;
      resource: Record<string, unknown>;
    }> = [];
    entries.push({
      fullUrl: `Patient/${patient.id}`,
      resource: patientToFhir(patient),
    });
    for (const c of coverages ?? []) {
      entries.push({
        fullUrl: `Coverage/${c.id}`,
        resource: coverageToFhir(c, patient.id),
      });
    }
    for (const s of studies ?? []) {
      if (!s.diagnosis_icd10) continue;
      entries.push({
        fullUrl: `Condition/${s.id}`,
        resource: conditionToFhir(s, patient.id),
      });
    }
    for (const rx of rxs ?? []) {
      entries.push({
        fullUrl: `MedicationRequest/${rx.id}`,
        resource: medicationRequestToFhir(rx, patient.id),
      });
    }
    for (const e of equipment ?? []) {
      entries.push({
        fullUrl: `Device/${e.id}`,
        resource: deviceToFhir(e, patient.id),
      });
    }

    res.status(200).type("application/fhir+json").json({
      resourceType: "Bundle",
      type: "searchset",
      total: entries.length,
      entry: entries,
    });
    logger.info(
      {
        event: "fhir.patient.everything",
        patientId: patient.id,
        entryCount: entries.length,
      },
      "fhir: $everything",
    );
    // PHI-view audit. The $everything bundle is more revealing than
    // the bare Patient resource (it adds Coverage, Condition, Rx,
    // Device); recording it under the same `patient.view` action
    // keeps the audit-stream uniform with the admin console PHI read
    // path.
    try {
      await logAudit({
        action: "patient.view",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patients",
        targetId: patient.id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: {
          source: "fhir.patient.everything",
          entry_count: entries.length,
        },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fhir: patient.view audit failed",
      );
    }
  },
);

// ── Resource mappers ────────────────────────────────────────────────

function patientToFhir(p: {
  id: string;
  legal_first_name: string;
  legal_last_name: string;
  date_of_birth: string;
  phone_e164: string | null;
  email: string | null;
  address: unknown;
}): Record<string, unknown> {
  const addr =
    p.address && typeof p.address === "object"
      ? (p.address as {
          line1?: string;
          city?: string;
          state?: string;
          zip?: string;
        })
      : null;
  return {
    resourceType: "Patient",
    id: p.id,
    name: [{ family: p.legal_last_name, given: [p.legal_first_name] }],
    telecom: [
      p.phone_e164
        ? { system: "phone", value: p.phone_e164, use: "home" }
        : null,
      p.email ? { system: "email", value: p.email } : null,
    ].filter(Boolean),
    birthDate: p.date_of_birth,
    address: addr
      ? [
          {
            use: "home",
            line: [addr.line1].filter(Boolean),
            city: addr.city,
            state: addr.state,
            postalCode: addr.zip,
            country: "US",
          },
        ]
      : undefined,
  };
}

function coverageToFhir(
  c: {
    id: string;
    rank: string;
    payer_name: string;
    plan_name: string | null;
    member_id: string;
    effective_date: string | null;
    termination_date: string | null;
    in_network: boolean | null;
  },
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: "Coverage",
    id: c.id,
    status:
      c.termination_date &&
      c.termination_date < new Date().toISOString().slice(0, 10)
        ? "cancelled"
        : "active",
    subscriberId: c.member_id,
    beneficiary: { reference: `Patient/${patientId}` },
    period: {
      start: c.effective_date ?? undefined,
      end: c.termination_date ?? undefined,
    },
    payor: [{ display: c.payer_name }],
    order: c.rank === "primary" ? 1 : c.rank === "secondary" ? 2 : 3,
    class: c.plan_name
      ? [{ type: { text: "plan" }, value: c.plan_name }]
      : undefined,
  };
}

function conditionToFhir(
  s: {
    id: string;
    study_date: string;
    diagnosis_icd10: string | null;
  },
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: "Condition",
    id: s.id,
    subject: { reference: `Patient/${patientId}` },
    code: {
      coding: [
        {
          system: "http://hl7.org/fhir/sid/icd-10-cm",
          code: s.diagnosis_icd10 ?? "",
        },
      ],
    },
    recordedDate: s.study_date,
  };
}

function medicationRequestToFhir(
  rx: {
    id: string;
    hcpcs_code: string | null;
    item_sku: string;
    valid_from: string;
    valid_until: string | null;
    status: string;
    provider_id: string | null;
  },
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: "MedicationRequest",
    id: rx.id,
    status: rx.status === "active" ? "active" : "completed",
    intent: "order",
    subject: { reference: `Patient/${patientId}` },
    requester: rx.provider_id
      ? { reference: `Practitioner/${rx.provider_id}` }
      : undefined,
    medicationCodeableConcept: {
      coding: [
        rx.hcpcs_code
          ? {
              system:
                "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
              code: rx.hcpcs_code,
            }
          : { display: rx.item_sku },
      ],
    },
    authoredOn: rx.valid_from,
    dispenseRequest: rx.valid_until
      ? { validityPeriod: { start: rx.valid_from, end: rx.valid_until } }
      : undefined,
  };
}

function deviceToFhir(
  e: {
    id: string;
    device_class: string;
    serial_number: string;
    model: string;
    manufacturer: string;
    dispensed_at: string | null;
  },
  patientId: string,
): Record<string, unknown> {
  return {
    resourceType: "Device",
    id: e.id,
    patient: { reference: `Patient/${patientId}` },
    type: { text: e.device_class },
    serialNumber: e.serial_number,
    modelNumber: e.model,
    manufacturer: e.manufacturer,
    note: e.dispensed_at
      ? [{ text: `Dispensed: ${e.dispensed_at}` }]
      : undefined,
  };
}

function notFound(resourceType: string): Record<string, unknown> {
  return {
    resourceType: "OperationOutcome",
    issue: [
      {
        severity: "error",
        code: "not-found",
        diagnostics: `${resourceType} not found`,
      },
    ],
  };
}

export default router;

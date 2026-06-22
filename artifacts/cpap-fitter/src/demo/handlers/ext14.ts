// Demo handlers for the PATIENT-DETAIL billing & clinical tabs that hang
// off the *non-admin* `/resupply-api/patients/:id/...` routes (as opposed
// to the `/resupply-api/admin/patients/:id/...` family seeded by
// `handlers/patient-detail.ts`). These back the Insurance, Claims,
// Prescriptions / Prior-auth, Sleep-studies, Notes, and Timeline tabs of
// the patient detail page so they render realistic sample data instead of
// falling through to the router's benign empty fallback.
//
// Everything here is obviously fictional — this is the demonstration
// sandbox, never real PHI. Patient ids align to the `demo-patient-N`
// roster owned by `handlers/admin.ts`; every builder derives a stable
// seed index from the requested id so the same patient always shows the
// same supporting data.
//
// Shapes are matched 1:1 against:
//   * the live routes under
//     `artifacts/resupply-api/src/routes/patients/*`, and
//   * what the SPA actually derefs — `lib/admin/clinical-tabs-api.ts`
//     (claims/coverages/PA/sleep-studies) and the generated client
//     (`PatientNotesPage` = `{ items, count }`, `PatientTimeline` =
//     `{ patientId, events }`). Where the live route's JSON and the SPA's
//     expected shape disagree (notes: route returns `{ notes }`, SPA
//     reads `{ items, count }`), we follow the SPA so the tab renders.
//
// Fixtures are inline (one self-contained file). Paths NOT seeded here
// and why:
//   * /patients/:id/timeline (admin variant) — the admin-prefixed
//     `/admin/patients/:id/timeline` is already seeded by
//     `handlers/patient-detail.ts`; the non-admin variant below is a
//     DIFFERENT path (used by `useGetPatientTimeline`) and is seeded.
//   * /patients/:id/documents — the documents list is seeded (GET);
//     binary download/upload-url/finalize are skipped (object storage).
//   * /patients/:id/prescriptions/:rxId/attachment* — SKIPPED, binary
//     object-storage upload/stream.
//   * /patients (list) + /patients/:id (detail) — owned by
//     `handlers/admin.ts`; NOT touched here.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, dateOnly, NOW_ISO } from "../fixtures/dates";

/** Derive the 1-based seed number from a `demo-patient-N` id (default 1). */
function seedNum(id: string): number {
  return Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
}

const DEMO_ADMIN_EMAIL = "demo.admin@caremetric.example";
const DEMO_ADMIN_ID = "demo-admin-1";

// ── /patients/:id/insurance-coverages ──────────────────────────────
// Source: routes/patients/insurance-coverages.ts — `{ coverages: [...] }`.
// SPA: clinical-tabs-api.ts listInsuranceCoverages reads `.coverages`.
function demoInsuranceCoverages(patientId: string) {
  const n = seedNum(patientId);
  const policyholder = `Demo Patient ${n}`;
  return {
    coverages: [
      {
        id: `demo-coverage-${n}-1`,
        rank: "primary" as const,
        payerName: "Independence Blue Cross",
        planName: "Personal Choice PPO",
        memberId: "QHP998877001",
        groupNumber: "PA-00271",
        policyholderName: policyholder,
        policyholderRelationship: "self" as const,
        effectiveDate: dateOnly(-400),
        terminationDate: null,
        inNetwork: true,
        deductibleCents: 150000,
        deductibleMetCents: 92000,
        oopMaxCents: 400000,
        copayCents: 2500,
        cappedRentalStatus: "rental_month_4_to_13" as const,
        verifiedAt: daysAgo(3),
        notes: "Verified via 270/271 round-trip.",
        createdAt: daysAgo(120),
        updatedAt: daysAgo(3),
      },
      {
        id: `demo-coverage-${n}-2`,
        rank: "secondary" as const,
        payerName: "Medicare PA",
        planName: "Medicare Part B",
        memberId: "1EG4TE5MK72",
        groupNumber: null,
        policyholderName: policyholder,
        policyholderRelationship: "self" as const,
        effectiveDate: dateOnly(-900),
        terminationDate: null,
        inNetwork: true,
        deductibleCents: 24000,
        deductibleMetCents: 24000,
        oopMaxCents: null,
        copayCents: null,
        cappedRentalStatus: "not_applicable" as const,
        verifiedAt: null,
        notes: null,
        createdAt: daysAgo(118),
        updatedAt: daysAgo(60),
      },
    ],
  };
}

// ── /patients/:id/prior-authorizations ─────────────────────────────
// Source: routes/patients/prior-authorizations.ts —
// `{ priorAuthorizations: [...] }`. SPA reads `.priorAuthorizations`.
function demoPriorAuthorizations(patientId: string) {
  const n = seedNum(patientId);
  return {
    priorAuthorizations: [
      {
        id: `demo-pa-${n}-1`,
        insuranceCoverageId: `demo-coverage-${n}-1`,
        hcpcsCode: "E0601",
        payerName: "Independence Blue Cross",
        authNumber: "AUTH-DEMO-55120",
        status: "approved" as const,
        requestedAt: daysAgo(50),
        submittedAt: daysAgo(49),
        decisionAt: daysAgo(44),
        approvedThrough: dateOnly(280),
        denialReason: null,
        documentId: null,
        notes: "Approved for PAP device, 13-month capped rental.",
        createdAt: daysAgo(50),
        updatedAt: daysAgo(44),
      },
      {
        id: `demo-pa-${n}-2`,
        insuranceCoverageId: `demo-coverage-${n}-1`,
        hcpcsCode: "A7034",
        payerName: "Independence Blue Cross",
        authNumber: null,
        status: "submitted" as const,
        requestedAt: daysAgo(6),
        submittedAt: daysAgo(5),
        decisionAt: null,
        approvedThrough: null,
        denialReason: null,
        documentId: null,
        notes: "Resupply auth for nasal mask cushions; awaiting payer reply.",
        createdAt: daysAgo(6),
        updatedAt: daysAgo(5),
      },
    ],
  };
}

// ── /patients/:id/sleep-studies ────────────────────────────────────
// Source: routes/patients/sleep-studies.ts — `{ studies: [...] }`.
// SPA: clinical-tabs-api.ts listSleepStudies reads `.studies`.
function demoSleepStudies(patientId: string) {
  const n = seedNum(patientId);
  return {
    studies: [
      {
        id: `demo-study-${n}-1`,
        studyDate: dateOnly(-220),
        studyType: "psg" as const,
        ahi: 32.4,
        rdi: 38.1,
        lowestSpo2Pct: 84,
        sleepEfficiencyPct: 79,
        diagnosisIcd10: "G47.33",
        interpretingProviderId: `demo-provider-${n}`,
        facilityName: "Demo Sleep Associates",
        source: "external_lab" as const,
        documentId: null,
        notes: "Severe OSA; titrated to 10 cmH2O.",
        createdAt: daysAgo(210),
      },
      {
        id: `demo-study-${n}-2`,
        studyDate: dateOnly(-40),
        studyType: "hsat" as const,
        ahi: 4.1,
        rdi: null,
        lowestSpo2Pct: 91,
        sleepEfficiencyPct: null,
        diagnosisIcd10: "G47.33",
        interpretingProviderId: `demo-provider-${n}`,
        facilityName: "HomeTest Diagnostics",
        source: "home_test_vendor" as const,
        documentId: null,
        notes: "Follow-up HSAT confirms therapy effectiveness.",
        createdAt: daysAgo(38),
      },
    ],
  };
}

// ── /patients/:id/sleep-studies/:sid/suggest-icd10 (POST) ──────────
// Source: routes/patients/sleep-studies-suggest-icd10.ts — AI suggester.
// Benign canned suggestion so the "suggest ICD-10" button returns a
// realistic shape rather than the router's bare `{ ok: true }`.
function demoSuggestIcd10() {
  return {
    suggestions: [
      {
        code: "G47.33",
        label: "Obstructive sleep apnea (adult) (pediatric)",
        confidence: 0.94,
        rationale:
          "AHI > 15 on diagnostic PSG meets the LCD L33718 criteria for obstructive sleep apnea.",
      },
      {
        code: "G47.30",
        label: "Sleep apnea, unspecified",
        confidence: 0.41,
        rationale: "Fallback when apnea subtype is not documented.",
      },
    ],
    autoApplied: false,
  };
}

// ── /patients/:id/notes ────────────────────────────────────────────
// Source: routes/patients/notes-list.ts returns `{ notes }`, but the SPA
// (generated PatientNotesPage + patient-detail.tsx NotesTab) derefs
// `data.items` / `data.count`. Follow the SPA so the tab renders.
function demoPatientNotes(patientId: string) {
  const n = seedNum(patientId);
  const items = [
    {
      id: `demo-pnote-${n}-1`,
      body: "Patient called to confirm next resupply; verified shipping address and added replacement filters.",
      authorEmail: DEMO_ADMIN_EMAIL,
      authorUserId: DEMO_ADMIN_ID,
      createdAt: daysAgo(3),
    },
    {
      id: `demo-pnote-${n}-2`,
      body: "Reviewed adherence report — compliant at 88% over the last 30 nights. No coaching needed this cycle.",
      authorEmail: DEMO_ADMIN_EMAIL,
      authorUserId: DEMO_ADMIN_ID,
      createdAt: daysAgo(16),
    },
    {
      id: `demo-pnote-${n}-3`,
      body: "Prior auth for PAP device approved through next year. Filed approval letter to chart.",
      authorEmail: DEMO_ADMIN_EMAIL,
      authorUserId: DEMO_ADMIN_ID,
      createdAt: daysAgo(44),
    },
  ];
  return { items, count: items.length };
}

// ── /patients/:id/documents ────────────────────────────────────────
// Source: routes/patients/patient-documents.ts (GET list) —
// `{ documents: [...] }`. Binary download/upload paths are NOT seeded.
function demoPatientDocuments(patientId: string) {
  const n = seedNum(patientId);
  return {
    documents: [
      {
        id: `demo-pdoc-${n}-1`,
        documentType: "prescription",
        filename: "swo-pap.pdf",
        contentType: "application/pdf",
        sizeBytes: 184_320,
        createdAt: daysAgo(40),
        reviewedAt: daysAgo(39),
        reviewedByAdminId: DEMO_ADMIN_ID,
        reviewNote: "Valid SWO on file; matches active prescription.",
      },
      {
        id: `demo-pdoc-${n}-2`,
        documentType: "insurance_card",
        filename: "insurance-card-front.jpg",
        contentType: "image/jpeg",
        sizeBytes: 96_240,
        createdAt: daysAgo(12),
        reviewedAt: null,
        reviewedByAdminId: null,
        reviewNote: null,
      },
    ],
  };
}

// ── /patients/:id/timeline (non-admin) ─────────────────────────────
// Source: routes/patients/timeline.ts — `{ patientId, events }` where
// each event is a PatientTimelineEvent. NOTE: distinct from the
// admin-prefixed `/admin/patients/:id/timeline` (different shape) that
// `handlers/patient-detail.ts` already seeds.
function demoPatientTimeline(patientId: string) {
  const n = seedNum(patientId);
  const epId = `demo-ep-${n}`;
  const rxId = `demo-rx-${n}`;
  const fulId = `demo-ful-${n}`;
  const convId = `demo-conv-${n}`;
  const event = (
    kind:
      | "patient_created"
      | "prescription_created"
      | "episode_created"
      | "message"
      | "fulfillment_queued"
      | "fulfillment_submitted"
      | "fulfillment_shipped"
      | "fulfillment_delivered",
    at: string,
    title: string,
    detail: string | null,
    refs: {
      episodeId?: string;
      conversationId?: string;
      prescriptionId?: string;
      fulfillmentId?: string;
    } = {},
  ) => ({
    kind,
    at,
    title,
    detail,
    episodeId: refs.episodeId ?? null,
    conversationId: refs.conversationId ?? null,
    prescriptionId: refs.prescriptionId ?? null,
    fulfillmentId: refs.fulfillmentId ?? null,
  });
  return {
    patientId,
    events: [
      event(
        "message",
        daysAgo(2),
        "Inbound SMS",
        "Patient confirmed resupply",
        {
          conversationId: convId,
        },
      ),
      event(
        "fulfillment_delivered",
        daysAgo(38),
        "A7034 delivered",
        "Carrier confirmation received",
        { fulfillmentId: fulId, episodeId: epId },
      ),
      event(
        "fulfillment_shipped",
        daysAgo(40),
        "A7034 shipped",
        "Handed to carrier",
        { fulfillmentId: fulId, episodeId: epId },
      ),
      event(
        "episode_created",
        daysAgo(45),
        "Resupply episode opened",
        "Cadence 90 days",
        { episodeId: epId, prescriptionId: rxId },
      ),
      event(
        "prescription_created",
        daysAgo(200),
        "Prescription recorded",
        "E0601 — PAP device",
        { prescriptionId: rxId },
      ),
      event(
        "patient_created",
        daysAgo(120 - (n - 1) * 5),
        "Patient created",
        "Customer-since marker",
      ),
    ],
  };
}

// Match only real demo patient ids for the :id reads; an unrecognized
// segment (a static sub-route or stale link) falls through to the
// router's generic empty fallback rather than a wrong-shaped fixture.
const isDemoPatient = (id: string): boolean => /^demo-patient-\d+$/.test(id);

export const ext14Handlers: DemoHandler[] = [
  // ── Insurance coverages ──────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/patients/:id/insurance-coverages",
    (_req, { id }) =>
      isDemoPatient(id)
        ? json(demoInsuranceCoverages(id))
        : json({ coverages: [] }),
  ),
  route("POST", "/resupply-api/patients/:id/insurance-coverages", () =>
    json({ id: `demo-coverage-new-${Date.now()}` }, 201),
  ),

  // ── Prior authorizations ─────────────────────────────────────────
  route(
    "GET",
    "/resupply-api/patients/:id/prior-authorizations",
    (_req, { id }) =>
      isDemoPatient(id)
        ? json(demoPriorAuthorizations(id))
        : json({ priorAuthorizations: [] }),
  ),
  route("POST", "/resupply-api/patients/:id/prior-authorizations", () =>
    json({ id: `demo-pa-new-${Date.now()}` }, 201),
  ),

  // NOTE: the entire /patients/:id/insurance-claims surface (list,
  // detail, create, PATCH, lines, events, plus the AI/preflight/submit
  // endpoints) is already owned by `handlers/ext13.ts` — intentionally
  // NOT seeded here to avoid duplicate handlers.

  // ── Sleep studies (suggest-icd10 POST BEFORE the bare list/`:sid`) ─
  route(
    "POST",
    "/resupply-api/patients/:id/sleep-studies/:sid/suggest-icd10",
    () => json(demoSuggestIcd10()),
  ),
  route("GET", "/resupply-api/patients/:id/sleep-studies", (_req, { id }) =>
    isDemoPatient(id) ? json(demoSleepStudies(id)) : json({ studies: [] }),
  ),
  route("POST", "/resupply-api/patients/:id/sleep-studies", () =>
    json({ id: `demo-study-new-${Date.now()}` }, 201),
  ),

  // ── Notes (SPA derefs `{ items, count }`) ────────────────────────
  route("GET", "/resupply-api/patients/:id/notes", (_req, { id }) =>
    isDemoPatient(id)
      ? json(demoPatientNotes(id))
      : json({ items: [], count: 0 }),
  ),
  route("POST", "/resupply-api/patients/:id/notes", (req) => {
    const body = req.json<{ body?: string }>() ?? {};
    return json(
      {
        id: `demo-pnote-new-${Date.now()}`,
        body: body.body ?? "",
        authorEmail: DEMO_ADMIN_EMAIL,
        authorUserId: DEMO_ADMIN_ID,
        createdAt: NOW_ISO(),
      },
      201,
    );
  }),

  // ── Prescriptions create + status update ─────────────────────────
  route("POST", "/resupply-api/patients/:id/prescriptions", () =>
    json({ id: `demo-rx-new-${Date.now()}` }, 201),
  ),
  route("PATCH", "/resupply-api/prescriptions/:rxId", (req, { rxId }) => {
    const body = req.json<{ status?: string }>() ?? {};
    return json({
      id: rxId,
      status: body.status ?? "active",
      changed: true,
    });
  }),

  // ── Patient documents (GET list only; binary paths skipped) ──────
  route("GET", "/resupply-api/patients/:id/documents", (_req, { id }) =>
    isDemoPatient(id)
      ? json(demoPatientDocuments(id))
      : json({ documents: [] }),
  ),

  // ── Non-admin timeline (distinct from the admin-prefixed one) ────
  route("GET", "/resupply-api/patients/:id/timeline", (_req, { id }) =>
    isDemoPatient(id)
      ? json(demoPatientTimeline(id))
      : json({ patientId: id, events: [] }),
  ),

  // ── Patient merge (benign success) ───────────────────────────────
  route("POST", "/resupply-api/patients/merge", () =>
    json({ ok: true, tablesRepointed: 7, rowsRepointed: 23 }),
  ),

  // ── Patient update (PATCH) — benign success ──────────────────────
  // NOTE: `/patients/:id` GET is owned by handlers/admin.ts; only the
  // PATCH mutation is seeded here (handlers are method-scoped).
  route("PATCH", "/resupply-api/patients/:id", (_req, { id }) =>
    json({ id, changed: ["status"], updatedAt: NOW_ISO() }),
  ),
];

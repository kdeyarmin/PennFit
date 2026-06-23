// Demo handlers (extension #13) for the PATIENTS route family that lives
// under `artifacts/resupply-api/src/routes/patients/*` and mounts at
// `/resupply-api/patients/...`. These seed the admin patient-record sub-
// resources (clinical equipment registry, CSR follow-ups) and the full
// insurance-claims surface (list/detail + the prominent create/update +
// the AI scrub/denial tools) so those tabs render realistic sample data
// instead of the router's benign empty fallback.
//
// Scope + de-duplication:
//   * The patient LIST (GET /resupply-api/patients) and patient DETAIL
//     (GET /resupply-api/patients/:id) are owned by `handlers/admin.ts`
//     (demoPatients / demoPatientDetail). This module does NOT touch
//     them — but it MUST be installed AFTER admin.ts's `:id` matcher is
//     out of the way, OR have its more-specific paths win. Every path
//     here is more specific than `/patients/:id` (it has extra
//     segments) EXCEPT the two static one-segment routes
//     `/patients/duplicates` and `/patients/bulk-status`; those are
//     ordered first in this array AND admin.ts's `/patients/:id` is a
//     GET (duplicates is GET, bulk-status is POST), so there is no
//     shadow conflict in practice — admin.ts's `:id` GET only answers
//     ids matching /^demo-patient-\d+$/, returning the empty fallback
//     for "duplicates", which is why we seed a real one here.
//   * `handlers/patient-detail.ts` seeds the `/resupply-api/admin/
//     patients/:id/*` clinical tabs and a few `/resupply-api/admin/...`
//     paths — none under `/resupply-api/patients/:id/*`, so there is no
//     overlap with this module.
//
// Patient ids are aligned to the `demo-patient-N` roster. Claim/line/
// equipment ids are derived from the patient seed so the same patient
// always shows the same supporting records.
//
// Shapes are matched 1:1 against the live route handlers under
// `artifacts/resupply-api/src/routes/patients/*` — see the per-handler
// comment for the source file + exact JSON the SPA derefs.
//
// All data is obviously fictional — this is the demonstration sandbox,
// never real PHI. NPIs are fake (1-prefixed 10-digit); money is in cents.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "../fixtures/dates";

// ── shared fictional roster context ─────────────────────────────────
const FIRST_NAMES = [
  "Jordan",
  "Casey",
  "Morgan",
  "Riley",
  "Avery",
  "Quinn",
  "Harper",
  "Rowan",
  "Sawyer",
  "Emerson",
  "Devon",
  "Skylar",
];
const LAST_NAMES = [
  "Sample",
  "Demo",
  "Example",
  "Tester",
  "Placeholder",
  "Fictional",
  "Mockford",
  "Sandbox",
  "Trial",
  "Preview",
  "Dummy",
  "Faux",
];

/** Derive the 1-based seed number from a `demo-patient-N` id (default 1). */
function seedNum(id: string): number {
  return Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
}

function fullName(patientId: string): string {
  const i = seedNum(patientId) - 1;
  return `${FIRST_NAMES[i % FIRST_NAMES.length]} ${
    LAST_NAMES[i % LAST_NAMES.length]
  }`;
}

// ════════════════════════════════════════════════════════════════════
// EQUIPMENT — routes/patients/equipment.ts
//   GET /patients/:id/equipment → { equipment: EquipmentAsset[] }
// ════════════════════════════════════════════════════════════════════
function demoEquipment(patientId: string) {
  const n = seedNum(patientId);
  return {
    equipment: [
      {
        id: `demo-equip-${n}-1`,
        patientId,
        prescriptionId: `demo-rx-${n}`,
        deviceClass: "auto_cpap",
        manufacturer: "RESMED",
        model: "AirSense 11 AutoSet",
        serialNumber: `DEMO22A1B2C${n}`,
        pressureSetting: "8–14 cmH₂O (auto)",
        humidifierSetting: "Climate Control: Auto",
        status: "active",
        dispensedAt: dateOnly(-200),
        dispensingNote: "Initial PAP setup; patient trained on mask seal.",
        recallId: null,
        notes: "Heated tube; SD card on file.",
        createdAt: daysAgo(200),
        updatedAt: daysAgo(40),
      },
      {
        id: `demo-equip-${n}-2`,
        patientId,
        prescriptionId: null,
        deviceClass: "humidifier",
        manufacturer: "RESMED",
        model: "HumidAir (integrated)",
        serialNumber: `DEMO9988HX${n}`,
        pressureSetting: null,
        humidifierSetting: "Level 4",
        status: "retired",
        dispensedAt: dateOnly(-620),
        dispensingNote: null,
        recallId: null,
        notes: "Retired when AirSense 11 dispensed.",
        createdAt: daysAgo(620),
        updatedAt: daysAgo(201),
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════
// FOLLOW-UPS — routes/patients/followups.ts
//   GET /patients/:id/followups → { followups: Followup[] }
// ════════════════════════════════════════════════════════════════════
function demoFollowups(patientId: string, includeCompleted: boolean) {
  const name = fullName(patientId).split(" ")[0];
  const open = [
    {
      id: `demo-fup-${seedNum(patientId)}-open`,
      body: `Call ${name} to confirm new mask fit and answer sizing questions.`,
      dueAt: daysFromNow(1),
      completedAt: null,
      completedByEmail: null,
      createdByEmail: "demo.admin@caremetric.example",
      createdAt: daysAgo(2),
    },
  ];
  const completed = [
    {
      id: `demo-fup-${seedNum(patientId)}-done`,
      body: "Left voicemail about resupply eligibility; will retry.",
      dueAt: daysAgo(6),
      completedAt: daysAgo(5),
      completedByEmail: "demo.admin@caremetric.example",
      createdByEmail: "demo.admin@caremetric.example",
      createdAt: daysAgo(8),
    },
  ];
  return { followups: includeCompleted ? [...open, ...completed] : open };
}

// ════════════════════════════════════════════════════════════════════
// INSURANCE CLAIMS — routes/patients/insurance-claims.ts
//   GET  /patients/:id/insurance-claims → { insuranceClaims: ClaimApi[] }
//   GET  /patients/:id/insurance-claims/:claimId →
//        { claim, lineItems, events }
// ════════════════════════════════════════════════════════════════════
type ClaimStatus =
  | "draft"
  | "submitted"
  | "accepted"
  | "denied"
  | "paid"
  | "appealed"
  | "closed";

interface DemoClaim {
  id: string;
  insuranceCoverageId: string | null;
  payerName: string;
  claimNumber: string | null;
  dateOfService: string;
  fulfillmentId: string | null;
  status: ClaimStatus;
  totalBilledCents: number;
  totalAllowedCents: number;
  totalPaidCents: number;
  patientResponsibilityCents: number;
  deductibleCents: number;
  coinsuranceCents: number;
  copayCents: number;
  submittedAt: string | null;
  decisionAt: string | null;
  paidAt: string | null;
  denialReason: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// Two claims per patient: one paid, one denied (so the AI denial-
// analysis / explain-denial / auto-fix tools all have a valid target).
function demoClaimsForPatient(patientId: string): DemoClaim[] {
  const n = seedNum(patientId);
  return [
    {
      id: `demo-claim-${n}-1`,
      insuranceCoverageId: `demo-coverage-${n}`,
      payerName: "Independence Blue Cross",
      claimNumber: `IBX-DEMO-${44000 + n}`,
      dateOfService: dateOnly(-48),
      fulfillmentId: `demo-ful-${n}`,
      status: "paid",
      totalBilledCents: 18995,
      totalAllowedCents: 14200,
      totalPaidCents: 11360,
      patientResponsibilityCents: 2840,
      deductibleCents: 0,
      coinsuranceCents: 2840,
      copayCents: 0,
      submittedAt: daysAgo(46),
      decisionAt: daysAgo(40),
      paidAt: daysAgo(38),
      denialReason: null,
      notes: "Routine resupply — mask + cushions.",
      createdAt: daysAgo(48),
      updatedAt: daysAgo(38),
    },
    {
      id: `demo-claim-${n}-2`,
      insuranceCoverageId: `demo-coverage-${n}`,
      payerName: "Aetna Choice PPO",
      claimNumber: `AET-DEMO-${77000 + n}`,
      dateOfService: dateOnly(-12),
      fulfillmentId: null,
      status: "denied",
      totalBilledCents: 22900,
      totalAllowedCents: 0,
      totalPaidCents: 0,
      patientResponsibilityCents: 0,
      deductibleCents: 0,
      coinsuranceCents: 0,
      copayCents: 0,
      submittedAt: daysAgo(9),
      decisionAt: daysAgo(4),
      paidAt: null,
      denialReason:
        "CO-16: missing/incomplete documentation (CMN not on file).",
      notes: "Resubmit with current CMN attached.",
      createdAt: daysAgo(12),
      updatedAt: daysAgo(4),
    },
  ];
}

function findDemoClaim(patientId: string, claimId: string): DemoClaim {
  const claims = demoClaimsForPatient(patientId);
  return claims.find((c) => c.id === claimId) ?? claims[0];
}

function demoClaimDetail(patientId: string, claimId: string) {
  const claim = findDemoClaim(patientId, claimId);
  // Re-key so an unrecognized id still round-trips what the UI navigated
  // with (keeps the header consistent with the row that was clicked).
  const keyed: DemoClaim = { ...claim, id: claimId };
  const denied = keyed.status === "denied";
  return {
    claim: keyed,
    lineItems: [
      {
        id: `${claimId}-line-1`,
        hcpcsCode: "A7034",
        modifier: "NU",
        description: "Nasal interface (mask), full face, used with PAP device",
        quantity: 1,
        billedCents: 12900,
        allowedCents: denied ? 0 : 9600,
        paidCents: denied ? 0 : 7680,
        narrative: null,
        status: denied ? "denied" : "paid",
        denialReason: denied ? "CO-16" : null,
        createdAt: keyed.createdAt,
        updatedAt: keyed.updatedAt,
      },
      {
        id: `${claimId}-line-2`,
        hcpcsCode: "A7032",
        modifier: "NU",
        description: "Replacement cushion for nasal application, 2/month",
        quantity: 2,
        billedCents: 5000,
        allowedCents: denied ? 0 : 4600,
        paidCents: denied ? 0 : 3680,
        narrative: null,
        status: denied ? "denied" : "paid",
        denialReason: denied ? "CO-16" : null,
        createdAt: keyed.createdAt,
        updatedAt: keyed.updatedAt,
      },
    ],
    events: denied
      ? [
          {
            id: `${claimId}-evt-2`,
            eventType: "denied",
            amountCents: null,
            payerRef: keyed.claimNumber,
            documentId: null,
            note: keyed.denialReason,
            actorEmail: "demo.admin@caremetric.example",
            occurredAt: keyed.decisionAt,
          },
          {
            id: `${claimId}-evt-1`,
            eventType: "submitted",
            amountCents: keyed.totalBilledCents,
            payerRef: keyed.claimNumber,
            documentId: null,
            note: null,
            actorEmail: "demo.admin@caremetric.example",
            occurredAt: keyed.submittedAt,
          },
        ]
      : [
          {
            id: `${claimId}-evt-3`,
            eventType: "paid",
            amountCents: keyed.totalPaidCents,
            payerRef: keyed.claimNumber,
            documentId: null,
            note: null,
            actorEmail: "demo.admin@caremetric.example",
            occurredAt: keyed.paidAt,
          },
          {
            id: `${claimId}-evt-2`,
            eventType: "accepted",
            amountCents: keyed.totalAllowedCents,
            payerRef: keyed.claimNumber,
            documentId: null,
            note: null,
            actorEmail: "demo.admin@caremetric.example",
            occurredAt: keyed.decisionAt,
          },
          {
            id: `${claimId}-evt-1`,
            eventType: "submitted",
            amountCents: keyed.totalBilledCents,
            payerRef: keyed.claimNumber,
            documentId: null,
            note: null,
            actorEmail: "demo.admin@caremetric.example",
            occurredAt: keyed.submittedAt,
          },
        ],
  };
}

// ── preflight — insurance-claims-preflight.ts → { preflight: Summary }
function demoPreflight() {
  return {
    preflight: {
      readyToSubmit: false,
      errorCount: 1,
      warningCount: 1,
      items: [
        {
          key: "coverage",
          severity: "ok" as const,
          label: "Insurance coverage on file",
          detail: "Active coverage with Independence Blue Cross.",
        },
        {
          key: "line_items",
          severity: "ok" as const,
          label: "At least one line item",
          detail: "2 HCPCS line items present.",
        },
        {
          key: "cmn",
          severity: "error" as const,
          label: "Certificate of Medical Necessity",
          detail: "No completed CMN linked to this claim.",
        },
        {
          key: "patient_address",
          severity: "warning" as const,
          label: "Structured patient address",
          detail: "Address line 2 missing — verify before submission.",
        },
      ],
    },
  };
}

// ── ai-scrub history — insurance-claims-ai.ts (GET) → { scrubs: [...] }
function demoScrubHistory(patientId: string, claimId: string) {
  return {
    scrubs: [
      {
        id: `${claimId}-scrub-1`,
        verdict: "needs_changes",
        model: "gpt-4o-mini",
        prompt_version: "demo-scrub-v1",
        confidence: 0.82,
        findings_json: {
          summary:
            "Claim is mostly clean but the CMN is not attached and one modifier is missing.",
          findings: [
            {
              key: "missing_cmn",
              severity: "error",
              message:
                "No CMN linked; payer requires one for E0601-family supplies.",
            },
            {
              key: "modifier",
              severity: "warning",
              message: "Line 2 (A7032) is missing the NU/RR modifier.",
            },
          ],
        },
        suggested_patches_json: [
          {
            op: "set",
            target: "line.2.modifier",
            value: "NU",
            rationale: "Replacement cushion billed as new equipment.",
          },
        ],
        review_status: "pending",
        reviewed_by_email: null,
        reviewed_at: null,
        applied_patches_log: null,
        applied_at: null,
        latency_ms: 1840,
        prompt_tokens: 1320,
        completion_tokens: 210,
        error_message: null,
        created_at: daysAgo(3),
      },
    ],
  };
}

// ════════════════════════════════════════════════════════════════════
// Benign-success mutation responses (canned, in the real route shapes)
// ════════════════════════════════════════════════════════════════════
function demoNewId(prefix: string): string {
  // Deterministic-ish fake id so the UI has something stable to render.
  return `demo-${prefix}-${Date.now().toString(36)}`;
}

export const ext13Handlers: DemoHandler[] = [
  // ── STATIC patient routes (MUST precede any `/patients/:id` match) ──
  // /patients/duplicates — routes/patients/duplicates.ts.
  // { groups: [{ matchReason, members[], memberCount }], groupCount }
  route("GET", "/resupply-api/patients/duplicates", () =>
    json({
      groups: [
        {
          matchReason: "same_dob_last_name",
          memberCount: 2,
          members: [
            {
              patientId: "demo-patient-2",
              firstName: "Casey",
              lastName: "Demo",
              dateOfBirth: "1972-03-14",
              pacwareId: "PW-10241",
              status: "active",
              hasPhone: true,
              hasEmail: true,
              createdAt: daysAgo(95),
            },
            {
              patientId: "demo-patient-9",
              firstName: "Casey",
              lastName: "Demo",
              dateOfBirth: "1972-03-14",
              pacwareId: null,
              status: "active",
              hasPhone: false,
              hasEmail: true,
              createdAt: daysAgo(20),
            },
          ],
        },
      ],
      groupCount: 1,
    }),
  ),
  // /patients/bulk-status — routes/patients/bulk-status.ts.
  // Echo every requested id as updated; nothing fails in the demo.
  route("POST", "/resupply-api/patients/bulk-status", (req) => {
    const body = req.json<{ ids?: string[]; status?: string }>() ?? {};
    const ids = Array.from(new Set(body.ids ?? []));
    const status = body.status ?? "active";
    const updatedAt = NOW_ISO();
    return json({
      updated: ids.map((id) => ({ id, status, updatedAt })),
      failed: [] as Array<{ id: string; error: "not_found" }>,
    });
  }),
  // POST /patients — routes/patients/create.ts → { id }. (GET /patients
  // is owned by handlers/admin.ts; only the create POST is seeded here.)
  route("POST", "/resupply-api/patients", () =>
    json({ id: demoNewId("patient") }, 201),
  ),

  // ── EQUIPMENT — routes/patients/equipment.ts ──────────────────────
  route("GET", "/resupply-api/patients/:id/equipment", (_req, { id }) =>
    json(demoEquipment(id)),
  ),
  route("POST", "/resupply-api/patients/:id/equipment", () =>
    json({ id: demoNewId("equip") }, 201),
  ),
  route(
    "PATCH",
    "/resupply-api/patients/:id/equipment/:assetId",
    (_req, { assetId }) => json({ id: assetId, changed: true }),
  ),

  // ── FOLLOW-UPS — routes/patients/followups.ts ─────────────────────
  // PATCH complete/reopen are more specific; order them before the
  // bare `/followups` POST/GET match.
  route(
    "PATCH",
    "/resupply-api/patients/:id/followups/:fid/complete",
    (_req, { fid }) => json({ id: fid, completedAt: NOW_ISO() }),
  ),
  route(
    "PATCH",
    "/resupply-api/patients/:id/followups/:fid/reopen",
    (_req, { fid }) => json({ id: fid, completedAt: null }),
  ),
  route("GET", "/resupply-api/patients/:id/followups", (req, { id }) =>
    json(demoFollowups(id, req.query.get("include") === "completed")),
  ),
  route("POST", "/resupply-api/patients/:id/followups", () =>
    json(
      { id: demoNewId("fup"), dueAt: daysFromNow(2), createdAt: NOW_ISO() },
      201,
    ),
  ),

  // ── INSURANCE CLAIMS — claim-scoped STATIC sub-paths FIRST ────────
  // Every `/insurance-claims/:claimId/<segment>` route is more specific
  // than the bare `/insurance-claims/:claimId` detail match, so they
  // must precede it to avoid being shadowed.

  // preflight (GET) — insurance-claims-preflight.ts
  route(
    "GET",
    "/resupply-api/patients/:id/insurance-claims/:claimId/preflight",
    () => json(demoPreflight()),
  ),
  // ai-scrub history (GET) — insurance-claims-ai.ts
  route(
    "GET",
    "/resupply-api/patients/:id/insurance-claims/:claimId/ai-scrub",
    (_req, { id, claimId }) => json(demoScrubHistory(id, claimId)),
  ),
  // ai-scrub run (POST) — insurance-claims-ai.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/ai-scrub",
    (_req, { claimId }) =>
      json(
        {
          scrubResultId: `${claimId}-scrub-${Date.now().toString(36)}`,
          verdict: "needs_changes",
          summary:
            "The claim is well-formed, but the CMN is missing and one HCPCS modifier should be added before submission.",
          confidence: 0.84,
          findings: [
            {
              key: "missing_cmn",
              severity: "error",
              message:
                "No Certificate of Medical Necessity is linked; this payer requires one for PAP supplies.",
            },
            {
              key: "modifier",
              severity: "warning",
              message: "Line A7032 is missing the NU modifier.",
            },
          ],
          suggestedPatches: [
            {
              op: "set",
              target: "line.2.modifier",
              value: "NU",
              rationale: "Replacement cushion billed as new equipment.",
            },
          ],
          droppedPatches: [],
        },
        201,
      ),
  ),
  // ai-scrub apply (POST) — insurance-claims-ai.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/ai-scrub/apply",
    () =>
      json({
        ok: true,
        outcomes: [
          {
            target: "line.2.modifier",
            status: "applied",
            detail: "Set modifier to NU.",
          },
        ],
      }),
  ),
  // predict-denial (POST) — insurance-claims-predict-denial.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/predict-denial",
    () =>
      json({
        probability: 0.31,
        factors: [
          {
            key: "missing_cmn",
            weight: 0.18,
            label: "No CMN on file for a PAP supply claim.",
          },
          {
            key: "payer_history",
            weight: 0.09,
            label:
              "This payer denies ~9% of resupply claims in the last 90 days.",
          },
          {
            key: "modifier",
            weight: 0.04,
            label: "One line item is missing a billing modifier.",
          },
        ],
        scoredAt: NOW_ISO(),
      }),
  ),
  // explain-denial (POST) — insurance-claims-explain-denial.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/explain-denial",
    (_req, { id }) =>
      json({
        subject: "An update on your recent insurance claim",
        body: `Hi ${fullName(id).split(" ")[0]},\n\nWe wanted to let you know that your insurance asked for one more document before they finish processing your recent CPAP supply claim — a Certificate of Medical Necessity from your doctor. This is a common, routine request and does not mean your claim was rejected.\n\nWe're already requesting that document on your behalf and will resubmit as soon as it arrives. There is nothing you need to do right now, and you won't be billed while we sort this out.\n\nWe'll reach out again the moment we hear back.\n\nWarmly,\nThe Penn Home Medical Supply team`,
        tone: "reassuring",
        latencyMs: 1620,
        promptVersion: "demo-explainer-v1",
      }),
  ),
  // ai-denial-analysis run (POST) — insurance-claims-ai.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/ai-denial-analysis",
    (_req, { claimId }) =>
      json(
        {
          analysisId: `${claimId}-denial-${Date.now().toString(36)}`,
          recommendation: "auto_resubmit",
          confidence: 0.79,
          rootCauseSummary:
            "Denied CO-16 (missing documentation). The payer requires a current CMN on file; once attached, this claim should pay cleanly.",
          mappedCodes: [
            {
              code: "CO-16",
              meaning: "Claim lacks information needed for adjudication.",
            },
          ],
          fixSteps: [
            "Attach the patient's current Certificate of Medical Necessity.",
            "Verify the ordering physician NPI matches the CMN.",
            "Resubmit the corrected claim to the payer.",
          ],
          appealLetterSketch:
            "To whom it may concern: We are resubmitting claim AET-DEMO with the required Certificate of Medical Necessity now attached...",
          suggestedPatches: [
            {
              op: "attach",
              target: "claim.cmn_document_id",
              value: "demo-cmn-1",
              rationale: "Satisfies the CO-16 documentation requirement.",
            },
          ],
          droppedPatches: [],
          canAutoResubmit: true,
        },
        201,
      ),
  ),
  // auto-fix-and-resubmit (POST) — insurance-claims-ai.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/ai-denial-analysis/auto-fix-and-resubmit",
    () =>
      json({
        ok: true,
        newClaimId: demoNewId("claim"),
        outcomes: [
          {
            target: "claim.cmn_document_id",
            status: "applied",
            detail: "Attached CMN demo-cmn-1.",
          },
        ],
        submission: {
          submissionId: demoNewId("oasub"),
          isaControlNumber: "000000123",
          claimCount: 1,
        },
      }),
  ),
  // submit-office-ally (POST) — insurance-claims-submit.ts
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/submit-office-ally",
    () =>
      json(
        {
          ok: true,
          submissionId: demoNewId("oasub"),
          isaControlNumber: "000000123",
          gsControlNumber: "000000123",
          claimCount: 1,
          fileSizeBytes: 4096,
          transport: "stub",
        },
        201,
      ),
  ),
  // add line item (POST) — insurance-claims.ts → { id }
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/lines",
    () => json({ id: demoNewId("line") }, 201),
  ),
  // add claim event (POST) — insurance-claims.ts → { id }
  route(
    "POST",
    "/resupply-api/patients/:id/insurance-claims/:claimId/events",
    () => json({ id: demoNewId("evt") }, 201),
  ),

  // ── INSURANCE CLAIMS — `:claimId` detail + bare list LAST ─────────
  // detail (GET) — insurance-claims.ts → { claim, lineItems, events }
  route(
    "GET",
    "/resupply-api/patients/:id/insurance-claims/:claimId",
    (_req, { id, claimId }) => json(demoClaimDetail(id, claimId)),
  ),
  // update (PATCH) — insurance-claims.ts → { ok: true }
  route("PATCH", "/resupply-api/patients/:id/insurance-claims/:claimId", () =>
    json({ ok: true }),
  ),
  // list (GET) — insurance-claims.ts → { insuranceClaims: [...] }
  route("GET", "/resupply-api/patients/:id/insurance-claims", (_req, { id }) =>
    json({ insuranceClaims: demoClaimsForPatient(id) }),
  ),
  // create (POST) — insurance-claims.ts → { id }
  route("POST", "/resupply-api/patients/:id/insurance-claims", () =>
    json({ id: demoNewId("claim") }, 201),
  ),
];

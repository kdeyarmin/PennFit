// Seed data for the PATIENT CLINICAL DETAIL tabs and CSR admin tools.
//
// Every record is obviously fictional — this is the demonstration
// sandbox, never real PHI. Patient ids align to the `demo-patient-N`
// roster seeded by `handlers/admin.ts` (`demoPatientDetail`) so the
// sub-resources hang together with the patient list/detail the user
// clicks through from. Each builder is keyed off the requested patient
// id and derives a stable seed index `n` from it, so the same patient
// always shows the same supporting data.
//
// Shapes are matched 1:1 against the live admin route handlers under
// `artifacts/resupply-api/src/routes/admin/*` — see the per-builder
// comment for the source route + exact JSON the SPA derefs.

import { daysAgo, daysFromNow, dateOnly, NOW_ISO } from "./dates";

/** Derive the 1-based seed number from a `demo-patient-N` id (default 1). */
function seedNum(id: string): number {
  return Number.parseInt(id.replace(/\D/g, ""), 10) || 1;
}

// ── /admin/patients/:id/therapy-snapshot ───────────────────────────
// Source: routes/admin/patient-therapy-snapshot.ts — the route spreads
// a TherapySnapshot over `{ patientId, ...snapshot }`. The Patient360
// panel renders nothing unless `hasData` is true, so seed real numbers.
export function demoTherapySnapshot(patientId: string) {
  return {
    patientId,
    hasData: true,
    windowDays: 30,
    nightsWithData: 27,
    windowStartDate: dateOnly(-30),
    windowEndDate: dateOnly(-1),
    lastNightDate: dateOnly(-1),
    staleDays: 1,
    avgUsageHours: 6.8,
    avgAhi: 2.4,
    avgLeakLMin: 9.1,
    compliantNights: 24,
    complianceRatePct: 88.9,
  };
}

// ── /admin/patients/:id/resupply-summary ───────────────────────────
// Source: routes/admin/patient-resupply-summary.ts — adherence math +
// nightly rows + smart triggers + compliance alerts + counts. The
// PatientResupplyTab derefs `data.adherence`, `data.nights`, etc.
export function demoResupplySummary(_patientId: string) {
  // 30 synthetic nights, newest first (route orders descending).
  const nights = Array.from({ length: 30 }, (_, idx) => {
    const i = 29 - idx; // 0 (oldest) .. 29 (newest)
    const usage = 6.5 + Math.sin(i / 4) * 1.3;
    return {
      id: `demo-night-${i + 1}`,
      nightDate: dateOnly(-(30 - i)),
      source: "resmed_airview",
      usageMinutes: Math.round(Math.max(0, usage) * 60),
      ahi: Math.round((2 + Math.cos(i / 5) * 1.2) * 10) / 10,
      leakRateLMin: Math.round((9 + Math.sin(i / 6) * 3) * 10) / 10,
      pressureP95Cmh2o: Math.round((11 + Math.sin(i / 7)) * 10) / 10,
    };
  });
  return {
    adherence: {
      windowDays: 30,
      windowNightsAvailable: 28,
      nightsCompliant: 25,
      minCompliantNightsForMedicare: 21,
      minUsageMinutesForCompliantNight: 240,
      adherenceFraction: 0.893,
      meetsMedicareBar: true,
      medianUsageMinutes: 408,
      medianAhi: 2.3,
      medianLeakRateLMin: 8.7,
    },
    nights,
    smartTriggers: [
      {
        id: "demo-trigger-1",
        kind: "cushion_wear",
        detectedAt: daysAgo(2),
        windowStartDate: dateOnly(-16),
        windowEndDate: dateOnly(-2),
        sentAt: null,
      },
    ],
    complianceAlerts: [
      {
        id: "demo-alert-1",
        alertType: "low_usage",
        severity: "warning",
        summary: "Usage dipped below 4 hrs on 2 of the last 7 nights.",
        status: "open",
        snoozedUntil: null,
        createdAt: daysAgo(3),
      },
    ],
    counts: {
      nightsOnFile: 30,
      smartTriggersOpen: 1,
      complianceAlertsOpen: 1,
    },
    generatedAt: NOW_ISO(),
  };
}

// ── /admin/patients/:id/timeline ───────────────────────────────────
// Source: routes/admin/patient-timeline.ts — `{ events, degradedSources }`.
// The ActivityTab derefs `data.events` and renders each event's kind.
export function demoPatientTimeline(patientId: string) {
  const n = seedNum(patientId);
  return {
    events: [
      {
        kind: "fulfillment_delivered",
        title: "A7034 delivered",
        detail: "Carrier confirmation received",
        refId: `demo-ful-${n}`,
        at: daysAgo(38),
      },
      {
        kind: "fulfillment_shipped",
        title: "A7034 shipped",
        detail: "Fulfillment status: shipped",
        refId: `demo-ful-${n}`,
        at: daysAgo(40),
      },
      {
        kind: "conversation_opened",
        title: "Conversation (sms)",
        detail: "Status: awaiting_admin",
        refId: `demo-conv-${n}`,
        at: daysAgo(2),
      },
      {
        kind: "episode_created",
        title: "Episode awaiting_response",
        detail: "Resupply cycle in awaiting_response state",
        refId: `demo-ep-${n}`,
        at: daysAgo(10),
      },
      {
        kind: "coaching_plan_opened",
        title: "Adherence coaching plan",
        detail: "Status: active, target 80%",
        refId: `demo-plan-${n}`,
        at: daysAgo(54),
      },
    ],
    degradedSources: [] as string[],
  };
}

// ── /admin/manual-documents (list) ─────────────────────────────────
// Source: routes/admin/manual-documents.ts — `{ documents: [...] }` of
// MANUAL_DOCUMENT_ROW_COLUMNS rows. The documents page lists these.
export function demoManualDocuments() {
  return {
    documents: [
      {
        id: "demo-mdoc-1",
        document_type: "cmn",
        title: "Certificate of Medical Necessity — PAP",
        status: "sent",
        patient_id: "demo-patient-1",
        chart_document_id: null,
        fields: {
          patient_name: "Jordan Sample",
          ordering_physician: "Dr. Alex Rivera, MD",
          diagnosis: "G47.33",
        },
        body: null,
        recipient_name: "Dr. Alex Rivera, MD — Demo Sleep Associates",
        recipient_address: "100 Demo Plaza, Suite 200\nPhiladelphia, PA 19104",
        recipient_email: "office@demosleep.example",
        recipient_fax_e164: "+12155550148",
        last_emailed_at: daysAgo(5),
        last_faxed_at: daysAgo(5),
        attached_at: null,
        created_by_email: "demo.admin@caremetric.example",
        created_at: daysAgo(6),
        updated_at: daysAgo(5),
      },
      {
        id: "demo-mdoc-2",
        document_type: "delivery_ticket",
        title: "Delivery Ticket — Mask Resupply",
        status: "attached",
        patient_id: "demo-patient-2",
        chart_document_id: "demo-chart-doc-2",
        fields: {
          patient_name: "Casey Demo",
          delivery_address: "415 Maple Avenue, Apt 6\nPhiladelphia, PA 19107",
        },
        body: null,
        recipient_name: "Casey Demo",
        recipient_address: "415 Maple Avenue, Apt 6\nPhiladelphia, PA 19107",
        recipient_email: "casey@caremetric.example",
        recipient_fax_e164: null,
        last_emailed_at: daysAgo(12),
        last_faxed_at: null,
        attached_at: daysAgo(11),
        created_by_email: "demo.admin@caremetric.example",
        created_at: daysAgo(13),
        updated_at: daysAgo(11),
      },
    ],
  };
}

// ── /admin/manual-documents/catalog ────────────────────────────────
// Source: routes/admin/manual-documents.ts — `{ types: [...] }`, each
// type carrying label/description/phi/requiresSignature + fields.
export function demoManualDocumentsCatalog() {
  const field = (
    key: string,
    label: string,
    kind: "text" | "textarea" | "date",
    required: boolean,
  ) => ({ key, label, kind, required });
  return {
    types: [
      {
        type: "cmn",
        label: "Certificate of Medical Necessity",
        description: "Physician-signed medical-necessity form for PAP therapy.",
        phi: true,
        requiresSignature: true,
        fields: [
          field("patient_name", "Patient name", "text", true),
          field("date_of_birth", "Date of birth", "date", false),
          field("ordering_physician", "Ordering physician", "text", true),
          field("diagnosis", "Diagnosis (ICD-10)", "text", false),
          field(
            "clinical_justification",
            "Clinical justification",
            "textarea",
            false,
          ),
        ],
      },
      {
        type: "prescription",
        label: "Prescription / Order",
        description: "Standard written order for DME supplies.",
        phi: true,
        requiresSignature: true,
        fields: [
          field("patient_name", "Patient name", "text", true),
          field("prescriber_name", "Prescriber", "text", true),
          field("items_ordered", "Items ordered", "textarea", true),
        ],
      },
      {
        type: "delivery_ticket",
        label: "Delivery Ticket",
        description: "Proof-of-delivery ticket for a shipment.",
        phi: true,
        requiresSignature: true,
        fields: [
          field("patient_name", "Patient name", "text", true),
          field("delivery_address", "Delivery address", "textarea", false),
        ],
      },
      {
        type: "cover_letter",
        label: "Fax Cover Letter",
        description: "Cover sheet for an outbound fax.",
        phi: false,
        requiresSignature: false,
        fields: [
          field("attention", "Attention", "text", false),
          field("from_name", "From", "text", false),
        ],
      },
      {
        type: "other",
        label: "Free-form Letter",
        description: "A blank, free-form document.",
        phi: false,
        requiresSignature: false,
        fields: [],
      },
    ],
  };
}

// ── /admin/manual-documents/standard-catalog ───────────────────────
// Source: routes/admin/manual-documents.ts — `{ templates, packets }`.
export function demoManualDocumentsStandardCatalog() {
  return {
    templates: [
      {
        key: "swo_pap",
        label: "Standard Written Order (PAP)",
        documentType: "prescription",
        description: "CMS-aligned SWO for PAP devices and supplies.",
        title: "Standard Written Order",
        fields: { patient_name: "", prescriber_name: "" },
        body: null,
      },
      {
        key: "abn",
        label: "Advance Beneficiary Notice (ABN)",
        documentType: "agreement",
        description: "Medicare ABN of non-coverage.",
        title: "Advance Beneficiary Notice",
        fields: { party_name: "" },
        body: null,
      },
    ],
    packets: [
      {
        key: "medicare_new_patient",
        label: "Medicare New Patient",
        description: "Standard Medicare onboarding document bundle.",
        title: "Medicare New Patient Packet",
        includeCoverSheet: true,
        templateKeys: ["swo_pap", "abn"],
      },
    ],
  };
}

// ── /admin/patients/:id/packets + /admin/patient-packets ───────────
// Source: routes/admin/patient-packets.ts — `{ packets: [...] }`.
export function demoPatientPackets(patientId?: string) {
  const targetId = patientId ?? "demo-patient-1";
  const all = [
    {
      id: "demo-packet-1",
      patient_id: "demo-patient-1",
      title: "New Patient Signature Packet",
      status: "completed",
      recipient_name: "Jordan Sample",
      recipient_email: "jordan@caremetric.example",
      sent_at: daysAgo(20),
      first_viewed_at: daysAgo(19),
      completed_at: daysAgo(19),
      expires_at: daysFromNow(10),
      created_at: daysAgo(21),
      reminder_count: 1,
      last_reminded_at: daysAgo(20),
      chart_document_id: "demo-chart-doc-1",
      chart_filed_at: daysAgo(19),
    },
    {
      id: "demo-packet-2",
      patient_id: "demo-patient-1",
      title: "Annual Re-Certification Packet",
      status: "sent",
      recipient_name: "Jordan Sample",
      recipient_email: "jordan@caremetric.example",
      sent_at: daysAgo(3),
      first_viewed_at: null,
      completed_at: null,
      expires_at: daysFromNow(27),
      created_at: daysAgo(3),
      reminder_count: 0,
      last_reminded_at: null,
      chart_document_id: null,
      chart_filed_at: null,
    },
    {
      id: "demo-packet-3",
      patient_id: "demo-patient-2",
      title: "Proof of Delivery — Mask Resupply",
      status: "viewed",
      recipient_name: "Casey Demo",
      recipient_email: "casey@caremetric.example",
      sent_at: daysAgo(6),
      first_viewed_at: daysAgo(5),
      completed_at: null,
      expires_at: daysFromNow(24),
      created_at: daysAgo(6),
      reminder_count: 2,
      last_reminded_at: daysAgo(2),
      chart_document_id: null,
      chart_filed_at: null,
    },
  ];
  if (patientId) {
    return { packets: all.filter((p) => p.patient_id === targetId) };
  }
  return { packets: all };
}

// ── /admin/shop/customers/:userId/notes ────────────────────────────
// Source: routes/admin/customer-notes.ts — `{ notes: [...] }`.
export function demoCustomerNotes(_userId: string) {
  return {
    notes: [
      {
        id: "demo-cnote-1",
        body: "Customer called about a delayed shipment; reassured and confirmed tracking by email.",
        authorEmail: "demo.admin@caremetric.example",
        authorUserId: "demo-admin-1",
        createdAt: daysAgo(4),
      },
      {
        id: "demo-cnote-2",
        body: "Prefers SMS over email for resupply reminders. Updated comm prefs.",
        authorEmail: "demo.admin@caremetric.example",
        authorUserId: "demo-admin-1",
        createdAt: daysAgo(18),
      },
    ],
  };
}

// ── /admin/shop/customers/:customerId/timeline ─────────────────────
// Source: routes/admin/customer-timeline.ts — `{ events, count }`.
export function demoCustomerTimeline(customerId: string) {
  const n = seedNum(customerId);
  const events = [
    {
      kind: "conversation" as const,
      refId: `demo-conv-${n}`,
      at: daysAgo(2),
      label: "sms · awaiting_admin",
    },
    {
      kind: "order" as const,
      refId: `demo-order-${n}`,
      at: daysAgo(12),
      label: "paid",
    },
    {
      kind: "review" as const,
      refId: `demo-review-${n}`,
      at: daysAgo(30),
      label: "5★ · published",
    },
    {
      kind: "return" as const,
      refId: `demo-return-${n}`,
      at: daysAgo(50),
      label: "refunded",
    },
  ];
  return { events, count: events.length };
}

// ── /admin/shop/orders/:orderId/notes ──────────────────────────────
// Source: routes/admin/order-notes.ts — `{ notes: [...] }`.
export function demoOrderNotes(_orderId: string) {
  return {
    notes: [
      {
        id: "demo-onote-1",
        body: "Address corrected per customer request before label was printed.",
        authorEmail: "demo.admin@caremetric.example",
        authorUserId: "demo-admin-1",
        createdAt: daysAgo(1),
      },
    ],
  };
}

// ── /admin/patients/:id/onboarding ─────────────────────────────────
// Source: routes/admin/patient-onboarding.ts — `{ journey: {...} | null }`.
export function demoPatientOnboarding(_patientId: string) {
  return {
    journey: {
      id: "demo-journey-1",
      startedAt: daysAgo(38),
      day1SentAt: daysAgo(37),
      day3SentAt: daysAgo(35),
      day7SentAt: daysAgo(31),
      day30SentAt: daysAgo(8),
      day60SentAt: null,
      day90SentAt: null,
      status: "active",
      enrolledByEmail: "demo.admin@caremetric.example",
      createdAt: daysAgo(38),
    },
  };
}

// ── /admin/patients/:id/onboarding/attempts ────────────────────────
// Source: routes/admin/patient-onboarding.ts — `{ attempts: [...] }`.
export function demoPatientOnboardingAttempts(_patientId: string) {
  return {
    attempts: [
      {
        id: "demo-attempt-1",
        dayLabel: "day30",
        channel: "email",
        outcome: "sent",
        vendorRef: "sg_demo_30a",
        errorCode: null,
        attemptedAt: daysAgo(8),
      },
      {
        id: "demo-attempt-2",
        dayLabel: "day7",
        channel: "sms",
        outcome: "sent",
        vendorRef: "tw_demo_7b",
        errorCode: null,
        attemptedAt: daysAgo(31),
      },
      {
        id: "demo-attempt-3",
        dayLabel: "day1",
        channel: "voice",
        outcome: "vendor_error",
        vendorRef: null,
        errorCode: "no_answer",
        attemptedAt: daysAgo(37),
      },
    ],
  };
}

// ── /admin/patients/:id/therapy-links ──────────────────────────────
// Source: routes/admin/patient-therapy-links.ts — `{ links: [...] }`
// of LinkResponse rows.
export function demoTherapyLinks(patientId: string) {
  return {
    links: [
      {
        id: "demo-tlink-1",
        patientId,
        source: "resmed_airview",
        partnerPatientId: "AV-DEMO-44821",
        deviceSerial: "DEMO-22A1B2C3",
        status: "active",
        lastSyncedAt: daysAgo(1),
        lastSyncStatus: "ok",
        lastSyncError: null,
        createdAt: daysAgo(40),
        updatedAt: daysAgo(1),
      },
    ],
  };
}

// ── /admin/patients/:id/same-or-similar ────────────────────────────
// Source: routes/admin/same-or-similar.ts — `{ checks: [...] }`, each
// check being the stored row spread with a computed `window` from
// evaluateSameOrSimilar (status/blocked/clearsOn/daysUntilClear/reason).
export function demoSameOrSimilar(patientId: string) {
  const n = seedNum(patientId);
  return {
    checks: [
      {
        id: "demo-sos-1",
        patient_id: patientId,
        hcpcs_code: "E0601",
        status: "active",
        last_dispense_on: dateOnly(-400),
        raw_response_json: { note: "HETS portal ticket #DEMO-99213" },
        requested_by_email: "demo.admin@caremetric.example",
        checked_at: daysAgo(5),
        created_at: daysAgo(5),
        window: {
          status: "active",
          blocked: true,
          clearsOn: dateOnly(1425), // ~5y window from last dispense
          daysUntilClear: 1425,
          reason:
            "Medicare billed for the same HCPCS within the 5-year reasonable-useful-lifetime window.",
        },
      },
      {
        id: "demo-sos-2",
        patient_id: patientId,
        hcpcs_code: "A7034",
        status: "clear",
        last_dispense_on: null,
        raw_response_json: null,
        requested_by_email: "demo.admin@caremetric.example",
        checked_at: daysAgo(5 + (n % 3)),
        created_at: daysAgo(5 + (n % 3)),
        window: {
          status: "clear",
          blocked: false,
          clearsOn: null,
          daysUntilClear: null,
          reason: "No same-or-similar equipment on file.",
        },
      },
    ],
  };
}

// ── /admin/patients/:id/cmn-documents ──────────────────────────────
// Source: routes/admin/cmn-documents.ts — `{ documents: [...] }`, each
// row spread with `validation` from validateCmnAnswers.
export function demoCmnDocuments(patientId: string) {
  return {
    documents: [
      {
        id: "demo-cmn-1",
        patient_id: patientId,
        claim_id: null,
        dwo_document_id: null,
        form_type: "pap_0601",
        hcpcs_code: "E0601",
        status: "completed",
        answers: {
          ahi_at_least_15: true,
          face_to_face_completed: true,
          adherence_documented: true,
        },
        physician_name: "Dr. Alex Rivera, MD",
        physician_npi: "1538291746",
        initial_date: dateOnly(-200),
        recert_date: null,
        length_of_need_months: 99,
        created_by_email: "demo.admin@caremetric.example",
        created_at: daysAgo(40),
        updated_at: daysAgo(38),
        validation: { ok: true, missing: [] as string[] },
      },
      {
        id: "demo-cmn-2",
        patient_id: patientId,
        claim_id: null,
        dwo_document_id: null,
        form_type: "pap_0601",
        hcpcs_code: "E0601",
        status: "draft",
        answers: { ahi_at_least_15: true },
        physician_name: null,
        physician_npi: null,
        initial_date: null,
        recert_date: null,
        length_of_need_months: null,
        created_by_email: "demo.admin@caremetric.example",
        created_at: daysAgo(2),
        updated_at: daysAgo(2),
        validation: {
          ok: false,
          missing: ["face_to_face_completed", "adherence_documented"],
        },
      },
    ],
  };
}

// ── /admin/billing/cmn-catalog ─────────────────────────────────────
// Source: routes/admin/cmn-documents.ts — `{ forms: [...] }`.
export function demoCmnCatalog() {
  return {
    forms: [
      {
        formType: "pap_0601",
        label: "PAP Device (E0601) — CMN",
        hcpcsCodes: ["E0601"],
        requiredKeys: [
          "ahi_at_least_15",
          "face_to_face_completed",
          "adherence_documented",
        ],
        questions: [
          {
            key: "ahi_at_least_15",
            label: "AHI or RDI ≥ 15 events/hour?",
            kind: "boolean",
          },
          {
            key: "face_to_face_completed",
            label: "Face-to-face evaluation completed?",
            kind: "boolean",
          },
          {
            key: "adherence_documented",
            label: "Adherence (≥4h on 70% of nights) documented?",
            kind: "boolean",
          },
        ],
      },
    ],
  };
}

// ── /admin/patients/:id/eligibility-checks ─────────────────────────
// Source: routes/admin/eligibility-checks.ts — `{ checks: [...] }` of
// raw eligibility_checks rows (select *).
export function demoEligibilityChecks(patientId: string) {
  return {
    checks: [
      {
        id: "demo-elig-1",
        patient_id: patientId,
        insurance_coverage_id: "demo-coverage-1",
        payer_name: "Independence Blue Cross",
        hcpcs_code: "E0601",
        status: "active",
        is_active: true,
        in_network: true,
        plan_name: "Personal Choice PPO",
        member_id: "DEMOQHP998877",
        deductible_cents: 150000,
        deductible_met_cents: 92000,
        oop_max_cents: 400000,
        oop_met_cents: 110000,
        coinsurance_pct: 20,
        copay_cents: null,
        requires_prior_auth: false,
        trace_reference: "271-DEMO-77120",
        realtime: true,
        requested_by_email: "demo.admin@caremetric.example",
        requested_at: daysAgo(3),
        created_at: daysAgo(3),
      },
    ],
  };
}

// ── /admin/signature-tracking ──────────────────────────────────────
// Source: routes/admin/signature-tracking.ts — `{ count, byProvider,
// items }`. Items are SignatureTrackingRow + a `documentPdfPath`.
export function demoSignatureTracking() {
  const items = [
    {
      id: "demo-sig-1",
      trackingCode: "PFS-7Q3K",
      documentKind: "manual_document" as const,
      documentId: "demo-mdoc-1",
      patientId: "demo-patient-1",
      providerId: "demo-provider-1",
      patientLabel: "Jordan Sample",
      providerLabel: "Dr. Alex Rivera, MD",
      practiceName: "Demo Sleep Associates",
      title: "Certificate of Medical Necessity — PAP",
      status: "awaiting_signature" as const,
      deliveryChannel: "fax" as const,
      returnFaxE164: "+12155550148",
      sentCount: 2,
      lastSentAt: daysAgo(2),
      returnedAt: null,
      canceledAt: null,
      createdAt: daysAgo(6),
      updatedAt: daysAgo(2),
      documentPdfPath: "/resupply-api/admin/manual-documents/demo-mdoc-1/pdf",
    },
    {
      id: "demo-sig-2",
      trackingCode: "PFS-2M8X",
      documentKind: "prescription_request" as const,
      documentId: "demo-rxreq-1",
      patientId: "demo-patient-4",
      providerId: "demo-provider-2",
      patientLabel: "Riley Tester",
      providerLabel: "Dr. Morgan Lee, MD",
      practiceName: "Demo Pulmonary Group",
      title: "Prescription request — PAP supplies",
      status: "awaiting_signature" as const,
      deliveryChannel: "fax" as const,
      returnFaxE164: "+12155550161",
      sentCount: 1,
      lastSentAt: daysAgo(9),
      returnedAt: null,
      canceledAt: null,
      createdAt: daysAgo(9),
      updatedAt: daysAgo(9),
      documentPdfPath:
        "/resupply-api/admin/prescription-requests/demo-rxreq-1/pdf",
    },
  ];
  return {
    count: items.length,
    byProvider: [
      {
        label: "Dr. Morgan Lee, MD",
        practiceName: "Demo Pulmonary Group",
        count: 1,
        oldestCreatedAt: daysAgo(9),
      },
      {
        label: "Dr. Alex Rivera, MD",
        practiceName: "Demo Sleep Associates",
        count: 1,
        oldestCreatedAt: daysAgo(6),
      },
    ],
    items,
  };
}

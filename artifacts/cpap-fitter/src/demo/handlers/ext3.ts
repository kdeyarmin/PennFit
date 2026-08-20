// Demo handlers (batch 3) for the client-side DEMO sandbox. Each route
// below mirrors the EXACT response shape of its live route file under
// artifacts/resupply-api/src/routes/admin/* so the corresponding admin
// page renders realistic sample data instead of crashing on the empty
// `{}` fallback the fetch interceptor would otherwise return.
//
// Route files seeded (relative to artifacts/resupply-api/src/routes/):
//   admin/davinci-pas-submit.ts        admin/era-ingest.ts
//   admin/delivery-failures.ts         admin/fitter-invites.ts
//   admin/dispense-readiness.ts        admin/form-acknowledgements.ts
//   admin/dme-organization.ts          admin/fulfillment-to-claim.ts
//   admin/documentation-packets.ts     admin/gl-account-mappings.ts
//   admin/education-videos.ts
//   admin/equipment-recalls.ts
//
// DATA RULES: everything here is fictional demo data — obviously-fake
// patient names ("Avery Sample", "Demo Patient"), demo ids, fresh
// relative dates, cents for money. Platform = CareMetric Breathe; the
// demo tenant is Penn Home Medical Supply (pennpaps.com). Therapy-cloud
// vendors are the real product names (ResMed AirView, Philips Care
// Orchestrator, 3B/React Health). NO real PHI.

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  daysAgo,
  daysFromNow,
  dateOnly,
  hoursFromNow,
  NOW_ISO,
} from "../fixtures/dates";

// ── Delivery failures (delivery-failures.ts) ──────────────────────────
// GET /resupply-api/admin/delivery-failures
//   The live route returns a route-specific DEGRADED shape: the audit
//   stream was retired (migration 0156), so `auditEvents` is always []
//   and `auditEventsUnavailable: true` / `counts.auditFailures: null`.
//   Match that real shape — do NOT invent audit rows. Message + recall
//   delivery failures are still real, so a couple of those are seeded.
function deliveryFailures(sinceDays: number) {
  const messageEvents = [
    {
      kind: "message" as const,
      id: "demo-msg-fail-0001",
      occurredAt: daysAgo(1),
      channel: "sms",
      direction: "outbound",
      senderRole: "system",
      deliveryStatus: "undelivered",
      deliveryError: "30005 — Unknown destination handset",
      conversationId: "demo-conv-5001",
      patientId: "demo-p-2004",
      patientName: "Avery Sample",
    },
    {
      kind: "message" as const,
      id: "demo-msg-fail-0002",
      occurredAt: daysAgo(3),
      channel: "email",
      direction: "outbound",
      senderRole: "system",
      deliveryStatus: "bounced",
      deliveryError: "550 5.1.1 — recipient address rejected",
      conversationId: "demo-conv-5002",
      patientId: "demo-p-3007",
      patientName: "Demo Patient",
    },
    {
      kind: "message" as const,
      id: "demo-msg-fail-0003",
      occurredAt: daysAgo(6),
      channel: "email",
      direction: "outbound",
      senderRole: "csr",
      deliveryStatus: "spam_report",
      deliveryError: null,
      conversationId: "demo-conv-5003",
      patientId: null,
      patientName: null,
    },
  ];
  const recallEvents = [
    {
      kind: "recall" as const,
      id: "demo-recall-notif-fail-0001",
      occurredAt: daysAgo(2),
      channel: "sms",
      deliveryStatus: "failed",
      deliveryError: "30003",
      recallId: "demo-recall-0001",
      patientId: "demo-p-2006",
      patientName: "Quinn Mockton",
    },
  ];
  // Retired audit stream — always empty / unavailable in the live app.
  const auditEvents: Array<{
    kind: "audit";
    id: string;
    occurredAt: string;
    action: string;
    targetTable: string | null;
    targetId: string | null;
    actorEmail: string | null;
    metadata: unknown;
  }> = [];
  return {
    sinceDays,
    counts: {
      messageFailures: messageEvents.length,
      recallFailures: recallEvents.length,
      auditFailures: null,
    },
    failureStatuses: [
      "failed",
      "undelivered",
      "bounced",
      "dropped",
      "rejected",
      "spam_report",
    ],
    messageEvents,
    recallEvents,
    auditEvents,
    auditEventsUnavailable: true,
  };
}

// ── Dispense-readiness queue (dispense-readiness.ts) ──────────────────
// GET /resupply-api/admin/dispense-readiness/queue → { reviews: [...] }
//   Selected columns only (see route .select(...)).
function dispenseReadinessQueue(verdict?: string) {
  const reviews = [
    {
      id: "demo-drr-0001",
      patient_id: "demo-p-2004",
      hcpcs_code: "E0601",
      overall_verdict: "gaps_with_fixable" as const,
      estimated_days_to_ready: 3,
      checks_failed: 0,
      checks_warning: 2,
      ai_summary:
        "Ready except for a missing recent compliance download and an expiring prior auth. Both fixable this week.",
      created_at: daysAgo(1),
    },
    {
      id: "demo-drr-0002",
      patient_id: "demo-p-3007",
      hcpcs_code: "E0470",
      overall_verdict: "gaps_with_blocking" as const,
      estimated_days_to_ready: 10,
      checks_failed: 2,
      checks_warning: 1,
      ai_summary:
        "Blocked: no qualifying sleep study on file and the DWO is unsigned. Obtain both before dispensing.",
      created_at: daysAgo(2),
    },
  ];
  const filtered =
    verdict === "gaps_with_fixable" || verdict === "gaps_with_blocking"
      ? reviews.filter((r) => r.overall_verdict === verdict)
      : reviews;
  return { reviews: filtered };
}

// Per-patient dispense-readiness review list / detail rows. The live
// route does `select("*")`, so we shape a fuller row.
function dispenseReview(over: Record<string, unknown>) {
  return {
    id: "demo-drr-detail-0001",
    patient_id: "demo-p-2004",
    hcpcs_code: "E0601",
    fulfillment_id: null,
    payer_profile_id: null,
    insurance_coverage_id: null,
    ready_to_dispense: false,
    overall_verdict: "gaps_with_fixable",
    estimated_days_to_ready: 3,
    deterministic_findings_json: [
      {
        key: "active_prescription",
        label: "Active prescription on file",
        status: "pass",
        detail: "Rx E0601 valid through " + dateOnly(220),
      },
      {
        key: "recent_compliance_download",
        label: "Recent compliance download",
        status: "warning",
        detail: "Last therapy night is 8 days old.",
      },
      {
        key: "prior_auth_current",
        label: "Prior authorization current",
        status: "warning",
        detail: "Auth expires in 18 days.",
      },
    ],
    checks_total: 8,
    checks_passed: 6,
    checks_warning: 2,
    checks_failed: 0,
    ai_summary:
      "Ready except for a missing recent compliance download and an expiring prior auth. Both fixable this week.",
    ai_action_plan_json: [
      "Request a fresh ResMed AirView download to refresh compliance.",
      "Submit a prior-auth renewal before expiry.",
    ],
    ai_model: "gpt-4.1-mini",
    ai_prompt_version: "2026-05.v3",
    ai_confidence: 0.82,
    ai_latency_ms: 1240,
    ai_prompt_tokens: 1820,
    ai_completion_tokens: 240,
    ai_error_message: null,
    review_status: "pending",
    reviewed_by_email: null,
    reviewed_at: null,
    created_by_email: "demo.csr@pennpaps.example",
    created_at: daysAgo(1),
    ...over,
  };
}

// ── DME organization (dme-organization.ts) ────────────────────────────
// GET /resupply-api/admin/dme-organization → { organization, contacts }
//   This is the demo TENANT's billing identity: Penn Home Medical Supply.
function dmeOrganization() {
  return {
    organization: {
      id: "demo-dme-org-0001",
      legalName: "Penn Home Medical Supply, LLC",
      dbaName: "PennPaps",
      taxId: "123456789",
      organizationalNpi: "1982736450",
      taxonomyCode: "332B00000X",
      medicarePtan: "DME-0099221",
      physical: {
        line1: "100 Liberty Avenue",
        line2: "Suite 220",
        city: "Philadelphia",
        state: "PA",
        zip: "19103",
      },
      mailing: {
        line1: "PO Box 4421",
        line2: null,
        city: "Philadelphia",
        state: "PA",
        zip: "19103",
      },
      payTo: null,
      phoneE164: "+12155550123",
      faxE164: "+12155550144",
      billingEmail: "billing@pennpaps.com",
      generalEmail: "info@pennpaps.com",
      supportEmail: "support@pennpaps.com",
      supportPhoneE164: "+12155550123",
      supportHoursText: "Mon-Fri 8am-6pm ET",
      websiteUrl: "https://pennpaps.com",
      accreditation: {
        body: "achc" as const,
        number: "ACHC-DEMO-77120",
        expiresOn: dateOnly(540),
      },
      stateLicense: {
        number: "PA-DME-44120",
        state: "PA",
        expiresOn: dateOnly(300),
      },
      liability: {
        carrier: "Keystone Mutual (demo)",
        policyNumber: "POL-DEMO-3321",
        expiresOn: dateOnly(210),
      },
      suretyBond: {
        carrier: "Liberty Surety (demo)",
        amountCents: 5_000_000,
        expiresOn: dateOnly(180),
      },
      authorizedSigner: {
        name: "Dana Operator",
        title: "Owner / Authorized Signer",
      },
      notes: null,
      createdAt: daysAgo(420),
      updatedAt: daysAgo(12),
    },
    contacts: [
      {
        id: "demo-dme-contact-0001",
        role: "billing_manager" as const,
        name: "Riley Ledger",
        title: "Billing Manager",
        email: "billing@pennpaps.com",
        phoneE164: "+12155550130",
        isPrimary: true,
        isActive: true,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(40),
      },
      {
        id: "demo-dme-contact-0002",
        role: "authorized_signer" as const,
        name: "Dana Operator",
        title: "Owner",
        email: "owner@pennpaps.com",
        phoneE164: "+12155550131",
        isPrimary: false,
        isActive: true,
        createdAt: daysAgo(400),
        updatedAt: daysAgo(400),
      },
    ],
  };
}

// ── Documentation packets (documentation-packets.ts) ──────────────────
// GET /resupply-api/admin/patients/:id/documentation-packets
//   → { packets: [...] }  (select("*") rows). The POST renders a PDF —
//   SKIPPED (binary).
function documentationPackets() {
  return {
    packets: [
      {
        id: "demo-docpkt-0001",
        patient_id: "demo-p-2004",
        kind: "prior_auth_support",
        included_docs_json: {
          sleep_study_ids: ["demo-study-1"],
          prescription_ids: ["demo-rx-1"],
          dwo_document_ids: [],
          compliance_window_days: 30,
        },
        page_count: 6,
        notes: "Assembled for Demo Medicaid MCO prior-auth submission.",
        generated_by_email: "demo.csr@pennpaps.example",
        created_at: daysAgo(4),
      },
      {
        id: "demo-docpkt-0002",
        patient_id: "demo-p-2004",
        kind: "accreditation_audit",
        included_docs_json: {
          sleep_study_ids: [],
          prescription_ids: ["demo-rx-1"],
          dwo_document_ids: ["demo-dwo-1"],
          compliance_window_days: 90,
        },
        page_count: 11,
        notes: null,
        generated_by_email: "demo.csr@pennpaps.example",
        created_at: daysAgo(20),
      },
    ],
  };
}

// ── Education videos (education-videos.ts) ─────────────────────────────
// GET /resupply-api/admin/education-videos → { videos: [...] }
//   select("*") rows. Content management, no PHI.
function educationVideos() {
  return {
    videos: [
      {
        id: "demo-edu-0001",
        title: "Getting Started: Your First Night on CPAP",
        topic: "getting_started",
        description:
          "A two-minute walkthrough of putting on your mask, turning on ramp, and what to expect.",
        video_url: "https://videos.example.com/demo/first-night.mp4",
        thumbnail_url: "https://videos.example.com/demo/first-night.jpg",
        duration_seconds: 142,
        sort_order: 10,
        active: true,
        created_by_email: "demo.rt@pennpaps.example",
        created_at: daysAgo(120),
        updated_at: daysAgo(30),
      },
      {
        id: "demo-edu-0002",
        title: "Cleaning Your Mask and Tubing",
        topic: "cleaning",
        description:
          "How to keep your equipment clean and when to replace cushions and filters.",
        video_url: "https://videos.example.com/demo/cleaning.mp4",
        thumbnail_url: "https://videos.example.com/demo/cleaning.jpg",
        duration_seconds: 198,
        sort_order: 20,
        active: true,
        created_by_email: "demo.rt@pennpaps.example",
        created_at: daysAgo(90),
        updated_at: daysAgo(90),
      },
      {
        id: "demo-edu-0003",
        title: "Troubleshooting Mask Leaks",
        topic: "troubleshooting",
        description:
          "Quick fixes for the most common reasons a mask leaks overnight.",
        video_url: "https://videos.example.com/demo/leaks.mp4",
        thumbnail_url: null,
        duration_seconds: 165,
        sort_order: 30,
        active: false,
        created_by_email: "demo.rt@pennpaps.example",
        created_at: daysAgo(45),
        updated_at: daysAgo(10),
      },
    ],
  };
}

// ── Equipment recalls (equipment-recalls.ts) ──────────────────────────
// GET /resupply-api/admin/equipment-recalls → { recalls: [...] }
const EQUIPMENT_RECALLS = [
  {
    id: "demo-recall-0001",
    recallReference: "FDA-2026-DEMO-001",
    title: "Foam degradation advisory — affected blower units",
    manufacturer: "Philips",
    modelMatch: "DreamStation",
    serialMatch: { kind: "range" as const, from: "DS100000", to: "DS199999" },
    severity: "urgent" as const,
    status: "active" as const,
    issuedAt: dateOnly(-40),
    deadlineAt: dateOnly(20),
    referenceUrl: "https://www.example.com/recalls/demo-001",
    description:
      "Manufacturer advisory regarding sound-abatement foam in a range of units. Affected patients should be contacted for replacement.",
    createdAt: daysAgo(40),
    updatedAt: daysAgo(5),
  },
  {
    id: "demo-recall-0002",
    recallReference: "MFR-2026-DEMO-014",
    title: "Heated tubing connector inspection",
    manufacturer: "ResMed",
    modelMatch: "AirSense 11",
    serialMatch: null,
    severity: "advisory" as const,
    status: "active" as const,
    issuedAt: dateOnly(-14),
    deadlineAt: null,
    referenceUrl: null,
    description:
      "Inspect heated tubing connectors for a manufacturing tolerance issue. Low risk; advisory only.",
    createdAt: daysAgo(14),
    updatedAt: daysAgo(14),
  },
  {
    id: "demo-recall-0003",
    recallReference: "FDA-2025-DEMO-203",
    title: "Battery pack firmware (closed)",
    manufacturer: "3B Medical",
    modelMatch: "Luna G3",
    serialMatch: { kind: "list" as const, serials: ["LG3-0001", "LG3-0002"] },
    severity: "priority" as const,
    status: "closed" as const,
    issuedAt: dateOnly(-220),
    deadlineAt: dateOnly(-120),
    referenceUrl: "https://www.example.com/recalls/demo-203",
    description: "Firmware remediation completed; recall closed.",
    createdAt: daysAgo(220),
    updatedAt: daysAgo(118),
  },
];

function recallScan(recallId: string) {
  const affected = [
    {
      id: "demo-asset-0001",
      patientId: "demo-p-3007",
      manufacturer: "Philips",
      model: "DreamStation",
      serialNumber: "DS150042",
      status: "active",
      dispensedAt: daysAgo(380),
    },
    {
      id: "demo-asset-0002",
      patientId: "demo-p-2003",
      manufacturer: "Philips",
      model: "DreamStation",
      serialNumber: "DS162210",
      status: "active",
      dispensedAt: daysAgo(410),
    },
  ];
  return {
    recallId,
    candidatesScanned: 5,
    affectedCount: affected.length,
    affected,
  };
}

function recallNotifications(recallId: string) {
  const notifications = [
    {
      id: "demo-recall-notif-0001",
      assetId: "demo-asset-0001",
      patientId: "demo-p-3007",
      status: "sent",
      channel: "sms",
      notifiedAt: daysAgo(3),
      failedAt: null,
      failedReason: null,
      deliveryStatus: "delivered",
      deliveryErrorCode: null,
      createdAt: daysAgo(4),
    },
    {
      id: "demo-recall-notif-0002",
      assetId: "demo-asset-0002",
      patientId: "demo-p-2003",
      status: "failed",
      channel: "sms",
      notifiedAt: null,
      failedAt: daysAgo(2),
      failedReason: "undelivered",
      deliveryStatus: "failed",
      deliveryErrorCode: "30003",
      createdAt: daysAgo(4),
    },
    {
      id: "demo-recall-notif-0003",
      assetId: "demo-asset-0003",
      patientId: "demo-p-2006",
      status: "queued",
      channel: "email",
      notifiedAt: null,
      failedAt: null,
      failedReason: null,
      deliveryStatus: null,
      deliveryErrorCode: null,
      createdAt: daysAgo(1),
    },
  ];
  const counts = notifications.reduce<Record<string, number>>((acc, n) => {
    acc[n.status] = (acc[n.status] ?? 0) + 1;
    return acc;
  }, {});
  void recallId;
  return { counts, notifications };
}

function recallRemediation(recallId: string) {
  const actions = [
    {
      id: "demo-recall-rem-0001",
      assetId: "demo-asset-0001",
      action: "replaced",
      evidenceUrl: null,
      notes: "Swapped for a new AirSense 11 at no charge.",
      performedByUserId: "demo-user-csr-1",
      performedAt: daysAgo(1),
    },
    {
      id: "demo-recall-rem-0002",
      assetId: "demo-asset-0002",
      action: "patient_declined",
      evidenceUrl: null,
      notes: "Patient prefers to keep current unit; documented decline.",
      performedByUserId: "demo-user-csr-1",
      performedAt: daysAgo(2),
    },
  ];
  const counts = actions.reduce<Record<string, number>>((acc, a) => {
    acc[a.action] = (acc[a.action] ?? 0) + 1;
    return acc;
  }, {});
  void recallId;
  return { counts, actions };
}

// ── ERA ingest (era-ingest.ts) ────────────────────────────────────────
// POST /resupply-api/admin/billing/era-ingest → benign 201 ingest-result.
//   The GET /admin/billing/era-files list is already handled elsewhere in
//   the demo (billing-claims.ts) — NOT re-seeded here.
function eraIngestResult(fileName: string) {
  return {
    eraFileId: "demo-era-ingest-0001",
    status: "processed",
    summary: {
      fileName,
      checkOrEftNumber: "EFT-DEMO-88210",
      paymentDate: dateOnly(-2),
      totalPaidCents: 184_250,
      paidClaims: 7,
      deniedClaims: 1,
      unmatchedClaims: 0,
      linesUpdated: 14,
      outcomes: [
        {
          patientControlNumber: "demo-claim-9001",
          matched: true,
          newStatus: "paid",
          paidCents: 38_400,
        },
        {
          patientControlNumber: "demo-claim-9002",
          matched: true,
          newStatus: "denied",
          paidCents: 0,
        },
      ],
    },
    denialAnalysesRun: 1,
  };
}

// ── Fitter invites (fitter-invites.ts) ────────────────────────────────
// GET /resupply-api/admin/fitter-invites → { invites: [...] }
function fitterInvites(status: string, holding: boolean) {
  const all = [
    {
      id: "demo-fi-0001",
      patient_id: "demo-p-2004",
      recipient_email: "avery.sample@example.com",
      recipient_phone_e164: "+12155550170",
      recipient_name: "Avery Sample",
      channel: "email",
      status: "completed",
      invited_by_email: "demo.csr@pennpaps.example",
      measurements: { faceWidthMm: 138, noseBridgeMm: 22 },
      questionnaire_answers: { sleepPosition: "side", facialHair: "no" },
      recommended_mask_id: "demo-mask-n30",
      recommended_mask_name: "Demo Nasal Pillow N30",
      recommended_mask_type: "nasal_pillow",
      recommendations: [
        { maskId: "demo-mask-n30", score: 0.91 },
        { maskId: "demo-mask-p10", score: 0.78 },
      ],
      auto_matched: true,
      claimed_by_user_id: null,
      claimed_by_email: null,
      claimed_at: null,
      sent_at: daysAgo(5),
      opened_at: daysAgo(5),
      completed_at: daysAgo(4),
      attached_at: null,
      expires_at: daysFromNow(2),
      created_at: daysAgo(5),
    },
    {
      id: "demo-fi-0002",
      patient_id: null,
      recipient_email: "prospect.demo@example.com",
      recipient_phone_e164: null,
      recipient_name: "Jordan Prospect",
      channel: "email",
      status: "completed",
      invited_by_email: "demo.csr@pennpaps.example",
      measurements: { faceWidthMm: 145, noseBridgeMm: 26 },
      questionnaire_answers: { sleepPosition: "back", facialHair: "yes" },
      recommended_mask_id: "demo-mask-f30i",
      recommended_mask_name: "Demo Full Face F30i",
      recommended_mask_type: "full_face",
      recommendations: [{ maskId: "demo-mask-f30i", score: 0.84 }],
      auto_matched: false,
      claimed_by_user_id: null,
      claimed_by_email: null,
      claimed_at: null,
      sent_at: daysAgo(3),
      opened_at: daysAgo(3),
      completed_at: daysAgo(2),
      attached_at: null,
      expires_at: daysFromNow(4),
      created_at: daysAgo(3),
    },
    {
      id: "demo-fi-0003",
      patient_id: null,
      recipient_email: null,
      recipient_phone_e164: "+12155550172",
      recipient_name: "Sam Newlead",
      channel: "sms",
      status: "sent",
      invited_by_email: "demo.csr@pennpaps.example",
      measurements: null,
      questionnaire_answers: null,
      recommended_mask_id: null,
      recommended_mask_name: null,
      recommended_mask_type: null,
      recommendations: null,
      auto_matched: false,
      claimed_by_user_id: null,
      claimed_by_email: null,
      claimed_at: null,
      sent_at: daysAgo(1),
      opened_at: null,
      completed_at: null,
      attached_at: null,
      expires_at: daysFromNow(6),
      created_at: daysAgo(1),
    },
  ];
  if (holding) {
    return {
      invites: all.filter((i) => i.status === "completed" && !i.patient_id),
    };
  }
  if (status !== "all") {
    return { invites: all.filter((i) => i.status === status) };
  }
  return { invites: all };
}

// ── Form acknowledgements (form-acknowledgements.ts) ──────────────────
// GET /resupply-api/admin/form-acknowledgements/summary → { summary: [...] }
function formAckSummary() {
  return {
    summary: [
      {
        formKind: "hipaa_npp",
        title: "HIPAA Notice of Privacy Practices",
        currentVersion: "2026-01",
        activePatients: 312,
        signedCurrent: 268,
        signedOld: 24,
        neverSigned: 20,
        complianceNote: null,
      },
      {
        formKind: "aob",
        title: "Assignment of Benefits",
        currentVersion: "2025-09",
        activePatients: 312,
        signedCurrent: 281,
        signedOld: 9,
        neverSigned: 22,
        complianceNote: null,
      },
      {
        formKind: "abn",
        title: "Advance Beneficiary Notice",
        currentVersion: "2025-06",
        activePatients: 312,
        signedCurrent: 142,
        signedOld: 5,
        neverSigned: 165,
        complianceNote:
          "Demo form — not the official CMS-R-131. Use for internal tracking only.",
      },
      {
        formKind: "financial_responsibility",
        title: "Financial Responsibility Agreement",
        currentVersion: "2025-09",
        activePatients: 312,
        signedCurrent: 255,
        signedOld: 18,
        neverSigned: 39,
        complianceNote: null,
      },
      {
        formKind: "supplier_standards",
        title: "Medicare DMEPOS Supplier Standards",
        currentVersion: "2026-01",
        activePatients: 312,
        signedCurrent: 240,
        signedOld: 30,
        neverSigned: 42,
        complianceNote: null,
      },
    ],
  };
}

// GET /resupply-api/admin/patients/:id/form-acknowledgements
//   → { acknowledgements: [...] }
function patientFormAcks() {
  return {
    acknowledgements: [
      {
        id: "demo-ack-0001",
        formKind: "hipaa_npp",
        formVersion: "2026-01",
        signedAt: daysAgo(30),
        signedFromIp: "203.0.113.10",
        source: "portal",
        notes: null,
        hcpcsCodes: null,
        currentVersion: "2026-01",
      },
      {
        id: "demo-ack-0002",
        formKind: "aob",
        formVersion: "2025-09",
        signedAt: daysAgo(30),
        signedFromIp: "203.0.113.10",
        source: "portal",
        notes: null,
        hcpcsCodes: null,
        currentVersion: "2025-09",
      },
      {
        id: "demo-ack-0003",
        formKind: "abn",
        formVersion: "2025-06",
        signedAt: daysAgo(12),
        signedFromIp: null,
        source: "csr_recorded",
        notes: "Paper ABN signed in office for upgrade items.",
        hcpcsCodes: ["A7034", "A7035"],
        currentVersion: "2025-06",
      },
    ],
  };
}

// ── GL account mappings (gl-account-mappings.ts) ──────────────────────
// GET /resupply-api/admin/billing/gl-account-mappings → { accounts: [...] }
function glAccountMappings() {
  return {
    accounts: [
      {
        key: "deposit",
        accountName: "Stripe Clearing",
        isCustom: false,
        default: "Stripe Clearing",
      },
      {
        key: "revenue",
        accountName: "Resupply Revenue",
        isCustom: true,
        default: "Sales:Online Orders",
      },
      {
        key: "refund",
        accountName: "Sales Returns and Allowances",
        isCustom: false,
        default: "Sales Returns and Allowances",
      },
      {
        key: "patient_pay",
        accountName: "Patient Payments",
        isCustom: false,
        default: "Patient Payments",
      },
    ],
  };
}

function intParam(
  req: { query: URLSearchParams },
  key: string,
  fallback: number,
): number {
  const raw = req.query.get(key);
  const n = raw == null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const ext3Handlers: DemoHandler[] = [
  // ── Delivery failures (degraded audit-stream shape) ─────────────────
  route("GET", "/resupply-api/admin/delivery-failures", (req) =>
    json(deliveryFailures(intParam(req, "sinceDays", 14))),
  ),

  // ── Dispense readiness ──────────────────────────────────────────────
  route("GET", "/resupply-api/admin/dispense-readiness/queue", (req) =>
    json(dispenseReadinessQueue(req.query.get("verdict") ?? undefined)),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/dispense-readiness-reviews",
    () =>
      json({
        reviews: [
          dispenseReview({}),
          dispenseReview({
            id: "demo-drr-detail-0002",
            hcpcs_code: "A7038",
            overall_verdict: "ready",
            ready_to_dispense: true,
            checks_failed: 0,
            checks_warning: 0,
            checks_passed: 8,
            estimated_days_to_ready: 0,
            review_status: "acknowledged",
            reviewed_by_email: "demo.csr@pennpaps.example",
            reviewed_at: daysAgo(8),
            ai_summary: "All checks pass — ready to dispense.",
            created_at: daysAgo(9),
          }),
        ],
      }),
  ),
  route(
    "GET",
    "/resupply-api/admin/patients/:id/dispense-readiness-reviews/:reviewId",
    (_req, params) => json({ review: dispenseReview({ id: params.reviewId }) }),
  ),
  // Run a review (benign success in the route's 201 shape).
  route(
    "POST",
    "/resupply-api/admin/patients/:id/dispense-readiness-reviews",
    (req) => {
      const body = req.json<{ hcpcsCode?: string }>();
      return json(
        {
          reviewId: "demo-drr-new-0001",
          readyToDispense: false,
          overallVerdict: "gaps_with_fixable",
          counts: { total: 8, passed: 6, warning: 2, failed: 0 },
          findings: dispenseReview({}).deterministic_findings_json,
          ai: {
            summary:
              "Ready except for a couple of fixable gaps for " +
              (body?.hcpcsCode ?? "E0601") +
              ".",
            actionPlan: dispenseReview({}).ai_action_plan_json,
            estimatedDaysToReady: 3,
            confidence: 0.82,
            latencyMs: 1200,
            promptTokens: 1800,
            completionTokens: 230,
            errorMessage: null,
          },
        },
        201,
      );
    },
  ),
  route(
    "PATCH",
    "/resupply-api/admin/patients/:id/dispense-readiness-reviews/:reviewId",
    () => json({ ok: true }),
  ),

  // ── DME organization ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/dme-organization", () =>
    json(dmeOrganization()),
  ),
  route("PUT", "/resupply-api/admin/dme-organization", () =>
    json({ id: "demo-dme-org-0001", created: false }),
  ),
  route("POST", "/resupply-api/admin/dme-organization/contacts", () =>
    json({ id: "demo-dme-contact-new-0001" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/dme-organization/contacts/:id", () =>
    json({ ok: true }),
  ),
  route("DELETE", "/resupply-api/admin/dme-organization/contacts/:id", () =>
    json({ ok: true }),
  ),

  // ── Documentation packets (list only; POST renders a PDF — skipped) ──
  route("GET", "/resupply-api/admin/patients/:id/documentation-packets", () =>
    json(documentationPackets()),
  ),

  // ── Education videos ────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/education-videos", () =>
    json(educationVideos()),
  ),
  route("POST", "/resupply-api/admin/education-videos", () =>
    json({ id: "demo-edu-new-0001" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/education-videos/:id", () =>
    json({ ok: true }),
  ),

  // ── Equipment recalls ───────────────────────────────────────────────
  route("GET", "/resupply-api/admin/equipment-recalls", () =>
    json({ recalls: EQUIPMENT_RECALLS }),
  ),
  route("POST", "/resupply-api/admin/equipment-recalls", () =>
    json({ id: "demo-recall-new-0001" }, 201),
  ),
  route("PATCH", "/resupply-api/admin/equipment-recalls/:id", (_req, params) =>
    json({ id: params.id, changed: true }),
  ),
  route(
    "GET",
    "/resupply-api/admin/equipment-recalls/:id/scan",
    (_req, params) => json(recallScan(params.id)),
  ),
  route("POST", "/resupply-api/admin/equipment-recalls/:id/match-assets", () =>
    json({ matchedCount: 2, newlyQueuedCount: 1, alreadyQueuedCount: 1 }),
  ),
  route(
    "GET",
    "/resupply-api/admin/equipment-recalls/:id/notifications",
    (_req, params) => json(recallNotifications(params.id)),
  ),
  route(
    "GET",
    "/resupply-api/admin/equipment-recalls/:id/remediation",
    (_req, params) => json(recallRemediation(params.id)),
  ),
  route("POST", "/resupply-api/admin/equipment-recalls/:id/remediation", () =>
    json({ id: "demo-recall-rem-new-0001" }, 201),
  ),

  // ── ERA ingest (POST upload; GET era-files list handled elsewhere) ──
  route("POST", "/resupply-api/admin/billing/era-ingest", (req) => {
    const body = req.json<{ fileName?: string }>();
    return json(eraIngestResult(body?.fileName ?? "demo-era-835.txt"), 201);
  }),

  // ── Fitter invites ──────────────────────────────────────────────────
  route("GET", "/resupply-api/admin/fitter-invites", (req) => {
    const holding =
      req.query.get("holding") === "1" || req.query.get("holding") === "true";
    return json(fitterInvites(req.query.get("status") ?? "all", holding));
  }),
  route("POST", "/resupply-api/admin/fitter-invites", (req) => {
    const body = req.json<{ channel?: "email" | "sms" | "in_office" }>();
    // Echo the requested channel — the senders render a QR panel for
    // "in_office" and a "texted/emailed" line otherwise, so collapsing it
    // to email here showed the demo the wrong confirmation.
    const channel =
      body?.channel === "sms" || body?.channel === "in_office"
        ? body.channel
        : "email";
    return json(
      {
        id: "demo-fi-new-0001",
        channel,
        delivered: true,
        deliveryError: null,
        inviteLink: "https://pennpaps.com/fitter-invite?t=demo-token",
        // In-office links expire with the visit; mailed ones in a month
        // (FITTER_INVITE_IN_OFFICE_TTL_MS / FITTER_INVITE_TTL_MS). Without
        // this the senders' expiry line read "Expires soon.".
        expiresAt: channel === "in_office" ? hoursFromNow(4) : daysFromNow(30),
      },
      201,
    );
  }),
  route(
    "POST",
    "/resupply-api/admin/fitter-invites/:id/claim",
    (_req, params) =>
      json({
        id: params.id,
        claimedByEmail: "demo.csr@pennpaps.example",
        claimedAt: NOW_ISO(),
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter-invites/:id/release",
    (_req, params) => json({ id: params.id, released: true }),
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter-invites/:id/attach",
    (_req, params) =>
      json({
        id: params.id,
        patientId: "demo-p-2004",
        status: "attached",
        enrolledInOnboarding: false,
      }),
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter-invites/:id/resend",
    (_req, params) =>
      json({
        id: params.id,
        delivered: true,
        deliveryError: null,
        inviteLink: "https://pennpaps.com/fitter-invite?t=demo-token",
      }),
  ),
  route("DELETE", "/resupply-api/admin/fitter-invites/:id", (_req, params) =>
    json({ id: params.id, status: "revoked" }),
  ),

  // ── Form acknowledgements ───────────────────────────────────────────
  route("GET", "/resupply-api/admin/form-acknowledgements/summary", () =>
    json(formAckSummary()),
  ),
  route("GET", "/resupply-api/admin/patients/:id/form-acknowledgements", () =>
    json(patientFormAcks()),
  ),
  route(
    "POST",
    "/resupply-api/admin/patients/:id/form-acknowledgements",
    (req) => {
      const body = req.json<{ formKind?: string; hcpcsCodes?: string[] }>();
      return json(
        {
          id: "demo-ack-new-0001",
          formKind: body?.formKind ?? "hipaa_npp",
          formVersion: "2026-01",
          hcpcsCodes: body?.hcpcsCodes ?? null,
        },
        201,
      );
    },
  ),

  // ── Fulfillment → claim (one-click claim creation) ──────────────────
  route(
    "POST",
    "/resupply-api/admin/fulfillments/:fulfillmentId/create-claim",
    () =>
      json(
        {
          id: "demo-claim-new-0001",
          patientId: "demo-p-2004",
          lineCount: 2,
          builderNotes: [
            "Resolved payer from active coverage: Demo Health Plan.",
            "Diagnosis codes pulled from the most recent sleep study.",
          ],
          proposed: {
            payerProfileId: "demo-payer-1",
            payerName: "Demo Health Plan",
            diagnosisCodes: ["G47.33"],
            renderingProviderId: "demo-prov-1",
            referringProviderId: "demo-prov-1",
            priorAuthNumber: null,
            lines: [
              {
                hcpcsCode: "A7038",
                modifiers: ["RR", "KX"],
                quantity: 2,
                billedCents: 3_200,
                sourceKind: "fee_schedule",
                feeScheduleRowId: "demo-fee-1",
              },
              {
                hcpcsCode: "A7034",
                modifiers: ["RR", "KX"],
                quantity: 1,
                billedCents: 9_800,
                sourceKind: "fee_schedule",
                feeScheduleRowId: "demo-fee-2",
              },
            ],
          },
        },
        201,
      ),
  ),

  // ── Da Vinci PAS submit (FHIR prior-auth submission — benign success)
  route(
    "POST",
    "/resupply-api/admin/patients/:id/prior-authorizations/:paId/submit-davinci-pas",
    () =>
      json(
        {
          submissionId: "demo-pas-sub-0001",
          transportStatus: "accepted",
          decision: "pended",
          authNumber: null,
          denialReason: null,
          dispositionText:
            "Request received and is pending payer review (demo).",
          latencyMs: 1420,
        },
        201,
      ),
  ),

  // ── GL account mappings ─────────────────────────────────────────────
  route("GET", "/resupply-api/admin/billing/gl-account-mappings", () =>
    json(glAccountMappings()),
  ),
  route(
    "PUT",
    "/resupply-api/admin/billing/gl-account-mappings/:key",
    (req, params) => {
      const body = req.json<{ accountName?: string }>();
      return json({
        ok: true,
        key: params.key,
        accountName: body?.accountName ?? "Demo Account",
      });
    },
  ),
];
